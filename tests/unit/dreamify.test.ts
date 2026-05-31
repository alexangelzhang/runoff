import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PipelineTrace } from "../../src/observability/trace.ts";
import { recordTrace } from "../../src/observability/trace.ts";
import { appendExperimentEntry } from "../../src/observability/experiment-log.ts";
import { hashPrompt } from "../../src/orchestration/pattern-cache.ts";
import { PatternCache } from "../../src/orchestration/pattern-cache.ts";
import { resetPipelineMemoryRegistry, getPipelineLocalMemory } from "../../src/memory/pipeline-memory.ts";
import {
  DEFAULT_DREAMIFY_RETRIEVAL,
  loadDreamifyParamsFile,
  saveDreamifyBestParams,
  setDreamifyRetrievalOverride,
  getDreamifyBestParamsPath,
} from "../../src/dreamify/dreamify-params.ts";
import { scoreDreamifyParams } from "../../src/dreamify/dreamify-scorer.ts";
import { runDreamifyTune } from "../../src/dreamify/dreamify-tuner.ts";
import { matchPatternEntriesWithParams } from "../../src/dreamify/dreamify-match.ts";

let home: string;
let origHome: string | undefined;

test.beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dreamify-test-"));
  origHome = process.env.LLM_PIPELINE_HOME;
  process.env.LLM_PIPELINE_HOME = home;
  resetPipelineMemoryRegistry();
  setDreamifyRetrievalOverride(null);
});

test.afterEach(() => {
  if (origHome !== undefined) process.env.LLM_PIPELINE_HOME = origHome;
  else delete process.env.LLM_PIPELINE_HOME;
  setDreamifyRetrievalOverride(null);
  rmSync(home, { recursive: true, force: true });
});

function seedApproved(prompt: string, id: string): string {
  const experimentId = hashPrompt(prompt);
  const trace: PipelineTrace = {
    id,
    prompt,
    promptLength: prompt.length,
    mode: "pipeline",
    steps: [{ name: "draft", provider: "mock", durationMs: 5, round: 1 }],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 5,
    hasVerifyResults: false,
    timestamp: "2026-05-28T15:00:00.000Z",
    totalUsage: { promptTokens: 10, completionTokens: 5 },
    experiment: { experimentId, variant: "v1", tags: [] },
  };
  recordTrace(trace);
  appendExperimentEntry({
    timestamp: trace.timestamp,
    traceId: id,
    experimentId,
    variant: "v1",
    tags: [],
    status: "approved",
    totalTokens: 15,
    promptTokens: 10,
    completionTokens: 5,
    durationMs: 5,
    rounds: 1,
    providers: ["mock"],
  });
  return experimentId;
}

test("saveDreamifyBestParams writes active + previous", () => {
  saveDreamifyBestParams(DEFAULT_DREAMIFY_RETRIEVAL, { experimentId: "e1", score: 0.5 });
  const next = { ...DEFAULT_DREAMIFY_RETRIEVAL, patternLimit: 5 };
  saveDreamifyBestParams(next, { experimentId: "e1", score: 0.7 });
  const file = loadDreamifyParamsFile();
  assert.equal(file?.active.patternLimit, 5);
  assert.equal(file?.previous?.patternLimit, 3);
  assert.ok(existsSync(getDreamifyBestParamsPath()));
});

test("scoreDreamifyParams rewards pattern hits on approved runs", () => {
  const prompt = "build auth module v2";
  const experimentId = seedApproved(prompt, "t-score-1");
  const mem = getPipelineLocalMemory();
  const cache = new PatternCache(mem, { project: "default" });
  cache.storeFromTrace({
    id: "t-score-1",
    prompt,
    promptLength: prompt.length,
    mode: "pipeline",
    steps: [{ name: "draft", provider: "mock", durationMs: 1, round: 1 }],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 1,
    hasVerifyResults: false,
    timestamp: "2026-05-28T15:00:00.000Z",
  });

  const high = scoreDreamifyParams(experimentId, DEFAULT_DREAMIFY_RETRIEVAL, mem);
  const strict = scoreDreamifyParams(
    experimentId,
    { ...DEFAULT_DREAMIFY_RETRIEVAL, minSemanticSimilarity: 0.99 },
    mem,
  );
  assert.ok(high.score >= strict.score);
  assert.equal(high.samples, 1);
});

test("runDreamifyTune small grid dryRun", () => {
  const prompt = "tune grid prompt";
  const experimentId = seedApproved(prompt, "t-tune");
  const mem = getPipelineLocalMemory();
  new PatternCache(mem).storeFromTrace({
    id: "t-tune",
    prompt,
    promptLength: prompt.length,
    mode: "pipeline",
    steps: [{ name: "draft", provider: "mock", durationMs: 1, round: 1 }],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 1,
    hasVerifyResults: false,
    timestamp: "2026-05-28T15:00:00.000Z",
  });

  const report = runDreamifyTune({
    experimentId,
    memory: mem,
    dryRun: true,
    grid: {
      minSemanticSimilarity: [0.35],
      patternLimit: [3],
      decayHalfLifeDays: [7],
      fileLinkMinOverlap: [1],
    },
  });
  assert.equal(report.candidatesEvaluated, 1);
  assert.ok(report.baseline.breakdown.score >= 0);
});

test("pattern cache uses saved dreamify params", () => {
  setDreamifyRetrievalOverride({ ...DEFAULT_DREAMIFY_RETRIEVAL, minSemanticSimilarity: 0.99 });
  const mem = getPipelineLocalMemory();
  const cache = new PatternCache(mem, { project: "default" });
  const prompt = "cached params test";
  cache.storeFromTrace({
    id: "t-cache",
    prompt,
    promptLength: prompt.length,
    mode: "pipeline",
    steps: [{ name: "draft", provider: "mock", durationMs: 1, round: 1 }],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 1,
    hasVerifyResults: false,
    timestamp: "2026-05-28T15:00:00.000Z",
  });
  const loose = matchPatternEntriesWithParams(mem, { project: "default" }, prompt, {
    ...DEFAULT_DREAMIFY_RETRIEVAL,
    minSemanticSimilarity: 0.2,
  });
  const strict = matchPatternEntriesWithParams(mem, { project: "default" }, prompt, {
    ...DEFAULT_DREAMIFY_RETRIEVAL,
    minSemanticSimilarity: 0.99,
  });
  assert.ok(loose.length >= strict.length);
});
