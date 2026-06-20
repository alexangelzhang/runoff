/**
 * Pipeline run request/result types (MCP + CLI + orchestration).
 * Kept in core/ so orchestration does not depend on src/tools/.
 */

import type { StepResult, PipelineStatus } from "./state.js";

export interface PipelineParams {
  prompt: string;
  language?: string;
  context?: string;
  workDir?: string;
  acceptanceCriteria?: string[];
  verifyResults?: string;
  configHash?: string;
  sessionId?: string;
  maxRounds?: number;
  setPipelineTraceId?: (id: string) => void;
  signal?: AbortSignal;
  /** Resume a run paused for human approval (`awaiting_approval`). */
  approvalDecision?: "approve" | "reject";
  approvalReason?: string;
}

/** A past race pattern surfaced at judge-pause time so the human judge has evidence. */
export interface HistoricalPattern {
  /** Plain-text summary of what the pattern captured. */
  summary: string;
  /** The traceId of the race run that produced this pattern. */
  evidenceTraceId: string;
  /** The provider that won in that historical race (if recorded). */
  winnerProvider?: string;
}

export interface PipelineResult {
  status: PipelineStatus;
  rounds: number;
  totalDurationMs: number;
  totalCostUSD: number;
  checkpointFile: string;
  traceId: string;
  stepResults: Record<string, StepResult>;
  usage: { promptTokens: number; completionTokens: number };
  costBreakdown: Record<string, number>;
  observation?: PipelineObservation;
  error?: string;
  /** Non-fatal warnings (trace persist, enrichment, etc.). */
  warnings?: string[];
  /**
   * Relevant historical race patterns retrieved at judge-pause time.
   * Each entry traces back to a specific past run via evidenceTraceId,
   * making the memory auditable: "this suggestion came from run X".
   * Only populated when status === "awaiting_judge".
   */
  historicalPatterns?: HistoricalPattern[];
}

export interface PipelineObservationStepRef {
  stepName: string;
  status: StepResult["status"];
  round?: number;
  summary?: string;
}

export interface PipelineObservation {
  schemaVersion: 1;
  action: "pipeline_result";
  purpose: string;
  status: PipelineStatus;
  summary: string;
  evidence: string[];
  coverageGaps: string[];
  stepRefs: PipelineObservationStepRef[];
  traceRef: { traceId: string };
  checkpointRef?: { sessionId: string; status: PipelineStatus };
  nextHint?: string;
}
