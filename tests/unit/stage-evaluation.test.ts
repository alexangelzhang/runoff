import assert from "node:assert/strict";
import test from "node:test";
import { buildStageEvaluationHints, evaluateStageForStep } from "../../src/observability/stage-evaluation.ts";
import { createDiffArtifact } from "../../src/orchestration/artifacts.ts";
import type { StepResult } from "../../src/core/state.ts";

test("buildStageEvaluationHints maps common step names to stage metric families", () => {
  const hints = buildStageEvaluationHints([
    "analyze",
    "refactor",
    "review",
    "verify",
    "final-summary",
    "custom",
  ]);

  assert.deepEqual(
    hints.map((hint) => hint.kind),
    ["analyze", "implement", "review", "test", "final_summary", "other"],
  );
  assert.ok(hints[0]!.metrics.some((metric) => metric.name === "scope_accuracy"));
  assert.ok(hints[1]!.metrics.some((metric) => metric.name === "diff_validity"));
  assert.ok(hints[2]!.metrics.some((metric) => metric.name === "evidence_citation"));
  assert.ok(hints[3]!.metrics.some((metric) => metric.name === "command_capture"));
  assert.ok(hints[4]!.metrics.some((metric) => metric.name === "claim_evidence_coverage"));
  assert.ok(hints[5]!.metrics.some((metric) => metric.name === "step_completion"));
});

test("evaluateStageForStep marks implement diff_validity fail without diff evidence", () => {
  const result: StepResult = {
    status: "success",
    kind: "agent",
    summary: "Described changes in prose only.",
  };

  const evaluation = evaluateStageForStep("implement", result, {
    schemaVersion: 1,
    action: "pipeline_step_result",
    purpose: "",
    status: "success",
    summary: result.summary!,
    evidence: [],
    coverageGaps: [],
    artifactRefs: [],
  });

  assert.equal(evaluation.kind, "implement");
  assert.equal(evaluation.metrics.find((metric) => metric.name === "diff_validity")?.status, "fail");
  assert.equal(evaluation.overallStatus, "fail");
});

test("evaluateStageForStep passes implement when diff artifacts exist", () => {
  const result: StepResult = {
    status: "success",
    kind: "agent",
    filesModified: ["src/retry.ts"],
    diffStat: "1 file changed",
    artifacts: [
      createDiffArtifact("diff", "Updated retry.", ["src/retry.ts"], "1 file changed"),
    ],
  };

  const evaluation = evaluateStageForStep("implement", result, {
    schemaVersion: 1,
    action: "pipeline_step_result",
    purpose: "",
    status: "success",
    summary: "Updated retry.",
    evidence: ["filesModified=src/retry.ts"],
    coverageGaps: [],
    artifactRefs: [
      {
        stepName: "implement",
        artifactIndex: 0,
        kind: "diff",
        ref: "stepResults.implement.artifacts[0]",
      },
    ],
    claims: [
      {
        claim: "Updated retry.",
        evidenceRefs: ["stepResults.implement.artifacts[0]"],
      },
    ],
  });

  assert.equal(evaluation.metrics.find((metric) => metric.name === "diff_validity")?.status, "pass");
  assert.equal(evaluation.overallStatus, "pass");
});
