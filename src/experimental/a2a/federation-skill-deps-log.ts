/**
 * P17 — Persist skill dependency prune log + sync receipts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getA2AFederationDir } from "../../core/paths.js";
import {
  parseSkillDepRef,
  type SkillDepPruneEntry,
  type SkillDepPruneStrategy,
} from "./federation-skill-deps.js";
import { stringifyFederationLogNdjsonEmptyMeta } from "./federation-ndjson-meta.js";

export type SkillDepsPruneLogSource = "sync" | "merge";

export type SkillDepsPruneLogEntry = {
  receiptId: string;
  at: string;
  source: SkillDepsPruneLogSource;
  strategy?: SkillDepPruneStrategy;
  pruned: SkillDepPruneEntry[];
};

export type SkillDepsPruneLog = {
  version: 1;
  updatedAt: string;
  entries: SkillDepsPruneLogEntry[];
};

export type SkillDepsPruneReceipt = {
  receiptId: string;
  at: string;
  prunedCount: number;
  logPath: string;
};

export function federationSkillDepsPruneLogPath(storePath?: string): string {
  const base = storePath
    ? storePath.endsWith(".json")
      ? dirname(storePath)
      : storePath
    : getA2AFederationDir();
  return join(base, "skill-deps-prune-log.json");
}

export function readSkillDepsPruneLog(storePath?: string): SkillDepsPruneLog {
  const path = federationSkillDepsPruneLogPath(storePath);
  if (!existsSync(path)) {
    return { version: 1, updatedAt: new Date(0).toISOString(), entries: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as SkillDepsPruneLog;
    if (raw.version !== 1 || !Array.isArray(raw.entries)) {
      return { version: 1, updatedAt: new Date(0).toISOString(), entries: [] };
    }
    return raw;
  } catch {
    return { version: 1, updatedAt: new Date(0).toISOString(), entries: [] };
  }
}

/** Append prune entries and return receipt for sync/merge callers. */
export function appendSkillDepsPruneLog(options: {
  source: SkillDepsPruneLogSource;
  pruned: SkillDepPruneEntry[];
  strategy?: SkillDepPruneStrategy;
  storePath?: string;
  maxEntries?: number;
}): SkillDepsPruneReceipt | null {
  if (!options.pruned.length) return null;
  const path = federationSkillDepsPruneLogPath(options.storePath);
  const log = readSkillDepsPruneLog(options.storePath);
  const at = new Date().toISOString();
  const receiptId = `sdp-${options.source}-${Date.now()}`;
  log.entries.push({
    receiptId,
    at,
    source: options.source,
    strategy: options.strategy,
    pruned: options.pruned,
  });
  const max = options.maxEntries ?? 200;
  if (log.entries.length > max) log.entries = log.entries.slice(-max);
  log.updatedAt = at;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(log, null, 2), "utf-8");
  return { receiptId, at, prunedCount: options.pruned.length, logPath: path };
}

function pruneEntryTouchesAgent(entry: SkillDepPruneEntry, agentId: string): boolean {
  const dep = parseSkillDepRef(entry.dependent);
  const rem = parseSkillDepRef(entry.removedDep);
  return dep?.agentId === agentId || rem?.agentId === agentId;
}

/** P21: find a single prune log entry by receipt id. */
export function findSkillDepsPruneLogEntry(
  log: SkillDepsPruneLog,
  receiptId: string,
): SkillDepsPruneLogEntry | undefined {
  return log.entries.find((e) => e.receiptId === receiptId);
}

/** P21: filter log to one receipt (empty entries if not found). */
export function filterSkillDepsPruneLogByReceipt(
  log: SkillDepsPruneLog,
  receiptId: string,
): SkillDepsPruneLog {
  const entry = findSkillDepsPruneLogEntry(log, receiptId);
  return { ...log, entries: entry ? [entry] : [] };
}

/** P19: filter log entries to those touching agentId (dependent or removed dep). */
export function filterSkillDepsPruneLogByAgent(
  log: SkillDepsPruneLog,
  agentId: string,
): SkillDepsPruneLog {
  const entries = log.entries
    .map((e) => ({
      ...e,
      pruned: e.pruned.filter((p) => pruneEntryTouchesAgent(p, agentId)),
    }))
    .filter((e) => e.pruned.length > 0);
  return { ...log, entries };
}

export type SkillDepsPruneLogNdjsonMeta = {
  filteredEmpty: boolean;
  emptyHint: string;
  emptyHintCode: SkillDepsPruneEmptyHintCode;
  totalEntries: number;
  truncated: boolean;
  receiptNotFound?: boolean;
};

export type SkillDepsPruneEmptyHintCode =
  | "prune_log_empty"
  | "receipt_not_found"
  | "no_prune_entries_for_agent"
  | "no_pruned_edges_match_filter";

/** P27/P28: hint when prune-log filters yield zero entries. */
export function skillDepsPruneLogEmptyHint(
  log: SkillDepsPruneLog,
  options: { agentId?: string; receiptId?: string } | undefined,
  entries: SkillDepsPruneLogEntry[],
): { hint: string; code: SkillDepsPruneEmptyHintCode } | undefined {
  if (entries.length > 0) return undefined;
  const filtered = !!(options?.agentId || options?.receiptId);
  if (!filtered) {
    return log.entries.length === 0
      ? { hint: "prune log empty", code: "prune_log_empty" }
      : undefined;
  }
  if (options?.receiptId && !findSkillDepsPruneLogEntry(log, options.receiptId)) {
    return { hint: "receipt not found", code: "receipt_not_found" };
  }
  if (options?.receiptId && options?.agentId) {
    return { hint: "no pruned edges match filter", code: "no_pruned_edges_match_filter" };
  }
  if (options?.receiptId) {
    return { hint: "receipt not found", code: "receipt_not_found" };
  }
  if (options?.agentId) {
    return log.entries.length === 0
      ? { hint: "prune log empty", code: "prune_log_empty" }
      : { hint: "no prune entries for agent", code: "no_prune_entries_for_agent" };
  }
  return { hint: "no entries match filter", code: "no_pruned_edges_match_filter" };
}

/** P20: export prune log as JSON or NDJSON (one entry per line). */
/** P31/P32: NDJSON empty filter emits shared federation-log-empty-v1 _meta line. */
export function exportSkillDepsPruneLog(
  log: SkillDepsPruneLog,
  format: "json" | "ndjson" = "json",
  emptyMeta?: SkillDepsPruneLogNdjsonMeta,
): string {
  if (format === "ndjson") {
    const lines = log.entries.map((entry) => JSON.stringify(entry));
    if (emptyMeta?.filteredEmpty && log.entries.length === 0) {
      lines.unshift(
        stringifyFederationLogNdjsonEmptyMeta({
          version: log.version,
          updatedAt: log.updatedAt,
          totalCount: emptyMeta.totalEntries,
          truncated: emptyMeta.truncated,
          emptyHint: emptyMeta.emptyHint,
          emptyHintCode: emptyMeta.emptyHintCode,
          ...(emptyMeta.receiptNotFound ? { receiptNotFound: true } : {}),
        }),
      );
    }
    return lines.join("\n") + (lines.length ? "\n" : "");
  }
  return JSON.stringify(log, null, 2);
}

export function buildSkillDepsPruneLogBody(
  log: SkillDepsPruneLog,
  options?: { limit?: number; agentId?: string; receiptId?: string },
): SkillDepsPruneLog & {
  totalEntries: number;
  truncated: boolean;
  agentFilter?: string;
  receiptFilter?: string;
  receiptFound?: boolean;
  filteredEmpty?: boolean;
  emptyHint?: string;
  emptyHintCode?: SkillDepsPruneEmptyHintCode;
  receiptNotFound?: boolean;
} {
  let working = log;
  if (options?.receiptId) {
    working = filterSkillDepsPruneLogByReceipt(working, options.receiptId);
  }
  if (options?.agentId) {
    working = filterSkillDepsPruneLogByAgent(working, options.agentId);
  }
  const totalEntries = working.entries.length;
  const limit = options?.limit;
  const empty = skillDepsPruneLogEmptyHint(log, options, working.entries);
  const base = {
    totalEntries,
    ...(options?.agentId ? { agentFilter: options.agentId } : {}),
    ...(options?.receiptId
      ? {
          receiptFilter: options.receiptId,
          receiptFound: !!findSkillDepsPruneLogEntry(log, options.receiptId),
        }
      : {}),
    ...(empty
      ? {
          filteredEmpty: true,
          emptyHint: empty.hint,
          emptyHintCode: empty.code,
          ...(empty.code === "receipt_not_found" ? { receiptNotFound: true } : {}),
        }
      : {}),
  };
  if (!limit || limit <= 0 || totalEntries <= limit) {
    return { ...working, ...base, truncated: false };
  }
  return {
    ...working,
    entries: working.entries.slice(-limit),
    ...base,
    truncated: true,
  };
}
