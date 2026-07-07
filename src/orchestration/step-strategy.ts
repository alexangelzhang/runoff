/**
 * Maps pipeline step identity → prompt builder (issue 6.8).
 */

import type { Candidate } from "../core/candidate.js";
import { getCandidateContent, getCandidateContentLabel } from "../core/candidate.js";
import {
  buildGeneratePrompt,
  buildReviewPrompt,
  type StructuredPrompt,
} from "../pipeline/prompt.js";
import {
  type StepPromptBuildInput,
  buildStepContextContract,
  composeBoundedStepContext,
  buildContextCompositionReport,
  resolveStepContextKind,
} from "./context-contract.js";
import {
  applyHarnessRoleIsolation,
  harnessRoleScopeNote,
  resolveLoopHarnessRole,
} from "./harness-role.js";
import { contractAssertionLines } from "./completion-contract.js";

export type { StepPromptBuildInput };
export {
  buildStepContextContract,
  composeBoundedStepContext,
  buildContextCompositionReport,
  resolveStepContextKind,
};
export { resolveLoopHarnessRole, applyHarnessRoleIsolation } from "./harness-role.js";
export { ensureCompletionContract, contractAssertionLines } from "./completion-contract.js";

export type StepKind = "review" | "generate";

export function isReviewStep(stepName: string, reviewStepName: string): boolean {
  return stepName === reviewStepName;
}

export function resolveStepKind(stepName: string, reviewStepName: string): StepKind {
  return isReviewStep(stepName, reviewStepName) ? "review" : "generate";
}

export function buildStructuredPromptForStep(
  input: StepPromptBuildInput & {
    completionContract?: import("../core/state.js").CompletionContract;
    contractDebateSummary?: string;
  },
): StructuredPrompt {
  const kind = resolveStepContextKind(input.stepName, input.reviewStepName);
  const harnessRole = resolveLoopHarnessRole(kind);
  const isolated = applyHarnessRoleIsolation(input, harnessRole);
  const effective = isolated.input;
  const contractLines = contractAssertionLines(input.completionContract);

  if (resolveStepKind(effective.stepName, effective.reviewStepName) === "review") {
    return buildReviewPrompt({
      spec: effective.spec,
      acceptanceCriteria: effective.acceptanceCriteria,
      verifyResults: effective.verifyResults,
      candidateContent: getCandidateContent(effective.candidate),
      candidateLabel: getCandidateContentLabel(effective.candidate),
      knowledge: effective.globalKnowledge,
      contractAssertions: contractLines,
      contractDebateSummary: input.contractDebateSummary,
      harnessRole: harnessRole === "evaluator" ? "evaluator" : undefined,
    });
  }

  return buildGeneratePrompt({
    spec: effective.spec,
    round: effective.round,
    lastReviewFeedback: effective.lastReviewFeedback,
    previousContent: getCandidateContent(effective.candidate),
    previousContentLabel: getCandidateContentLabel(effective.candidate),
    context: effective.context,
    knowledge: effective.globalKnowledge,
    contractAssertions: contractLines,
    contractDebateSummary: input.contractDebateSummary,
    harnessRole,
    harnessRoleNote: harnessRoleScopeNote(harnessRole),
  });
}
