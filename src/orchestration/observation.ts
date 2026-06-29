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
import { buildStageEvaluationHints } from "../observability/stage-evaluation.js";
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

function buildStepContextContract(stepName: string, stepResult: StepResult): StepContextContract {
  const kind = stepResult.observation?.contextContract?.kind ?? (stepName.toLowerCase().includes("review") ? "review" : "generate");
  if (stepResult.observation?.contextContract) return stepResult.observation.contextContract;

  if (kind === "review") {
    return {
      kind,
      inputs: [
        "spec",
        "acceptanceCriteria",
        "verifyResults",
        "candidateContent",
        "knowledge",
      ],
      forbidden: [
        "full_trace_history",
        "unrelated_artifacts",
        "unbounded_repo_context",
      ],
      requiredEvidence: [
        "verdict",
        "artifactRefs",
        "review_feedback",
      ],
      scopeNotes: [
        "Focus on the supplied candidate and explicit verification results.",
      ],
    };
  }

  const requiredEvidence =
    stepResult.kind === "text"
      ? ["code", "artifacts"]
      : ["filesModified", "diffStat", "artifacts"];

  return {
    kind,
    inputs: [
      "spec",
      "lastReviewFeedback",
      "previousContent",
      "context",
      "knowledge",
    ],
    forbidden: [
      "full_trace_history",
      "unrelated_artifacts",
      "unbounded_repo_context",
    ],
    requiredEvidence,
    scopeNotes: [
      "Prefer the smallest edit surface that satisfies the spec and review feedback.",
    ],
  };
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
  return evidence;
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
  return gaps;
}

function requiredEvidenceRef(stepName: string, requirement: string): string {
  switch (requirement) {
    case "artifactRefs":
    case "artifacts":
      return `stepResults.${stepName}.artifacts`;
    case "diffStat":
      return `stepResults.${stepName}.diffStat`;
    case "filesModified":
      return `stepResults.${stepName}.filesModified`;
    case "code":
      return `stepResults.${stepName}.code`;
    case "review_feedback":
    case "verdict":
      return `stepResults.${stepName}.artifacts`;
    default:
      return `stepResults.${stepName}`;
  }
}

function hasRequiredEvidence(
  requirement: string,
  stepResult: StepResult,
  artifactRefs: StepObservation["artifactRefs"],
): boolean {
  const artifacts = stepResult.artifacts ?? [];
  switch (requirement) {
    case "artifactRefs":
    case "artifacts":
      return artifactRefs.length > 0;
    case "diffStat":
      return Boolean(
        stepResult.diffStat ||
          artifacts.some((artifact) => (artifact.kind === "diff" || artifact.kind === "patch") && artifact.diffStat),
      );
    case "filesModified":
      return Boolean(
        stepResult.filesModified?.length ||
          artifacts.some((artifact) => (artifact.kind === "diff" || artifact.kind === "patch") && artifact.filesModified.length),
      );
    case "code":
      return Boolean(
        stepResult.code ||
          artifacts.some((artifact) => artifact.kind === "code" && artifact.code),
      );
    case "review_feedback":
      return Boolean(
        stepResult.reason ||
          stepResult.summary ||
          stepResult.explanation ||
          artifacts.some((artifact) => {
            if (artifact.kind === "review") {
              return Boolean(artifact.reviewText || artifact.issues?.length || artifact.suggestions?.length);
            }
            if (artifact.kind === "verdict") {
              return Boolean(artifact.feedback || artifact.sourceReview);
            }
            return false;
          }),
      );
    case "verdict":
      return artifacts.some((artifact) => artifact.kind === "verdict");
    default:
      return buildEvidence(stepResult).some((entry) => entry.toLowerCase().startsWith(`${requirement.toLowerCase()}=`));
  }
}

function buildRequiredEvidenceGaps(
  stepName: string,
  stepResult: StepResult,
  contextContract: StepContextContract,
  artifactRefs: StepObservation["artifactRefs"],
): ObservationCoverageGap[] {
  if (stepResult.status !== "success") return [];
  return contextContract.requiredEvidence
    .filter((requirement) => !hasRequiredEvidence(requirement, stepResult, artifactRefs))
    .map((requirement) => ({
      kind: "evidence" as const,
      detail: `Missing required evidence ${JSON.stringify(requirement)} from step context contract.`,
      evidenceRefs: [requiredEvidenceRef(stepName, requirement)],
    }));
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
  return gaps;
}

function buildStepClaims(stepName: string, stepResult: StepResult, artifactRefs: StepObservation["artifactRefs"], evidence: string[]): ObservationClaim[] | undefined {
  const claimEvidenceRefs = artifactRefs.length
    ? artifactRefs.map((ref) => ref.ref)
    : evidence;
  const summary = summarizeStep(stepName, stepResult);
  if (!summary && !claimEvidenceRefs.length) return undefined;
  return [
    {
      claim: summary,
      evidenceRefs: claimEvidenceRefs,
    },
  ];
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
  const contextContract = stepResult.contextContract ?? buildStepContextContract(stepName, stepResult);
  const evidence = buildEvidence(stepResult);
  const requiredEvidenceGaps = buildRequiredEvidenceGaps(stepName, stepResult, contextContract, artifactRefs);
  const typedCoverageGaps = [
    ...buildTypedCoverageGaps(stepName, stepResult),
    ...requiredEvidenceGaps,
  ];
  const claims = buildStepClaims(stepName, stepResult, artifactRefs, evidence);

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

function pipelineNextHint(status: PipelineStatus): string | undefined {
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

  const summary = summarizePipeline(input.status, input.stepResults, input.error);
  const typedCoverageGaps = buildPipelineTypedCoverageGaps(input);
  const claims = buildPipelineClaims({
    ...input,
    summary,
    evidence,
  });

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
    stageEvaluations: buildStageEvaluationHints(Object.keys(input.stepResults)),
    traceRef: { traceId: input.traceId },
    checkpointRef: input.checkpointFile ? { sessionId: input.checkpointFile, status: input.status } : undefined,
    nextHint: pipelineNextHint(input.status),
  };
}
