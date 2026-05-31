/**
 * P5 — Optional Mem0/Zep npm SDK transport (falls back to REST adapters).
 */

import type { MemoryEntry, MemoryQuery, MemoryScope } from "./memory.js";
import { agentId } from "./multi-agent-types.js";
import { HttpMemoryClient } from "./http-memory-client.js";
import { Mem0MemoryClient, type Mem0MemoryConfig } from "./mem0-memory-client.js";
import { ZepMemoryClient, type ZepMemoryConfig } from "./zep-memory-client.js";
import type { RemoteMemoryClient } from "./remote-memory.js";
import type { MemoryBackendConfig } from "./memory-factory.js";

export type MemoryTransport = "rest" | "sdk" | "auto";

function restClient(backend: MemoryBackendConfig): RemoteMemoryClient | undefined {
  if (backend.type === "http") return new HttpMemoryClient(backend);
  if (backend.type === "mem0") return new Mem0MemoryClient(backend);
  if (backend.type === "zep") return new ZepMemoryClient(backend);
  return undefined;
}

function mapMem0SdkResults(body: unknown, userId?: string): MemoryEntry[] {
  if (!body || typeof body !== "object") return [];
  const arr = Array.isArray(body)
    ? body
    : Array.isArray((body as { results?: unknown }).results)
      ? (body as { results: unknown[] }).results
      : [];
  const now = Date.now();
  const out: MemoryEntry[] = [];
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
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
    const scope: MemoryScope = {
      user: typeof row.user_id === "string" ? row.user_id : userId,
    };
    out.push({
      id: String(row.id ?? `mem0-sdk-${i}`),
      agentId: agentId("mem0"),
      scope,
      category: "context",
      content,
      createdAt: now,
      lastAccessedAt: now,
      metadata: { source: "mem0-sdk" },
    });
  }
  return out;
}

async function tryMem0SdkClient(config: Mem0MemoryConfig): Promise<RemoteMemoryClient | null> {
  if (config.variant === "oss") return null;
  try {
    const mod = (await import("mem0ai")) as {
      MemoryClient?: new (opts: { apiKey?: string }) => {
        add: (messages: unknown[], opts: { user_id: string }) => Promise<unknown>;
        search: (query: string, opts: { user_id: string }) => Promise<unknown>;
      };
    };
    const Client = mod.MemoryClient;
    if (!Client || !config.apiKey) return null;
    const client = new Client({ apiKey: config.apiKey });
    const userId = config.userId ?? "default";
    return {
      async push(entry: MemoryEntry): Promise<void> {
        const uid = config.userId ?? entry.scope?.user ?? userId;
        await client.add([{ role: "user", content: entry.content }], { user_id: uid });
      },
      async search(query: MemoryQuery): Promise<MemoryEntry[]> {
        const uid = config.userId ?? query.scope?.user ?? userId;
        const q = query.semanticQuery ?? query.textSearch ?? "";
        if (!q) return [];
        const raw = await client.search(q, { user_id: uid });
        return mapMem0SdkResults(raw, uid);
      },
    };
  } catch {
    return null;
  }
}

async function tryZepSdkClient(config: ZepMemoryConfig): Promise<RemoteMemoryClient | null> {
  try {
    const mod = (await import("@getzep/zep-cloud")) as {
      ZepClient?: new (opts: { apiKey: string }) => {
        memory: {
          add: (sessionId: string, opts: { messages: { role: string; content: string }[] }) => Promise<unknown>;
          search: (sessionId: string, opts: { text: string; limit?: number }) => Promise<unknown>;
        };
      };
    };
    const Client = mod.ZepClient;
    if (!Client || !config.apiKey) return null;
    const client = new Client({ apiKey: config.apiKey });
    const sessionId = config.sessionId ?? config.userId ?? "llm-pipeline-default";
    return {
      async push(entry: MemoryEntry): Promise<void> {
        const sid = config.sessionId ?? config.userId ?? sessionId;
        await client.memory.add(sid, {
          messages: [{ role: "user", content: entry.content }],
        });
      },
      async search(query: MemoryQuery): Promise<MemoryEntry[]> {
        const sid = config.sessionId ?? config.userId ?? sessionId;
        const q = query.semanticQuery ?? query.textSearch ?? "";
        if (!q) return [];
        try {
          const raw = await client.memory.search(sid, { text: q, limit: 20 });
          const rows = Array.isArray(raw)
            ? raw
            : Array.isArray((raw as { results?: unknown }).results)
              ? (raw as { results: unknown[] }).results
              : [];
          const now = Date.now();
          const out: MemoryEntry[] = [];
          for (let i = 0; i < rows.length; i++) {
            const item = rows[i];
            if (!item || typeof item !== "object") continue;
            const row = item as Record<string, unknown>;
            const content =
              typeof row.content === "string"
                ? row.content
                : typeof row.message === "string"
                  ? row.message
                  : "";
            if (!content) continue;
            const scope: MemoryScope = { user: config.userId };
            out.push({
              id: `zep-sdk-${i}`,
              agentId: agentId("zep"),
              scope,
              category: "context",
              content,
              createdAt: now,
              lastAccessedAt: now,
              metadata: { source: "zep-sdk" },
            });
          }
          return out;
        } catch {
          return [];
        }
      },
    };
  } catch {
    return null;
  }
}

async function trySdkClient(backend: MemoryBackendConfig): Promise<RemoteMemoryClient | null> {
  if (backend.type === "mem0") return tryMem0SdkClient(backend);
  if (backend.type === "zep") return tryZepSdkClient(backend);
  return null;
}

/** Lazy remote client: resolves SDK on first use, else REST. */
export class LazyRemoteMemoryClient implements RemoteMemoryClient {
  private delegate?: RemoteMemoryClient;
  private loading?: Promise<RemoteMemoryClient>;

  constructor(
    private readonly backend: MemoryBackendConfig,
    private readonly transport: MemoryTransport,
  ) {}

  private resolve(): Promise<RemoteMemoryClient> {
    if (this.delegate) return Promise.resolve(this.delegate);
    this.loading ??= (async () => {
      if (this.transport === "rest") {
        this.delegate = restClient(this.backend)!;
        return this.delegate;
      }
      const sdk =
        this.transport === "sdk" || this.transport === "auto"
          ? await trySdkClient(this.backend)
          : null;
      this.delegate = sdk ?? restClient(this.backend)!;
      return this.delegate;
    })();
    return this.loading;
  }

  async push(entry: MemoryEntry): Promise<void> {
    return (await this.resolve()).push(entry);
  }

  async search(query: MemoryQuery): Promise<MemoryEntry[]> {
    return (await this.resolve()).search(query);
  }
}

export function createRemoteMemoryClient(
  backend: MemoryBackendConfig,
  transport: MemoryTransport = "auto",
): RemoteMemoryClient | undefined {
  if (backend.type === "local") return undefined;
  if (transport === "rest") return restClient(backend);
  return new LazyRemoteMemoryClient(backend, transport);
}
