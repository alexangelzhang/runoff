import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyCandidate } from "../../src/core/candidate.ts";
import {
  applyHarnessRoleIsolation,
  forbiddenPromptInputsForRole,
  resolveLoopHarnessRole,
} from "../../src/orchestration/harness-role.ts";
import type { StepPromptBuildInput } from "../../src/orchestration/context-contract.ts";

const baseInput: StepPromptBuildInput = {
  stepName: "implement",
  reviewStepName: "review",
  spec: "Fix bug",
  round: 1,
  globalKnowledge: {},
  candidate: { ...emptyCandidate(), code: "export const x = 1;" },
  verifyResults: "npm test passed",
  lastReviewFeedback: "add tests",
};

test("resolveLoopHarnessRole maps step kinds to loop roles", () => {
  assert.equal(resolveLoopHarnessRole("review"), "evaluator");
  assert.equal(resolveLoopHarnessRole("test"), "evaluator");
  assert.equal(resolveLoopHarnessRole("analyze"), "planner");
  assert.equal(resolveLoopHarnessRole("implement"), "generator");
});

test("planner role omits implementation context from prompts", () => {
  const { input, omittedInputs } = applyHarnessRoleIsolation(
    { ...baseInput, stepName: "analyze_scope" },
    "planner",
  );
  assert.ok(omittedInputs.includes("candidateContent"));
  assert.equal(input.candidate.code ?? "", "");
  assert.equal(input.verifyResults, undefined);
  assert.equal(input.lastReviewFeedback, undefined);
});

test("evaluator role omits generator retry hints", () => {
  const { omittedInputs } = applyHarnessRoleIsolation(
    { ...baseInput, stepName: "review" },
    "evaluator",
  );
  assert.ok(omittedInputs.includes("lastReviewFeedback"));
  assert.deepEqual(forbiddenPromptInputsForRole("evaluator"), [
    "lastReviewFeedback",
    "implementationHints",
  ]);
});

test("ensureCompletionContract writes contract files under session harness dir", async () => {
  const prev = process.env.RUNOFF_HOME;
  const home = await mkdtemp(join(tmpdir(), "runoff-contract-"));
  process.env.RUNOFF_HOME = home;
  try {
    const { ensureCompletionContract, readCompletionContract, contractMarkdownPath } =
      await import("../../src/orchestration/completion-contract.ts");
    const contract = await ensureCompletionContract({
      sessionId: "sess-1",
      spec: "Add retry policy",
      acceptanceCriteria: ["Must preserve API", "Must add unit test"],
    });
    assert.equal(contract.assertionCount, 3);
    assert.equal(contract.assertions[0]!.source, "acceptance_criteria");

    const reread = await readCompletionContract("sess-1");
    assert.equal(reread?.sessionId, "sess-1");

    const markdown = await readFile(contractMarkdownPath("sess-1"), "utf-8");
    assert.match(markdown, /Completion Contract/);
    assert.match(markdown, /Must preserve API/);
  } finally {
    if (prev === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = prev;
  }
});
