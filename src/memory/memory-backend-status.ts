/**
 * Phase 9+ TOP2 — external memory backend status & hybrid search helpers.
 * No SaaS coupling; describes resolved config and probes remote reachability.
 */

import type { PipelineConfig } from "../core/config.js";
import {
  resolveMemoryBackendConfig,
  type MemoryBackendConfig,
} from "../orchestration/memory-factory.js";
import { getPipelineMemory } from "../memory/pipeline-memory.js";
import { LayeredAgentMemory } from "../orchestration/http-memory-client.js";
import type { AgentMemory, MemoryEntry, MemoryQuery } from "../orchestration/memory.js";
import { createRemoteMemoryClient } from "../orchestration/memory-transport.js";

export interface MemoryBackendDescribeOptions {
  /** When Zep is configured without sessionId, bind pipeline run session. */
  pipelineSessionId?: string;
}

export interface MemoryBackendStatus {
  configuredType: string;
  effectiveType: MemoryBackendConfig["type"];
  layered: boolean;
  transport?: string;
  baseUrl?: string;
  sessionId?: string;
  userIdPresent: boolean;
  apiKeyPresent: boolean;
  readPath: "local-sync" | "local+remote-async";
  notes: string[];
}

export interface MemoryBackendProbeResult {
  remoteConfigured: boolean;
  reachable: boolean;
  latencyMs?: number;
  sampleCount?: number;
  error?: string;
}

export function isLayeredAgentMemory(mem: AgentMemory): mem is LayeredAgentMemory {
  return mem instanceof LayeredAgentMemory;
}

export function describeMemoryBackend(
  config: PipelineConfig,
  options?: MemoryBackendDescribeOptions,
): MemoryBackendStatus {
  const raw = config.orchestration?.memoryBackend;
  const configuredType = raw?.type ?? "local";
  const backend = resolveMemoryBackendConfig(config, options);
  const notes: string[] = [];

  if (configuredType !== "local" && backend.type === "local") {
    notes.push("Configured remote backend fell back to local (missing baseUrl or apiKey).");
  }

  if (backend.type !== "local") {
    notes.push(
      "Pipeline hooks use sync retrieve() (local disk). Use llm_query_memory or retrieveMerged for hybrid search.",
    );
  }

  if (backend.type === "zep" && !backend.sessionId && options?.pipelineSessionId) {
    notes.push("Zep sessionId will use pipeline sessionId for this probe/query only.");
  }

  const readPath: MemoryBackendStatus["readPath"] =
    backend.type === "local" ? "local-sync" : "local+remote-async";

  return {
    configuredType,
    effectiveType: backend.type,
    layered: backend.type !== "local",
    transport: backend.type === "local" ? undefined : backend.transport,
    baseUrl: backend.type === "local" ? undefined : backend.baseUrl,
    sessionId: backend.type === "zep" ? backend.sessionId : undefined,
    userIdPresent: Boolean(
      raw?.userId ?? process.env.RUNOFF_MEMORY_USER_ID,
    ),
    apiKeyPresent: Boolean(
      raw?.apiKey ?? process.env.RUNOFF_MEMORY_API_KEY,
    ),
    readPath,
    notes,
  };
}

export async function probeMemoryBackend(
  config: PipelineConfig,
  options?: MemoryBackendDescribeOptions,
): Promise<MemoryBackendProbeResult> {
  const backend = resolveMemoryBackendConfig(config, options);
  if (backend.type === "local") {
    return { remoteConfigured: false, reachable: false, error: "effective backend is local" };
  }

  const transport = backend.transport ?? "auto";
  const remote = createRemoteMemoryClient(backend, transport);
  if (!remote) {
    return { remoteConfigured: true, reachable: false, error: "remote client not created" };
  }

  const t0 = Date.now();
  try {
    const entries = await remote.search({ limit: 1 });
    return {
      remoteConfigured: true,
      reachable: true,
      latencyMs: Date.now() - t0,
      sampleCount: entries.length,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      remoteConfigured: true,
      reachable: false,
      latencyMs: Date.now() - t0,
      error: message,
    };
  }
}

/** Hybrid local + remote search (LayeredAgentMemory.retrieveMerged). */
export async function queryPipelineMemoryMerged(
  config: PipelineConfig,
  query: MemoryQuery,
  options?: MemoryBackendDescribeOptions,
): Promise<{ entries: MemoryEntry[]; layered: boolean }> {
  const mem = getPipelineMemory(config, options?.pipelineSessionId);
  if (isLayeredAgentMemory(mem)) {
    const entries = await mem.retrieveMerged(query);
    return { entries, layered: true };
  }
  return { entries: mem.retrieve(query), layered: false };
}
