/**
 * Execution governance — Policy → Guardrails → Approval (Phase 2 + 7.7/7.8).
 */

import type { PipelineConfig, PipelineRuntimeConfig } from "../core/config.js";
import type { SchedulerContext } from "./step-execution.js";
import type { AgentTask, AgentResult } from "./agent.js";
import type { AgentId, AgentRole } from "./multi-agent-types.js";
import { agentId } from "./multi-agent-types.js";
import {
  PolicyEngine,
  type PolicyDecision,
  type PolicyRequest,
  type PolicyResult,
  type PolicyRule,
} from "./policy.js";
import {
  buildGuardrailsFromConfig,
  runInputGuardrails,
  runOutputGuardrails,
  type InputGuardrail,
  type OutputGuardrail,
} from "./guardrails.js";
import { ApprovalManager, type PendingAction, type RiskLevel } from "./approval.js";
import { createApprovalGate, ApprovalDeferredError } from "./approval-adapters.js";
import type { ApprovalGate, ApprovalResponse } from "./approval.js";
import type { RunStore } from "./run-store.js";
import { pauseRunForApproval } from "./run-control.js";
import type { RunState } from "./run-store.js";
import type { EventLog } from "./event-log.js";
import {
  createApprovalAuditSink,
  type ApprovalAuditSink,
  type ApprovalPhase,
} from "./approval-audit.js";
import { renderPrompt } from "../pipeline/prompt.js";
import { buildStructuredPromptForStep } from "./step-strategy.js";

export class PolicyDenialError extends Error {
  readonly result: PolicyResult;

  constructor(result: PolicyResult) {
    super(result.reason ?? `Policy denied: ${result.matchedRule ?? "default"}`);
    this.name = "PolicyDenialError";
    this.result = result;
  }
}

export class PipelineAwaitingApprovalError extends Error {
  readonly runId: string;
  readonly pending: NonNullable<RunState["pendingApproval"]>;

  constructor(runId: string, pending: NonNullable<RunState["pendingApproval"]>) {
    super(`Pipeline paused for approval: ${pending.action}`);
    this.name = "PipelineAwaitingApprovalError";
    this.runId = runId;
    this.pending = pending;
  }
}

export type GovernanceConfig = NonNullable<PipelineRuntimeConfig["governance"]>;

export class ExecutionGovernance {
  readonly policy: PolicyEngine;
  readonly inputGuardrails: InputGuardrail[];
  readonly outputGuardrails: OutputGuardrail[];
  readonly approval: ApprovalManager;
  private readonly approvalMode: "auto" | "defer" | "callback";
  private readonly runStore?: RunStore;
  private readonly runId?: string;
  private readonly audit?: ApprovalAuditSink;

  constructor(
    policy: PolicyEngine,
    inputGuardrails: InputGuardrail[],
    outputGuardrails: OutputGuardrail[],
    approval: ApprovalManager,
    options: {
      approvalMode?: "auto" | "defer" | "callback";
      runStore?: RunStore;
      runId?: string;
      audit?: ApprovalAuditSink;
    } = {},
  ) {
    this.policy = policy;
    this.inputGuardrails = inputGuardrails;
    this.outputGuardrails = outputGuardrails;
    this.approval = approval;
    this.approvalMode = options.approvalMode ?? "auto";
    this.runStore = options.runStore;
    this.runId = options.runId;
    this.audit = options.audit;
  }

  async beforeStep(input: {
    agentId: AgentId;
    role: AgentRole;
    task: AgentTask;
    action?: string;
    targetPath?: string;
    risk?: RiskLevel;
  }): Promise<void> {
    const action = input.action ?? "execute_step";
    const policyResult = this.policy.evaluate({
      agentId: input.agentId,
      role: input.role,
      action,
      targetPath: input.targetPath,
      metadata: { stepName: input.task.stepName, round: input.task.round },
    });

    if (policyResult.decision === "deny") {
      throw new PolicyDenialError(policyResult);
    }

    if (policyResult.decision === "require-approval") {
      await this.resolveApproval({
        agentId: input.agentId,
        action,
        targetPath: input.targetPath,
        risk: input.risk ?? "medium",
        description: `Policy requires approval for ${action} on step ${input.task.stepName}`,
        context: { policy: policyResult, task: input.task },
      });
    }

    await runInputGuardrails(this.inputGuardrails, input.task);
  }

  async afterStep(result: AgentResult): Promise<void> {
    await runOutputGuardrails(this.outputGuardrails, result);
  }

  private async resolveApproval(input: {
    agentId: AgentId;
    action: string;
    targetPath?: string;
    risk: RiskLevel;
    description: string;
    context?: unknown;
  }): Promise<void> {
    const pending: PendingAction = {
      agentId: input.agentId,
      action: input.action,
      targetPath: input.targetPath,
      risk: input.risk,
    };

    try {
      const response = await this.approval.requestApproval(pending, input.description, input.context);
      if (response.decision === "reject") {
        throw new PolicyDenialError({
          decision: "deny",
          reason: response.reason,
          matchedRule: "approval-rejected",
        });
      }
    } catch (err: unknown) {
      if (!(err instanceof ApprovalDeferredError)) throw err;
      if (this.approvalMode !== "defer" || !this.runStore || !this.runId) {
        throw err;
      }
      const run = this.runStore.load(this.runId);
      if (!run) throw err;
      const pendingApproval = {
        agentId: input.agentId,
        action: input.action,
        description: input.description,
        requestedAt: err.request.requestedAt,
        requestId: err.request.id,
        phase: "action" as ApprovalPhase,
      };
      pauseRunForApproval(this.runStore, run, pendingApproval);
      throw new PipelineAwaitingApprovalError(this.runId, pendingApproval);
    }
  }
}

export function schedulerContextToAgentTask(
  stepName: string,
  ctx: SchedulerContext,
  reviewStepName: string,
): AgentTask {
  const structured = buildStructuredPromptForStep({
    stepName,
    reviewStepName,
    spec: ctx.prompt,
    round: ctx.round,
    globalKnowledge: ctx.globalKnowledge,
    candidate: ctx.candidate,
    acceptanceCriteria: ctx.acceptanceCriteria,
    verifyResults: ctx.verifyResults,
    lastReviewFeedback: ctx.lastReviewFeedback,
    context: ctx.context,
  });
  return {
    stepName,
    prompt: renderPrompt(structured),
    round: ctx.round,
    language: ctx.language,
    context: ctx.context,
    workDir: ctx.workDir,
    sessionId: ctx.sessionId,
    sharedKnowledge: ctx.globalKnowledge,
    reviewFeedback: ctx.lastReviewFeedback,
    signal: ctx.signal,
  };
}

export function roleForStep(stepName: string, reviewStepName: string): AgentRole {
  return stepName === reviewStepName ? "reviewer" : "worker";
}

export function createExecutionGovernance(
  config: PipelineConfig,
  deps?: {
    runStore?: RunStore;
    runId?: string;
    eventLog?: EventLog;
    approvalGate?: ApprovalGate;
    approvalCallback?: (request: import("./approval.js").ApprovalRequest) => Promise<ApprovalResponse>;
  },
): ExecutionGovernance | undefined {
  const gov = config.runtime?.governance;
  if (!gov?.enabled) return undefined;

  const defaultPolicy: PolicyDecision = gov.defaultPolicy ?? "allow";
  const policy = new PolicyEngine(defaultPolicy);
  const rules = gov.rules?.length ? gov.rules : defaultGovernanceRules();
  for (const rule of rules) {
    policy.addRule(rule);
  }

  const audit =
    deps?.eventLog && deps?.runId ? createApprovalAuditSink(deps.eventLog, deps.runId) : undefined;

  const { input: inputGuardrails, output: outputGuardrails } = buildGuardrailsFromConfig(gov);

  const gate = deps?.approvalGate ?? createApprovalGate(config.runtime, deps?.approvalCallback);
  const approval = new ApprovalManager(gate, {
    onRequested: audit ? (req) => audit.emitRequested(req, "action") : undefined,
    onRecord: audit ? (record) => audit.emitResolved(record, "action") : undefined,
  });

  return new ExecutionGovernance(policy, inputGuardrails, outputGuardrails, approval, {
    approvalMode: gov.approvalMode ?? "auto",
    runStore: deps?.runStore,
    runId: deps?.runId,
    audit,
  });
}

/** Default rules for agent-write steps touching repo paths. */
export function defaultGovernanceRules(): PolicyRule[] {
  return [
    {
      name: "deny-env-files",
      action: "execute_step",
      pathPrefix: ".env",
      decision: "deny",
    },
    {
      name: "approve-high-risk-delete",
      action: "delete",
      decision: "require-approval",
    },
  ];
}
