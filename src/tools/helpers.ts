/**
 * Shared types and helper functions used across MCP tool modules.
 */

import { loadConfig } from "../config.js";
import { isTextResponse, isAgentMode, LLMResponse, ProviderMode } from "../providers/types.js";
import { SessionWorkspace } from "../workspace.js";
import { StepResult, PipelineStatus } from "../state.js";
import { StepTrace } from "../trace.js";

// --- Stage outcome types ---

export interface SkippedOutcome {
  skipped: true;
  stepName: string;
}

export interface BuiltinOutcome {
  builtin: true;
  stepName: string;
}

export interface ExecutedOutcome {
  stepName: string;
  response: LLMResponse;
  usedProvider: string;
  routedProvider: string | undefined;
  usedFallback: boolean;
  stepDurationMs: number;
}

export type StageOutcome = SkippedOutcome | BuiltinOutcome | ExecutedOutcome;

// --- Race session registry ---

export interface RaceSession {
  traceId: string;
  repoRoot: string;
  candidates: Array<{
    providerName: string;
    workspace?: SessionWorkspace;
    patchText?: string;
    filesModified?: string[];
    diffStat?: string;
  }>;
  createdAt: number;
}

export const raceSessions = new Map<string, RaceSession>();

const RACE_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function cleanupStaleRaceSessions(): void {
  const now = Date.now();
  for (const [id, session] of raceSessions) {
    if (now - session.createdAt > RACE_SESSION_TTL_MS) {
      for (const c of session.candidates) {
        c.workspace?.destroy().catch(() => {});
      }
      raceSessions.delete(id);
    }
  }
}

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

export type PipelineConfig = ReturnType<typeof loadConfig>;

export function canRouteStepToProvider(stepName: string, providerName: string, config: PipelineConfig): boolean {
  return true; // Simple stub for alignment
}

export function ensureWorkDirForStep(stepName: string, config: PipelineConfig, workDir?: string): void {
  // Simple stub for alignment
}

export function pipelineHasAgentWriteStep(config: PipelineConfig): boolean {
  return true; // Simple stub for alignment
}

export function truncateString(str: string, maxLen: number): string {
  if (!str || str.length <= maxLen) return str;
  const half = Math.floor(maxLen / 2);
  return str.slice(0, half) + `\n\n... [TRUNCATED] ...\n\n` + str.slice(str.length - half);
}

export function getRawContent(response: LLMResponse): string {
  if (isTextResponse(response)) return response.content;
  return response.summary;
}

export function serializeResponse(response: LLMResponse): any {
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
    usage: response.usage
  };
}
