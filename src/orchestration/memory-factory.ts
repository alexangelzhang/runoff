/**
 * P3/P4 — Pipeline memory factory (local + HTTP / Mem0 / Zep).
 */

import type { PipelineConfig } from "../core/config.js";
import type { AgentMemory } from "./memory.js";
import { PersistentAgentMemory } from "./persistent-memory.js";
import { LayeredAgentMemory, type HttpMemoryBackendConfig } from "./http-memory-client.js";
import type { Mem0Variant } from "./mem0-memory-client.js";
import {
  createRemoteMemoryClient,
  type MemoryTransport,
} from "./memory-transport.js";
import type { RemoteMemoryClient } from "./remote-memory.js";

export type MemoryBackendConfig =
  | { type: "local" }
  | ({ type: "http" } & HttpMemoryBackendConfig & { transport?: MemoryTransport })
  | ({ type: "mem0" } & HttpMemoryBackendConfig & { variant?: Mem0Variant; transport?: MemoryTransport })
  | ({ type: "zep" } & HttpMemoryBackendConfig & { sessionId?: string; transport?: MemoryTransport });

function remoteFromConfig(backend: MemoryBackendConfig): RemoteMemoryClient | undefined {
  const transport = backend.type === "local" ? "rest" : (backend.transport ?? "auto");
  return createRemoteMemoryClient(backend, transport);
}

export interface ResolveMemoryBackendOptions {
  /** Zep: use when config.memoryBackend.sessionId is unset. */
  pipelineSessionId?: string;
}

export function resolveMemoryBackendConfig(
  config: PipelineConfig,
  options?: ResolveMemoryBackendOptions,
): MemoryBackendConfig {
  const raw = config.orchestration?.memoryBackend;
  if (!raw || raw.type === "local") return { type: "local" };

  const apiKey = raw.apiKey ?? process.env.LLM_PIPELINE_MEMORY_API_KEY;
  const userId = raw.userId ?? process.env.LLM_PIPELINE_MEMORY_USER_ID;

  if (raw.type === "mem0") {
    const baseUrl =
      raw.baseUrl ??
      (raw.variant === "oss" ? process.env.LLM_PIPELINE_MEM0_OSS_URL : process.env.LLM_PIPELINE_MEM0_URL);
    if (!baseUrl && !apiKey && raw.variant !== "oss") return { type: "local" };
    return {
      type: "mem0",
      baseUrl: baseUrl ?? (raw.variant === "oss" ? "http://127.0.0.1:8888" : "https://api.mem0.ai"),
      apiKey,
      userId,
      timeoutMs: raw.timeoutMs,
      variant: raw.variant ?? "platform",
      transport: raw.transport ?? "auto",
    };
  }

  if (raw.type === "zep") {
    const baseUrl = raw.baseUrl ?? process.env.LLM_PIPELINE_ZEP_URL ?? "https://api.getzep.com/api/v2";
    if (!apiKey) return { type: "local" };
    return {
      type: "zep",
      baseUrl,
      apiKey,
      userId,
      sessionId: raw.sessionId ?? options?.pipelineSessionId,
      timeoutMs: raw.timeoutMs,
      transport: raw.transport ?? "auto",
    };
  }

  if (raw.type === "http") {
    const baseUrl = raw.baseUrl ?? process.env.LLM_PIPELINE_MEMORY_URL;
    if (!baseUrl) return { type: "local" };
    return {
      type: "http",
      baseUrl,
      apiKey,
      userId,
      timeoutMs: raw.timeoutMs,
      transport: raw.transport ?? "auto",
    };
  }

  return { type: "local" };
}

export function createPipelineMemory(
  config?: PipelineConfig,
  options?: ResolveMemoryBackendOptions,
): AgentMemory {
  const local = new PersistentAgentMemory();
  if (!config) return local;

  const backend = resolveMemoryBackendConfig(config, options);
  const remote = remoteFromConfig(backend);
  if (!remote) return local;

  return new LayeredAgentMemory(local, remote);
}
