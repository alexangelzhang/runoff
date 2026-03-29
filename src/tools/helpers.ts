/**
 * Shared types and helper functions used across MCP tool modules.
 */

import { isTextResponse, LLMResponse, type AgentWorkspaceArtifact } from "../providers/types.js";
import { type StepResult, type PipelineStatus } from "../state.js";

// --- Pipeline interface types ---

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
}

// --- Helper functions ---

export type { PipelineConfig } from "../config.js";

export type SerializedTextResponse = {
  kind: "text";
  model: string;
  code: string;
  explanation: string;
  usage?: { promptTokens: number; completionTokens: number };
};

export type SerializedAgentResponse = {
  kind: "agent";
  model: string;
  summary: string;
  changes: string;
  filesModified: string[];
  diffStat: string;
  workspace?: AgentWorkspaceArtifact;
  usage?: { promptTokens: number; completionTokens: number };
};

export type SerializedLLMResponse = SerializedTextResponse | SerializedAgentResponse;

export function serializeResponse(response: LLMResponse): SerializedLLMResponse {
  if (isTextResponse(response)) {
    return {
      kind: "text",
      model: response.model,
      code: response.code,
      explanation: response.explanation,
      usage: response.usage
    };
  }
  return {
    kind: "agent",
    model: response.model,
    summary: response.summary,
    changes: response.changes,
    filesModified: response.filesModified,
    diffStat: response.diffStat,
    workspace: response.workspace,
    usage: response.usage
  };
}
