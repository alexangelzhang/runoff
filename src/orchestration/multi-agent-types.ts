/**
 * Core multi-agent orchestration types (Wave 7.1).
 *
 * Foundational branded types, roles, and event definitions used across
 * agent.ts, registry.ts, agent-state.ts, and future orchestrator modules.
 */

// --- Branded Agent Identifier ---

/** Branded agent identifier — use {@link agentId} to construct. */
export type AgentId = string & { readonly __brand: "AgentId" };

const AGENT_ID_PATTERN = /^[\w.-]{1,128}$/;

export function agentId(value: string): AgentId {
  const t = value.trim();
  if (!t || !AGENT_ID_PATTERN.test(t)) {
    throw new Error(
      `Invalid agentId: expected 1-128 chars [A-Za-z0-9_.-], got ${JSON.stringify(value)}`
    );
  }
  return t as AgentId;
}

// --- Agent Roles ---

/** Fixed roles for a multi-agent graph. */
export type AgentRole = "orchestrator" | "worker" | "reviewer";

// --- Agent Descriptor (lightweight, config-level) ---

export type AgentDescriptor = {
  id: AgentId;
  role: AgentRole;
  capabilities?: string[];
};

// --- Orchestration Events ---

export type OrchestrationEvent =
  | { type: "agent_registered"; agentId: AgentId; role: AgentRole }
  | { type: "agent_disposed"; agentId: AgentId }
  | {
      type: "step_started";
      agentId: AgentId;
      stepId: string;
      spanId?: string;
      parentSpanId?: string;
    }
  | {
      type: "step_finished";
      agentId: AgentId;
      stepId: string;
      ok: boolean;
      durationMs?: number;
      spanId?: string;
      parentSpanId?: string;
    }
  | { type: "graph_patched"; patchId: string; summary?: string }
  | { type: "handoff"; from: AgentId; to: AgentId; reason?: string }
  | { type: "knowledge_shared"; from: AgentId; to: AgentId; keys: string[] }
  | { type: "plan_created"; agentId: AgentId; steps: Array<string | string[]> }
  | {
      type: "plan_revision";
      agentId: AgentId;
      steps: Array<string | string[]>;
      trigger: "review_revision" | "step_failure";
    }
  | {
      type: "approval_requested";
      requestId: string;
      agentId: AgentId;
      action: string;
      phase: "plan" | "action";
      description: string;
      risk?: "low" | "medium" | "high";
      requestedAt: number;
    }
  | {
      type: "approval_resolved";
      requestId: string;
      agentId: AgentId;
      action: string;
      phase: "plan" | "action";
      decision: string;
      respondedAt: number;
      respondedBy?: string;
      reason?: string;
    };
