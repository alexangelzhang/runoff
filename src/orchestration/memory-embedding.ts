/**
 * Phase 8.1.3 — Local text embeddings for semantic memory retrieval.
 * Deterministic bag-of-tokens vectors + cosine similarity (no external API).
 */

import { decayedRelevance, memoryDecayLambda } from "./memory-decay.js";
import { resolveDreamifyRetrieval } from "../dreamify/dreamify-params.js";
import { tokenizeForSimilarity } from "./memory-merge.js";
import type { MemoryEntry } from "./memory.js";

export const EMBEDDING_DIM = 64;

/** L2-normalized sparse embedding from token hashes. */
export function embedText(text: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIM).fill(0);
  for (const token of tokenizeForSimilarity(text)) {
    let h = 0;
    for (let i = 0; i < token.length; i++) {
      h = (h * 31 + token.charCodeAt(i)) >>> 0;
    }
    vec[h % EMBEDDING_DIM]! += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

/** Cosine similarity for L2-normalized vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i]! * b[i]!;
  return dot;
}

export function isEmbeddingVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

export function getEntryEmbedding(entry: MemoryEntry): number[] {
  const stored = entry.metadata?.embedding;
  if (isEmbeddingVector(stored) && stored.length === EMBEDDING_DIM) {
    return stored;
  }
  return embedText(entry.content);
}

export function attachEmbeddingMetadata(
  metadata: Record<string, unknown> | undefined,
  content: string,
): Record<string, unknown> {
  return {
    ...metadata,
    embedding: embedText(content),
  };
}

export interface SemanticRankOptions {
  minSimilarity?: number;
  nowMs?: number;
  decayHalfLifeMs?: number;
}

/**
 * Rank memories by cosine(query, entry) × decayed relevance.
 */
export function rankEntriesBySemanticQuery(
  entries: MemoryEntry[],
  queryText: string,
  options: SemanticRankOptions = {},
): MemoryEntry[] {
  const dreamify = resolveDreamifyRetrieval(undefined);
  const minSim = options.minSimilarity ?? dreamify.minSemanticSimilarity;
  const now = options.nowMs ?? Date.now();
  const lambda = memoryDecayLambda(options.decayHalfLifeMs ?? dreamify.decayHalfLifeMs);
  const queryEmb = embedText(queryText);

  return entries
    .map((entry) => {
      const sim = cosineSimilarity(queryEmb, getEntryEmbedding(entry));
      const rel = decayedRelevance(entry.relevance ?? 0.5, now - entry.createdAt, lambda);
      return { entry, score: sim * rel, sim };
    })
    .filter((row) => row.sim >= minSim)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.entry);
}
