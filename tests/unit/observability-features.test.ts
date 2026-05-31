import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  recordTrace,
  queryTraces,
  loadTraceById,
  updateTrace,
  type PipelineTrace,
} from "../../src/observability/trace.js";
import { buildTracePostmortem } from "../../src/observability/trace-postmortem.js";
import { appendTraceScore, listTraceScores } from "../../src/observability/trace-scores.js";
import { appendExperimentEntry } from "../../src/observability/experiment-log.js";
import { buildExperimentEvalReport } from "../../src/observability/observability-dataset.js";

describe("observability P0–P2", () => {
  let prevHome: string | undefined;
  let tmpDir: string;

  beforeEach(() => {
    prevHome = process.env.LLM_PIPELINE_HOME;
    tmpDir = mkdtempSync(join(tmpdir(), "llm-obs-feat-"));
    process.env.LLM_PIPELINE_HOME = tmpDir;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function sampleTrace(overrides: Partial<PipelineTrace> = {}): PipelineTrace {
    return {
      id: "abc12345",
      sessionId: "sess-1",
      prompt: "fix bug",
      promptLength: 7,
      mode: "pipeline",
      steps: [
        { name: "gen", provider: "mock", durationMs: 10, round: 1 },
        { name: "review", provider: "mock", durationMs: 5, round: 1, error: "syntax error" },
      ],
      totalRounds: 1,
      finalStatus: "failed",
      totalDurationMs: 15,
      hasVerifyResults: false,
      timestamp: "2026-05-26T12:00:00.000Z",
      ...overrides,
    };
  }

  it("queryTraces filters by traceId and sessionId", () => {
    recordTrace(sampleTrace({ id: "t1", sessionId: "s-a" }));
    recordTrace(sampleTrace({ id: "t2", sessionId: "s-b" }));
    assert.equal(queryTraces({ traceId: "t1" }).length, 1);
    assert.equal(queryTraces({ sessionId: "s-b" }).length, 1);
  });

  it("updateTrace patches sessionId and experiment metadata", () => {
    recordTrace(sampleTrace());
    const ok = updateTrace("abc12345", {
      experiment: { experimentId: "exp1", variant: "v1", tags: [] },
      costSummary: { totalCostUSD: 0.01, totalTokens: 100, breakdown: [] },
    });
    assert.ok(ok);
    const loaded = loadTraceById("abc12345");
    assert.equal(loaded?.experiment?.experimentId, "exp1");
    assert.equal(loaded?.costSummary?.totalTokens, 100);
  });

  it("buildTracePostmortem includes failed steps and headline", () => {
    const pm = buildTracePostmortem(sampleTrace());
    assert.equal(pm.traceId, "abc12345");
    assert.equal(pm.sessionId, "sess-1");
    assert.ok(pm.failedSteps.length >= 1);
    assert.match(pm.headline, /failed|review/i);
  });

  it("appendTraceScore writes scores.jsonl", () => {
    appendTraceScore({ traceId: "abc12345", name: "quality", value: 0.9, comment: "good" });
    const scores = listTraceScores("abc12345");
    assert.equal(scores.length, 1);
    assert.equal(scores[0]!.name, "quality");
    const path = join(tmpDir, "traces", "scores.jsonl");
    assert.ok(existsSync(path));
    assert.ok(readFileSync(path, "utf-8").includes("quality"));
  });

  it("eval report includes traceInsights for failures", () => {
    recordTrace(sampleTrace({ id: "fail01" }));
    appendExperimentEntry({
      timestamp: "2026-05-26T12:00:00.000Z",
      traceId: "fail01",
      experimentId: "exp-x",
      variant: "a",
      tags: [],
      status: "failed",
      totalTokens: 10,
      promptTokens: 5,
      completionTokens: 5,
      durationMs: 10,
      rounds: 1,
      providers: ["mock"],
    });
    const report = buildExperimentEvalReport("exp-x");
    assert.ok(report.traceInsights?.length);
    assert.match(report.traceInsights![0]!.postmortemSummary, /failed|review/i);
  });
});
