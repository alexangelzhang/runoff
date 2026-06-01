/**
 * Structured Experiment Log (autoresearch-inspired).
 *
 * Append-only JSONL log at ~/.runoff/experiments.jsonl.
 * Each entry records one pipeline run's outcome for A/B comparison.
 */

import { existsSync, appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getPipelineHomeDir } from "../core/paths.js";
import type { PipelineTrace, ExperimentMeta } from "./trace.js";
import type { PipelineStatus } from "../core/state.js";

// --- Entry ---

export interface ExperimentEntry {
  /** ISO timestamp. */
  timestamp: string;
  /** Trace ID for cross-reference. */
  traceId: string;
  /** Experiment metadata. */
  experimentId: string;
  variant: string;
  tags: string[];
  /** Outcome. */
  status: PipelineStatus;
  /** Token economics. */
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  /** Performance. */
  durationMs: number;
  rounds: number;
  /** Provider chain used. */
  providers: string[];
  /** Keep/discard verdict (set after judge runs). */
  verdict?: "keep" | "discard" | "regression";
  /** Phase 8.3.7 multidimensional judge scores. */
  judgeScores?: {
    correctness: number;
    tokenEfficiency: number;
    latency: number;
    overall: number;
  };
  /** Human-readable description. */
  description?: string;
}

// --- Log path ---

function getLogPath(): string {
  return join(getPipelineHomeDir(), "experiments.jsonl");
}

// --- Append ---

export function appendExperimentEntry(entry: ExperimentEntry): void {
  const logPath = getLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

/**
 * Create an experiment entry from a pipeline trace.
 * Returns null if trace has no experiment metadata.
 */
export function entryFromTrace(
  trace: PipelineTrace,
  verdict?: "keep" | "discard" | "regression",
  description?: string,
  judgeScores?: ExperimentEntry["judgeScores"],
): ExperimentEntry | null {
  if (!trace.experiment) return null;

  const usage = trace.totalUsage ?? { promptTokens: 0, completionTokens: 0 };
  return {
    timestamp: trace.timestamp,
    traceId: trace.id,
    experimentId: trace.experiment.experimentId,
    variant: trace.experiment.variant,
    tags: trace.experiment.tags ?? [],
    status: trace.finalStatus,
    totalTokens: usage.promptTokens + usage.completionTokens,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    durationMs: trace.totalDurationMs,
    rounds: trace.totalRounds,
    providers: trace.steps.map((s) => s.provider),
    verdict,
    judgeScores,
    description,
  };
}

// --- Query ---

export interface ExperimentQuery {
  experimentId?: string;
  variant?: string;
  status?: PipelineStatus;
  verdict?: "keep" | "discard" | "regression";
  since?: string;
  limit?: number;
}

export function queryExperiments(query: ExperimentQuery = {}): ExperimentEntry[] {
  const logPath = getLogPath();
  if (!existsSync(logPath)) return [];

  const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
  let entries: ExperimentEntry[] = [];

  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as ExperimentEntry);
    } catch {
      // Skip corrupt lines
    }
  }

  if (query.experimentId) {
    entries = entries.filter((e) => e.experimentId === query.experimentId);
  }
  if (query.variant) {
    entries = entries.filter((e) => e.variant === query.variant);
  }
  if (query.status) {
    entries = entries.filter((e) => e.status === query.status);
  }
  if (query.verdict) {
    entries = entries.filter((e) => e.verdict === query.verdict);
  }
  if (query.since) {
    entries = entries.filter((e) => e.timestamp >= query.since!);
  }
  if (query.limit && query.limit > 0) {
    entries = entries.slice(-query.limit);
  }

  return entries;
}

/**
 * Summarize experiment results grouped by variant.
 */
export interface VariantSummary {
  variant: string;
  count: number;
  approvedCount: number;
  avgTokens: number;
  avgDurationMs: number;
  keepCount: number;
  discardCount: number;
}

export function summarizeExperiment(experimentId: string): VariantSummary[] {
  const entries = queryExperiments({ experimentId });
  const groups = new Map<string, ExperimentEntry[]>();

  for (const e of entries) {
    const list = groups.get(e.variant) ?? [];
    list.push(e);
    groups.set(e.variant, list);
  }

  const summaries: VariantSummary[] = [];
  for (const [variant, list] of groups) {
    summaries.push({
      variant,
      count: list.length,
      approvedCount: list.filter((e) => e.status === "approved").length,
      avgTokens: list.reduce((s, e) => s + e.totalTokens, 0) / list.length,
      avgDurationMs: list.reduce((s, e) => s + e.durationMs, 0) / list.length,
      keepCount: list.filter((e) => e.verdict === "keep").length,
      discardCount: list.filter((e) => e.verdict === "discard").length,
    });
  }

  return summaries;
}
