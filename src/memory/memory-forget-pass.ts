/**
 * B6-style memory forget pass — decay + TTL eviction (shared by Dream and hot path).
 */

import type { AgentMemory, MemoryScope } from "../orchestration/memory.js";
import { decayedRelevance } from "../orchestration/memory-decay.js";

export const DEFAULT_FORGET_BELOW_RELEVANCE = 0.05;

export interface MemoryForgetPassOptions {
  scope?: Partial<MemoryScope>;
  forgetBelowRelevance?: number;
  /** When true, count candidates but do not delete. */
  dryRun?: boolean;
  onCandidate?: (info: {
    memoryId: string;
    reason: "ttl" | "decay";
    relevance: number;
    evidenceTraceId: string;
  }) => void;
}

export function applyMemoryForgetPass(
  memory: AgentMemory,
  options: MemoryForgetPassOptions = {},
): { forgotten: number; candidateCount: number } {
  const scope = options.scope ?? { project: "default" };
  const forgetBelow = options.forgetBelowRelevance ?? DEFAULT_FORGET_BELOW_RELEVANCE;
  const dryRun = options.dryRun ?? false;
  const now = Date.now();
  let forgotten = 0;
  let candidateCount = 0;

  const entries = memory.retrieve({ scope, limit: 10_000, includeExpired: true });
  for (const e of entries) {
    const expired = e.ttlMs !== undefined && now - e.createdAt >= e.ttlMs;
    const rel = decayedRelevance(e.relevance ?? 0.5, now - e.createdAt);
    if (!expired && rel >= forgetBelow) continue;

    candidateCount += 1;
    const evidenceTraceId =
      typeof e.metadata?.evidenceTraceId === "string" ? e.metadata.evidenceTraceId : "batch";

    options.onCandidate?.({
      memoryId: e.id,
      reason: expired ? "ttl" : "decay",
      relevance: rel,
      evidenceTraceId,
    });

    if (!dryRun && memory.forget(e.id)) {
      forgotten += 1;
    }
  }

  return { forgotten, candidateCount };
}
