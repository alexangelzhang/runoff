/**
 * Phase 8.2.5 — L2 persistent response cache (file-backed warm store).
 * Evicted L1 entries are written here; startup preloads valid entries into L1.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getPipelineHomeDir } from "../core/paths.js";
import type { LLMResponse } from "../providers/types.js";

export interface L2CacheRecord {
  key: string;
  response: LLMResponse;
  createdAt: number;
  lastAccess: number;
}

export function getDefaultL2CachePath(): string {
  return join(getPipelineHomeDir(), "cache", "l2-store.json");
}

/**
 * JSON file store for evicted LRU entries (bounded size).
 */
export class ResponseCacheL2Store {
  private records = new Map<string, L2CacheRecord>();

  constructor(
    private readonly filePath: string,
    private readonly maxEntries = 256,
  ) {
    this.load();
  }

  load(): number {
    if (!existsSync(this.filePath)) return 0;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as L2CacheRecord[];
      if (!Array.isArray(parsed)) return 0;
      this.records.clear();
      for (const row of parsed) {
        if (row?.key && row.response) {
          this.records.set(row.key, row);
        }
      }
      return this.records.size;
    } catch {
      return 0;
    }
  }

  get(key: string): L2CacheRecord | undefined {
    return this.records.get(key);
  }

  put(record: L2CacheRecord): void {
    this.records.set(record.key, record);
    this.trim();
    this.persist();
  }

  delete(key: string): void {
    if (!this.records.delete(key)) return;
    this.persist();
  }

  /** Entries sorted by lastAccess desc (for L1 warm-up). */
  entriesByRecency(): L2CacheRecord[] {
    return [...this.records.values()].sort((a, b) => b.lastAccess - a.lastAccess);
  }

  clear(): void {
    this.records.clear();
    this.persist();
  }

  get size(): number {
    return this.records.size;
  }

  private trim(): void {
    if (this.records.size <= this.maxEntries) return;
    const sorted = this.entriesByRecency();
    const keep = new Set(sorted.slice(0, this.maxEntries).map((r) => r.key));
    for (const key of this.records.keys()) {
      if (!keep.has(key)) this.records.delete(key);
    }
  }

  private persist(): void {
    const dir = join(this.filePath, "..");
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    const payload = JSON.stringify([...this.records.values()]);
    writeFileSync(tmp, payload);
    renameSync(tmp, this.filePath);
  }
}
