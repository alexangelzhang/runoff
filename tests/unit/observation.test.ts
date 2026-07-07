import assert from "node:assert/strict";
import test from "node:test";
import type { StepResult } from "../../src/core/state.ts";
import { createCodeArtifact, createDiffArtifact } from "../../src/orchestration/artifacts.ts";
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
    resumeMetadata: {
      schemaVersion: 1,
      stepName: "implement",
      round: 1,
      inputHash: "input-hash-1",
      artifactCompleteness: "complete",
      providerResultPresent: true,
      workspaceAttachment: "session_workspace",
      canSkipOnResume: true,
      evidenceRefs: ["stepResults.implement.status"],
    },
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
  assert.deepEqual(observation.typedCoverageGaps, []);
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
  assert.deepEqual(observation.claims, [
    {
      claim: "Updated the retry policy.",
      evidenceRefs: ["stepResults.implement.artifacts[0]"],
    },
    {
      claim: "Modified 1 file(s): src/retry.ts.",
      evidenceRefs: ["stepResults.implement.filesModified", "stepResults.implement.artifacts[0]"],
    },
    {
      claim: "Diff stat: 1 file changed, 3 insertions(+).",
      evidenceRefs: ["stepResults.implement.diffStat", "stepResults.implement.artifacts[0]"],
    },
  ]);
  assert.equal(observation.contextContract?.kind, "implement");
  assert.ok(observation.contextContract?.requiredEvidence.includes("artifacts"));
  assert.equal(observation.stageEvaluation?.kind, "implement");
  assert.equal(observation.stageEvaluation?.overallStatus, "pass");
  assert.equal(observation.resumeMetadata?.inputHash, "input-hash-1");
  assert.ok(observation.evidence.includes("inputHash=input-hash-1"));
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
  assert.deepEqual(observation.typedCoverageGaps?.map((gap) => gap.kind), ["evidence", "process"]);
  assert.ok(observation.claims?.[0]?.evidenceRefs.includes("error=provider timed out"));
  assert.deepEqual(observation.artifactRefs, []);
});

test("buildStepObservation warns when required evidence is missing", () => {
  const result: StepResult = {
    status: "success",
    provider: "codex",
    kind: "agent",
    summary: "Changed retry behavior.",
    filesModified: ["src/retry.ts"],
    contextContract: {
      kind: "generate",
      inputs: ["spec"],
      forbidden: ["unbounded_repo_context"],
      requiredEvidence: ["filesModified", "diffStat"],
    },
  };

  const observation = buildStepObservation("implement", result);

  assert.equal(observation.status, "success");
  assert.ok(
    observation.coverageGaps.includes('Missing required evidence "diffStat" from step context contract.'),
  );
  assert.ok(
    observation.typedCoverageGaps?.some(
      (gap) =>
        gap.kind === "evidence" &&
        gap.detail === 'Missing required evidence "diffStat" from step context contract.' &&
        gap.evidenceRefs?.includes("stepResults.implement.diffStat"),
    ),
  );
});

test("buildStepObservation fallback contract accepts text code artifacts", () => {
  const result: StepResult = {
    status: "success",
    provider: "mock",
    kind: "text",
    code: "export const ok = true;",
    explanation: "Generated code.",
    artifacts: [
      createCodeArtifact("export const ok = true;", "Generated code."),
    ],
  };

  const observation = buildStepObservation("generate", result);

  assert.deepEqual(observation.contextContract?.requiredEvidence, ["code", "artifacts"]);
  assert.equal(observation.coverageGaps.includes('Missing required evidence "filesModified" from step context contract.'), false);
  assert.equal(observation.coverageGaps.includes('Missing required evidence "diffStat" from step context contract.'), false);
  assert.deepEqual(observation.typedCoverageGaps, []);
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
  assert.equal(observation.contextContract?.kind, "pipeline");
  assert.deepEqual(observation.typedCoverageGaps?.map((gap) => gap.kind), ["process"]);
  assert.deepEqual(observation.stepRefs, [
    {
      stepName: "implement",
      status: "success",
      round: 1,
      summary: "candidate ready",
    },
  ]);
  assert.equal(observation.stageEvaluations?.[0]?.kind, "implement");
  assert.equal(observation.claims?.[0]?.claim, "Pipeline awaiting_judge; latest step \"implement\" completed.");
  assert.match(observation.nextHint ?? "", /runoff_race_apply/);
  assert.equal(observation.loopAction, "escalate_human");
});

test("buildPipelineObservation sets loopAction stop_loop on terminal failure", () => {
  const observation = buildPipelineObservation({
    status: "failed",
    traceId: "trace-fail",
    stepResults: {},
    error: "step timeout",
  });

  assert.equal(observation.loopAction, "stop_loop");
  assert.ok(observation.nextHint?.includes("Inspect failed"));
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
  assert.ok(observation.coverageGaps.includes("Pipeline failed with error: approval rejected"));
  assert.deepEqual(observation.typedCoverageGaps?.map((gap) => gap.kind), ["process", "evidence"]);
  assert.equal(observation.claims?.[0]?.claim, "Pipeline failed: approval rejected");
});

test("buildPipelineObservation carries scope preflight blockers", () => {
  const observation = buildPipelineObservation({
    status: "needs_clarification",
    traceId: "trace-preflight",
    checkpointFile: "session-preflight",
    stepResults: {},
    scopePreflight: {
      schemaVersion: 1,
      decision: "needs_clarification",
      risk: "high",
      checks: [
        {
          name: "workDir",
          status: "block",
          detail: "Agent write steps require an explicit workDir.",
          clarificationQuestion: "Pass workDir.",
        },
      ],
      assumptions: [],
      warnings: [],
      blockers: ["Agent write steps require an explicit workDir."],
      clarificationQuestions: ["Pass workDir."],
      evidenceRefs: ["pipeline.agentWriteSteps=true"],
      safeDefaults: [],
    },
  });

  assert.equal(observation.status, "needs_clarification");
  assert.equal(observation.scopePreflight?.decision, "needs_clarification");
  assert.ok(observation.coverageGaps.some((gap) => /Scope preflight/.test(gap)));
  assert.ok(observation.typedCoverageGaps?.some((gap) => gap.evidenceRefs?.includes("pipeline.scopePreflight")));
  assert.match(observation.nextHint ?? "", /scopePreflight/);
});

test("buildPipelineObservation aggregates step-level claims when present", () => {
  const implement: StepResult = {
    status: "success",
    provider: "codex",
    kind: "agent",
    summary: "Updated retry behavior.",
    filesModified: ["src/retry.ts"],
    diffStat: "1 file changed",
    artifacts: [
      createDiffArtifact(
        "diff --git a/src/retry.ts b/src/retry.ts",
        "Updated retry behavior.",
        ["src/retry.ts"],
        "1 file changed",
        { producedBy: "implement" },
      ),
    ],
  };
  implement.observation = buildStepObservation("implement", implement);

  const observation = buildPipelineObservation({
    status: "approved",
    traceId: "trace-claims",
    stepResults: { implement },
  });

  assert.ok(observation.claims?.some((claim) => claim.claim === "Updated retry behavior."));
  assert.ok(observation.claims?.some((claim) => claim.evidenceRefs.includes("stepResults.implement.artifacts[0]")));
});

test("buildPipelineObservation aggregates contextRefs from step contextComposition", () => {
  const triage: StepResult = {
    status: "success",
    kind: "text",
    summary: "CI lint failure on retry helper.",
    contextComposition: {
      schemaVersion: 1,
      suppliedInputs: ["context"],
      omittedForbidden: ["inline_tool_json"],
      warnings: [],
      contextRefs: [
        { ref: "mfs://repo/src/retry.ts", scheme: "mfs" },
        { ref: "file:///tmp/ci.log", scheme: "file" },
      ],
    },
  };
  triage.observation = buildStepObservation("triage", triage);

  const observation = buildPipelineObservation({
    status: "approved",
    traceId: "trace-context-refs",
    stepResults: { triage },
  });

  assert.equal(observation.contextRefs?.length, 2);
  assert.ok(observation.evidence.includes("contextRef=mfs://repo/src/retry.ts"));
  assert.ok(triage.observation?.evidence.includes("contextRef=file:///tmp/ci.log"));
});

test("buildPipelineObservation exposes resume reuse planner decisions", () => {
  const observation = buildPipelineObservation({
    status: "approved",
    traceId: "trace-resume-plan",
    checkpointFile: "session-resume-plan",
    stepResults: {
      generate: { status: "success", round: 1, summary: "regenerated" },
      review: { status: "success", round: 1, summary: "reviewed regenerated output" },
    },
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
      ],
      summary: { skipped: 0, rerun: 2 },
      evidenceRefs: ["stepResults.generate.resumeMetadata", "stepResults.review.resumeMetadata"],
    },
  });

  assert.equal(observation.resumeReusePlan?.summary.rerun, 2);
  assert.ok(observation.evidence.includes("resumeReusePlan=rerun:2,skipped:0"));
  assert.ok(
    observation.coverageGaps.includes(
      "Resume planner reruns review: downstream dependency generate must rerun on resume",
    ),
  );
  assert.ok(
    observation.typedCoverageGaps?.some(
      (gap) =>
        gap.kind === "process" &&
        gap.detail === "Resume planner reruns generate: artifact completeness is partial" &&
        gap.evidenceRefs?.includes("pipeline.resumeReusePlan.entries.generate"),
    ),
  );
});
