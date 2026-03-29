import type { PipelineConfig } from "../config.js";

/**
 * Snapshot the pipeline graph for a single run without mutating the cached config from {@link loadConfig}.
 * Dynamic steps and resume merge only touch this copy.
 */
export function forkPipelineForRun(base: PipelineConfig): PipelineConfig {
  return { ...base, pipeline: { ...base.pipeline } };
}
