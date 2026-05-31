/**
 * Phase 8.1.4 — Relevance feedback from pipeline outcomes.
 */

import type { PipelineTrace } from "../observability/trace.js";
import { hashPrompt } from "./pattern-cache.js";
import type { AgentMemory, MemoryScope } from "./memory.js";

const APPROVED_BUMP = 0.1;
const FAILED_BUMP = -0.15;

/**
 * Adjust relevance for pattern memories tied to this prompt hash.
 * Returns number of entries updated.
 */
export function feedbackRelevanceFromTrace(
  memory: AgentMemory,
  trace: PipelineTrace,
  scope: Partial<MemoryScope>,
): number {
  const hash = hashPrompt(trace.prompt);
  const bump = trace.finalStatus === "approved" ? APPROVED_BUMP : FAILED_BUMP;

  const related = memory.retrieve({
    category: "pattern",
    scope,
    textSearch: `promptHash:${hash}`,
    limit: 32,
  });

  let updated = 0;
  for (const entry of related) {
    const next = Math.max(0, Math.min(1, (entry.relevance ?? 0.5) + bump));
    if (memory.updateRelevance(entry.id, next)) updated++;
  }
  return updated;
}
