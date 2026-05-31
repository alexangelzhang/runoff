/**
 * Async formation queue — pattern store, entity triples, relevance, compact, hot-path forget.
 * Serializes writes so pipeline end does not block on memory I/O.
 */

import type { PipelineConfig } from "../core/config.js";
import type { PipelineTrace } from "../observability/trace.js";
import { logger } from "../core/logger.js";
import { PatternCache } from "../orchestration/pattern-cache.js";
import { feedbackRelevanceFromTrace } from "../orchestration/memory-relevance.js";
import { storeEntityTriplesFromTrace } from "../orchestration/trace-entities.js";
import { getPipelineMemory } from "./pipeline-memory.js";
import { applyMemoryForgetPass } from "./memory-forget-pass.js";

export interface PipelineMemoryFormationJob {
  config: PipelineConfig;
  sessionId: string;
  trace: PipelineTrace;
  autoCompact: boolean;
  hotPathForget: boolean;
  project?: string;
}

let chain: Promise<void> = Promise.resolve();
let pendingJobs = 0;

function memoryProject(config: PipelineConfig, override?: string): string {
  return override ?? config.orchestration?.dream?.project ?? "default";
}

async function runFormationJob(job: PipelineMemoryFormationJob): Promise<void> {
  const scope = { project: memoryProject(job.config, job.project) };
  const memory = getPipelineMemory(job.config, job.sessionId);
  const patternCache = new PatternCache(memory, scope);

  if (job.trace.finalStatus === "approved") {
    patternCache.storeFromTrace(job.trace);
  }
  feedbackRelevanceFromTrace(memory, job.trace, scope);
  storeEntityTriplesFromTrace(memory, job.trace, scope);

  if (job.autoCompact && "compact" in memory && typeof memory.compact === "function") {
    try {
      memory.compact();
    } catch (err: unknown) {
      logger.warn(
        "memory-formation-queue",
        `Memory compact failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (job.hotPathForget) {
    const { forgotten } = applyMemoryForgetPass(memory, { scope });
    if (forgotten > 0) {
      logger.debug("memory-formation-queue", `Hot-path forget removed ${forgotten} entries`);
    }
  }
}

/** Enqueue formation work (returns immediately; jobs run serially in background). */
export function enqueuePipelineMemoryFormation(job: PipelineMemoryFormationJob): void {
  pendingJobs += 1;
  chain = chain
    .then(() => runFormationJob(job))
    .catch((err: unknown) => {
      logger.warn(
        "memory-formation-queue",
        `Formation job failed for trace ${job.trace.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    })
    .finally(() => {
      pendingJobs -= 1;
    });
}

/** Run formation inline (no queue). */
export async function runPipelineMemoryFormationNow(job: PipelineMemoryFormationJob): Promise<void> {
  await runFormationJob(job);
}

/** Await all queued formation jobs (tests and graceful shutdown). */
export async function flushPipelineMemoryFormationQueue(): Promise<void> {
  await chain;
}

/** Reset queue state (tests). */
export function resetPipelineMemoryFormationQueue(): void {
  chain = Promise.resolve();
  pendingJobs = 0;
}

export function pipelineMemoryFormationQueueDepth(): number {
  return pendingJobs;
}

export function resolveMemoryFormationOptions(config: PipelineConfig): {
  async: boolean;
  hotPathForget: boolean;
  autoCompact: boolean;
} {
  const orch = config.orchestration;
  return {
    async: orch?.memoryFormationAsync !== false,
    hotPathForget: orch?.memoryHotPathForget !== false,
    autoCompact: orch?.memoryAutoCompact === true,
  };
}
