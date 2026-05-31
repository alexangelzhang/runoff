/**
 * P3 — HTTP memory backend (Mem0/Zep-style REST adapter).
 *
 * Contract: docs/external-memory.md
 */

import type { AgentMemory, MemoryEntry, MemoryQuery, MemoryScope } from "./memory.js";
import type { MemoryMergeOptions } from "./memory-merge.js";
import { PersistentAgentMemory } from "./persistent-memory.js";
import type { RemoteMemoryClient } from "./remote-memory.js";

export type HttpMemoryBackendConfig = {
  baseUrl: string;
  apiKey?: string;
  /** Optional Mem0-style user / project header. */
  userId?: string;
  timeoutMs?: number;
};

type RemoteMemoryPayload = {
  entries?: MemoryEntry[];
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function buildHeaders(config: HttpMemoryBackendConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  if (config.userId) headers["X-Memory-User-Id"] = config.userId;
  return headers;
}

/** Generic HTTP client; Mem0/Zep use dedicated adapters. */
export class HttpMemoryClient implements RemoteMemoryClient {
  constructor(private readonly config: HttpMemoryBackendConfig) {}

  async search(query: MemoryQuery): Promise<MemoryEntry[]> {
    const base = normalizeBaseUrl(this.config.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 8_000);
    try {
      const res = await fetch(`${base}/v1/memories/search`, {
        method: "POST",
        headers: buildHeaders(this.config),
        body: JSON.stringify({ query }),
        signal: controller.signal,
      });
      if (!res.ok) return [];
      const body = (await res.json()) as RemoteMemoryPayload;
      return Array.isArray(body.entries) ? body.entries : [];
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async push(entry: MemoryEntry): Promise<void> {
    const base = normalizeBaseUrl(this.config.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 8_000);
    try {
      await fetch(`${base}/v1/memories`, {
        method: "POST",
        headers: buildHeaders(this.config),
        body: JSON.stringify({ entry }),
        signal: controller.signal,
      });
    } catch {
      // non-critical
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Local primary store + optional HTTP mirror/search (Zep/Mem0 external backend).
 */
export class LayeredAgentMemory implements AgentMemory {
  constructor(
    private readonly local: AgentMemory,
    private readonly remote?: RemoteMemoryClient,
  ) {}

  store(entry: Omit<MemoryEntry, "id" | "createdAt" | "lastAccessedAt">): MemoryEntry {
    const saved = this.local.store(entry);
    if (this.remote) void this.remote.push(saved);
    return saved;
  }

  retrieve(query: MemoryQuery): MemoryEntry[] {
    const local = this.local.retrieve(query);
    if (!this.remote) return local;
    // Remote search is async; sync retrieve stays local-only for AgentMemory contract.
    return local;
  }

  /** Async retrieve merging local + remote (use from tooling / future hooks). */
  async retrieveMerged(query: MemoryQuery): Promise<MemoryEntry[]> {
    const local = this.local.retrieve(query);
    if (!this.remote) return local;
    const remote = await this.remote.search(query);
    const seen = new Set(local.map((e) => e.id));
    const merged = [...local];
    for (const e of remote) {
      if (!seen.has(e.id)) merged.push(e);
    }
    return merged;
  }

  forget(id: string): boolean {
    return this.local.forget(id);
  }

  forgetByScope(scope: Partial<MemoryScope>): number {
    return this.local.forgetByScope(scope);
  }

  updateRelevance(id: string, relevance: number): boolean {
    return this.local.updateRelevance(id, relevance);
  }

  patchMetadata(id: string, metadata: Record<string, unknown>): boolean {
    return this.local.patchMetadata(id, metadata);
  }

  get size(): number {
    return this.local.size;
  }

  clear(): void {
    this.local.clear();
  }

  compact(options?: MemoryMergeOptions): number {
    if (this.local instanceof PersistentAgentMemory) {
      return this.local.compact(options);
    }
    return 0;
  }
}
