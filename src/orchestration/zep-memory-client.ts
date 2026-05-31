/**
 * P4 — Zep Cloud REST adapter (session memory + graph search, no npm SDK).
 */

import type { MemoryEntry, MemoryQuery } from "./memory.js";
import type { HttpMemoryBackendConfig } from "./http-memory-client.js";
import { agentId } from "./multi-agent-types.js";
import type { RemoteMemoryClient } from "./remote-memory.js";

export type ZepMemoryConfig = HttpMemoryBackendConfig & {
  /** Zep session id (defaults to userId). */
  sessionId?: string;
};

function zepHeaders(config: ZepMemoryConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  return headers;
}

function mapZepGraphResults(body: unknown): MemoryEntry[] {
  if (!body || typeof body !== "object") return [];
  const edges = (body as { edges?: unknown[] }).edges;
  const nodes = (body as { nodes?: unknown[] }).nodes;
  const chunks: string[] = [];
  if (Array.isArray(edges)) {
    for (const e of edges) {
      if (e && typeof e === "object" && typeof (e as { fact?: string }).fact === "string") {
        chunks.push((e as { fact: string }).fact);
      }
    }
  }
  if (Array.isArray(nodes)) {
    for (const n of nodes) {
      if (n && typeof n === "object" && typeof (n as { summary?: string }).summary === "string") {
        chunks.push((n as { summary: string }).summary);
      }
    }
  }
  const now = Date.now();
  return chunks.map((content, i) => ({
    id: `zep-${i}`,
    agentId: agentId("zep"),
    scope: {},
    category: "context",
    content,
    createdAt: now,
    lastAccessedAt: now,
    metadata: { source: "zep" },
  }));
}

export class ZepMemoryClient implements RemoteMemoryClient {
  constructor(private readonly config: ZepMemoryConfig) {}

  private baseUrl(): string {
    return (this.config.baseUrl ?? "https://api.getzep.com/api/v2").replace(/\/$/, "");
  }

  private sessionId(entry?: MemoryEntry): string {
    return this.config.sessionId ?? this.config.userId ?? entry?.scope?.user ?? "llm-pipeline";
  }

  async push(entry: MemoryEntry): Promise<void> {
    const sessionId = this.sessionId(entry);
    const url = `${this.baseUrl()}/sessions/${encodeURIComponent(sessionId)}/memory`;
    const body = {
      messages: [{ role_type: "user", role: "user", content: entry.content }],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 12_000);
    try {
      await fetch(url, {
        method: "POST",
        headers: zepHeaders(this.config),
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
    const q = query.semanticQuery ?? query.textSearch ?? "";
    if (!q) return [];
    const userId = this.config.userId ?? query.scope?.user ?? "default";
    const url = `${this.baseUrl()}/graph/search`;
    const body = { query: q, user_id: userId, limit: query.limit ?? 8 };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 12_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: zepHeaders(this.config),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) return [];
      return mapZepGraphResults(await res.json());
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }
}
