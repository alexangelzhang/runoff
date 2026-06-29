/**
 * Helpers for pipeline-runner DAG loop (step outcomes, stage resolution).
 */
import type { PipelineConfig } from "../core/config.js";
import { getDagStages } from "../core/config.js";
import type { ResumeReusePlanEntry, ResumeReusePlanReport, StepResult } from "../core/state.js";
import type { Candidate } from "../core/candidate.js";
import { emptyCandidate } from "../core/candidate.js";
import type { StepOutcome } from "./step-execution.js";
import type { AgentResult } from "./agent.js";
import { agentId } from "./multi-agent-types.js";
import {
  agentGraphToStages,
  type AgentGraph,
} from "./agent-graph.js";
import type { ExecutionPlan } from "./orchestrator.js";
import { executionPlanToStages } from "./plan-scheduler.js";

export function failedStepOutcome(stepName: string, round: number, error: string): StepOutcome {
  return {
    stepName,
    usedProvider: "governance",
    upgraded: false,
    durationMs: 0,
    trace: { name: stepName, provider: "governance", durationMs: 0, round, error },
    response: {
      kind: "text",
      model: "governance",
      content: "",
      code: "",
      explanation: "",
      failed: true,
      error,
    },
  };
}

export function outcomeToAgentResult(outcome: StepOutcome): AgentResult {
  return {
    agentId: agentId(outcome.stepName),
    stepName: outcome.stepName,
    response: outcome.response,
    durationMs: outcome.durationMs,
  };
}

export function isStepCompletedForRound(
  stepResults: Record<string, StepResult>,
  stepName: string,
  round: number,
): boolean {
  const result = stepResults[stepName];
  if (!result || result.round !== round) return false;
  return result.status === "success" || result.status === "skipped";
}

function isCompletedResultForRound(result: StepResult | undefined, round: number): result is StepResult {
  return Boolean(
    result &&
      result.round === round &&
      (result.status === "success" || result.status === "skipped"),
  );
}

function buildDependentIndex(
  pipeline: PipelineConfig["pipeline"],
): Map<string, Set<string>> {
  const dependents = new Map<string, Set<string>>();
  for (const stepName of Object.keys(pipeline)) {
    dependents.set(stepName, new Set());
  }
  for (const [stepName, tuple] of Object.entries(pipeline)) {
    const [, ...deps] = tuple;
    for (const dep of deps) {
      const list = dependents.get(dep) ?? new Set<string>();
      list.add(stepName);
      dependents.set(dep, list);
    }
  }
  return dependents;
}

function collectTransitiveDependents(
  seed: Iterable<string>,
  dependents: Map<string, Set<string>>,
): Map<string, { reason: string; downstreamOf: string }> {
  const reasons = new Map<string, { reason: string; downstreamOf: string }>();
  const queue = [...seed];
  while (queue.length) {
    const upstream = queue.shift()!;
    for (const downstream of dependents.get(upstream) ?? []) {
      if (reasons.has(downstream)) continue;
      reasons.set(downstream, {
        reason: `downstream dependency ${upstream} must rerun on resume`,
        downstreamOf: upstream,
      });
      queue.push(downstream);
    }
  }
  return reasons;
}

function markStepForResumeRerun(
  stepResults: Record<string, StepResult>,
  stepName: string,
  round: number,
  reason: string,
): boolean {
  const prior = stepResults[stepName];
  if (!isCompletedResultForRound(prior, round)) return false;
  stepResults[stepName] = {
    status: "queued",
    round,
    provider: prior.provider,
    routedFrom: prior.routedFrom,
    kind: prior.kind,
    model: prior.model,
    contextContract: prior.contextContract,
    reason,
    resumeMetadata: prior.resumeMetadata
      ? {
          ...prior.resumeMetadata,
          canSkipOnResume: false,
          rerunReason: reason,
          mustRerunReason: reason,
          skipReason: undefined,
        }
      : undefined,
  };
  return true;
}

export interface ResumeStepReusePlan {
  rerunSteps: Array<{ stepName: string; reason: string }>;
  skippedSteps: Array<{ stepName: string; reason: string }>;
  report: ResumeReusePlanReport;
}

/**
 * Apply P3 resume reuse decisions before the DAG loop starts.
 *
 * Backward compatibility: legacy success results without resumeMetadata keep the
 * pre-P3 behavior and are considered skippable. When metadata exists, an
 * explicit `canSkipOnResume=false` wins and invalidates transitive downstream
 * completed results in the same round.
 */
export function applyResumeStepReusePlan(input: {
  stepResults: Record<string, StepResult>;
  pipeline: PipelineConfig["pipeline"];
  round: number;
}): ResumeStepReusePlan {
  const { stepResults, pipeline, round } = input;
  const rerunReasons = new Map<string, string>();
  const downstreamOfByStep = new Map<string, string>();
  const skippedSteps: Array<{ stepName: string; reason: string }> = [];

  for (const stepName of Object.keys(pipeline)) {
    const result = stepResults[stepName];
    if (!isCompletedResultForRound(result, round)) continue;
    if (!result.resumeMetadata) {
      skippedSteps.push({ stepName, reason: "legacy completed result has no resume metadata" });
      continue;
    }
    if (result.resumeMetadata.canSkipOnResume) {
      skippedSteps.push({ stepName, reason: "resume metadata allows skip" });
      continue;
    }
    rerunReasons.set(
      stepName,
      result.resumeMetadata.mustRerunReason ??
        result.resumeMetadata.rerunReason ??
        "resume metadata requires rerun",
    );
  }

  const dependentReasons = collectTransitiveDependents(
    rerunReasons.keys(),
    buildDependentIndex(pipeline),
  );
  for (const [stepName, dependency] of dependentReasons) {
    if (!isCompletedResultForRound(stepResults[stepName], round)) continue;
    rerunReasons.set(stepName, dependency.reason);
    downstreamOfByStep.set(stepName, dependency.downstreamOf);
  }

  const rerunSteps: Array<{ stepName: string; reason: string }> = [];
  for (const [stepName, reason] of rerunReasons) {
    if (markStepForResumeRerun(stepResults, stepName, round, reason)) {
      rerunSteps.push({ stepName, reason });
    }
  }

  const finalSkippedSteps = skippedSteps.filter((step) => !rerunReasons.has(step.stepName));
  const entries: ResumeReusePlanEntry[] = [
    ...finalSkippedSteps.map((step) => ({
      stepName: step.stepName,
      decision: "skipped" as const,
      reason: step.reason,
      round,
      evidenceRefs: [`stepResults.${step.stepName}.status`, `stepResults.${step.stepName}.resumeMetadata`],
    })),
    ...rerunSteps.map((step) => ({
      stepName: step.stepName,
      decision: "rerun" as const,
      reason: step.reason,
      round,
      downstreamOf: downstreamOfByStep.get(step.stepName),
      evidenceRefs: [`stepResults.${step.stepName}.status`, `stepResults.${step.stepName}.resumeMetadata`],
    })),
  ];
  const report: ResumeReusePlanReport = {
    schemaVersion: 1,
    round,
    entries,
    summary: {
      skipped: finalSkippedSteps.length,
      rerun: rerunSteps.length,
    },
    evidenceRefs: entries.flatMap((entry) => entry.evidenceRefs),
  };

  return {
    rerunSteps,
    skippedSteps: finalSkippedSteps,
    report,
  };
}

export function latestCandidateFromCompletedSteps(
  stepResults: Record<string, StepResult>,
): Candidate {
  const latest = Object.values(stepResults)
    .filter((step) => (step.status === "success" || step.status === "skipped") && step.candidateSnapshot)
    .sort((left, right) => (left.round ?? 0) - (right.round ?? 0))
    .pop();
  return latest?.candidateSnapshot ? ({ ...latest.candidateSnapshot } as Candidate) : emptyCandidate();
}

export function resolvePipelineStages(
  runtimeConfig: PipelineConfig,
  executionPlan?: ExecutionPlan,
  agentGraph?: AgentGraph,
): string[][] {
  if (agentGraph) return agentGraphToStages(agentGraph);
  if (executionPlan) return executionPlanToStages(executionPlan);
  return getDagStages(runtimeConfig);
}
