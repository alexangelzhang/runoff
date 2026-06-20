import type { PipelineObservation } from "../core/pipeline-run-types.js";
import type { PipelineStatus, StepObservation, StepResult } from "../core/state.js";
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
  return evidence;
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

  return {
    schemaVersion: 1,
    action: "pipeline_step_result",
    purpose: `Report the outcome of pipeline step ${JSON.stringify(stepName)} for the next reasoning turn.`,
    status: stepResult.status,
    summary: summarizeStep(stepName, stepResult),
    evidence: buildEvidence(stepResult),
    coverageGaps: buildCoverageGaps(stepResult),
    artifactRefs,
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

export function buildPipelineObservation(input: {
  status: PipelineStatus;
  traceId: string;
  checkpointFile?: string;
  stepResults: Record<string, StepResult>;
  rounds?: number;
  totalDurationMs?: number;
  error?: string;
}): PipelineObservation {
  const evidence: string[] = [`traceId=${input.traceId}`];
  if (input.checkpointFile) evidence.push(`checkpoint=${input.checkpointFile}`);
  if (input.rounds !== undefined) evidence.push(`rounds=${input.rounds}`);
  if (input.totalDurationMs !== undefined) evidence.push(`durationMs=${input.totalDurationMs}`);
  if (input.error) evidence.push(`error=${input.error}`);

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

  return {
    schemaVersion: 1,
    action: "pipeline_result",
    purpose: "Report the pipeline outcome for the next host/model reasoning turn.",
    status: input.status,
    summary: summarizePipeline(input.status, input.stepResults, input.error),
    evidence,
    coverageGaps,
    stepRefs,
    traceRef: { traceId: input.traceId },
    checkpointRef: input.checkpointFile ? { sessionId: input.checkpointFile, status: input.status } : undefined,
    nextHint: pipelineNextHint(input.status),
  };
}
