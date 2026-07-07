import type { PipelineObservation } from "../core/pipeline-run-types.js";
import type {
  ObservationClaim,
  ObservationCoverageGap,
  PipelineStatus,
  ResumeReusePlanReport,
  ScopePreflightReport,
  StepContextContract,
  StepObservation,
  StepResult,
} from "../core/state.js";
import {
  buildStageEvaluationsFromStepResults,
  evaluateStageForStep,
  toStageEvaluationHints,
} from "../observability/stage-evaluation.js";
import {
  buildFallbackStepContextContract,
  buildRequiredEvidenceGaps,
} from "./context-contract.js";
import { summarizeCompletionContract } from "./completion-contract.js";
import type { Artifact } from "./artifacts.js";

function artifactSummary(artifact: Artifact): string | undefined {
  switch (artifact.kind) {
    case "plan":
      return artifact.summary;
    case "code":
      return artifact.explanation;
    case "diff":
      return artifact.summary || artifact.diffStat;
    case "review":
      return artifact.issues?.length ? artifact.issues.join("; ") : undefined;
    case "verdict":
      return artifact.feedback;
    case "patch":
      return artifact.diffStat;
  }
}

function buildEvidence(stepResult: StepResult): string[] {
  const evidence: string[] = [];
  if (stepResult.provider) evidence.push(`provider=${stepResult.provider}`);
  if (stepResult.routedFrom) evidence.push(`routedFrom=${stepResult.routedFrom}`);
  if (stepResult.model) evidence.push(`model=${stepResult.model}`);
  if (stepResult.filesModified?.length) evidence.push(`filesModified=${stepResult.filesModified.join(", ")}`);
  if (stepResult.diffStat) evidence.push(`diffStat=${stepResult.diffStat}`);
  if (stepResult.reason) evidence.push(`reason=${stepResult.reason}`);
  if (stepResult.error) evidence.push(`error=${stepResult.error}`);
  if (stepResult.resumeMetadata?.inputHash) evidence.push(`inputHash=${stepResult.resumeMetadata.inputHash}`);
  for (const ref of stepResult.contextComposition?.contextRefs ?? []) {
    evidence.push(`contextRef=${ref.ref}`);
  }
  return evidence;
}

function aggregatePipelineContextRefs(
  stepResults: Record<string, StepResult>,
): import("../core/state.js").ContextEvidenceRef[] | undefined {
  const seen = new Set<string>();
  const refs: import("../core/state.js").ContextEvidenceRef[] = [];
  for (const step of Object.values(stepResults)) {
    for (const ref of step.contextComposition?.contextRefs ?? []) {
      if (seen.has(ref.ref)) continue;
      seen.add(ref.ref);
      refs.push(ref);
    }
  }
  return refs.length ? refs : undefined;
}

function buildTypedCoverageGaps(stepName: string, stepResult: StepResult): ObservationCoverageGap[] {
  const gaps: ObservationCoverageGap[] = [];
  if (!stepResult.artifacts?.length) {
    gaps.push({
      kind: "evidence",
      detail: "No typed artifact was produced for this step.",
      evidenceRefs: [`stepResults.${stepName}.artifacts`],
    });
  }
  if (!stepResult.filesModified?.length && stepResult.kind === "agent") {
    gaps.push({
      kind: "evidence",
      detail: "No modified files were reported by the agent response.",
      evidenceRefs: [`stepResults.${stepName}.filesModified`],
    });
  }
  if (stepResult.error) {
    gaps.push({
      kind: "process",
      detail: "Step failed before producing a complete successful result.",
      evidenceRefs: [`stepResults.${stepName}.error`],
    });
  }
  if (stepResult.contextComposition?.warnings.length) {
    for (const warning of stepResult.contextComposition.warnings) {
      gaps.push({
        kind: "process",
        detail: warning,
        evidenceRefs: [`stepResults.${stepName}.contextComposition`],
      });
    }
  }
  if (stepResult.contractAssertionCoverage) {
    for (const row of stepResult.contractAssertionCoverage.mappings) {
      if (row.status === "fail" || row.status === "partial") {
        gaps.push({
          kind: "draft",
          detail: `Contract assertion ${row.assertionId} ${row.status}: ${row.detail ?? row.assertion}`,
          evidenceRefs: row.evidenceRefs,
        });
      }
    }
  }
  return gaps;
}

function buildCoverageGaps(stepResult: StepResult): string[] {
  const gaps: string[] = [];
  if (!stepResult.filesModified?.length && stepResult.kind === "agent") {
    gaps.push("No modified files were reported by the agent response.");
  }
  if (!stepResult.artifacts?.length) {
    gaps.push("No typed artifact was produced for this step.");
  }
  if (stepResult.error) {
    gaps.push("Step failed before producing a complete successful result.");
  }
  if (stepResult.contextComposition?.warnings.length) {
    gaps.push(...stepResult.contextComposition.warnings);
  }
  return gaps;
}

function buildStepClaims(
  stepName: string,
  stepResult: StepResult,
  artifactRefs: StepObservation["artifactRefs"],
  evidence: string[],
  stageEvaluation?: StepObservation["stageEvaluation"],
): ObservationClaim[] | undefined {
  const claims: ObservationClaim[] = [];
  const summary = summarizeStep(stepName, stepResult);
  const claimEvidenceRefs = artifactRefs.length
    ? artifactRefs.map((ref) => ref.ref)
    : evidence;

  if (summary) {
    claims.push({ claim: summary, evidenceRefs: claimEvidenceRefs });
  }

  if (stepResult.filesModified?.length) {
    claims.push({
      claim: `Modified ${stepResult.filesModified.length} file(s): ${stepResult.filesModified.join(", ")}.`,
      evidenceRefs: [`stepResults.${stepName}.filesModified`, ...artifactRefs.map((ref) => ref.ref)],
    });
  }

  if (stepResult.diffStat) {
    claims.push({
      claim: `Diff stat: ${stepResult.diffStat}.`,
      evidenceRefs: [`stepResults.${stepName}.diffStat`, ...artifactRefs.map((ref) => ref.ref)],
    });
  }

  const verdictArtifact = stepResult.artifacts?.find((artifact) => artifact.kind === "verdict");
  if (verdictArtifact && verdictArtifact.kind === "verdict") {
    claims.push({
      claim: `Review verdict recorded${verdictArtifact.approved ? " (approved)" : " (needs revision)"}.`,
      evidenceRefs: artifactRefs.filter((ref) => ref.kind === "verdict").map((ref) => ref.ref),
    });
  }

  if (stageEvaluation?.overallStatus === "fail") {
    claims.push({
      claim: `Stage evaluation failed for ${stepName}.`,
      evidenceRefs: [`stepResults.${stepName}.stageEvaluation`],
    });
  }

  if (stepResult.contractAssertionCoverage) {
    const failed = stepResult.contractAssertionCoverage.mappings.filter(
      (row) => row.status === "fail" || row.status === "partial",
    );
    for (const row of failed) {
      claims.push({
        claim: `Contract assertion ${row.assertionId} ${row.status}: ${row.assertion}`,
        evidenceRefs: row.evidenceRefs,
      });
    }
  }

  return claims.length ? claims : undefined;
}

function summarizeStep(stepName: string, stepResult: StepResult): string {
  if (stepResult.error) return `${stepName} ${stepResult.status}: ${stepResult.error}`;
  if (stepResult.summary) return stepResult.summary;
  if (stepResult.explanation) return stepResult.explanation;
  if (stepResult.reason) return stepResult.reason;
  return `${stepName} completed with status ${stepResult.status}.`;
}

export function buildStepObservation(stepName: string, stepResult: StepResult): StepObservation {
  const artifactRefs = (stepResult.artifacts ?? []).map((artifact, index) => ({
    artifactId: artifact.artifactId,
    stepName,
    artifactIndex: index,
    kind: artifact.kind,
    ref: `stepResults.${stepName}.artifacts[${index}]`,
    summary: artifactSummary(artifact),
    producedBy: artifact.producedBy,
  }));
  const contextContract = stepResult.contextContract ?? buildFallbackStepContextContract(stepName, stepResult);
  const evidence = buildEvidence(stepResult);
  const requiredEvidenceGaps = buildRequiredEvidenceGaps(
    stepName,
    stepResult,
    contextContract,
    artifactRefs.length,
  );
  const typedCoverageGaps = [
    ...buildTypedCoverageGaps(stepName, stepResult),
    ...requiredEvidenceGaps,
  ];
  const draftObservation: StepObservation = {
    schemaVersion: 1,
    action: "pipeline_step_result",
    purpose: "",
    status: stepResult.status,
    summary: summarizeStep(stepName, stepResult),
    evidence,
    coverageGaps: [],
    typedCoverageGaps,
    artifactRefs,
    contextContract,
    contextComposition: stepResult.contextComposition,
  };
  const preliminaryClaims = buildStepClaims(stepName, stepResult, artifactRefs, evidence);
  const stageEvaluation = evaluateStageForStep(stepName, stepResult, {
    ...draftObservation,
    claims: preliminaryClaims,
  });
  const claims = buildStepClaims(stepName, stepResult, artifactRefs, evidence, stageEvaluation);

  return {
    schemaVersion: 1,
    action: "pipeline_step_result",
    purpose: `Report the outcome of pipeline step ${JSON.stringify(stepName)} for the next reasoning turn.`,
    status: stepResult.status,
    summary: summarizeStep(stepName, stepResult),
    evidence,
    coverageGaps: [
      ...buildCoverageGaps(stepResult),
      ...requiredEvidenceGaps.map((gap) => gap.detail),
    ],
    typedCoverageGaps,
    artifactRefs,
    claims,
    contextContract,
    contextComposition: stepResult.contextComposition,
    contractAssertionCoverage: stepResult.contractAssertionCoverage,
    stageEvaluation,
    resumeMetadata: stepResult.resumeMetadata,
    nextHint: artifactRefs.length
      ? "Inspect artifactRefs for complete step output before making detailed claims."
      : "Inspect the raw step result before making detailed claims.",
  };
}

function latestStepName(stepResults: Record<string, StepResult>): string | undefined {
  const entries = Object.entries(stepResults);
  if (!entries.length) return undefined;
  entries.sort(([, left], [, right]) => (right.round ?? 0) - (left.round ?? 0));
  return entries[0]?.[0];
}

function summarizePipeline(status: PipelineStatus, stepResults: Record<string, StepResult>, error?: string): string {
  if (error) return `Pipeline ${status}: ${error}`;
  const failed = Object.entries(stepResults).find(([, step]) => step.status === "failed");
  if (failed) return `Pipeline ${status}; step ${JSON.stringify(failed[0])} failed.`;
  const latest = latestStepName(stepResults);
  if (latest) return `Pipeline ${status}; latest step ${JSON.stringify(latest)} completed.`;
  return `Pipeline ${status}; no completed steps recorded.`;
}

function pipelineNextHint(
  status: PipelineStatus,
  loopAction?: "continue" | "stop_loop" | "escalate_human",
): string | undefined {
  switch (status) {
    case "needs_clarification":
      return "Resolve scopePreflight.clarificationQuestions, then rerun runoff_run_pipeline with the same sessionId and explicit scopePreflight overrides.";
    case "awaiting_judge":
      return "Select a race candidate with runoff_race_apply or abort with runoff_race_abort.";
    case "awaiting_approval":
    case "awaiting_plan_approval":
      return "Resume this checkpoint with approvalDecision once the pending approval is decided.";
    case "failed":
    case "aborted":
    case "max_rounds":
      return "Inspect failed step observations and trace data before retrying.";
    case "approved":
      return "Inspect artifacts and trace data for complete audit material.";
    case "queued":
    case "running":
      return "Poll or resume the run before treating the result as terminal.";
  }
  if (loopAction === "stop_loop") {
    return "loopAction=stop_loop: Pause loop scheduling until stage evaluation failures and coverageGaps are reviewed.";
  }
  if (loopAction === "escalate_human") {
    return "loopAction=escalate_human: Human decision required before the next loop tick.";
  }
  return undefined;
}

function resolveLoopAction(input: {
  status: PipelineStatus;
  failedStageCount: number;
  hasReviewStageFail: boolean;
}): "continue" | "stop_loop" | "escalate_human" | undefined {
  if (
    input.status === "awaiting_approval" ||
    input.status === "awaiting_plan_approval" ||
    input.status === "awaiting_judge"
  ) {
    return "escalate_human";
  }
  if (input.status === "failed" || input.status === "aborted" || input.status === "max_rounds") {
    return "stop_loop";
  }
  if (input.hasReviewStageFail || input.failedStageCount >= 2) {
    return "stop_loop";
  }
  if (input.failedStageCount === 1) {
    return "escalate_human";
  }
  if (input.status === "approved") {
    return "continue";
  }
  return undefined;
}

function buildPipelineContextContract(input: {
  status: PipelineStatus;
  traceId: string;
  checkpointFile?: string;
  stepResults: Record<string, StepResult>;
  rounds?: number;
  totalDurationMs?: number;
  error?: string;
}): StepContextContract {
  return {
    kind: "pipeline",
    inputs: [
      "traceId",
      "checkpointFile",
      "stepResults",
      "rounds",
      "totalDurationMs",
      "error",
    ],
    forbidden: [
      "full_trace_history",
      "raw_provider_payloads",
      "unbounded_artifact_dumps",
    ],
    requiredEvidence: [
      "traceRef",
      "stepRefs",
      "coverageGaps",
    ],
    scopeNotes: [
      `Summarize the run boundary for status ${input.status} without inlining every raw step payload.`,
      input.checkpointFile
        ? `Checkpoint file: ${input.checkpointFile}.`
        : "Checkpoint may be absent on fresh runs.",
    ],
  };
}

function buildPipelineTypedCoverageGaps(input: {
  status: PipelineStatus;
  stepResults: Record<string, StepResult>;
  error?: string;
  scopePreflight?: ScopePreflightReport;
  resumeReusePlan?: ResumeReusePlanReport;
}): ObservationCoverageGap[] {
  const gaps: ObservationCoverageGap[] = [];
  if (!Object.keys(input.stepResults).length) {
    gaps.push({
      kind: "process",
      detail: "No step results are present in this pipeline result.",
      evidenceRefs: ["pipeline.stepResults"],
    });
  }
  if (input.status === "awaiting_judge") {
    gaps.push({
      kind: "process",
      detail: "Race winner has not been applied yet.",
      evidenceRefs: ["pipeline.status"],
    });
  }
  if (input.status === "awaiting_approval" || input.status === "awaiting_plan_approval") {
    gaps.push({
      kind: "process",
      detail: "Pipeline is paused for approval and has not reached a terminal outcome.",
      evidenceRefs: ["pipeline.status"],
    });
  }
  if (input.error) {
    gaps.push({
      kind: "evidence",
      detail: `Pipeline failed with error: ${input.error}`,
      evidenceRefs: ["pipeline.error"],
    });
  }
  if (input.scopePreflight?.blockers.length) {
    for (const blocker of input.scopePreflight.blockers) {
      gaps.push({
        kind: "process",
        detail: `Scope preflight needs clarification: ${blocker}`,
        evidenceRefs: ["pipeline.scopePreflight"],
      });
    }
  }
  if (input.scopePreflight?.warnings.length) {
    for (const warning of input.scopePreflight.warnings) {
      gaps.push({
        kind: "process",
        detail: `Scope preflight warning: ${warning}`,
        evidenceRefs: ["pipeline.scopePreflight"],
      });
    }
  }
  if (input.resumeReusePlan?.entries.length) {
    for (const entry of input.resumeReusePlan.entries.filter((item) => item.decision === "rerun")) {
      gaps.push({
        kind: "process",
        detail: `Resume planner reruns ${entry.stepName}: ${entry.reason}`,
        evidenceRefs: [`pipeline.resumeReusePlan.entries.${entry.stepName}`, ...entry.evidenceRefs],
      });
    }
  }
  for (const [stepName, step] of Object.entries(input.stepResults)) {
    if (step.observation?.stageEvaluation?.overallStatus === "fail") {
      gaps.push({
        kind: "draft",
        detail: `Stage evaluation failed for ${stepName}.`,
        evidenceRefs: [`stepResults.${stepName}.observation.stageEvaluation`],
      });
    }
  }
  return gaps;
}

function buildPipelineClaims(input: {
  status: PipelineStatus;
  traceId: string;
  checkpointFile?: string;
  stepResults: Record<string, StepResult>;
  rounds?: number;
  totalDurationMs?: number;
  error?: string;
  summary: string;
  evidence: string[];
}): ObservationClaim[] {
  const stepClaims = Object.entries(input.stepResults).flatMap(([, step]) => step.observation?.claims ?? []);
  const claims: ObservationClaim[] = [
    {
      claim: input.summary,
      evidenceRefs: input.evidence,
    },
    ...stepClaims,
  ];
  return claims;
}

export function buildPipelineObservation(input: {
  status: PipelineStatus;
  traceId: string;
  checkpointFile?: string;
  stepResults: Record<string, StepResult>;
  rounds?: number;
  totalDurationMs?: number;
  error?: string;
  scopePreflight?: ScopePreflightReport;
  resumeReusePlan?: ResumeReusePlanReport;
  completionContract?: import("../core/state.js").CompletionContract;
}): PipelineObservation {
  const evidence: string[] = [`traceId=${input.traceId}`];
  if (input.checkpointFile) evidence.push(`checkpoint=${input.checkpointFile}`);
  if (input.rounds !== undefined) evidence.push(`rounds=${input.rounds}`);
  if (input.totalDurationMs !== undefined) evidence.push(`durationMs=${input.totalDurationMs}`);
  if (input.error) evidence.push(`error=${input.error}`);
  if (input.scopePreflight) evidence.push(`scopePreflight=${input.scopePreflight.decision}`);
  if (input.resumeReusePlan) {
    evidence.push(
      `resumeReusePlan=rerun:${input.resumeReusePlan.summary.rerun},skipped:${input.resumeReusePlan.summary.skipped}`,
    );
  }
  const contractSummary = summarizeCompletionContract(input.completionContract);
  if (contractSummary) evidence.push(`completionContract=${contractSummary}`);

  const stageEvaluations = buildStageEvaluationsFromStepResults(input.stepResults);
  const failedStageCount = stageEvaluations.filter((entry) => entry.overallStatus === "fail").length;
  if (failedStageCount) {
    evidence.push(`stageEvaluationFailures=${failedStageCount}`);
  }

  const stepRefs = Object.entries(input.stepResults).map(([stepName, step]) => ({
    stepName,
    status: step.status,
    round: step.round,
    summary: step.observation?.summary ?? step.summary ?? step.explanation ?? step.error,
  }));

  const coverageGaps: string[] = [];
  if (!stepRefs.length) coverageGaps.push("No step results are present in this pipeline result.");
  if (input.status === "awaiting_judge") coverageGaps.push("Race winner has not been applied yet.");
  if (input.status === "awaiting_approval" || input.status === "awaiting_plan_approval") {
    coverageGaps.push("Pipeline is paused for approval and has not reached a terminal outcome.");
  }
  if (input.error) coverageGaps.push(`Pipeline failed with error: ${input.error}`);
  if (input.scopePreflight?.blockers.length) {
    coverageGaps.push(...input.scopePreflight.blockers.map((blocker) => `Scope preflight needs clarification: ${blocker}`));
  }
  if (input.scopePreflight?.warnings.length) {
    coverageGaps.push(...input.scopePreflight.warnings.map((warning) => `Scope preflight warning: ${warning}`));
  }
  if (input.resumeReusePlan?.entries.length) {
    coverageGaps.push(
      ...input.resumeReusePlan.entries
        .filter((entry) => entry.decision === "rerun")
        .map((entry) => `Resume planner reruns ${entry.stepName}: ${entry.reason}`),
    );
  }
  for (const evaluation of stageEvaluations) {
    if (evaluation.overallStatus === "fail") {
      coverageGaps.push(`Stage evaluation failed for ${evaluation.stepName}.`);
    }
  }

  const summary = summarizePipeline(input.status, input.stepResults, input.error);
  const typedCoverageGaps = buildPipelineTypedCoverageGaps(input);
  const claims = buildPipelineClaims({
    ...input,
    summary,
    evidence,
  });

  const loopAction = resolveLoopAction({
    status: input.status,
    failedStageCount,
    hasReviewStageFail: stageEvaluations.some(
      (entry) => entry.overallStatus === "fail" && entry.kind === "review",
    ),
  });

  const contextRefs = aggregatePipelineContextRefs(input.stepResults);
  if (contextRefs?.length) {
    for (const ref of contextRefs) {
      evidence.push(`contextRef=${ref.ref}`);
    }
  }

  return {
    schemaVersion: 1,
    action: "pipeline_result",
    purpose: "Report the pipeline outcome for the next host/model reasoning turn.",
    status: input.status,
    summary,
    evidence,
    coverageGaps,
    typedCoverageGaps,
    stepRefs,
    claims,
    scopePreflight: input.scopePreflight,
    resumeReusePlan: input.resumeReusePlan,
    contextContract: buildPipelineContextContract(input),
    completionContract: input.completionContract,
    stageEvaluations: toStageEvaluationHints(stageEvaluations),
    traceRef: { traceId: input.traceId },
    checkpointRef: input.checkpointFile ? { sessionId: input.checkpointFile, status: input.status } : undefined,
    contextRefs,
    loopAction,
    nextHint: pipelineNextHint(input.status, loopAction),
  };
}
