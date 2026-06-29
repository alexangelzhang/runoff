/**
 * Maps pipeline step identity → prompt builder (issue 6.8).
 * Review steps use structured verdict instructions; other steps use generate/refine flow.
 */

import type { Candidate } from "../core/candidate.js";
import type { StepContextContract } from "../core/state.js";
import { getCandidateContent, getCandidateContentLabel } from "../core/candidate.js";
import {
  buildGeneratePrompt,
  buildReviewPrompt,
  type StructuredPrompt,
} from "../pipeline/prompt.js";

export type StepPromptBuildInput = {
  stepName: string;
  /** Configured review step id (e.g. from retry.reviewStep). */
  reviewStepName: string;
  spec: string;
  round: number;
  globalKnowledge: Record<string, string>;
  candidate: Candidate;
  acceptanceCriteria?: string[];
  verifyResults?: string;
  /** Populated after a review pass; feeds generate rounds. */
  lastReviewFeedback?: string;
  context?: string;
  outputKind?: "text" | "agent" | "mixed";
};

export type StepKind = "review" | "generate";

export function isReviewStep(stepName: string, reviewStepName: string): boolean {
  return stepName === reviewStepName;
}

/** Classify step for prompt builder selection (issue 6.8 / 7.16). */
export function resolveStepKind(stepName: string, reviewStepName: string): StepKind {
  return isReviewStep(stepName, reviewStepName) ? "review" : "generate";
}

export function buildStepContextContract(input: StepPromptBuildInput): StepContextContract {
  if (resolveStepKind(input.stepName, input.reviewStepName) === "review") {
    return {
      kind: "review",
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
    input.outputKind === "text"
      ? ["code", "artifacts"]
      : input.outputKind === "mixed"
        ? ["artifacts"]
        : ["filesModified", "diffStat", "artifacts"];

  return {
    kind: "generate",
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

export function buildStructuredPromptForStep(input: StepPromptBuildInput): StructuredPrompt {
  if (resolveStepKind(input.stepName, input.reviewStepName) === "review") {
    return buildReviewPrompt({
      spec: input.spec,
      acceptanceCriteria: input.acceptanceCriteria,
      verifyResults: input.verifyResults,
      candidateContent: getCandidateContent(input.candidate),
      candidateLabel: getCandidateContentLabel(input.candidate),
      knowledge: input.globalKnowledge,
    });
  }

  return buildGeneratePrompt({
    spec: input.spec,
    round: input.round,
    lastReviewFeedback: input.lastReviewFeedback,
    previousContent: getCandidateContent(input.candidate),
    previousContentLabel: getCandidateContentLabel(input.candidate),
    context: input.context,
    knowledge: input.globalKnowledge,
  });
}
