/**
 * Federation HTTP routes for A2A transport (split from http-transport.ts).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpA2ATransportOptions } from "./http-transport-options.js";
import {
  buildFederationDirectoryBody,
  mergeRemoteCardsIntoFederationStore,
  parseFederationDirectoryBody,
} from "./federation-sync.js";
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
import { loadFederatedAgentCards } from "./federated-registry-store.js";

export type FederationRouteContext = {
  opts: HttpA2ATransportOptions;
  isAuthorized: (req: IncomingMessage) => boolean;
  readBody: (req: IncomingMessage) => Promise<string>;
};

/** @returns true if the request was handled. */
export async function handleA2AFederationHttpRoute(
  ctx: FederationRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const { opts, isAuthorized, readBody } = ctx;

        if (url.pathname === "/a2a/federation/lease/witness" && req.method === "POST") {
          if (!isAuthorized(req)) {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "unauthorized" }));
            return true;
          }
          const raw = await readBody(req);
          const entry = parseLeaseWitnessPostBody(JSON.parse(raw));
          if (!entry) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "invalid witness entry" }));
            return true;
          }
          const receipt = recordRemoteLeaseWitness(entry, opts.federationPath);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(receipt));
          return true;
        }

        if (url.pathname === "/a2a/federation/lease/witnesses") {
          if (req.method === "GET") {
            if (!isAuthorized(req)) {
              res.writeHead(401, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "unauthorized" }));
              return true;
            }
            const log = readLeaseWriteWitnessLog(opts.federationPath);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(buildLeaseWitnessLogBody(log)));
            return true;
          }
        }

        if (url.pathname === "/a2a/federation/lease/audit/export") {
          if (req.method === "GET") {
            if (!isAuthorized(req)) {
              res.writeHead(401, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "unauthorized" }));
              return true;
            }
            const chain = readLeaseAuditChain(opts.federationPath);
            const format = url.searchParams.get("format") ?? "json";
            if (format === "bundle" || format === "manifest") {
              const keyRing = readLeaseAuditKeyRing(opts.federationPath);
              const auditKid = opts.federationLeaseAuditKeyId ?? keyRing.activeKeyId;
              const secrets: Record<string, string> = {
                ...(opts.federationLeaseAuditKeyRing ?? {}),
              };
              if (opts.federationLeaseAuditSecret) {
                secrets[auditKid] = opts.federationLeaseAuditSecret;
              }
              const secret = secrets[keyRing.activeKeyId] ?? opts.federationLeaseAuditSecret;
              const bundle = exportLeaseAuditSignedBundle(chain, {
                keyRing,
                secret,
                keyId: keyRing.activeKeyId,
              });
              const body = serializeLeaseAuditSignedBundle(bundle);
              res.writeHead(200, {
                "content-type": "application/json",
                "content-disposition": 'attachment; filename="lease-audit-bundle.json"',
              });
              res.end(body);
              return true;
            }
            const exportFmt = format === "ndjson" ? "ndjson" : "json";
            const body = exportLeaseAuditChain(chain, exportFmt);
            const contentType =
              exportFmt === "ndjson" ? "application/x-ndjson" : "application/json";
            res.writeHead(200, {
              "content-type": contentType,
              "content-disposition": `attachment; filename="lease-audit.${exportFmt === "ndjson" ? "ndjson" : "json"}"`,
            });
            res.end(body);
            return true;
          }
        }

        if (url.pathname === "/a2a/federation/lease/audit/keyring") {
          if (req.method === "GET") {
            if (!isAuthorized(req)) {
              res.writeHead(401, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "unauthorized" }));
              return true;
            }
            const ring = readLeaseAuditKeyRing(opts.federationPath);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(buildLeaseAuditKeyRingBody(ring)));
            return true;
          }
        }

        if (url.pathname === "/a2a/federation/lease/audit/rotate") {
          if (req.method === "POST") {
            if (!isAuthorized(req)) {
              res.writeHead(401, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "unauthorized" }));
              return true;
            }
            const raw = await readBody(req);
            const body = parseLeaseAuditRotateBody(JSON.parse(raw));
            if (!body) {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "invalid rotate body" }));
              return true;
            }
            const result = rotateLeaseAuditSigningKey({
              nodeId:
                opts.federationLeaseAuditNodeId ??
                opts.federationNodeId ??
                "local",
              keyId: body.keyId,
              secret: body.secret,
              storePath: opts.federationPath,
            });
            configureLeaseAuditSigning({
              secret: body.secret,
              nodeId:
                opts.federationLeaseAuditNodeId ??
                opts.federationNodeId ??
                "local",
              keyId: body.keyId,
            });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                ok: true,
                keyRing: buildLeaseAuditKeyRingBody(result.keyRing),
                seal: result.seal,
              }),
            );
            return true;
          }
        }

        if (url.pathname === "/a2a/federation/lease/audit/log") {
          if (req.method === "GET") {
            if (!isAuthorized(req)) {
              res.writeHead(401, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "unauthorized" }));
              return true;
            }
            const chain = readLeaseAuditChain(opts.federationPath);
            const limitRaw = url.searchParams.get("limit");
            const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
            const limitOpt = Number.isFinite(limit) ? limit : undefined;
            const format = url.searchParams.get("format") ?? "json";
            const typeRaw = url.searchParams.get("type") ?? undefined;
            const typeFilters = parseLeaseAuditEventTypes(typeRaw);
            const excludeRaw = url.searchParams.get("exclude") ?? undefined;
            const excludeFilters = parseLeaseAuditEventTypes(excludeRaw);
            if ((typeRaw && !typeFilters) || (excludeRaw && !excludeFilters)) {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "invalid audit event type" }));
              return true;
            }
            const auditLogOpts = {
              limit: limitOpt,
              types: typeFilters,
              excludeTypes: excludeFilters,
            };
            const filterCheck = validateLeaseAuditLogFilterOptions(auditLogOpts);
            if (!filterCheck.ok) {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: filterCheck.reason }));
              return true;
            }
            if (format === "ndjson") {
              const body = exportLeaseAuditLog(chain, auditLogOpts, "ndjson");
              res.writeHead(200, {
                "content-type": "application/x-ndjson",
                "content-disposition": 'attachment; filename="lease-audit-log.ndjson"',
              });
              res.end(body);
              return true;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify(
                buildLeaseAuditLogBody(chain, auditLogOpts),
              ),
            );
            return true;
          }
        }

        if (url.pathname === "/a2a/federation/skill-deps/prune-strategy/rollback") {
          if (req.method === "POST") {
            if (!isAuthorized(req)) {
              res.writeHead(401, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "unauthorized" }));
              return true;
            }
            const raw = await readBody(req);
            const body = JSON.parse(raw) as { enable?: boolean; agentId?: string };
            const priorMode = isSkillDepPruneStrategyRollbackEnabled();
            if (typeof body.enable === "boolean") {
              configureSkillDepPruneStrategyRollback(body.enable);
            }
            let applied:
              | { ok: boolean; strategy?: string; reason?: string; reasonCode?: string }
              | undefined;
            if (body.agentId) {
              applied = applySkillDepPruneStrategyRollbackForAgent({
                agentId: body.agentId,
                storePath: opts.federationPath,
              });
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                ok: applied === undefined || applied.ok,
                priorMode,
                rollbackMode: isSkillDepPruneStrategyRollbackEnabled(),
                ...(applied !== undefined ? { applied } : {}),
              }),
            );
            return true;
          }
        }

        if (url.pathname === "/a2a/federation/skill-deps/prune-log") {
          if (req.method === "GET") {
            if (!isAuthorized(req)) {
              res.writeHead(401, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "unauthorized" }));
              return true;
            }
            const log = readSkillDepsPruneLog(opts.federationPath);
            const limitRaw = url.searchParams.get("limit");
            const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
            const agentId = url.searchParams.get("agentId") ?? undefined;
            const receiptId = url.searchParams.get("receiptId") ?? undefined;
            const limitOpt = Number.isFinite(limit) ? limit : undefined;
            const format = url.searchParams.get("format") ?? "json";
            const filtered = buildSkillDepsPruneLogBody(log, {
              limit: limitOpt,
              agentId: agentId || undefined,
              receiptId: receiptId || undefined,
            });
            if (format === "ndjson") {
              const body = exportSkillDepsPruneLog(
                {
                  version: filtered.version,
                  updatedAt: filtered.updatedAt,
                  entries: filtered.entries,
                },
                "ndjson",
                filtered.filteredEmpty && filtered.emptyHint && filtered.emptyHintCode
                  ? {
                      filteredEmpty: true,
                      emptyHint: filtered.emptyHint,
                      emptyHintCode: filtered.emptyHintCode,
                      totalEntries: filtered.totalEntries,
                      truncated: filtered.truncated,
                      ...(filtered.receiptNotFound ? { receiptNotFound: true } : {}),
                    }
                  : undefined,
              );
              res.writeHead(200, {
                "content-type": "application/x-ndjson",
                "content-disposition": 'attachment; filename="skill-deps-prune-log.ndjson"',
              });
              res.end(body);
              return true;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(filtered));
            return true;
          }
        }

        if (url.pathname === "/a2a/federation/lease/audit") {
          if (req.method === "GET") {
            if (!isAuthorized(req)) {
              res.writeHead(401, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "unauthorized" }));
              return true;
            }
            const chain = readLeaseAuditChain(opts.federationPath);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(buildLeaseAuditChainBody(chain)));
            return true;
          }
        }

        if (url.pathname === "/a2a/federation/lease") {
          if (req.method === "GET") {
            if (!isAuthorized(req)) {
              res.writeHead(401, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "unauthorized" }));
              return true;
            }
            const lease = readFederationLease(federationLeasePath(opts.federationPath));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(buildFederationLeaseBody(lease)));
            return true;
          }
        }

        if (url.pathname === "/a2a/federation/directory") {
          if (req.method === "GET") {
            if (!isAuthorized(req)) {
              res.writeHead(401, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "unauthorized" }));
              return true;
            }
            const agents = loadFederatedAgentCards(opts.federationPath);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(buildFederationDirectoryBody(agents)));
            return true;
          }
          if (req.method === "POST" && isAuthorized(req)) {
            const raw = await readBody(req);
            const incoming = parseFederationDirectoryBody(JSON.parse(raw));
            const added = mergeRemoteCardsIntoFederationStore(incoming, {
              storePath: opts.federationPath,
              enabled: opts.federationPersist,
              conflictStrategy: opts.federationConflictStrategy,
              nodeId: opts.federationNodeId,
            });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, added }));
            return true;
          }
        }

  return false;
}
