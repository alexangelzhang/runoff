/**
 * Phase 8.1.2 — Memory compression/merge.
 * Merges entries with the same category and similar content (token Jaccard).
 */

import type { MemoryEntry } from "./memory.js";

export interface MemoryMergeOptions {
  /** Minimum Jaccard similarity (0–1). Default 0.85. */
  minSimilarity?: number;
  /** Only merge within the same category. Default true. */
  sameCategoryOnly?: boolean;
  /** Only merge within the same agentId. Default true. */
  sameAgentOnly?: boolean;
}

export interface MemoryMergeResult {
  entries: MemoryEntry[];
  mergedCount: number;
  removedIds: string[];
}

const DEFAULT_MIN_SIMILARITY = 0.85;

/** Tokenize text for similarity (lowercase alphanumeric tokens). */
export function tokenizeForSimilarity(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9_]{2,}/g);
  return tokens ?? [];
}

/** Jaccard similarity on token sets (0–1). */
export function contentSimilarity(a: string, b: string): number {
  const setA = new Set(tokenizeForSimilarity(a));
  const setB = new Set(tokenizeForSimilarity(b));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function scopeKey(scope: MemoryEntry["scope"]): string {
  return `${scope.tenant ?? ""}|${scope.project ?? ""}|${scope.repo ?? ""}|${scope.user ?? ""}`;
}

function pickKeeper(a: MemoryEntry, b: MemoryEntry): MemoryEntry {
  const relA = a.relevance ?? 0;
  const relB = b.relevance ?? 0;
  if (relB > relA) return b;
  if (relA > relB) return a;
  return a.lastAccessedAt >= b.lastAccessedAt ? a : b;
}

function mergeContent(keeper: MemoryEntry, other: MemoryEntry): string {
  if (keeper.content.includes(other.content) || other.content.length < 40) {
    return keeper.content;
  }
  if (other.content.includes(keeper.content)) {
    return other.content;
  }
  const extra = other.content.slice(0, 120).replace(/\s+/g, " ").trim();
  return `${keeper.content}\n---\n${extra}`;
}

/**
 * Merge similar memory entries. Returns deduplicated list and ids removed by merge.
 */
export function mergeMemoryEntries(
  entries: MemoryEntry[],
  options: MemoryMergeOptions = {},
): MemoryMergeResult {
  const minSim = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const sameCategory = options.sameCategoryOnly !== false;
  const sameAgent = options.sameAgentOnly !== false;

  const removedIds: string[] = [];
  /** Entries absorbed into another cluster (roots stay out of this set). */
  const mergedAway = new Set<string>();
  const kept: MemoryEntry[] = [];
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id));

  for (const entry of sorted) {
    if (mergedAway.has(entry.id)) continue;

    let cluster: MemoryEntry = { ...entry };

    for (const other of sorted) {
      if (other.id === entry.id || mergedAway.has(other.id)) continue;
      if (sameCategory && other.category !== entry.category) continue;
      if (sameAgent && other.agentId !== entry.agentId) continue;
      if (scopeKey(other.scope) !== scopeKey(entry.scope)) continue;
      if (contentSimilarity(cluster.content, other.content) < minSim) continue;

      const keeper = pickKeeper(cluster, other);
      const absorbedId = keeper.id === other.id ? cluster.id : other.id;
      cluster = {
        ...keeper,
        content: mergeContent(keeper, other),
        relevance: Math.max(cluster.relevance ?? 0, other.relevance ?? 0),
        lastAccessedAt: Math.max(cluster.lastAccessedAt, other.lastAccessedAt),
      };
      mergedAway.add(absorbedId);
      removedIds.push(absorbedId);
    }

    kept.push(cluster);
  }

  return {
    entries: kept,
    mergedCount: removedIds.length,
    removedIds,
  };
}
