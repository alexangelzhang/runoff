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
import type { StageEvaluationHint, StageEvaluationKind } from "./stage-evaluation.js";

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

export type ExperimentStageEvaluationKindSummary = {
  kind: StageEvaluationKind;
  traceCount: number;
  stepCount: number;
  stepNames: string[];
  metricNames: string[];
  evidenceRefs: string[];
  passCount: number;
  failCount: number;
  partialCount: number;
  unknownCount: number;
};

export type ExperimentStageEvaluationSummary = {
  evaluatedTraceCount: number;
  stageEvaluationCount: number;
  missingTraceCount: number;
  missingStageEvaluationCount: number;
  passCount: number;
  failCount: number;
  partialCount: number;
  unknownCount: number;
  byKind: ExperimentStageEvaluationKindSummary[];
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
  /** Stage-specific metric hints aggregated from PipelineObservation.stageEvaluations. */
  stageEvaluationSummary: ExperimentStageEvaluationSummary;
  /** Failed / regression runs with one-line postmortem for dashboards. */
  traceInsights?: ExperimentTraceInsight[];
};

const STAGE_KIND_ORDER: StageEvaluationKind[] = [
  "analyze",
  "implement",
  "review",
  "test",
  "final_summary",
  "other",
];

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

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values])].sort((a, b) => a.localeCompare(b));
}

type StageEvaluationAccumulator = {
  traceIds: Set<string>;
  stepNames: Set<string>;
  metricNames: Set<string>;
  evidenceRefs: Set<string>;
  stepCount: number;
  passCount: number;
  failCount: number;
  partialCount: number;
  unknownCount: number;
};

function incrementOverallStatus(
  acc: StageEvaluationAccumulator,
  status: StageEvaluationHint["overallStatus"],
): void {
  switch (status) {
    case "pass":
      acc.passCount += 1;
      break;
    case "fail":
      acc.failCount += 1;
      break;
    case "partial":
      acc.partialCount += 1;
      break;
    default:
      acc.unknownCount += 1;
      break;
  }
}

function addStageEvaluationHint(
  byKind: Map<StageEvaluationKind, StageEvaluationAccumulator>,
  traceId: string,
  hint: StageEvaluationHint,
): void {
  const acc =
    byKind.get(hint.kind) ??
    {
      traceIds: new Set<string>(),
      stepNames: new Set<string>(),
      metricNames: new Set<string>(),
      evidenceRefs: new Set<string>(),
      stepCount: 0,
      passCount: 0,
      failCount: 0,
      partialCount: 0,
      unknownCount: 0,
    };

  acc.traceIds.add(traceId);
  acc.stepNames.add(hint.stepName);
  acc.stepCount += 1;
  incrementOverallStatus(acc, hint.overallStatus);
  for (const metric of hint.metrics) {
    acc.metricNames.add(metric.name);
    for (const ref of metric.evidenceRefs) acc.evidenceRefs.add(ref);
  }
  byKind.set(hint.kind, acc);
}

function buildStageEvaluationSummary(entries: ExperimentEntry[]): ExperimentStageEvaluationSummary {
  const byKind = new Map<StageEvaluationKind, StageEvaluationAccumulator>();
  const evaluatedTraceIds = new Set<string>();
  let stageEvaluationCount = 0;
  let missingTraceCount = 0;
  let missingStageEvaluationCount = 0;

  for (const entry of entries) {
    const trace = loadTraceById(entry.traceId);
    if (!trace) {
      missingTraceCount += 1;
      continue;
    }

    const stageEvaluations = trace.observation?.stageEvaluations ?? [];
    if (!stageEvaluations.length) {
      missingStageEvaluationCount += 1;
      continue;
    }

    evaluatedTraceIds.add(entry.traceId);
    stageEvaluationCount += stageEvaluations.length;
    for (const hint of stageEvaluations) {
      addStageEvaluationHint(byKind, entry.traceId, hint);
    }
  }

  const totals = [...byKind.values()].reduce(
    (acc, row) => ({
      passCount: acc.passCount + row.passCount,
      failCount: acc.failCount + row.failCount,
      partialCount: acc.partialCount + row.partialCount,
      unknownCount: acc.unknownCount + row.unknownCount,
    }),
    { passCount: 0, failCount: 0, partialCount: 0, unknownCount: 0 },
  );

  const byKindRows = [...byKind.entries()]
    .sort(([left], [right]) => STAGE_KIND_ORDER.indexOf(left) - STAGE_KIND_ORDER.indexOf(right))
    .map(([kind, acc]) => ({
      kind,
      traceCount: acc.traceIds.size,
      stepCount: acc.stepCount,
      stepNames: uniqueSorted(acc.stepNames),
      metricNames: uniqueSorted(acc.metricNames),
      evidenceRefs: uniqueSorted(acc.evidenceRefs),
      passCount: acc.passCount,
      failCount: acc.failCount,
      partialCount: acc.partialCount,
      unknownCount: acc.unknownCount,
    }));

  return {
    evaluatedTraceCount: evaluatedTraceIds.size,
    stageEvaluationCount,
    missingTraceCount,
    missingStageEvaluationCount,
    passCount: totals.passCount,
    failCount: totals.failCount,
    partialCount: totals.partialCount,
    unknownCount: totals.unknownCount,
    byKind: byKindRows,
  };
}

/** Aggregate variant stats + winner for A/B dashboards (Phase 9+). */
export function buildExperimentEvalReport(experimentId: string): ExperimentEvalReport {
  const entries = queryExperiments({ experimentId });
  const variants = summarizeExperiment(experimentId);
  const winnerVariant = pickWinnerVariant(variants);
  const stageEvaluationSummary = buildStageEvaluationSummary(entries);
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
    stageEvaluationSummary,
    ...(traceInsights.length ? { traceInsights } : {}),
  };
}
