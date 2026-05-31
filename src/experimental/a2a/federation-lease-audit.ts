/**
 * P13 — Append-only lease witness audit chain (hash-linked events).
 */

import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getA2AFederationDir } from "../../core/paths.js";
import { stringifyFederationLogNdjsonEmptyMeta } from "./federation-ndjson-meta.js";

let leaseAuditSigning: { secret: string; nodeId: string; keyId?: string } | null = null;

/** Optional process-wide audit HMAC signing (e.g. from HTTP transport config). */
export function configureLeaseAuditSigning(
  options: { secret: string; nodeId: string; keyId?: string } | null,
): void {
  leaseAuditSigning = options;
}

export type LeaseAuditEventType =
  | "witness"
  | "acquire"
  | "renew"
  | "release"
  | "quorum_ok"
  | "quorum_fail"
  | "downgrade"
  | "key_rotate"
  | "skill_prune_strategy"
  | "skill_prune_strategy_rollback";

const LEASE_AUDIT_EVENT_TYPES: LeaseAuditEventType[] = [
  "witness",
  "acquire",
  "renew",
  "release",
  "quorum_ok",
  "quorum_fail",
  "downgrade",
  "key_rotate",
  "skill_prune_strategy",
  "skill_prune_strategy_rollback",
];

/** P22: validate ?type= query for audit log API. */
export function parseLeaseAuditEventType(
  raw: string | null | undefined,
): LeaseAuditEventType | undefined {
  if (!raw) return undefined;
  return LEASE_AUDIT_EVENT_TYPES.includes(raw as LeaseAuditEventType)
    ? (raw as LeaseAuditEventType)
    : undefined;
}

/** P23: comma-separated ?type=acquire,skill_prune_strategy (OR filter). */
export function parseLeaseAuditEventTypes(
  raw: string | null | undefined,
): LeaseAuditEventType[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return undefined;
  const out: LeaseAuditEventType[] = [];
  for (const part of parts) {
    const t = parseLeaseAuditEventType(part);
    if (!t) return undefined;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

export type LeaseAuditEvent = {
  seq: number;
  at: string;
  type: LeaseAuditEventType;
  nodeId: string;
  holderNodeId?: string;
  term?: number;
  detail?: string;
  prevHash: string;
  hash: string;
};

export type LeaseAuditSeal = {
  headHash: string;
  signature: string;
  signerNodeId: string;
  signedAt: string;
  /** P15: key id used for HMAC (supports rotation). */
  keyId?: string;
};

export type LeaseAuditChain = {
  version: 1;
  updatedAt: string;
  events: LeaseAuditEvent[];
  /** P14: HMAC seal over chain head (optional). */
  seal?: LeaseAuditSeal;
};

export function federationLeaseAuditPath(storePath?: string): string {
  const base = storePath
    ? storePath.endsWith(".json")
      ? dirname(storePath)
      : storePath
    : getA2AFederationDir();
  return join(base, "lease-audit-chain.json");
}

export function readLeaseAuditChain(storePath?: string): LeaseAuditChain {
  const path = federationLeaseAuditPath(storePath);
  if (!existsSync(path)) {
    return { version: 1, updatedAt: new Date(0).toISOString(), events: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as LeaseAuditChain;
    if (raw.version !== 1 || !Array.isArray(raw.events)) {
      return { version: 1, updatedAt: new Date(0).toISOString(), events: [] };
    }
    return raw;
  } catch {
    return { version: 1, updatedAt: new Date(0).toISOString(), events: [] };
  }
}

function hashEvent(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function verifyLeaseAuditChain(chain: LeaseAuditChain): boolean {
  let prev = "";
  for (const ev of chain.events) {
    if (ev.prevHash !== prev) return false;
    const expected = hashEvent({
      seq: ev.seq,
      at: ev.at,
      type: ev.type,
      nodeId: ev.nodeId,
      holderNodeId: ev.holderNodeId,
      term: ev.term,
      detail: ev.detail,
      prevHash: ev.prevHash,
    });
    if (ev.hash !== expected) return false;
    prev = ev.hash;
  }
  return true;
}

/** Append a hash-linked audit event. */
export function appendLeaseAuditEvent(options: {
  type: LeaseAuditEventType;
  nodeId: string;
  holderNodeId?: string;
  term?: number;
  detail?: string;
  storePath?: string;
  maxEvents?: number;
  auditSecret?: string;
  auditNodeId?: string;
  auditKeyId?: string;
}): LeaseAuditEvent {
  const chain = readLeaseAuditChain(options.storePath);
  const prevHash = chain.events.length ? chain.events[chain.events.length - 1]!.hash : "";
  const seq = chain.events.length + 1;
  const at = new Date().toISOString();
  const body = {
    seq,
    at,
    type: options.type,
    nodeId: options.nodeId,
    holderNodeId: options.holderNodeId,
    term: options.term,
    detail: options.detail,
    prevHash,
  };
  const ev: LeaseAuditEvent = { ...body, hash: hashEvent(body) };
  chain.events.push(ev);
  delete chain.seal;
  const max = options.maxEvents ?? 500;
  if (chain.events.length > max) chain.events = chain.events.slice(-max);
  chain.updatedAt = at;
  const path = federationLeaseAuditPath(options.storePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(chain, null, 2), "utf-8");
  const secret = options.auditSecret ?? leaseAuditSigning?.secret;
  const nodeId = options.auditNodeId ?? leaseAuditSigning?.nodeId;
  if (secret && nodeId) {
    sealLeaseAuditChain({
      nodeId,
      secret,
      storePath: options.storePath,
      keyId: options.auditKeyId ?? leaseAuditSigning?.keyId,
    });
  }
  return ev;
}

export function buildLeaseAuditChainBody(chain: LeaseAuditChain): LeaseAuditChain {
  return chain;
}

/** P18: tail of audit chain for GET /lease/audit/log?limit=N */
/** P20: export audit log tail as JSON array wrapper or NDJSON events. */
export function exportLeaseAuditLog(
  chain: LeaseAuditChain,
  options?: LeaseAuditLogFilterOptions,
  format: "json" | "ndjson" = "json",
): string {
  const events = applyLeaseAuditLogFilters(chain, options);
  const totalEvents = events.length;
  const limit = options?.limit;
  const out =
    limit && limit > 0 && totalEvents > limit ? events.slice(-limit) : events;
  const emptyFields = leaseAuditEmptyResponseFields(chain, options, events);
  if (format === "ndjson") {
    const lines = out.map((ev) => JSON.stringify(ev));
    if (emptyFields && out.length === 0) {
      lines.unshift(
        stringifyFederationLogNdjsonEmptyMeta({
          version: chain.version,
          updatedAt: chain.updatedAt,
          totalCount: 0,
          truncated: false,
          emptyHint: emptyFields.emptyHint,
          emptyHintCode: emptyFields.emptyHintCode,
        }),
      );
    }
    return lines.join("\n") + (lines.length ? "\n" : "");
  }
  return JSON.stringify(
    {
      version: chain.version,
      updatedAt: chain.updatedAt,
      events: out,
      totalEvents,
      truncated: out.length < totalEvents,
      ...emptyFields,
    },
    null,
    2,
  );
}

/** P22: filter audit events by type. */
export function filterLeaseAuditEventsByType(
  chain: LeaseAuditChain,
  type: LeaseAuditEventType,
): LeaseAuditEvent[] {
  return filterLeaseAuditEventsByTypes(chain, [type]);
}

/** P23: filter audit events matching any of the given types. */
export function filterLeaseAuditEventsByTypes(
  chain: LeaseAuditChain,
  types: LeaseAuditEventType[],
): LeaseAuditEvent[] {
  const allowed = new Set(types);
  return chain.events.filter((ev) => allowed.has(ev.type));
}

/** P24: drop events whose type is in the exclude list. */
export function filterLeaseAuditEventsExcludingTypes(
  chain: LeaseAuditChain,
  exclude: LeaseAuditEventType[],
): LeaseAuditEvent[] {
  const blocked = new Set(exclude);
  return chain.events.filter((ev) => !blocked.has(ev.type));
}

export type LeaseAuditLogFilterOptions = {
  limit?: number;
  types?: LeaseAuditEventType[];
  excludeTypes?: LeaseAuditEventType[];
};

/** P25: reject overlapping include/exclude type filters. */
export function validateLeaseAuditLogFilterOptions(
  options?: LeaseAuditLogFilterOptions,
): { ok: true } | { ok: false; reason: string } {
  const types = options?.types ?? [];
  const exclude = options?.excludeTypes ?? [];
  if (!types.length || !exclude.length) return { ok: true };
  const blocked = new Set(exclude);
  const overlap = types.filter((t) => blocked.has(t));
  if (!overlap.length) return { ok: true };
  return { ok: false, reason: `type and exclude overlap: ${overlap.join(",")}` };
}

export type LeaseAuditEmptyHintCode = "audit_chain_empty" | "no_events_match_filter";

/** P26/P29: hint when type/exclude filters yield zero events. */
export function leaseAuditLogEmptyHint(
  chain: LeaseAuditChain,
  options: LeaseAuditLogFilterOptions | undefined,
  events: LeaseAuditEvent[],
): { hint: string; code: LeaseAuditEmptyHintCode } | undefined {
  if (events.length > 0) return undefined;
  if (!options?.types?.length && !options?.excludeTypes?.length) {
    return chain.events.length === 0
      ? { hint: "audit chain empty", code: "audit_chain_empty" }
      : undefined;
  }
  if (chain.events.length === 0) {
    return { hint: "audit chain empty", code: "audit_chain_empty" };
  }
  return { hint: "no events match filter", code: "no_events_match_filter" };
}

function leaseAuditEmptyResponseFields(
  chain: LeaseAuditChain,
  options: LeaseAuditLogFilterOptions | undefined,
  events: LeaseAuditEvent[],
): { filteredEmpty: true; emptyHint: string; emptyHintCode: LeaseAuditEmptyHintCode } | undefined {
  const empty = leaseAuditLogEmptyHint(chain, options, events);
  if (!empty) return undefined;
  return { filteredEmpty: true, emptyHint: empty.hint, emptyHintCode: empty.code };
}

function applyLeaseAuditLogFilters(
  chain: LeaseAuditChain,
  options?: LeaseAuditLogFilterOptions,
): LeaseAuditEvent[] {
  let events = chain.events;
  if (options?.types?.length) {
    events = filterLeaseAuditEventsByTypes({ ...chain, events }, options.types);
  }
  if (options?.excludeTypes?.length) {
    const blocked = new Set(options.excludeTypes);
    events = events.filter((ev) => !blocked.has(ev.type));
  }
  return events;
}

export function buildLeaseAuditLogBody(
  chain: LeaseAuditChain,
  options?: LeaseAuditLogFilterOptions,
): LeaseAuditChain & {
  totalEvents: number;
  truncated: boolean;
  typeFilter?: string;
  excludeFilter?: string;
  filteredEmpty?: boolean;
  emptyHint?: string;
  emptyHintCode?: LeaseAuditEmptyHintCode;
} {
  const events = applyLeaseAuditLogFilters(chain, options);
  const totalEvents = events.length;
  const limit = options?.limit;
  const emptyFields = leaseAuditEmptyResponseFields(chain, options, events);
  const base = {
    totalEvents,
    ...(options?.types?.length ? { typeFilter: options.types.join(",") } : {}),
    ...(options?.excludeTypes?.length
      ? { excludeFilter: options.excludeTypes.join(",") }
      : {}),
    ...emptyFields,
  };
  if (!limit || limit <= 0 || totalEvents <= limit) {
    return { ...chain, events, ...base, truncated: false };
  }
  return {
    ...chain,
    events: events.slice(-limit),
    ...base,
    truncated: true,
  };
}

export function computeLeaseAuditHeadHash(chain: LeaseAuditChain): string {
  const last = chain.events[chain.events.length - 1];
  return last?.hash ?? "";
}

export function signLeaseAuditHead(headHash: string, secret: string): string {
  return createHmac("sha256", secret).update(headHash).digest("hex");
}

export function verifyLeaseAuditSeal(
  chain: LeaseAuditChain,
  secret: string | Record<string, string>,
): boolean {
  if (!chain.seal) return false;
  const head = computeLeaseAuditHeadHash(chain);
  if (chain.seal.headHash !== head) return false;
  if (typeof secret === "string") {
    return chain.seal.signature === signLeaseAuditHead(head, secret);
  }
  const kid = chain.seal.keyId ?? "default";
  const keySecret = secret[kid];
  if (!keySecret) return false;
  return chain.seal.signature === signLeaseAuditHead(head, keySecret);
}

/** Persist HMAC seal on chain head (cleared on next append). */
export function sealLeaseAuditChain(options: {
  nodeId: string;
  secret: string;
  storePath?: string;
  keyId?: string;
}): LeaseAuditSeal | null {
  const chain = readLeaseAuditChain(options.storePath);
  const headHash = computeLeaseAuditHeadHash(chain);
  if (!headHash) return null;
  const seal: LeaseAuditSeal = {
    headHash,
    signature: signLeaseAuditHead(headHash, options.secret),
    signerNodeId: options.nodeId,
    signedAt: new Date().toISOString(),
    keyId: options.keyId ?? leaseAuditSigning?.keyId ?? "default",
  };
  chain.seal = seal;
  chain.updatedAt = seal.signedAt;
  const path = federationLeaseAuditPath(options.storePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(chain, null, 2), "utf-8");
  return seal;
}

export function exportLeaseAuditChain(
  chain: LeaseAuditChain,
  format: "json" | "ndjson" = "json",
): string {
  if (format === "ndjson") {
    return chain.events.map((ev) => JSON.stringify(ev)).join("\n") + (chain.events.length ? "\n" : "");
  }
  return JSON.stringify(chain, null, 2);
}
