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
});
