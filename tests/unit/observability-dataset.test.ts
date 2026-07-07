import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendExperimentEntry } from "../../src/observability/experiment-log.js";
import {
  buildExperimentDatasetRows,
  buildExperimentEvalReport,
  exportExperimentDatasetJsonl,
  OBSERVABILITY_DATASET_SCHEMA,
} from "../../src/observability/observability-dataset.js";
import { recordTrace, type PipelineTrace } from "../../src/observability/trace.js";

describe("observability dataset + eval report", () => {
  let prevHome: string | undefined;
  let tmpDir: string;

  beforeEach(() => {
    prevHome = process.env.RUNOFF_HOME;
    tmpDir = mkdtempSync(join(tmpdir(), "llm-obs-"));
    process.env.RUNOFF_HOME = tmpDir;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seed() {
    appendExperimentEntry({
      timestamp: "2026-05-28T00:00:00.000Z",
      traceId: "t1",
      experimentId: "exp-ab",
      variant: "baseline",
      tags: [],
      status: "approved",
      totalTokens: 1000,
      promptTokens: 700,
      completionTokens: 300,
      durationMs: 2000,
      rounds: 2,
      providers: ["mock"],
      verdict: "keep",
      judgeScores: { correctness: 1, tokenEfficiency: 0.5, latency: 0.5, overall: 0.8 },
    });
    appendExperimentEntry({
      timestamp: "2026-05-28T01:00:00.000Z",
      traceId: "t2",
      experimentId: "exp-ab",
      variant: "fast-prompt",
      tags: [],
      status: "approved",
      totalTokens: 400,
      promptTokens: 300,
      completionTokens: 100,
      durationMs: 800,
      rounds: 2,
      providers: ["mock"],
      verdict: "keep",
      judgeScores: { correctness: 1, tokenEfficiency: 0.9, latency: 0.9, overall: 0.95 },
    });
  }

  function appendRun(experimentId: string, traceId: string, variant = "baseline"): void {
    appendExperimentEntry({
      timestamp: "2026-05-28T02:00:00.000Z",
      traceId,
      experimentId,
      variant,
      tags: [],
      status: "approved",
      totalTokens: 100,
      promptTokens: 60,
      completionTokens: 40,
      durationMs: 200,
      rounds: 1,
      providers: ["mock"],
    });
  }

  function sampleTrace(
    id: string,
    stageEvaluations?: NonNullable<PipelineTrace["observation"]>["stageEvaluations"],
  ): PipelineTrace {
    return {
      id,
      sessionId: `sess-${id}`,
      prompt: "fix bug",
      promptLength: 7,
      mode: "pipeline",
      steps: [],
      totalRounds: 1,
      finalStatus: "approved",
      totalDurationMs: 200,
      hasVerifyResults: false,
      timestamp: "2026-05-28T02:00:00.000Z",
      observation: {
        schemaVersion: 1,
        action: "pipeline_result",
        purpose: "Report pipeline outcome.",
        status: "approved",
        summary: "Pipeline approved.",
        evidence: ["traceId=" + id],
        coverageGaps: [],
        stepRefs: [],
        traceRef: { traceId: id },
        ...(stageEvaluations ? { stageEvaluations } : {}),
      },
    };
  }

  it("buildExperimentDatasetRows uses runoff-eval-v1 schema", () => {
    seed();
    const rows = buildExperimentDatasetRows("exp-ab");
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.schema, OBSERVABILITY_DATASET_SCHEMA);
    assert.equal(rows[1]!.outputs.judgeOverall, 0.95);
  });

  it("exportExperimentDatasetJsonl writes under ~/.runoff/datasets", () => {
    seed();
    const { path, rowCount } = exportExperimentDatasetJsonl("exp-ab");
    assert.equal(rowCount, 2);
    assert.ok(existsSync(path));
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
  });

  it("buildExperimentEvalReport picks winner by keep/approve/tokens", () => {
    seed();
    const report = buildExperimentEvalReport("exp-ab");
    assert.equal(report.totalRuns, 2);
    assert.equal(report.winnerVariant, "fast-prompt");
    assert.match(report.recommendation, /fast-prompt/);
    assert.equal(report.variants.length, 2);
  });

  it("buildExperimentEvalReport summarizes stage evaluation hints and gaps", () => {
    recordTrace(
      sampleTrace("stage01", [
        {
          stepName: "analyze_input",
          kind: "analyze",
          overallStatus: "pass",
          metrics: [
            {
              name: "context_relevance",
              description: "Check that the step used task-relevant context.",
              evidenceRefs: ["observation.contextContract"],
            },
          ],
        },
        {
          stepName: "verify_tests",
          kind: "test",
          overallStatus: "partial",
          metrics: [
            {
              name: "verification_signal",
              description: "Check test or verification output.",
              evidenceRefs: ["observation.claims"],
            },
          ],
        },
      ]),
    );
    recordTrace(sampleTrace("nostage01"));
    appendRun("exp-stage", "stage01", "with-stage");
    appendRun("exp-stage", "nostage01", "without-stage");
    appendRun("exp-stage", "missing01", "missing-trace");

    const report = buildExperimentEvalReport("exp-stage");

    assert.equal(report.stageEvaluationSummary.evaluatedTraceCount, 1);
    assert.equal(report.stageEvaluationSummary.stageEvaluationCount, 2);
    assert.equal(report.stageEvaluationSummary.missingTraceCount, 1);
    assert.equal(report.stageEvaluationSummary.missingStageEvaluationCount, 1);
    assert.equal(report.stageEvaluationSummary.passCount, 1);
    assert.equal(report.stageEvaluationSummary.partialCount, 1);
    assert.equal(report.stageEvaluationSummary.failCount, 0);
    assert.equal(report.stageEvaluationSummary.unknownCount, 0);
    assert.deepEqual(
      report.stageEvaluationSummary.byKind.map((row) => row.kind),
      ["analyze", "test"],
    );
    assert.deepEqual(report.stageEvaluationSummary.byKind[0]!.stepNames, ["analyze_input"]);
    assert.deepEqual(report.stageEvaluationSummary.byKind[0]!.metricNames, ["context_relevance"]);
    assert.deepEqual(report.stageEvaluationSummary.byKind[1]!.evidenceRefs, ["observation.claims"]);
  });
});
