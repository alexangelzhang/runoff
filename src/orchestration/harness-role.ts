/**
 * Loop harness roles — planner / generator / evaluator input isolation (LOOPS.md).
 */

import { emptyCandidate } from "../core/candidate.js";
import type { StepContextKind } from "../core/state.js";
import type { StepPromptBuildInput } from "./context-contract.js";

export type LoopHarnessRole = "planner" | "generator" | "evaluator";

export function resolveLoopHarnessRole(kind: StepContextKind): LoopHarnessRole {
  switch (kind) {
    case "review":
    case "test":
      return "evaluator";
    case "analyze":
    case "final_summary":
      return "planner";
    default:
      return "generator";
  }
}

export function forbiddenPromptInputsForRole(role: LoopHarnessRole): string[] {
  switch (role) {
    case "planner":
      return ["candidateContent", "previousContent", "verifyResults", "lastReviewFeedback"];
    case "generator":
      return ["verdictSignals"];
    case "evaluator":
      return ["lastReviewFeedback", "implementationHints"];
  }
}

export function applyHarnessRoleIsolation(
  input: StepPromptBuildInput,
  role: LoopHarnessRole,
): { input: StepPromptBuildInput; omittedInputs: string[] } {
  const forbidden = new Set(forbiddenPromptInputsForRole(role));
  const omitted: string[] = [];
  const next: StepPromptBuildInput = { ...input, candidate: { ...input.candidate } };

  if (forbidden.has("candidateContent") || forbidden.has("previousContent")) {
    const hasCandidate =
      Boolean(next.candidate.code || next.candidate.changes || next.candidate.summary);
    if (hasCandidate) {
      omitted.push("candidateContent");
      next.candidate = emptyCandidate();
    }
  }

  if (forbidden.has("verifyResults") && next.verifyResults) {
    omitted.push("verifyResults");
    next.verifyResults = undefined;
  }

  if (forbidden.has("lastReviewFeedback") && next.lastReviewFeedback) {
    omitted.push("lastReviewFeedback");
    next.lastReviewFeedback = undefined;
  }

  return { input: next, omittedInputs: omitted };
}

export function harnessRoleScopeNote(role: LoopHarnessRole): string {
  switch (role) {
    case "planner":
      return "Planner role: translate spec into actionable scope only; do not edit or score implementation.";
    case "generator":
      return "Generator role: implement against the contract; do not approve or score your own output.";
    case "evaluator":
      return "Evaluator role: assume defects exist; cite evidence from diffs, artifacts, and verification output.";
  }
}
