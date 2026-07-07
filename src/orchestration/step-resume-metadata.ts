import { createHash } from "node:crypto";
import type { StepResult, StepResumeMetadata, StepWorkspaceAttachment } from "../core/state.js";
import type { Artifact } from "./artifacts.js";
import { hasRequiredEvidence } from "./context-contract.js";

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

export function hashStepInput(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function artifactCompleteness(result: StepResult, artifacts: Artifact[]): StepResumeMetadata["artifactCompleteness"] {
  if (!artifacts.length) return "missing";
  if (result.status !== "success") return "partial";
  const required = result.contextContract?.requiredEvidence ?? [];
  const missingRequired = required.filter((requirement) => !hasRequiredEvidence(requirement, result, artifacts));
  return missingRequired.length ? "partial" : "complete";
}

function mustRerunReason(result: StepResult, completeness: StepResumeMetadata["artifactCompleteness"]): string | undefined {
  if (result.status !== "success") return `step status is ${result.status}`;
  if (completeness !== "complete") return `artifact completeness is ${completeness}`;
  return undefined;
}

export function resolveWorkspaceAttachment(input: {
  effectiveWorkDir?: string;
  sourceWorkDir?: string;
  raceCandidateWorkspace?: boolean;
}): StepWorkspaceAttachment {
  if (input.raceCandidateWorkspace) return "race_candidate_workspace";
  if (!input.effectiveWorkDir) return "none";
  if (input.sourceWorkDir && input.effectiveWorkDir !== input.sourceWorkDir) return "session_workspace";
  return "source_workdir";
}

export function buildStepResumeMetadata(input: {
  stepName: string;
  round: number;
  inputHash: string;
  stepResult: StepResult;
  artifacts?: Artifact[];
  promptVersionId?: string;
  workspaceAttachment: StepWorkspaceAttachment;
  rerunReason?: string;
  skipReason?: string;
}): StepResumeMetadata {
  const artifacts = input.artifacts ?? [];
  const completeness = artifactCompleteness(input.stepResult, artifacts);
  const rerun = mustRerunReason(input.stepResult, completeness);
  const providerResultPresent = Boolean(
    input.stepResult.provider ||
      input.stepResult.model ||
      input.stepResult.summary ||
      input.stepResult.explanation ||
      input.stepResult.error ||
      artifacts.length,
  );
  const evidenceRefs = [
    `stepResults.${input.stepName}.status`,
    `stepResults.${input.stepName}.resumeMetadata.inputHash`,
  ];
  if (artifacts.length) evidenceRefs.push(`stepResults.${input.stepName}.artifacts`);
  if (input.promptVersionId) evidenceRefs.push(`promptVersions.${input.promptVersionId}`);

  return {
    schemaVersion: 1,
    stepName: input.stepName,
    round: input.round,
    inputHash: input.inputHash,
    artifactCompleteness: completeness,
    providerResultPresent,
    workspaceAttachment: input.workspaceAttachment,
    canSkipOnResume: !rerun,
    evidenceRefs,
    promptVersionId: input.promptVersionId,
    skipReason: input.skipReason,
    rerunReason: input.rerunReason,
    mustRerunReason: rerun,
  };
}
