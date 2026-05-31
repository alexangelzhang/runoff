import assert from "node:assert/strict";
import test from "node:test";
import { emptyCandidate } from "../src/core/candidate.js";
import {
  buildStructuredPromptForStep,
  isReviewStep,
  resolveStepKind,
} from "../src/orchestration/step-strategy.js";

test("isReviewStep matches configured review step name", () => {
  assert.equal(isReviewStep("review", "review"), true);
  assert.equal(isReviewStep("generate", "review"), false);
});

test("resolveStepKind classifies review vs generate", () => {
  assert.equal(resolveStepKind("review", "review"), "review");
  assert.equal(resolveStepKind("generate", "review"), "generate");
});

test("buildStructuredPromptForStep uses review template for review step", () => {
  const p = buildStructuredPromptForStep({
    stepName: "review",
    reviewStepName: "review",
    spec: "do X",
    round: 1,
    globalKnowledge: {},
    candidate: { ...emptyCandidate(), code: "x" },
  });
  assert.match(p.system, /reviewer/i);
  assert.match(p.staticContext, /VERDICT:/);
});

test("buildStructuredPromptForStep uses generate template for non-review step", () => {
  const p = buildStructuredPromptForStep({
    stepName: "generate",
    reviewStepName: "review",
    spec: "do X",
    round: 1,
    globalKnowledge: {},
    candidate: emptyCandidate(),
  });
  assert.match(p.system, /software engineer/i);
  assert.doesNotMatch(p.staticContext, /VERDICT:/);
});
