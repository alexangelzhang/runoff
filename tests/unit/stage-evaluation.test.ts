import assert from "node:assert/strict";
import test from "node:test";
import { buildStageEvaluationHints } from "../../src/observability/stage-evaluation.ts";

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
