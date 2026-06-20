import assert from "node:assert/strict";
import test from "node:test";
import type { StepResult } from "../../src/core/state.ts";
import { createDiffArtifact } from "../../src/orchestration/artifacts.ts";
import { buildPipelineObservation, buildStepObservation } from "../../src/orchestration/observation.ts";

test("buildStepObservation summarizes successful step with artifact references", () => {
  const result: StepResult = {
    status: "success",
    provider: "codex",
    kind: "agent",
    model: "gpt-5.1",
    summary: "Updated the retry policy.",
    filesModified: ["src/retry.ts"],
    diffStat: "1 file changed, 3 insertions(+)",
    artifacts: [
      createDiffArtifact(
        "diff --git a/src/retry.ts b/src/retry.ts",
        "Updated the retry policy.",
        ["src/retry.ts"],
        "1 file changed, 3 insertions(+)",
        { producedBy: "implement" },
      ),
    ],
  };

  const observation = buildStepObservation("implement", result);

  assert.equal(observation.schemaVersion, 1);
  assert.equal(observation.action, "pipeline_step_result");
  assert.equal(observation.status, "success");
  assert.equal(observation.summary, "Updated the retry policy.");
  assert.ok(observation.evidence.includes("provider=codex"));
  assert.ok(observation.evidence.includes("filesModified=src/retry.ts"));
  assert.deepEqual(observation.coverageGaps, []);
  assert.deepEqual(observation.artifactRefs, [
    {
      artifactId: undefined,
      stepName: "implement",
      artifactIndex: 0,
      kind: "diff",
      ref: "stepResults.implement.artifacts[0]",
      summary: "Updated the retry policy.",
      producedBy: "implement",
    },
  ]);
});

test("buildStepObservation keeps failure evidence without inventing artifacts", () => {
  const result: StepResult = {
    status: "failed",
    provider: "codex",
    kind: "text",
    error: "provider timed out",
  };

  const observation = buildStepObservation("review", result);

  assert.equal(observation.status, "failed");
  assert.equal(observation.summary, "review failed: provider timed out");
  assert.ok(observation.evidence.includes("error=provider timed out"));
  assert.ok(observation.coverageGaps.includes("No typed artifact was produced for this step."));
  assert.ok(observation.coverageGaps.includes("Step failed before producing a complete successful result."));
  assert.deepEqual(observation.artifactRefs, []);
});

test("buildPipelineObservation summarizes pause states with next action", () => {
  const observation = buildPipelineObservation({
    status: "awaiting_judge",
    traceId: "trace-1",
    checkpointFile: "session-1",
    rounds: 1,
    totalDurationMs: 42,
    stepResults: {
      implement: {
        status: "success",
        round: 1,
        summary: "candidate ready",
      },
    },
  });

  assert.equal(observation.schemaVersion, 1);
  assert.equal(observation.action, "pipeline_result");
  assert.equal(observation.status, "awaiting_judge");
  assert.ok(observation.coverageGaps.includes("Race winner has not been applied yet."));
  assert.equal(observation.traceRef.traceId, "trace-1");
  assert.deepEqual(observation.checkpointRef, { sessionId: "session-1", status: "awaiting_judge" });
  assert.deepEqual(observation.stepRefs, [
    {
      stepName: "implement",
      status: "success",
      round: 1,
      summary: "candidate ready",
    },
  ]);
  assert.match(observation.nextHint ?? "", /runoff_race_apply/);
});

test("buildPipelineObservation preserves failure error evidence", () => {
  const observation = buildPipelineObservation({
    status: "failed",
    traceId: "trace-2",
    stepResults: {},
    error: "approval rejected",
  });

  assert.equal(observation.summary, "Pipeline failed: approval rejected");
  assert.ok(observation.evidence.includes("error=approval rejected"));
  assert.ok(observation.coverageGaps.includes("No step results are present in this pipeline result."));
});
