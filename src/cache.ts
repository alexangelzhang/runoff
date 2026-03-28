/**
 * TTL + LRU response cache for LLM provider calls.
 * Reduces redundant API/CLI calls for identical prompts.
 */

import { createHash } from "node:crypto";
import { LLMResponse } from "./providers/types.js";

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
  private stats: CacheStats = { hits: 0, misses: 0, evictions: 0, size: 0 };

  // Double Linked List pointers
  private head: CacheNode | null = null;
  private tail: CacheNode | null = null;

  constructor(maxSize = 64, ttlMinutes = 30) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMinutes * 60 * 1000;
  }

  /** Build a cache key from provider + prompt + language + context. */
  static key(provider: string, prompt: string, language?: string, context?: string): string {
    const raw = `${provider}::${prompt}::${language ?? ""}::${context ?? ""}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
  }

  get(key: string): LLMResponse | null {
    const node = this.store.get(key);
    if (!node) {
      this.stats.misses++;
      return null;
    }

    // TTL check
    if (Date.now() - node.entry.createdAt > this.ttlMs) {
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

  getStats(): CacheStats {
    return { ...this.stats, size: this.store.size };
  }

  private evictLRU(): void {
    if (!this.tail) return;
    const lruKey = this.tail.key;
    this.removeNode(this.tail);
    this.store.delete(lruKey);
    this.stats.evictions++;
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

export function getCache(): ResponseCache {
  if (!_cache) _cache = new ResponseCache();
  return _cache;
}
