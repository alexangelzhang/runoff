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
  error?: string;
  /** Non-fatal warnings (trace persist, enrichment, etc.). */
  warnings?: string[];
}
