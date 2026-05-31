/**
 * Phase 8.2.2 — Semantic response cache.
 * Reuses LLM responses when prompts are similar (token Jaccard ≥ threshold).
 */

import { ResponseCache, type CacheStats } from "./cache.js";
import { contentSimilarity, tokenizeForSimilarity } from "../orchestration/memory-merge.js";
import type { LLMResponse } from "../providers/types.js";

export interface SemanticCacheLookup {
  provider: string;
  prompt: string;
  language?: string;
  context?: string;
}

export interface SemanticCacheOptions {
  /** Minimum similarity to reuse (default 0.95, aligned with ROADMAP). */
  minSimilarity?: number;
  maxSize?: number;
  ttlMinutes?: number;
}

interface IndexedEntry {
  exactKey: string;
  provider: string;
  prompt: string;
  language: string;
  context: string;
}

const DEFAULT_MIN_SIMILARITY = 0.95;

/**
 * LRU exact cache + semantic lookup by prompt similarity (same provider).
 */
export class SemanticResponseCache {
  private inner: ResponseCache;
  private index: IndexedEntry[] = [];
  private minSimilarity: number;
  semanticHits = 0;

  constructor(options: SemanticCacheOptions = {}) {
    this.minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
    this.inner = new ResponseCache(options.maxSize, options.ttlMinutes);
  }

  get(key: string, lookup?: SemanticCacheLookup): LLMResponse | null {
    const exact = this.inner.get(key);
    if (exact) return exact;

    if (!lookup) return null;

    let bestSim = 0;
    let bestKey: string | null = null;
    for (const row of this.index) {
      if (row.provider !== lookup.provider) continue;
      if (row.language !== (lookup.language ?? "")) continue;
      if (row.context !== (lookup.context ?? "")) continue;
      const sim = contentSimilarity(row.prompt, lookup.prompt);
      if (sim >= this.minSimilarity && sim > bestSim) {
        bestSim = sim;
        bestKey = row.exactKey;
      }
    }

    if (!bestKey) return null;
    const hit = this.inner.get(bestKey);
    if (hit) this.semanticHits++;
    return hit;
  }

  put(key: string, response: LLMResponse, lookup?: SemanticCacheLookup): void {
    this.inner.put(key, response);
    if (!lookup) return;

    const row: IndexedEntry = {
      exactKey: key,
      provider: lookup.provider,
      prompt: lookup.prompt,
      language: lookup.language ?? "",
      context: lookup.context ?? "",
    };

    const dup = this.index.findIndex((e) => e.exactKey === key);
    if (dup >= 0) this.index[dup] = row;
    else this.index.push(row);

    // Trim index when inner evicts (approximate: cap index to maxSize)
    const stats = this.inner.getStats();
    if (this.index.length > stats.size + 8) {
      this.index = this.index.filter((e) => this.inner.get(e.exactKey) !== null);
    }
  }

  getStats(): CacheStats & { semanticHits: number } {
    return { ...this.inner.getStats(), semanticHits: this.semanticHits };
  }

  clear(): void {
    this.inner.clear();
    this.index = [];
    this.semanticHits = 0;
  }

  /** Normalize prompt fingerprint for debugging. */
  static fingerprint(prompt: string): string {
    return tokenizeForSimilarity(prompt).slice(0, 32).join(" ");
  }
}

let _semanticCache: SemanticResponseCache | null = null;

export function getSemanticCache(options?: SemanticCacheOptions): SemanticResponseCache {
  if (!_semanticCache) _semanticCache = new SemanticResponseCache(options);
  return _semanticCache;
}

export function clearSemanticCache(): void {
  if (_semanticCache) _semanticCache.clear();
  _semanticCache = null;
}
