/**
 * Phase 7.9 — HTTP + SSE A2A transport (local loopback for dev/tests).
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import type { A2ATransport, A2ATransportMessage } from "./transport.js";
import type { AgentId } from "../../orchestration/multi-agent-types.js";
import type { AgentCardRegistry } from "./agent-card.js";
import type { A2AAgentCard } from "./agent-card.js";
import { discoverAgentCards } from "./external-registry.js";
import {
  hydrateRegistryFromFederation,
  loadFederatedAgentCards,
  mergeCardsIntoRegistry,
} from "./federated-registry-store.js";
import {
  buildFederationDirectoryBody,
  mergeRemoteCardsIntoFederationStore,
  parseFederationDirectoryBody,
  syncFederationFromPeers,
  type FederationConflictStrategy,
} from "./federation-sync.js";
import { startFederationLeaseHeartbeat } from "./federation-lease-heartbeat.js";
import {
  buildFederationLeaseBody,
  parseFederationLeaseBody,
} from "./federation-lease-witness.js";
import { federationLeasePath, readFederationLease } from "./federation-lease.js";
import {
  buildLeaseAuditChainBody,
  buildLeaseAuditLogBody,
  configureLeaseAuditSigning,
  exportLeaseAuditChain,
  exportLeaseAuditLog,
  readLeaseAuditChain,
  parseLeaseAuditEventTypes,
  validateLeaseAuditLogFilterOptions,
} from "./federation-lease-audit.js";
import {
  applySkillDepPruneStrategyRollbackForAgent,
  configureSkillDepPruneStrategyAuditStore,
} from "./federation-skill-deps-audit.js";
import {
  configureSkillDepPruneStrategyRollback,
  isSkillDepPruneStrategyRollbackEnabled,
} from "./federation-skill-deps.js";
import {
  buildSkillDepsPruneLogBody,
  exportSkillDepsPruneLog,
  readSkillDepsPruneLog,
} from "./federation-skill-deps-log.js";
import {
  buildLeaseAuditKeyRingBody,
  configureLeaseAuditKeyRing,
  parseLeaseAuditRotateBody,
  readLeaseAuditKeyRing,
  rotateLeaseAuditSigningKey,
} from "./federation-lease-audit-keys.js";
import {
  serializeLeaseAuditSignedBundle,
  exportLeaseAuditSignedBundle,
} from "./federation-lease-audit-export.js";
import {
  buildLeaseWitnessLogBody,
  parseLeaseWitnessPostBody,
  readLeaseWriteWitnessLog,
  recordRemoteLeaseWitness,
} from "./federation-lease-quorum.js";
import {
  applyClientTlsToRequest,
  loadServerTlsOptions,
  type A2AClientTlsConfig,
  type A2AServerTlsConfig,
} from "./tls-config.js";

export type { A2AHttpAuthConfig, HttpA2ATransportOptions } from "./http-transport-options.js";
import type { HttpA2ATransportOptions } from "./http-transport-options.js";
import { handleA2AFederationHttpRoute } from "./http-transport-federation-routes.js";


type MessageHandler = (message: A2ATransportMessage) => Promise<unknown>;

/**
 * Loopback HTTP server implementing A2ATransport.
 * - POST /a2a/send — deliver message to agent handler
 * - GET /a2a/agents/:id/events — SSE stream of inbound messages
 */
export class HttpA2ATransport implements A2ATransport {
  private server: Server | null = null;
  private handlers = new Map<string, MessageHandler>();
  private sseClients = new Map<string, Set<ServerResponse>>();
  private messageLog: A2ATransportMessage[] = [];
  private nextId = 1;
  private baseUrl = "";
  private useTls = false;
  private remoteCache: { at: number; agents: A2AAgentCard[] } | null = null;
  private leaseHeartbeatStop: (() => void) | null = null;

  constructor(private readonly options: HttpA2ATransportOptions = {}) {}

  private isAuthorized(req: IncomingMessage): boolean {
    const tokens = this.options.auth?.bearerTokens;
    if (!tokens?.length) return true;
    const header = req.headers.authorization ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    return !!match && tokens.includes(match[1]!);
  }

  get url(): string {
    return this.baseUrl;
  }

  async start(): Promise<{ host: string; port: number; url: string }> {
    if (this.server) {
      const u = new URL(this.baseUrl);
      return { host: u.hostname, port: Number(u.port), url: this.baseUrl };
    }

    const tlsOpts = loadServerTlsOptions(this.options.tls);
    this.useTls = tlsOpts !== null;

    return new Promise((resolve, reject) => {
      const handler = (req: IncomingMessage, res: ServerResponse) => {
        void this.handleRequest(req, res);
      };
      this.server = this.useTls
        ? createHttpsServer(tlsOpts!, handler)
        : createHttpServer(handler);
      this.server.on("error", reject);
      const host = this.options.host ?? "127.0.0.1";
      this.server.listen(this.options.port ?? 0, host, () => {
        const addr = this.server!.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("Failed to bind HTTP A2A transport"));
          return;
        }
        const scheme = this.useTls ? "https" : "http";
        this.baseUrl = `${scheme}://${host}:${addr.port}`;
        const auditNodeId =
          this.options.federationLeaseAuditNodeId ??
          this.options.federationNodeId ??
          "local";
        const auditKid = this.options.federationLeaseAuditKeyId ?? "default";
        const keyRing: Record<string, string> = {
          ...(this.options.federationLeaseAuditKeyRing ?? {}),
        };
        if (this.options.federationLeaseAuditSecret) {
          keyRing[auditKid] = this.options.federationLeaseAuditSecret;
        }
        if (Object.keys(keyRing).length > 0) {
          configureLeaseAuditKeyRing({
            keys: keyRing,
            activeKeyId: auditKid,
            nodeId: auditNodeId,
          });
          configureLeaseAuditSigning({
            secret: keyRing[auditKid]!,
            nodeId: auditNodeId,
            keyId: auditKid,
          });
        } else {
          configureLeaseAuditKeyRing(null);
          configureLeaseAuditSigning(null);
        }
        configureSkillDepPruneStrategyAuditStore(this.options.federationPath);
        this.startLeaseHeartbeatIfNeeded();
        resolve({ host, port: addr.port, url: this.baseUrl });
      });
    });
  }

  private startLeaseHeartbeatIfNeeded(): void {
    if (!this.options.federationLeaderLease || !this.options.federationNodeId) return;
    if (this.options.federationLeaseHeartbeat === false) return;
    this.leaseHeartbeatStop?.();
    const handle = startFederationLeaseHeartbeat({
      nodeId: this.options.federationNodeId,
      leaseMs: this.options.federationLeaseMs,
      intervalMs: this.options.federationLeaseHeartbeatMs,
      storePath: this.options.federationPath,
    });
    this.leaseHeartbeatStop = handle.stop;
  }

  async stop(): Promise<void> {
    if (this.leaseHeartbeatStop) {
      this.leaseHeartbeatStop();
      this.leaseHeartbeatStop = null;
    }
    for (const clients of this.sseClients.values()) {
      for (const res of clients) {
        res.end();
      }
    }
    this.sseClients.clear();
    await new Promise<void>((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = null;
    this.baseUrl = "";
  }

  async send(message: A2ATransportMessage): Promise<void> {
    if (!this.baseUrl) await this.start();
    const body = JSON.stringify({
      ...message,
      id: message.id || `a2a-msg-${this.nextId++}`,
      timestamp: message.timestamp || Date.now(),
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.clientToken) {
      headers.authorization = `Bearer ${this.options.clientToken}`;
    }
    if (this.useTls || this.options.clientTls) {
      await this.postSendTls(`${this.baseUrl}/a2a/send`, headers, body);
      return;
    }

    const res = await fetch(`${this.baseUrl}/a2a/send`, {
      method: "POST",
      headers,
      body,
    });
    if (!res.ok) {
      throw new Error(`A2A HTTP send failed: ${res.status}`);
    }
  }

  private postSendTls(url: string, headers: Record<string, string>, body: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      let reqOpts = {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname,
        method: "POST",
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
      };
      reqOpts = applyClientTlsToRequest(reqOpts, this.options.clientTls) as typeof reqOpts;
      const req = httpsRequest(reqOpts, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`A2A HTTP send failed: ${res.statusCode}`));
            return;
          }
          resolve();
        });
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  onMessage(agentId: AgentId, handler: MessageHandler): void {
    this.handlers.set(agentId, handler);
  }

  offMessage(agentId: AgentId): void {
    this.handlers.delete(agentId);
    const clients = this.sseClients.get(agentId);
    if (clients) {
      for (const res of clients) res.end();
      this.sseClients.delete(agentId);
    }
  }

  getMessageLog(): readonly A2ATransportMessage[] {
    return this.messageLog;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const host = req.headers.host ?? "127.0.0.1";
      const url = new URL(req.url ?? "/", `http://${host}`);

      if (req.method === "GET" && url.pathname === "/a2a/agents") {
        const cards = await this.listDiscoveredAgents();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ agents: cards }));
        return;
      }

      if (await handleA2AFederationHttpRoute(
        {
          opts: this.options,
          isAuthorized: (r) => this.isAuthorized(r),
          readBody,
        },
        req,
        res,
        url,
      )) {
        return;
      }


      if (req.method === "POST" && url.pathname === "/a2a/send") {
        if (!this.isAuthorized(req)) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        const raw = await readBody(req);
        const message = JSON.parse(raw) as A2ATransportMessage;
        await this.deliver(message);
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: message.id }));
        return;
      }

      const sseMatch = url.pathname.match(/^\/a2a\/agents\/([^/]+)\/events$/);
      if (req.method === "GET" && sseMatch) {
        const agentId = decodeURIComponent(sseMatch[1]!);
        this.attachSse(agentId, res);
        return;
      }

      res.writeHead(404);
      res.end("not found");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
  }

  private attachSse(agentId: string, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    let set = this.sseClients.get(agentId);
    if (!set) {
      set = new Set();
      this.sseClients.set(agentId, set);
    }
    set.add(res);
    reqOnClose(res, () => {
      set!.delete(res);
    });
  }

  private async listDiscoveredAgents(): Promise<A2AAgentCard[]> {
    const registry = this.options.registry;
    const local = registry?.getAll() ?? [];

    if (this.options.federationSyncUrls?.length) {
      await syncFederationFromPeers({
        peerUrls: this.options.federationSyncUrls,
        storePath: this.options.federationPath,
        enabled: this.options.federationPersist,
        conflictStrategy: this.options.federationConflictStrategy,
        bearerToken: this.options.clientToken,
        retries: this.options.federationSyncRetries,
        backupPath: this.options.federationBackupPath,
        nodeId: this.options.federationNodeId,
        quorumMin: this.options.federationQuorumMin,
        leaderElection: this.options.federationLeaderElection,
        leaderLease: this.options.federationLeaderLease,
        leaseMs: this.options.federationLeaseMs,
        leaseWitnessUrls: this.options.federationLeaseWitnessUrls,
        splitBrainAlert: this.options.federationSplitBrainAlert,
        leaseArbitration: this.options.federationLeaseArbitration,
        leaseAutoDowngrade: this.options.federationLeaseAutoDowngrade,
        leaseQuorumMin: this.options.federationLeaseQuorumMin,
        leaseWitnessBroadcast: this.options.federationLeaseWitnessBroadcast,
        skillQuorumMin: this.options.federationSkillQuorumMin,
        skillDepsBlockSync: this.options.federationSkillDepsBlockSync,
        skillDepsPruneSync: this.options.federationSkillDepsPruneSync,
        skillDepsPruneStrategy: this.options.federationSkillDepsPruneStrategy,
        tombstoneRetentionMs: this.options.federationTombstoneRetentionMs,
        skillTombstoneRetentionMs: this.options.federationSkillTombstoneRetentionMs,
      });
    }

    if (registry) {
      hydrateRegistryFromFederation(registry, {
        storePath: this.options.federationPath,
        enabled: this.options.federationPersist,
      });
    }

    const mergedLocal = registry?.getAll() ?? local;
    const urls = this.options.remoteDiscoveryUrls;
    if (!urls?.length) return mergedLocal;

    const ttl = this.options.remoteDiscoveryTtlMs ?? 30_000;
    const now = Date.now();
    if (this.remoteCache && now - this.remoteCache.at < ttl) {
      return this.mergeLocalRemote(mergedLocal, this.remoteCache.agents);
    }

    const { agents, errors } = await discoverAgentCards(mergedLocal, urls, {
      bearerToken: this.options.clientToken,
      clientTls: this.options.clientTls,
    });
    if (errors.length) {
      // keep partial results
    }
    const remoteOnly = agents.filter((a) => !mergedLocal.some((l) => l.agentId === a.agentId));
    if (registry && remoteOnly.length > 0) {
      mergeCardsIntoRegistry(registry, remoteOnly, "remote");
      mergeRemoteCardsIntoFederationStore(remoteOnly, {
        storePath: this.options.federationPath,
        enabled: this.options.federationPersist,
        conflictStrategy: this.options.federationConflictStrategy,
        nodeId: this.options.federationNodeId,
        skillDepsBlockSync: this.options.federationSkillDepsBlockSync,
        skillDepsPruneSync: this.options.federationSkillDepsPruneSync,
        skillDepsPruneStrategy: this.options.federationSkillDepsPruneStrategy,
      });
    }
    this.remoteCache = { at: now, agents: remoteOnly };
    return agents;
  }

  private mergeLocalRemote(local: A2AAgentCard[], remote: A2AAgentCard[]): A2AAgentCard[] {
    const byId = new Map(local.map((c) => [c.agentId, c]));
    for (const c of remote) {
      if (!byId.has(c.agentId)) byId.set(c.agentId, c);
    }
    return [...byId.values()];
  }

  private async deliver(message: A2ATransportMessage): Promise<void> {
    if (!message.id) message.id = `a2a-msg-${this.nextId++}`;
    if (!message.timestamp) message.timestamp = Date.now();
    this.messageLog.push(message);

    const handler = this.handlers.get(message.to);
    if (handler) {
      await handler(message);
    }

    const clients = this.sseClients.get(message.to);
    if (clients) {
      const payload = `data: ${JSON.stringify(message)}\n\n`;
      for (const res of clients) {
        res.write(payload);
      }
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function reqOnClose(res: ServerResponse, fn: () => void): void {
  res.on("close", fn);
}
