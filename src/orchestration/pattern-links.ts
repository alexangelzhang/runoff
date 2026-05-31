/**
 * Phase 8.1.5 — Pattern association via filesModified intersection (A-MEM).
 */

import type { AgentMemory, MemoryEntry, MemoryScope } from "./memory.js";
import { agentId } from "./multi-agent-types.js";
import type { ExecutionPattern } from "./pattern-cache.js";

const PATTERN_AGENT_ID = agentId("pattern-cache");
const MIN_FILE_OVERLAP = 1;

export function patternFilesModified(pattern: ExecutionPattern): string[] {
  const files = new Set<string>();
  for (const hint of pattern.stepHints) {
    for (const f of hint.filesModified ?? []) {
      if (f) files.add(f);
    }
  }
  return [...files];
}

/** Count of overlapping file paths. */
export function filesIntersectionCount(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  let n = 0;
  for (const f of a) {
    if (setB.has(f)) n++;
  }
  return n;
}

export function asExecutionPattern(metadata: Record<string, unknown> | undefined): ExecutionPattern | null {
  if (!metadata || typeof metadata !== "object") return null;
  if (!Array.isArray(metadata.stepHints)) return null;
  return metadata as unknown as ExecutionPattern;
}

/**
 * Find pattern memory ids linked by shared filesModified.
 */
export function findRelatedPatternEntryIds(
  entries: MemoryEntry[],
  target: ExecutionPattern,
  excludeId?: string,
  minOverlap = MIN_FILE_OVERLAP,
): string[] {
  const targetFiles = patternFilesModified(target);
  if (targetFiles.length === 0) return [];

  const related: string[] = [];
  for (const entry of entries) {
    if (entry.id === excludeId) continue;
    const pattern = asExecutionPattern(entry.metadata);
    if (!pattern) continue;
    if (filesIntersectionCount(targetFiles, patternFilesModified(pattern)) >= minOverlap) {
      related.push(entry.id);
    }
  }
  return related;
}

/**
 * After storing a pattern, link bidirectionally via metadata.relatedPatternIds.
 */
export function linkPatternByFiles(
  memory: AgentMemory,
  scope: MemoryScope,
  newEntry: MemoryEntry,
  newPattern: ExecutionPattern,
  minOverlap = MIN_FILE_OVERLAP,
): string[] {
  const all = memory.retrieve({
    agentId: PATTERN_AGENT_ID,
    category: "pattern",
    scope,
    limit: 500,
  });

  const relatedIds = findRelatedPatternEntryIds(all, newPattern, newEntry.id, minOverlap);
  if (relatedIds.length === 0) return [];

  const mergedRelated = [...new Set([...relatedIds])];
  const newMeta = {
    ...(newEntry.metadata ?? {}),
    relatedPatternIds: mergedRelated,
  };
  patchEntryMetadata(memory, newEntry.id, newMeta);

  for (const rid of relatedIds) {
    const other = all.find((e) => e.id === rid);
    if (!other) continue;
    const otherMeta = { ...(other.metadata ?? {}) };
    const existing = Array.isArray(otherMeta.relatedPatternIds)
      ? (otherMeta.relatedPatternIds as string[])
      : [];
    if (!existing.includes(newEntry.id)) {
      otherMeta.relatedPatternIds = [...existing, newEntry.id];
      patchEntryMetadata(memory, rid, otherMeta);
    }
  }

  return mergedRelated;
}

/** Read related patterns for associative context injection (8.1.7 precursor). */
export function getLinkedPatterns(
  memory: AgentMemory,
  entry: MemoryEntry,
  scope: MemoryScope,
): ExecutionPattern[] {
  const all = memory.retrieve({
    agentId: PATTERN_AGENT_ID,
    category: "pattern",
    scope,
    limit: 500,
  });
  const current = all.find((e) => e.id === entry.id) ?? entry;
  const ids = current.metadata?.relatedPatternIds;
  if (!Array.isArray(ids) || ids.length === 0) return [];

  const byId = new Map(all.map((e) => [e.id, e]));
  const out: ExecutionPattern[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const p = asExecutionPattern(byId.get(id)?.metadata);
    if (p) out.push(p);
  }
  return out;
}

function patchEntryMetadata(
  memory: AgentMemory,
  id: string,
  metadata: Record<string, unknown>,
): void {
  memory.patchMetadata(id, metadata);
}
