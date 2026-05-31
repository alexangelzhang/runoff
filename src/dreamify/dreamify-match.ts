/**
 * Pattern matching with explicit Dreamify retrieval params (scoring + hot path).
 */

import type { AgentMemory, MemoryEntry, MemoryScope } from "../orchestration/memory.js";
import { agentId } from "../orchestration/multi-agent-types.js";
import { hashPrompt, type ExecutionPattern } from "../orchestration/pattern-cache.js";
import { findRelatedPatternEntryIds } from "../orchestration/pattern-links.js";
import type { DreamifyRetrievalParams, ResolvedDreamifyRetrieval } from "./dreamify-params.js";
import { DEFAULT_DREAMIFY_RETRIEVAL } from "./dreamify-params.js";
import { matchPatternEntriesMultiStrategy } from "./dreamify-multi-retrieve.js";

const PATTERN_AGENT_ID = agentId("pattern-cache");

function normalizePrompt(prompt: string): string {
  return prompt.toLowerCase().replace(/\s+/g, " ").trim();
}

export function matchPatternEntriesWithParams(
  memory: AgentMemory,
  scope: Partial<MemoryScope>,
  prompt: string,
  params: DreamifyRetrievalParams | ResolvedDreamifyRetrieval = DEFAULT_DREAMIFY_RETRIEVAL,
): MemoryEntry[] {
  if ("multiStrategy" in params && params.multiStrategy) {
    return matchPatternEntriesMultiStrategy(memory, scope, prompt, params);
  }

  const limit = params.patternLimit;
  const hash = hashPrompt(prompt);
  const exact = memory.retrieve({
    agentId: PATTERN_AGENT_ID,
    category: "pattern",
    scope,
    textSearch: `promptHash:${hash}`,
    limit,
  });
  if (exact.length > 0) return exact;

  const semantic = memory.retrieve({
    agentId: PATTERN_AGENT_ID,
    category: "pattern",
    scope,
    semanticQuery: prompt,
    minSemanticSimilarity: params.minSemanticSimilarity,
    limit,
  });
  if (semantic.length > 0) return semantic;

  const keywords = normalizePrompt(prompt).split(" ").filter((w) => w.length > 3).slice(0, 5);
  if (keywords.length === 0) return [];

  return memory
    .retrieve({
      agentId: PATTERN_AGENT_ID,
      category: "pattern",
      scope,
      textSearch: keywords[0],
      limit: limit * 3,
    })
    .filter((e) => {
      const content = e.content.toLowerCase();
      const matchCount = keywords.filter((k) => content.includes(k)).length;
      return matchCount >= Math.ceil(keywords.length * 0.4);
    })
    .slice(0, limit);
}

export function countAssociativePatterns(
  memory: AgentMemory,
  scope: Partial<MemoryScope>,
  prompt: string,
  params: DreamifyRetrievalParams,
): number {
  const primary = matchPatternEntriesWithParams(memory, scope, prompt, params);
  const all = memory.retrieve({
    agentId: PATTERN_AGENT_ID,
    category: "pattern",
    scope,
    limit: 500,
  });
  const seen = new Set<string>();
  for (const entry of primary) {
    const p = entry.metadata as unknown as ExecutionPattern;
    if (p?.promptHash) seen.add(p.promptHash);
    const relatedIds = findRelatedPatternEntryIds(
      all,
      p,
      entry.id,
      params.fileLinkMinOverlap,
    );
    for (const id of relatedIds) {
      const other = all.find((e) => e.id === id);
      const hp = other?.metadata as unknown as ExecutionPattern;
      if (hp?.promptHash) seen.add(hp.promptHash);
    }
  }
  return seen.size;
}
