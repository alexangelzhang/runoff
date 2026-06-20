/**
 * Local experiment datasets + eval reports (Phase 9+ observability).
 *
 * Exportable JSONL and variant comparison from `experiments.jsonl`.
 * No external observability SaaS — see docs/features/observability.md.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PipelineStatus } from "../core/state.js";
import {
  queryExperiments,
  summarizeExperiment,
  type ExperimentEntry,
  type ExperimentQuery,
  type VariantSummary,
} from "./experiment-log.js";
import { getPipelineHomeDir } from "../core/paths.js";
import { loadTraceById } from "./trace.js";
import { postmortemOneLiner } from "./trace-postmortem.js";

export const OBSERVABILITY_DATASET_SCHEMA = "runoff-eval-v1" as const;

export type ObservabilityDatasetRow = {
  schema: typeof OBSERVABILITY_DATASET_SCHEMA;
  experimentId: string;
  variant: string;
  traceId: string;
  timestamp: string;
  inputs: {
    rounds: number;
    providers: string[];
  };
  outputs: {
    status: PipelineStatus;
    totalTokens: number;
    durationMs: number;
    verdict?: ExperimentEntry["verdict"];
    judgeOverall?: number;
  };
  metadata: {
    tags: string[];
    description?: string;
    promptTokens: number;
    completionTokens: number;
  };
};

export function experimentDatasetPath(experimentId: string): string {
  const safe = experimentId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return join(getPipelineHomeDir(), "datasets", `${safe}.jsonl`);
}

export function buildExperimentDatasetRows(
  experimentId: string,
  query: Omit<ExperimentQuery, "experimentId"> = {},
): ObservabilityDatasetRow[] {
  const entries = queryExperiments({ experimentId, ...query });
  return entries.map((e) => rowFromEntry(e));
}

function rowFromEntry(e: ExperimentEntry): ObservabilityDatasetRow {
  return {
    schema: OBSERVABILITY_DATASET_SCHEMA,
    experimentId: e.experimentId,
    variant: e.variant,
    traceId: e.traceId,
    timestamp: e.timestamp,
    inputs: { rounds: e.rounds, providers: e.providers },
    outputs: {
      status: e.status,
      totalTokens: e.totalTokens,
      durationMs: e.durationMs,
      verdict: e.verdict,
      judgeOverall: e.judgeScores?.overall,
    },
    metadata: {
      tags: e.tags,
      description: e.description,
      promptTokens: e.promptTokens,
      completionTokens: e.completionTokens,
    },
  };
}

export function exportExperimentDatasetJsonl(
  experimentId: string,
  options?: { outPath?: string; query?: Omit<ExperimentQuery, "experimentId"> },
): { path: string; rowCount: number } {
  const rows = buildExperimentDatasetRows(experimentId, options?.query);
  const path = options?.outPath ?? experimentDatasetPath(experimentId);
  mkdirSync(dirname(path), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  writeFileSync(path, body, "utf-8");
  return { path, rowCount: rows.length };
}

export type ExperimentTraceInsight = {
  traceId: string;
  variant: string;
  status: PipelineStatus;
  verdict?: ExperimentEntry["verdict"];
  postmortemSummary: string;
  observationSummary?: string;
};

export type ExperimentEvalReport = {
  experimentId: string;
  schema: typeof OBSERVABILITY_DATASET_SCHEMA;
  generatedAt: string;
  totalRuns: number;
  regressionCount: number;
  variants: VariantSummary[];
  winnerVariant?: string;
  recommendation: string;
  /** Failed / regression runs with one-line postmortem for dashboards. */
  traceInsights?: ExperimentTraceInsight[];
};

function pickWinnerVariant(summaries: VariantSummary[]): string | undefined {
  if (!summaries.length) return undefined;
  const scored = [...summaries].sort((a, b) => {
    const keepDelta = b.keepCount - a.keepCount;
    if (keepDelta !== 0) return keepDelta;
    const approveDelta = b.approvedCount - a.approvedCount;
    if (approveDelta !== 0) return approveDelta;
    return a.avgTokens - b.avgTokens;
  });
  return scored[0]?.variant;
}

function buildRecommendation(
  experimentId: string,
  summaries: VariantSummary[],
  winner?: string,
): string {
  if (!summaries.length) {
    return `No runs logged for experiment "${experimentId}". Run pipelines with the same prompt to populate experiments.jsonl.`;
  }
  if (!winner) return "Insufficient data to recommend a variant.";
  const w = summaries.find((s) => s.variant === winner)!;
  return (
    `Promote variant "${winner}" (${w.keepCount} keep, ${w.approvedCount}/${w.count} approved, ` +
    `~${Math.round(w.avgTokens)} tokens, ~${Math.round(w.avgDurationMs)}ms).`
  );
}

function buildTraceInsights(entries: ExperimentEntry[]): ExperimentTraceInsight[] {
  const interesting = entries.filter(
    (e) => e.verdict === "regression" || e.status === "failed" || e.status === "max_rounds",
  );
  return interesting.slice(0, 20).map((e) => {
    const trace = loadTraceById(e.traceId);
    const postmortemSummary = trace
      ? postmortemOneLiner(trace)
      : `No trace file for ${e.traceId} (status=${e.status})`;
    return {
      traceId: e.traceId,
      variant: e.variant,
      status: e.status,
      verdict: e.verdict,
      postmortemSummary,
      observationSummary: trace?.observation?.summary,
    };
  });
}

/** Aggregate variant stats + winner for A/B dashboards (Phase 9+). */
export function buildExperimentEvalReport(experimentId: string): ExperimentEvalReport {
  const entries = queryExperiments({ experimentId });
  const variants = summarizeExperiment(experimentId);
  const winnerVariant = pickWinnerVariant(variants);
  const traceInsights = buildTraceInsights(entries);
  return {
    experimentId,
    schema: OBSERVABILITY_DATASET_SCHEMA,
    generatedAt: new Date().toISOString(),
    totalRuns: entries.length,
    regressionCount: entries.filter((e) => e.verdict === "regression").length,
    variants,
    winnerVariant,
    recommendation: buildRecommendation(experimentId, variants, winnerVariant),
    ...(traceInsights.length ? { traceInsights } : {}),
  };
}
