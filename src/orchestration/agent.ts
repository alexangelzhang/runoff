/**
 * Agent abstraction layer (Wave 7.1).
 *
 * Promotes pipeline steps from anonymous executors to first-class agents
 * with identity, role, capabilities, state, and provider binding.
 */

import type { AgentId, AgentRole } from "./multi-agent-types.js";
import type { AgentState } from "./agent-state.js";
import type { LLMProvider, LLMResponse } from "../providers/types.js";

// --- Agent Configuration (static, from config) ---

export type AgentCapability =
  | "plan"
  | "implement"
  | "refactor"
  | "review"
  | "verify"
  | "analyze"
  | "delegate"
  | (string & {});

export interface AgentConfig {
  id: AgentId;
  role: AgentRole;
  providerName: string;
  capabilities: AgentCapability[];
  /** Max rounds this agent may execute before forced stop. */
  maxRounds?: number;
}

// --- Agent Task & Result (per-execution) ---

export interface AgentTask {
  stepName: string;
  prompt: string;
  round: number;
  language?: string;
  context?: string;
  workDir?: string;
  sessionId: string;
  /** Knowledge shared by other agents or the orchestrator. */
  sharedKnowledge?: Record<string, string>;
  /** Feedback from a previous review pass. */
  reviewFeedback?: string;
  signal?: AbortSignal;
}

export interface AgentResult {
  agentId: AgentId;
  stepName: string;
  response: LLMResponse;
  durationMs: number;
  /** Insights this agent wants to share with others. */
  insights?: Record<string, string>;
}

// --- Agent Instance (runtime, stateful) ---

export interface AgentInstance {
  readonly id: AgentId;
  readonly role: AgentRole;
  readonly capabilities: readonly AgentCapability[];
  readonly provider: LLMProvider;
  readonly state: AgentState;

  /** Execute a task and return the result. */
  execute(task: AgentTask): Promise<AgentResult>;

  /** Tear down any resources held by this agent. */
  dispose(): void;
}
