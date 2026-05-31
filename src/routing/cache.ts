/**
 * TTL + LRU response cache for LLM provider calls.
 * Reduces redundant API/CLI calls for identical prompts.
 */

import { createHash } from "node:crypto";
import { getDefaultL2CachePath, ResponseCacheL2Store } from "./cache-l2.js";
import { LLMResponse } from "../providers/types.js";

interface CacheEntry {
  response: LLMResponse;
  createdAt: number;
  lastAccess: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
}

/** Internal list node for tracking access order in O(1). */
interface CacheNode {
  key: string;
  entry: CacheEntry;
  prev: CacheNode | null;
  next: CacheNode | null;
}

export class ResponseCache {
  private store = new Map<string, CacheNode>();
  private maxSize: number;
  private ttlMs: number;
  private l2: ResponseCacheL2Store | null;
  private stats: CacheStats = { hits: 0, misses: 0, evictions: 0, size: 0 };
  l2Hits = 0;

  // Double Linked List pointers
  private head: CacheNode | null = null;
  private tail: CacheNode | null = null;

  constructor(
    maxSize = 64,
    ttlMinutes = 30,
    l2?: ResponseCacheL2Store | null,
    options?: { warmL2?: boolean },
  ) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMinutes * 60 * 1000;
    this.l2 = l2 ?? null;
    if (this.l2 && options?.warmL2 !== false) this.warmFromL2();
  }

  private warmFromL2(): void {
    if (!this.l2) return;
    const now = Date.now();
    const expired: string[] = [];
    for (const row of this.l2.entriesByRecency()) {
      if (this.store.size >= this.maxSize) break;
      if (now - row.createdAt > this.ttlMs) {
        expired.push(row.key);
        continue;
      }
      this._insertDirect(row.key, row.response, row.createdAt);
    }
    for (const key of expired) this.l2.delete(key);
  }

  /** Insert directly into the LRU store without triggering eviction or L2 write-back. */
  private _insertDirect(key: string, response: LLMResponse, createdAt: number): void {
    if (this.store.has(key)) return;
    const node: CacheNode = {
      key,
      entry: { response, createdAt, lastAccess: createdAt },
      prev: null,
      next: null,
    };
    this.store.set(key, node);
    this.addToFront(node);
    this.stats.size = this.store.size;
  }

  private isExpired(createdAt: number, now = Date.now()): boolean {
    return now - createdAt > this.ttlMs;
  }

  /** Build a cache key from provider + prompt + language + context. */
  static key(provider: string, prompt: string, language?: string, context?: string): string {
    const raw = `${provider}::${prompt}::${language ?? ""}::${context ?? ""}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
  }

  get(key: string): LLMResponse | null {
    const node = this.store.get(key);
    if (!node) {
      const l2Hit = this.tryL2Get(key);
      if (l2Hit) return l2Hit;
      this.stats.misses++;
      return null;
    }

    // TTL check
    if (this.isExpired(node.entry.createdAt)) {
      this.removeNode(node);
      this.store.delete(key);
      this.stats.misses++;
      this.stats.size = this.store.size;
      return null;
    }

    node.entry.lastAccess = Date.now();
    this.moveToFront(node);
    this.stats.hits++;
    return node.entry.response;
  }

  put(key: string, response: LLMResponse): void {
    const existing = this.store.get(key);
    if (existing) {
      existing.entry.response = response;
      existing.entry.lastAccess = Date.now();
      this.moveToFront(existing);
      return;
    }

    // Evict LRU if at capacity
    if (this.store.size >= this.maxSize) {
      this.evictLRU();
    }

    const newNode: CacheNode = {
      key,
      entry: {
        response,
        createdAt: Date.now(),
        lastAccess: Date.now(),
      },
      prev: null,
      next: null,
    };

    this.store.set(key, newNode);
    this.addToFront(newNode);
    this.stats.size = this.store.size;
  }

  getStats(): CacheStats & { l2Hits: number } {
    return { ...this.stats, size: this.store.size, l2Hits: this.l2Hits };
  }

  /** Remove all entries and reset stats. */
  clear(): void {
    this.store.clear();
    this.head = null;
    this.tail = null;
    this.stats = { hits: 0, misses: 0, evictions: 0, size: 0 };
  }

  private tryL2Get(key: string): LLMResponse | null {
    if (!this.l2) return null;
    const row = this.l2.get(key);
    if (!row || this.isExpired(row.createdAt)) {
      if (row) this.l2.delete(key);
      return null;
    }
    this.put(key, row.response);
    this.l2Hits++;
    this.stats.hits++;
    return row.response;
  }

  private evictLRU(): void {
    if (!this.tail) return;
    const node = this.tail;
    const lruKey = node.key;
    // Remove from L1 first so L1 is always consistent even if L2 write fails.
    this.removeNode(node);
    this.store.delete(lruKey);
    this.stats.evictions++;
    if (this.l2) {
      try {
        this.l2.put({
          key: lruKey,
          response: node.entry.response,
          createdAt: node.entry.createdAt,
          lastAccess: node.entry.lastAccess,
        });
      } catch {
        // L2 unavailable; continue L1-only operation.
      }
    }
  }

  private addToFront(node: CacheNode): void {
    node.next = this.head;
    node.prev = null;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  private removeNode(node: CacheNode): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;

    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
  }

  private moveToFront(node: CacheNode): void {
    this.removeNode(node);
    this.addToFront(node);
  }
}

/** Module-level singleton cache */
let _cache: ResponseCache | null = null;
let _l2Store: ResponseCacheL2Store | null = null;

export function getCacheL2Store(): ResponseCacheL2Store | null {
  return _l2Store;
}

export function getCache(): ResponseCache {
  if (!_cache) {
    const l2Enabled = process.env.LLM_CACHE_L2 !== "0";
    if (l2Enabled) {
      const path = process.env.LLM_CACHE_L2_PATH ?? getDefaultL2CachePath();
      _l2Store = new ResponseCacheL2Store(path);
      _cache = new ResponseCache(64, 30, _l2Store);
    } else {
      _cache = new ResponseCache();
    }
  }
  return _cache;
}

/** Reset the singleton cache (for tests and hot-reload). */
export function clearCache(): void {
  if (_cache) _cache.clear();
  if (_l2Store) _l2Store.clear();
  _cache = null;
  _l2Store = null;
}
