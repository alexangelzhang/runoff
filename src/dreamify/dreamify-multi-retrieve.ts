/**
 * M4 — Multi-strategy pattern retrieval (semantic + BM25-lite + entity graph hop).
 */

import type { AgentMemory, MemoryEntry, MemoryScope } from "../orchestration/memory.js";
import { agentId } from "../orchestration/multi-agent-types.js";
import { tokenizeForSimilarity } from "../orchestration/memory-merge.js";
import { rankEntriesBySemanticQuery } from "../orchestration/memory-embedding.js";
import type { DreamifyRetrievalParams } from "./dreamify-params.js";
import { hashPrompt } from "../orchestration/pattern-cache.js";

const PATTERN_AGENT_ID = agentId("pattern-cache");
const ENTITY_AGENT_ID = agentId("trace-entities");

function tokenOverlapScore(query: string, content: string): number {
  const qTokens = new Set(tokenizeForSimilarity(query));
  if (qTokens.size === 0) return 0;
  const cTokens = tokenizeForSimilarity(content);
  if (cTokens.length === 0) return 0;
  let hits = 0;
  for (const t of cTokens) {
    if (qTokens.has(t)) hits++;
  }
  return hits / qTokens.size;
}

function extractPathHints(prompt: string): string[] {
  const matches = prompt.match(/[a-zA-Z0-9_./-]+\.[a-z]{1,4}/g) ?? [];
  return [...new Set(matches)].slice(0, 10);
}

function graphHopPatterns(
  memory: AgentMemory,
  scope: Partial<MemoryScope>,
  prompt: string,
  seeds: MemoryEntry[],
  limit: number,
): MemoryEntry[] {
  const files = new Set<string>();
  for (const hint of extractPathHints(prompt)) files.add(hint);
  for (const seed of seeds) {
    const meta = seed.metadata as { stepHints?: Array<{ filesModified?: string[] }> };
    for (const h of meta?.stepHints ?? []) {
      for (const f of h.filesModified ?? []) {
        if (f) files.add(f);
      }
    }
  }
  if (files.size === 0) return [];

  const patterns = memory.retrieve({
    agentId: PATTERN_AGENT_ID,
    category: "pattern",
    scope,
    limit: 200,
  });

  const scored: Array<{ entry: MemoryEntry; score: number }> = [];
  for (const entry of patterns) {
    const meta = entry.metadata as { stepHints?: Array<{ filesModified?: string[] }> };
    const pFiles = new Set<string>();
    for (const h of meta?.stepHints ?? []) {
      for (const f of h.filesModified ?? []) {
        if (f) pFiles.add(f);
      }
    }
    let overlap = 0;
    for (const f of files) {
      if (pFiles.has(f)) overlap++;
    }
    if (overlap === 0) continue;
    scored.push({ entry, score: overlap / files.size });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((r) => r.entry);
}

function fuseRanked(
  lists: Array<{ entries: MemoryEntry[]; weight: number }>,
  limit: number,
): MemoryEntry[] {
  const scores = new Map<string, { entry: MemoryEntry; score: number }>();
  for (const { entries, weight } of lists) {
    entries.forEach((entry, idx) => {
      const rankScore = 1 / (idx + 1);
      const prev = scores.get(entry.id);
      const add = rankScore * weight;
      if (prev) prev.score += add;
      else scores.set(entry.id, { entry, score: add });
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.entry);
}

/** Semantic + BM25-lite + entity-adjacent graph hop, fused ranking. */
export function matchPatternEntriesMultiStrategy(
  memory: AgentMemory,
  scope: Partial<MemoryScope>,
  prompt: string,
  params: DreamifyRetrievalParams,
): MemoryEntry[] {
  const limit = params.patternLimit;
  const exact = memory.retrieve({
    agentId: PATTERN_AGENT_ID,
    category: "pattern",
    scope,
    textSearch: `promptHash:${hashPrompt(prompt)}`,
    limit,
  });
  if (exact.length > 0) return exact;

  const allPatterns = memory.retrieve({
    agentId: PATTERN_AGENT_ID,
    category: "pattern",
    scope,
    limit: 500,
  });

  const semantic = rankEntriesBySemanticQuery(allPatterns, prompt, {
    minSimilarity: params.minSemanticSimilarity,
    decayHalfLifeMs: params.decayHalfLifeMs,
  }).slice(0, limit);

  const bm25 = [...allPatterns]
    .map((entry) => ({ entry, score: tokenOverlapScore(prompt, entry.content) }))
    .filter((r) => r.score >= 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.entry);

  const graph = graphHopPatterns(memory, scope, prompt, semantic, limit);

  const entityBoost: MemoryEntry[] = [];
  for (const file of extractPathHints(prompt)) {
    const edges = memory.retrieve({
      agentId: ENTITY_AGENT_ID,
      category: "entity_relation",
      scope,
      textSearch: file,
      limit: 8,
    });
    if (edges.length > 0) {
      const provider = (edges[0]!.metadata?.provider as string) ?? "";
      if (provider) {
        const byProvider = allPatterns.filter((p) =>
          p.content.toLowerCase().includes(provider.toLowerCase()),
        );
        entityBoost.push(...byProvider.slice(0, 2));
      }
    }
  }

  return fuseRanked(
    [
      { entries: semantic, weight: 0.45 },
      { entries: bm25, weight: 0.3 },
      { entries: graph, weight: 0.15 },
      { entries: entityBoost, weight: 0.1 },
    ],
    limit,
  );
}
