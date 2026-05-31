/**
 * M1 — Run-scoped pipeline memory: singleton local disk + optional layered remote per session.
 */

import type { PipelineConfig } from "../core/config.js";
import type { AgentMemory } from "../orchestration/memory.js";
import { LayeredAgentMemory } from "../orchestration/http-memory-client.js";
import {
  resolveMemoryBackendConfig,
  type MemoryBackendConfig,
  type ResolveMemoryBackendOptions,
} from "../orchestration/memory-factory.js";
import { PersistentAgentMemory } from "../orchestration/persistent-memory.js";
import { createRemoteMemoryClient } from "../orchestration/memory-transport.js";

// Lazy singleton — reset via resetPipelineMemoryRegistry() in tests.
let _localMemory: PersistentAgentMemory | null = null;
const _layeredByKey = new Map<string, LayeredAgentMemory>();

function getLocalMemory(): PersistentAgentMemory {
  if (!_localMemory) _localMemory = new PersistentAgentMemory();
  return _localMemory;
}

function layeredCacheKey(
  backend: MemoryBackendConfig,
  pipelineSessionId?: string,
): string {
  if (backend.type === "zep") {
    return `zep:${backend.sessionId ?? pipelineSessionId ?? "__default__"}`;
  }
  if (backend.type === "local") return "local";
  return `${backend.type}:__shared__`;
}

function createLayeredForBackend(
  local: PersistentAgentMemory,
  backend: MemoryBackendConfig,
): AgentMemory {
  if (backend.type === "local") return local;
  const remote = createRemoteMemoryClient(backend, backend.transport ?? "auto");
  if (!remote) return local;
  return new LayeredAgentMemory(local, remote);
}

/** Reset local singleton and per-session layered wrappers (tests). */
export function resetPipelineMemoryRegistry(): void {
  _localMemory = null;
  _layeredByKey.clear();
}

/**
 * Memory for a pipeline run. Local store is always shared; Zep uses per-session layered view.
 */
export function getPipelineMemory(
  config?: PipelineConfig,
  pipelineSessionId?: string,
): AgentMemory {
  const local = getLocalMemory();
  if (!config) return local;

  const backend = resolveMemoryBackendConfig(config, { pipelineSessionId });
  if (backend.type === "local") return local;

  const key = layeredCacheKey(backend, pipelineSessionId);
  const cached = _layeredByKey.get(key);
  if (cached) return cached;

  const layered = createLayeredForBackend(local, backend);
  if (layered instanceof LayeredAgentMemory) {
    _layeredByKey.set(key, layered);
    return layered;
  }
  return local;
}

/** Underlying local file memory (tests). */
export function getPipelineLocalMemory(): PersistentAgentMemory {
  return getLocalMemory();
}

export function getPipelineMemorySessionKey(
  config: PipelineConfig,
  pipelineSessionId?: string,
): string {
  return layeredCacheKey(resolveMemoryBackendConfig(config, { pipelineSessionId }), pipelineSessionId);
}

export type { ResolveMemoryBackendOptions };
