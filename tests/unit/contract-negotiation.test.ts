import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  mapVerdictToContractAssertions,
} from "../../src/orchestration/contract-verdict-mapping.ts";
import {
  parseGeneratorContractProposals,
  updateHarnessStateAfterStep,
} from "../../src/orchestration/contract-negotiation.ts";
import type { CompletionContract, StepResult } from "../../src/core/state.ts";

const sampleContract: CompletionContract = {
  schemaVersion: 1,
  sessionId: "sess-neg",
  specSummary: "Add retry policy",
  assertionCount: 2,
  assertions: [
    { id: "ac-1", assertion: "Must preserve public API", source: "acceptance_criteria", testable: true },
    { id: "ac-2", assertion: "Must add unit test", source: "acceptance_criteria", testable: true },
  ],
};

test("parseGeneratorContractProposals extracts CONTRACT_ADD lines", () => {
  const text = [
    "Implemented retry.",
    "CONTRACT_ADD: Must log retry attempts",
    "CONTRACT_ASSERTION: Exit code must be captured",
  ].join("\n");
  assert.deepEqual(parseGeneratorContractProposals(text), [
    "Must log retry attempts",
    "Exit code must be captured",
  ]);
});

test("mapVerdictToContractAssertions marks cited failures per assertion", () => {
  const coverage = mapVerdictToContractAssertions({
    contract: sampleContract,
    stepName: "review",
    round: 1,
    verdictApproved: false,
    reviewText: [
      "ac-2 is missing: no unit test was added.",
      "Public API looks fine.",
    ].join("\n"),
  });

  assert.equal(coverage.failCount >= 1, true);
  const ac2 = coverage.mappings.find((row) => row.assertionId === "ac-2");
  assert.equal(ac2?.status, "fail");
});

test("updateHarnessStateAfterStep writes debate, progress, and log files", async () => {
  const prev = process.env.RUNOFF_HOME;
  const home = await mkdtemp(join(tmpdir(), "runoff-negotiate-"));
  process.env.RUNOFF_HOME = home;
  try {
    const reviewResult: StepResult = {
      status: "success",
      round: 1,
      reason: "ac-2 missing unit test evidence",
    };

    const updated = await updateHarnessStateAfterStep({
      sessionId: "sess-neg",
      stepName: "review",
      round: 1,
      reviewStepName: "review",
      stepResult: reviewResult,
      contract: sampleContract,
      stepResults: { review: reviewResult },
      verdict: { approved: false, feedback: "ac-2 missing unit test evidence" },
    });

    assert.equal(updated.contract.negotiationStatus, "challenged");
    assert.ok(updated.assertionCoverage);
    assert.ok(updated.assertionCoverage.failCount >= 1);

    const debate = await readFile(
      join(home, "sessions", "sess-neg", "harness", "contract-debate.md"),
      "utf-8",
    );
    assert.match(debate, /evaluator @ review/);

    const progress = await readFile(
      join(home, "sessions", "sess-neg", "harness", "progress.md"),
      "utf-8",
    );
    assert.match(progress, /contractStatus: challenged/);

    const log = await readFile(join(home, "sessions", "sess-neg", "harness", "log.md"), "utf-8");
    assert.match(log, /review \| step success/);
  } finally {
    if (prev === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = prev;
  }
});
