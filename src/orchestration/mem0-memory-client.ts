/**
 * P4 — Mem0 REST adapter (platform + OSS paths, no npm SDK).
 *
 * Platform: https://api.mem0.ai/v1/memories/ …
 * OSS:      POST /memories, POST /search (no /v1 prefix)
 */

import type { MemoryEntry, MemoryQuery } from "./memory.js";
import type { HttpMemoryBackendConfig } from "./http-memory-client.js";
import { agentId } from "./multi-agent-types.js";
import type { RemoteMemoryClient } from "./remote-memory.js";

export type Mem0Variant = "platform" | "oss";

export type Mem0MemoryConfig = HttpMemoryBackendConfig & {
  variant?: Mem0Variant;
};

function variantPaths(variant: Mem0Variant): { add: string; search: string } {
  if (variant === "oss") {
    return { add: "/memories", search: "/search" };
  }
  return { add: "/v1/memories/", search: "/v1/memories/search/" };
}

function mem0Headers(config: Mem0MemoryConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Token ${config.apiKey}`;
    headers["X-API-Key"] = config.apiKey;
  }
  return headers;
}

function mapMem0Results(body: unknown): MemoryEntry[] {
  if (!body || typeof body !== "object") return [];
  const arr =
    Array.isArray(body)
      ? body
      : Array.isArray((body as { results?: unknown }).results)
        ? (body as { results: unknown[] }).results
        : Array.isArray((body as { memories?: unknown }).memories)
          ? (body as { memories: unknown[] }).memories
          : [];
  const out: MemoryEntry[] = [];
  const now = Date.now();
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const content =
      typeof row.memory === "string"
        ? row.memory
        : typeof row.text === "string"
          ? row.text
          : typeof row.content === "string"
            ? row.content
            : "";
    if (!content) continue;
    out.push({
      id: String(row.id ?? `mem0-${out.length}`),
      agentId: agentId("mem0"),
      scope: { user: typeof row.user_id === "string" ? row.user_id : undefined },
      category: "context",
      content,
      createdAt: now,
      lastAccessedAt: now,
      metadata: { source: "mem0" },
    });
  }
  return out;
}

export class Mem0MemoryClient implements RemoteMemoryClient {
  constructor(private readonly config: Mem0MemoryConfig) {}

  private baseUrl(): string {
    const v = this.config.variant ?? "platform";
    if (this.config.baseUrl) return this.config.baseUrl.replace(/\/$/, "");
    return v === "oss" ? "http://127.0.0.1:8888" : "https://api.mem0.ai";
  }

  async push(entry: MemoryEntry): Promise<void> {
    const userId = this.config.userId ?? entry.scope?.user ?? "default";
    const variant = this.config.variant ?? "platform";
    const paths = variantPaths(variant);
    const body =
      variant === "oss"
        ? {
            messages: [{ role: "user", content: entry.content }],
            user_id: userId,
          }
        : {
            messages: [{ role: "user", content: entry.content }],
            user_id: userId,
          };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 12_000);
    try {
      await fetch(`${this.baseUrl()}${paths.add}`, {
        method: "POST",
        headers: mem0Headers(this.config),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      // non-critical
    } finally {
      clearTimeout(timer);
    }
  }

  async search(query: MemoryQuery): Promise<MemoryEntry[]> {
    const userId = this.config.userId ?? query.scope?.user ?? "default";
    const q = query.semanticQuery ?? query.textSearch ?? "";
    if (!q) return [];
    const variant = this.config.variant ?? "platform";
    const paths = variantPaths(variant);
    const body = { query: q, user_id: userId };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 12_000);
    try {
      const res = await fetch(`${this.baseUrl()}${paths.search}`, {
        method: "POST",
        headers: mem0Headers(this.config),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) return [];
      return mapMem0Results(await res.json());
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}
