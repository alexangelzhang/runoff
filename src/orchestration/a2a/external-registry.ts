/**
 * Phase 7.9 — Fetch agent cards from external A2A discovery endpoints.
 */

import http from "node:http";
import https from "node:https";
import type { A2AAgentCard, AgentCardRegistry } from "./agent-card.js";
import { agentId } from "../multi-agent-types.js";
import {
  applyClientTlsToRequest,
  type A2AClientTlsConfig,
} from "./tls-config.js";

export interface RemoteDiscoveryOptions {
  bearerToken?: string;
  clientTls?: A2AClientTlsConfig;
  timeoutMs?: number;
}

interface DiscoveryResponse {
  agents?: A2AAgentCard[];
}

function normalizeCard(raw: A2AAgentCard): A2AAgentCard | null {
  if (!raw?.agentId && !raw?.name) return null;
  const id = raw.agentId ?? agentId(raw.name);
  return {
    ...raw,
    agentId: id,
    name: raw.name ?? String(id),
    description: raw.description ?? "",
    role: raw.role ?? "worker",
    capabilities: raw.capabilities ?? ["implement"],
    skills: raw.skills ?? [],
    protocolVersion: raw.protocolVersion ?? "0.1",
  };
}

function fetchDiscoveryJson(
  url: string,
  options: RemoteDiscoveryOptions = {},
): Promise<DiscoveryResponse> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.bearerToken) {
      headers.authorization = `Bearer ${options.bearerToken}`;
    }

    let reqOpts: https.RequestOptions = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      headers,
      timeout: timeoutMs,
    };
    reqOpts = applyClientTlsToRequest(reqOpts, options.clientTls);

    const mod = isHttps ? https : http;
    const req = mod.request(reqOpts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`Discovery ${url} failed: HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body) as DiscoveryResponse);
        } catch (err: unknown) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Discovery ${url} timed out`));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Fetch agent cards from a remote `GET {url}` returning `{ agents: [...] }`. */
export async function fetchRemoteAgentCards(
  discoveryUrl: string,
  options: RemoteDiscoveryOptions = {},
): Promise<A2AAgentCard[]> {
  const body = await fetchDiscoveryJson(discoveryUrl, options);
  const agents = body.agents ?? [];
  const out: A2AAgentCard[] = [];
  for (const raw of agents) {
    const card = normalizeCard(raw);
    if (card) out.push(card);
  }
  return out;
}

/**
 * Merge remote discovery into a local registry (remote cards do not overwrite local ids).
 */
export async function mergeRemoteDiscoveryIntoRegistry(
  registry: AgentCardRegistry,
  discoveryUrls: string[],
  options: RemoteDiscoveryOptions = {},
): Promise<{ merged: number; errors: string[] }> {
  let merged = 0;
  const errors: string[] = [];

  for (const url of discoveryUrls) {
    try {
      const cards = await fetchRemoteAgentCards(url, options);
      for (const card of cards) {
        if (registry.get(card.agentId)) continue;
        registry.register(card);
        merged++;
      }
    } catch (err: unknown) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { merged, errors };
}

/** List local + remote cards without mutating registry. */
export async function discoverAgentCards(
  local: A2AAgentCard[],
  discoveryUrls: string[],
  options: RemoteDiscoveryOptions = {},
): Promise<{ agents: A2AAgentCard[]; errors: string[] }> {
  const byId = new Map<string, A2AAgentCard>();
  for (const card of local) byId.set(card.agentId, card);

  const errors: string[] = [];
  for (const url of discoveryUrls) {
    try {
      const remote = await fetchRemoteAgentCards(url, options);
      for (const card of remote) {
        if (!byId.has(card.agentId)) byId.set(card.agentId, card);
      }
    } catch (err: unknown) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { agents: [...byId.values()], errors };
}
