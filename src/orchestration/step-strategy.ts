/**
 * Maps pipeline step identity → prompt builder (issue 6.8).
 * Review steps use structured verdict instructions; other steps use generate/refine flow.
 */

import type { Candidate } from "../core/candidate.js";
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
};

export type StepKind = "review" | "generate";

export function isReviewStep(stepName: string, reviewStepName: string): boolean {
  return stepName === reviewStepName;
}

/** Classify step for prompt builder selection (issue 6.8 / 7.16). */
export function resolveStepKind(stepName: string, reviewStepName: string): StepKind {
  return isReviewStep(stepName, reviewStepName) ? "review" : "generate";
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
