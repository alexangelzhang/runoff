/**
 * Dream track A — deterministic trace / experiment structuring (no LLM).
 */

import type { PipelineTrace } from "../observability/trace.js";
import type { PipelineStatus } from "../core/state.js";
import { loadTraceById } from "../observability/trace.js";
import { queryExperiments, type ExperimentEntry } from "../observability/experiment-log.js";
import { hashPrompt } from "../orchestration/pattern-cache.js";
import { loadDreamState } from "../memory/dream-state.js";

export interface DreamStepSummary {
  name: string;
  provider: string;
  durationMs: number;
  verdict?: string;
  filesModified: string[];
  error?: string;
  errorCode?: string;
}

/** Structured input for Dream rules + LLM (track B/C). */
export interface DreamBatchItem {
  traceId: string;
  timestamp: string;
  prompt: string;
  promptHash: string;
  finalStatus: PipelineStatus;
  totalTokens: number;
  durationMs: number;
  rounds: number;
  providers: string[];
  steps: DreamStepSummary[];
  experimentId?: string;
  variant?: string;
  verdict?: ExperimentEntry["verdict"];
  costSummaryUSD?: number;
  /** Joined experiment log row when available. */
  experiment?: ExperimentEntry;
}

export interface CollectDreamBatchOptions {
  /** ISO timestamp — only entries on or after (experiment log + trace time). */
  since?: string | null;
  limit?: number;
  /** When true, use dream-state.json lastDreamAt as since (if set). */
  sinceLastRun?: boolean;
}

export function structureTraceForDream(
  trace: PipelineTrace,
  experiment?: ExperimentEntry | null,
): DreamBatchItem {
  const usage = trace.totalUsage ?? { promptTokens: 0, completionTokens: 0 };
  const totalTokens = usage.promptTokens + usage.completionTokens;

  return {
    traceId: trace.id,
    timestamp: trace.timestamp,
    prompt: trace.prompt,
    promptHash: hashPrompt(trace.prompt),
    finalStatus: trace.finalStatus,
    totalTokens,
    durationMs: trace.totalDurationMs,
    rounds: trace.totalRounds,
    providers: trace.steps.map((s) => s.provider),
    steps: trace.steps.map((s) => ({
      name: s.name,
      provider: s.provider,
      durationMs: s.durationMs,
      verdict: s.verdict,
      filesModified: s.filesModified ?? [],
      error: s.error ?? s.errorDetail?.message,
      errorCode: s.errorDetail?.code,
    })),
    experimentId: trace.experiment?.experimentId ?? experiment?.experimentId,
    variant: trace.experiment?.variant ?? experiment?.variant,
    verdict: experiment?.verdict,
    costSummaryUSD: trace.costSummary?.totalCostUSD,
    experiment: experiment ?? undefined,
  };
}

/** Load traces indexed by experiment log (primary) with trace file fallback. */
export function collectDreamBatch(options: CollectDreamBatchOptions = {}): DreamBatchItem[] {
  let since = options.since ?? undefined;
  if (options.sinceLastRun && since === undefined) {
    const last = loadDreamState().lastDreamAt;
    if (last) since = last;
  }

  const limit = options.limit ?? 50;
  const entries = queryExperiments({ since, limit });
  const items: DreamBatchItem[] = [];
  const seen = new Set<string>();

  for (const exp of entries) {
    if (seen.has(exp.traceId)) continue;
    seen.add(exp.traceId);
    const trace = loadTraceById(exp.traceId);
    if (!trace) continue;
    items.push(structureTraceForDream(trace, exp));
  }

  return items;
}
