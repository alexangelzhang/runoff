/**
 * WIP scaffolding for multi-agent orchestration types — not wired into run-pipeline yet.
 * (Incremental integration will connect this module to the pipeline runner.)
 */

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

/** Fixed roles for a minimal multi-agent graph. */
export type AgentRole = "orchestrator" | "worker" | "reviewer";

export type AgentDescriptor = {
  id: AgentId;
  role: AgentRole;
  capabilities?: string[];
};

export type AgentState = {
  id: AgentId;
  lastStep?: string;
  knowledge?: Record<string, string>;
  candidateRef?: string;
};

export type OrchestrationEvent =
  | { type: "step_started"; agentId: AgentId; stepId: string }
  | {
      type: "step_finished";
      agentId: AgentId;
      stepId: string;
      ok: boolean;
    }
  | { type: "graph_patched"; patchId: string; summary?: string }
  | { type: "handoff"; from: AgentId; to: AgentId; reason?: string };
