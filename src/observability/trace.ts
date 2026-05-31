/**
 * Pipeline execution trace recorder.
 * Writes structured JSON traces to ~/.llm-pipeline/traces/ for data flywheel analysis.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getTracesDir } from "../core/paths.js";
import { PipelineStatus } from "../core/state.js";
import { logger } from "../core/logger.js";

export interface StepTrace {
  name: string;
  provider: string;
  routedFrom?: string;
  durationMs: number;
  round: number;
  verdict?: "approved" | "needs_revision" | "skipped";
  filesModified?: string[];
  cached?: boolean;
  error?: string;
  usage?: { promptTokens: number; completionTokens: number };
  /** Provider execution mode: text or agent */
  mode?: "text" | "agent";
  /** Whether this step used an agent provider */
  isAgent?: boolean;
  /** Whether a fallback provider was used */
  fallback?: boolean;
  /** Whether the provider was dynamically routed */
  routed?: boolean;
  /** Whether the provider was upgraded on retry */
  upgraded?: boolean;
  /** Race mode: participating provider names */
  raceParticipants?: string[];
  /** Provider race merge strategy applied for this step. */
  raceMergeStrategy?: "auto-merge" | "llm-merge" | "pick-winner";
  raceMerged?: boolean;
  raceMergeConflicts?: string[];
  /** Per-step cost breakdown (Phase 7.2, populated by PipelineHooks). */
  cost?: { inputCost: number; outputCost: number; cachedDiscount: number; totalCost: number };
  /** OpenTelemetry-style span id (Phase 8.3.3). */
  spanId?: string;
  parentSpanId?: string;
  /** Structured error (Phase 8.3.5). */
  errorDetail?: { message: string; source?: string; code?: string };
  /** Phase 8.3.11: id of stored prompt version for this step execution. */
  promptVersionId?: string;
}

/** Create a short unique span id for step traces. */
export function createStepSpanId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

/**
 * Temporal decay for trace-weighted routing (Phase 8.2.6).
 * 7d=1.0, 30d=0.5, older=0.1
 */
export function traceRecencyWeight(timestampIso: string, nowMs = Date.now()): number {
  const ts = Date.parse(timestampIso);
  if (!Number.isFinite(ts)) return 1;
  const ageDays = (nowMs - ts) / 86_400_000;
  if (ageDays <= 7) return 1;
  if (ageDays <= 30) return 0.5;
  return 0.1;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))]!;
}

export interface CandidateTrace {
  provider: string;
  durationMs: number;
  filesModified?: string[];
  diffStat?: string;
  isWinner?: boolean;
  failed?: boolean;
  error?: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface PipelineTrace {
  id: string;
  /** Checkpoint / resume session (groups related runs). */
  sessionId?: string;
  prompt: string;
  promptLength: number;
  mode: "pipeline" | "race";
  steps: StepTrace[];
  /** Race mode candidate traces */
  candidates?: CandidateTrace[];
  totalRounds: number;
  finalStatus: PipelineStatus;
  totalDurationMs: number;
  acceptanceCriteria?: string[];
  hasVerifyResults: boolean;
  timestamp: string;
  totalUsage?: { promptTokens: number; completionTokens: number };
  /** Pipeline-wide cost rollup (PipelineHooks on end/fail). */
  costSummary?: {
    totalCostUSD: number;
    totalTokens: number;
    breakdown: Array<{ step: string; provider: string; model: string; tokens: number; costUSD: number }>;
  };
  /** Rolling snapshot vs final write (same on-disk file key for a given id+day). */
  lifecycle?: "running" | "final";
  /** Experiment metadata for A/B comparison. */
  experiment?: ExperimentMeta;
  /** Replay of durable event log (Phase 7.6). */
  orchestrationEvents?: OrchestrationTraceRecord[];
  handoffs?: HandoffTraceRecord[];
  approvals?: ApprovalTraceRecord[];
  /** Run-scoped orchestrator insights (persisted on trace for Dream promotion). */
  globalKnowledge?: Record<string, string>;
}

export interface OrchestrationTraceRecord {
  seq: number;
  timestamp: number;
  type: string;
  detail: Record<string, unknown>;
}

export interface HandoffTraceRecord {
  from: string;
  to: string;
  reason?: string;
  timestamp: number;
  seq: number;
}

export interface ApprovalTraceRecord {
  requestId: string;
  agentId: string;
  action: string;
  phase?: "plan" | "action";
  requestedAt?: number;
  decision: string;
  respondedAt: number;
  respondedBy?: string;
  reason?: string;
}

export interface ExperimentMeta {
  /** Unique experiment run ID (groups related variants). */
  experimentId: string;
  /** Variant label within the experiment (e.g. "baseline", "new-prompt"). */
  variant: string;
  /** Free-form tags for filtering. */
  tags?: string[];
}

export function createTraceId(): string {
  return randomUUID().slice(0, 8);
}

export function recordTrace(trace: PipelineTrace): void {
  try {
    const tracesDir = getTracesDir();
    mkdirSync(tracesDir, { recursive: true });
    const filename = `${trace.timestamp.slice(0, 10)}_${trace.id}.json`;
    const outputFile = join(tracesDir, filename);
    const tmpFile = `${outputFile}.${process.pid}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(trace, null, 2));
    renameSync(tmpFile, outputFile);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("trace", `Failed to write trace ${trace.id}: ${message}`);
    if (process.env.LLM_PIPELINE_TRACE_STRICT === "1") {
      throw err;
    }
  }
}

/**
 * Lifecycle: rolling snapshot while the pipeline is still running (issue 6.10).
 * Uses the same on-disk key as {@link recordTrace} so each run overwrites one file per trace id + day.
 */
export function persistRunningPipelineTrace(trace: PipelineTrace): void {
  recordTrace({ ...trace, lifecycle: "running" });
}

/** Update an existing trace by ID. Reads, patches, and rewrites the trace file. */
export function updateTrace(traceId: string, patch: Partial<PipelineTrace>): boolean {
  try {
    const tracesDir = getTracesDir();
    if (!existsSync(tracesDir)) return false;
    const suffix = `_${traceId}.json`;
    const files = readdirSync(tracesDir).filter((f) => f.endsWith(suffix));
    if (files.length === 0) return false;
    const filePath = join(tracesDir, files[0]);
    const trace = JSON.parse(readFileSync(filePath, "utf-8")) as PipelineTrace;
    const updated = { ...trace, ...patch };
    const tmpFile = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(updated, null, 2));
    renameSync(tmpFile, filePath);
    return true;
  } catch {
    return false;
  }
}

/** Load a single trace by ID. Returns null if not found or corrupt. */
export function loadTraceById(traceId: string): PipelineTrace | null {
  try {
    const tracesDir = getTracesDir();
    if (!existsSync(tracesDir)) return null;
    const suffix = `_${traceId}.json`;
    const files = readdirSync(tracesDir).filter((f) => f.endsWith(suffix));
    if (files.length === 0) return null;
    return JSON.parse(readFileSync(join(tracesDir, files[0]), "utf-8")) as PipelineTrace;
  } catch {
    return null;
  }
}

// --- Trace query & aggregation ---

/** Read all trace files from the traces directory. Skips corrupt files individually. */
export function listTraces(): PipelineTrace[] {
  try {
    const tracesDir = getTracesDir();
    if (!existsSync(tracesDir)) return [];
    const files = readdirSync(tracesDir).filter((f) => f.endsWith(".json")).sort();
    return files.flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(tracesDir, f), "utf-8")) as PipelineTrace];
      } catch {
        logger.warn("trace", `Skipping corrupt trace file: ${f}`);
        return [];
      }
    });
  } catch {
    return [];
  }
}

export interface TraceQuery {
  status?: PipelineStatus;
  mode?: "pipeline" | "race";
  since?: string;   // ISO date string
  until?: string;   // ISO date string
  limit?: number;
  traceId?: string;
  sessionId?: string;
}

/** Filter traces by status, mode, date range, and limit. */
export function queryTraces(query: TraceQuery = {}): PipelineTrace[] {
  if (query.traceId) {
    const one = loadTraceById(query.traceId);
    return one ? [one] : [];
  }

  let traces = listTraces();

  if (query.sessionId) {
    traces = traces.filter((t) => t.sessionId === query.sessionId);
  }
  if (query.status) {
    traces = traces.filter((t) => t.finalStatus === query.status);
  }
  if (query.mode) {
    traces = traces.filter((t) => t.mode === query.mode);
  }
  if (query.since) {
    traces = traces.filter((t) => t.timestamp >= query.since!);
  }
  if (query.until) {
    traces = traces.filter((t) => t.timestamp <= query.until!);
  }
  if (query.limit && query.limit > 0) {
    traces = traces.slice(-query.limit);
  }

  return traces;
}

export interface ProviderStat {
  stepCount: number;
  successfulStepCount: number;
  failedStepCount: number;
  successRate: number;
  failureRate: number;
  totalDurationMs: number;
  avgDurationMs: number;
  durationP50Ms?: number;
  durationP95Ms?: number;
  durationP99Ms?: number;
  totalTokens: number;
  avgTokensPerStep: number;
}

// --- Token Economics ---

export interface TokenEconomics {
  /** Total tokens across all queried traces. */
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  /** Average tokens per pipeline run. */
  avgTokensPerTrace: number;
  /** Tokens saved by cache hits (steps with cached=true). */
  cachedStepCount: number;
  /** Per-provider token breakdown. */
  providerTokens: Record<string, { promptTokens: number; completionTokens: number; total: number }>;
}

/**
 * Compare token economics between two sets of traces (e.g. cold vs warm runs).
 * Returns the ratio and absolute savings.
 */
export interface TokenComparison {
  baselineTokens: number;
  comparisonTokens: number;
  /** comparisonTokens / baselineTokens (< 1 means savings). */
  ratio: number;
  /** Absolute token savings (baseline - comparison). */
  savedTokens: number;
  /** Percentage saved (0-100). */
  savedPercent: number;
}

export function computeTokenEconomics(traces: PipelineTrace[]): TokenEconomics {
  let totalPrompt = 0;
  let totalCompletion = 0;
  let cachedStepCount = 0;
  const providerTokens: Record<string, { promptTokens: number; completionTokens: number; total: number }> = {};

  for (const trace of traces) {
    if (trace.totalUsage) {
      totalPrompt += trace.totalUsage.promptTokens;
      totalCompletion += trace.totalUsage.completionTokens;
    }
    for (const step of trace.steps) {
      if (step.cached) cachedStepCount++;
      if (step.usage) {
        const entry = providerTokens[step.provider] ??= { promptTokens: 0, completionTokens: 0, total: 0 };
        entry.promptTokens += step.usage.promptTokens;
        entry.completionTokens += step.usage.completionTokens;
        entry.total += step.usage.promptTokens + step.usage.completionTokens;
      }
    }
  }

  const totalTokens = totalPrompt + totalCompletion;
  return {
    totalPromptTokens: totalPrompt,
    totalCompletionTokens: totalCompletion,
    totalTokens,
    avgTokensPerTrace: traces.length > 0 ? totalTokens / traces.length : 0,
    cachedStepCount,
    providerTokens,
  };
}

export function compareTraceEconomics(
  baseline: PipelineTrace[],
  comparison: PipelineTrace[],
): TokenComparison {
  const baseEcon = computeTokenEconomics(baseline);
  const compEcon = computeTokenEconomics(comparison);
  const saved = baseEcon.totalTokens - compEcon.totalTokens;
  return {
    baselineTokens: baseEcon.totalTokens,
    comparisonTokens: compEcon.totalTokens,
    ratio: baseEcon.totalTokens > 0 ? compEcon.totalTokens / baseEcon.totalTokens : 1,
    savedTokens: saved,
    savedPercent: baseEcon.totalTokens > 0 ? (saved / baseEcon.totalTokens) * 100 : 0,
  };
}

export interface TraceStats {
  totalTraces: number;
  approvedCount: number;
  failedCount: number;
  maxRoundsCount: number;
  approvalRate: number;
  avgDurationMs: number;
  avgRounds: number;
  providerStats: Record<string, ProviderStat>;
  tokenEconomics: TokenEconomics;
}

/** Compute aggregate statistics across all traces. */
export function aggregateTraceStats(query?: TraceQuery): TraceStats {
  const traces = query ? queryTraces(query) : listTraces();

  const emptyEconomics: TokenEconomics = {
    totalPromptTokens: 0, totalCompletionTokens: 0, totalTokens: 0,
    avgTokensPerTrace: 0, cachedStepCount: 0, providerTokens: {},
  };

  if (traces.length === 0) {
    return {
      totalTraces: 0,
      approvedCount: 0,
      failedCount: 0,
      maxRoundsCount: 0,
      approvalRate: 0,
      avgDurationMs: 0,
      avgRounds: 0,
      providerStats: {},
      tokenEconomics: emptyEconomics,
    };
  }

  const approvedCount = traces.filter((t) => t.finalStatus === "approved").length;
  const failedCount = traces.filter((t) => t.finalStatus === "failed").length;
  const maxRoundsCount = traces.filter((t) => t.finalStatus === "max_rounds").length;
  const totalDuration = traces.reduce((sum, t) => sum + t.totalDurationMs, 0);
  const totalRounds = traces.reduce((sum, t) => sum + t.totalRounds, 0);

  const nowMs = Date.now();
  const providerMap = new Map<
    string,
    { weight: number; successful: number; failed: number; totalMs: number; tokens: number; durations: number[] }
  >();
  for (const trace of traces) {
    const w = traceRecencyWeight(trace.timestamp, nowMs);
    for (const step of trace.steps) {
      const entry = providerMap.get(step.provider) ?? {
        weight: 0,
        successful: 0,
        failed: 0,
        totalMs: 0,
        tokens: 0,
        durations: [],
      };
      entry.weight += w;
      entry.totalMs += step.durationMs * w;
      entry.durations.push(step.durationMs);
      if (step.usage) entry.tokens += step.usage.promptTokens + step.usage.completionTokens;
      if (step.error) entry.failed += w;
      else entry.successful += w;
      providerMap.set(step.provider, entry);
    }
  }

  const providerStats: Record<string, ProviderStat> = {};
  for (const [name, entry] of providerMap) {
    const weight = entry.weight || 1;
    const successRate = entry.successful / weight;
    const failureRate = entry.failed / weight;
    const sortedDurations = [...entry.durations].sort((a, b) => a - b);
    providerStats[name] = {
      stepCount: Math.round(weight * 100) / 100,
      successfulStepCount: Math.round(entry.successful * 100) / 100,
      failedStepCount: Math.round(entry.failed * 100) / 100,
      successRate,
      failureRate,
      totalDurationMs: entry.totalMs,
      avgDurationMs: entry.totalMs / weight,
      durationP50Ms: percentile(sortedDurations, 50),
      durationP95Ms: percentile(sortedDurations, 95),
      durationP99Ms: percentile(sortedDurations, 99),
      totalTokens: entry.tokens,
      avgTokensPerStep: weight > 0 ? entry.tokens / weight : 0,
    };
  }

  return {
    totalTraces: traces.length,
    approvedCount,
    failedCount,
    maxRoundsCount,
    approvalRate: approvedCount / traces.length,
    avgDurationMs: totalDuration / traces.length,
    avgRounds: totalRounds / traces.length,
    providerStats,
    tokenEconomics: computeTokenEconomics(traces),
  };
}
