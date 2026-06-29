import assert from "node:assert/strict";
import test from "node:test";
import type { PipelineResult } from "../../src/core/pipeline-run-types.ts";
import { formatPipelineRunOutcomeHints } from "../../src/pipeline/run-outcome-hints.ts";

test("formatPipelineRunOutcomeHints surfaces claim evidence refs", () => {
  const result: PipelineResult = {
    status: "approved",
    rounds: 1,
    totalDurationMs: 120,
    totalCostUSD: 0,
    checkpointFile: "session-1",
    traceId: "trace-1",
    stepResults: {},
    usage: { promptTokens: 0, completionTokens: 0 },
    costBreakdown: {},
    observation: {
      schemaVersion: 1,
      action: "pipeline_result",
      purpose: "Report pipeline outcome.",
      status: "approved",
      summary: "Pipeline approved.",
      evidence: ["traceId=trace-1"],
      coverageGaps: [],
      stepRefs: [],
      claims: [
        {
          claim: "Updated retry behavior.",
          evidenceRefs: ["stepResults.implement.artifacts[0]", "traceId=trace-1"],
        },
      ],
      traceRef: { traceId: "trace-1" },
    },
  };

  const hints = formatPipelineRunOutcomeHints(result);

  assert.match(hints, /claim evidence refs/);
  assert.match(hints, /stepResults\.implement\.artifacts\[0\]/);
  assert.match(hints, /traceId=trace-1/);
});

test("formatPipelineRunOutcomeHints explains scope clarification", () => {
  const result: PipelineResult = {
    status: "needs_clarification",
    rounds: 0,
    totalDurationMs: 5,
    totalCostUSD: 0,
    checkpointFile: "session-scope",
    traceId: "trace-scope",
    stepResults: {},
    usage: { promptTokens: 0, completionTokens: 0 },
    costBreakdown: {},
    scopePreflight: {
      schemaVersion: 1,
      decision: "needs_clarification",
      risk: "high",
      checks: [],
      assumptions: [],
      warnings: [],
      blockers: ["Agent write steps require an explicit workDir."],
      clarificationQuestions: ["Pass workDir as an absolute path."],
      evidenceRefs: [],
      safeDefaults: [],
    },
  };

  const hints = formatPipelineRunOutcomeHints(result);

  assert.match(hints, /scope clarification/);
  assert.match(hints, /Pass workDir/);
  assert.match(hints, /session-scope/);
  assert.match(hints, /session-scope\.checkpoint\.json/);
});

test("formatPipelineRunOutcomeHints summarizes resume planner reruns and hides skipped details", () => {
  const result: PipelineResult = {
    status: "approved",
    rounds: 1,
    totalDurationMs: 10,
    totalCostUSD: 0,
    checkpointFile: "session-resume",
    traceId: "trace-resume",
    stepResults: {},
    usage: { promptTokens: 0, completionTokens: 0 },
    costBreakdown: {},
    resumeReusePlan: {
      schemaVersion: 1,
      round: 1,
      entries: [
        {
          stepName: "generate",
          decision: "rerun",
          reason: "artifact completeness is partial",
          round: 1,
          evidenceRefs: ["stepResults.generate.resumeMetadata"],
        },
        {
          stepName: "review",
          decision: "rerun",
          reason: "downstream dependency generate must rerun on resume",
          round: 1,
          downstreamOf: "generate",
          evidenceRefs: ["stepResults.review.resumeMetadata"],
        },
        {
          stepName: "format",
          decision: "skipped",
          reason: "resume metadata allows skip",
          round: 1,
          evidenceRefs: ["stepResults.format.resumeMetadata"],
        },
      ],
      summary: { skipped: 1, rerun: 2 },
      evidenceRefs: [
        "stepResults.generate.resumeMetadata",
        "stepResults.review.resumeMetadata",
        "stepResults.format.resumeMetadata",
      ],
    },
  };

  const hints = formatPipelineRunOutcomeHints(result);

  assert.match(hints, /resume planner: rerun=2, skipped=1/);
  assert.match(hints, /rerun generate: artifact completeness is partial/);
  assert.match(hints, /rerun review: downstream dependency generate must rerun on resume downstreamOf=generate/);
  assert.match(hints, /skipped entries hidden by default/);
  assert.doesNotMatch(hints, /format: resume metadata allows skip/);
});
