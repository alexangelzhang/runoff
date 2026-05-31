/**
 * Agent message types (Wave 7.2).
 *
 * Typed messages for inter-agent communication within a pipeline run.
 * Each message has a discriminant `type` field.
 */

import type { AgentId } from "./multi-agent-types.js";

// --- Message Types ---

export type AgentMessageType =
  | "task_delegation"
  | "result_report"
  | "feedback"
  | "handoff"
  | "knowledge_share";

interface MessageBase {
  id: string;
  type: AgentMessageType;
  from: AgentId;
  to: AgentId;
  timestamp: number;
  /** Optional correlation id to group related messages (e.g. request/response). */
  correlationId?: string;
}

/** Orchestrator assigns a task to a worker. */
export interface TaskDelegationMessage extends MessageBase {
  type: "task_delegation";
  payload: {
    stepName: string;
    prompt: string;
    round: number;
    context?: string;
  };
}

/** Worker reports execution result back. */
export interface ResultReportMessage extends MessageBase {
  type: "result_report";
  payload: {
    stepName: string;
    success: boolean;
    durationMs: number;
    artifactKind?: string;
    error?: string;
  };
}

/** Reviewer sends feedback to a worker. */
export interface FeedbackMessage extends MessageBase {
  type: "feedback";
  payload: {
    approved: boolean;
    feedback: string;
    stepName?: string;
  };
}

/** Control transfer from one agent to another. */
export interface HandoffMessage extends MessageBase {
  type: "handoff";
  payload: {
    reason: string;
    contextKeys?: string[];
  };
}

/** Directed knowledge sharing between agents. */
export interface KnowledgeShareMessage extends MessageBase {
  type: "knowledge_share";
  payload: {
    entries: Record<string, string>;
  };
}

export type AgentMessage =
  | TaskDelegationMessage
  | ResultReportMessage
  | FeedbackMessage
  | HandoffMessage
  | KnowledgeShareMessage;
