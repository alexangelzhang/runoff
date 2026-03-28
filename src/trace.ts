/**
 * Pipeline execution trace recorder.
 * Writes structured JSON traces to ~/.llm-pipeline/traces/ for data flywheel analysis.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getTracesDir } from "./paths.js";
import { PipelineStatus } from "./state.js";

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
  } catch {
    // Non-critical — don't break pipeline if trace write fails
  }
}

/** Update an existing trace by ID. Reads, patches, and rewrites the trace file. */
export function updateTrace(traceId: string, patch: Partial<PipelineTrace>): boolean {
  try {
    const tracesDir = getTracesDir();
    if (!existsSync(tracesDir)) return false;
    const files = readdirSync(tracesDir).filter((f) => f.endsWith(".json") && f.includes(traceId));
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
        console.error(`Skipping corrupt trace file: ${f}`);
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
}

/** Filter traces by status, mode, date range, and limit. */
export function queryTraces(query: TraceQuery = {}): PipelineTrace[] {
  let traces = listTraces();

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
  totalDurationMs: number;
  avgDurationMs: number;
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
}

/** Compute aggregate statistics across all traces. */
export function aggregateTraceStats(query?: TraceQuery): TraceStats {
  const traces = query ? queryTraces(query) : listTraces();

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
    };
  }

  const approvedCount = traces.filter((t) => t.finalStatus === "approved").length;
  const failedCount = traces.filter((t) => t.finalStatus === "failed").length;
  const maxRoundsCount = traces.filter((t) => t.finalStatus === "max_rounds").length;
  const totalDuration = traces.reduce((sum, t) => sum + t.totalDurationMs, 0);
  const totalRounds = traces.reduce((sum, t) => sum + t.totalRounds, 0);

  // Per-provider stats from step traces
  const providerMap = new Map<string, { count: number; totalMs: number }>();
  for (const trace of traces) {
    for (const step of trace.steps) {
      const entry = providerMap.get(step.provider) ?? { count: 0, totalMs: 0 };
      entry.count++;
      entry.totalMs += step.durationMs;
      providerMap.set(step.provider, entry);
    }
  }

  const providerStats: Record<string, ProviderStat> = {};
  for (const [name, entry] of providerMap) {
    providerStats[name] = {
      stepCount: entry.count,
      totalDurationMs: entry.totalMs,
      avgDurationMs: entry.totalMs / entry.count,
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
  };
}
