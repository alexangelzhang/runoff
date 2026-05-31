import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig } from "../src/core/config.ts";
import type { PipelineTrace } from "../src/observability/trace.ts";
import { recordTrace } from "../src/observability/trace.ts";
import { appendExperimentEntry } from "../src/observability/experiment-log.ts";
import { resetPipelineMemoryRegistry, getPipelineLocalMemory } from "../src/memory/pipeline-memory.ts";
import { structureTraceForDream, collectDreamBatch } from "../src/dream/dream-structured.ts";
import { applyDreamRules, getDreamAuditPath } from "../src/dream/dream-rules.ts";
import { enrichDreamBatchWithLlm } from "../src/dream/dream-llm.ts";
import { runDreamWorker } from "../src/dream/dream-worker.ts";
import { loadDreamState } from "../src/memory/dream-state.ts";
import { hashPrompt } from "../src/orchestration/pattern-cache.ts";

let home: string;
let origHome: string | undefined;

test.beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dream-test-"));
  origHome = process.env.LLM_PIPELINE_HOME;
  process.env.LLM_PIPELINE_HOME = home;
  resetPipelineMemoryRegistry();
  if (existsSync(getDreamAuditPath())) rmSync(getDreamAuditPath());
});

test.afterEach(() => {
  if (origHome !== undefined) process.env.LLM_PIPELINE_HOME = origHome;
  else delete process.env.LLM_PIPELINE_HOME;
  rmSync(home, { recursive: true, force: true });
});

function baseConfig(): PipelineConfig {
  return {
    providers: { mock: { type: "mock" } },
    pipeline: { draft: ["mock"] },
    orchestration: { mode: "dag", dream: { provider: "mock", llmEnabled: true } },
  };
}

function seedTrace(trace: PipelineTrace): void {
  recordTrace(trace);
  appendExperimentEntry({
    timestamp: trace.timestamp,
    traceId: trace.id,
    experimentId: trace.experiment!.experimentId,
    variant: trace.experiment!.variant,
    tags: [],
    status: trace.finalStatus,
    totalTokens: 100,
    promptTokens: 60,
    completionTokens: 40,
    durationMs: trace.totalDurationMs,
    rounds: trace.totalRounds,
    providers: trace.steps.map((s) => s.provider),
  });
}

test("structureTraceForDream extracts step fields", () => {
  const trace: PipelineTrace = {
    id: "t-struct",
    prompt: "Fix login",
    promptLength: 10,
    mode: "pipeline",
    steps: [
      {
        name: "draft",
        provider: "mock",
        durationMs: 50,
        round: 1,
        filesModified: ["src/a.ts"],
        errorDetail: { message: "x", code: "E1" },
      },
    ],
    totalRounds: 1,
    finalStatus: "failed",
    totalDurationMs: 50,
    hasVerifyResults: false,
    timestamp: "2026-05-28T10:00:00.000Z",
    experiment: { experimentId: "exp1", variant: "v1", tags: [] },
  };
  const item = structureTraceForDream(trace);
  assert.equal(item.traceId, "t-struct");
  assert.equal(item.promptHash, hashPrompt("Fix login"));
  assert.equal(item.steps[0]!.errorCode, "E1");
});

test("applyDreamRules ADD pattern for approved and LESSON for failed", () => {
  const mem = getPipelineLocalMemory();
  const approved: PipelineTrace = {
    id: "t-ok",
    prompt: "build feature X",
    promptLength: 16,
    mode: "pipeline",
    steps: [{ name: "draft", provider: "mock", durationMs: 10, round: 1 }],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 10,
    hasVerifyResults: false,
    timestamp: "2026-05-28T11:00:00.000Z",
    totalUsage: { promptTokens: 10, completionTokens: 5 },
    experiment: { experimentId: "e1", variant: "v", tags: [] },
  };
  seedTrace(approved);
  const batch = collectDreamBatch({ limit: 10 });
  assert.ok(batch.some((b) => b.traceId === "t-ok"));

  const rules = applyDreamRules(mem, batch.filter((b) => b.traceId === "t-ok"), {
    scope: { project: "default" },
  });
  assert.equal(rules.patternsAdded, 1);

  const failed: PipelineTrace = {
    ...approved,
    id: "t-fail",
    prompt: "build feature Y",
    finalStatus: "failed",
    timestamp: "2026-05-28T12:00:00.000Z",
    experiment: { experimentId: "e2", variant: "v", tags: [] },
    steps: [{ name: "draft", provider: "mock", durationMs: 10, round: 1, error: "boom" }],
  };
  seedTrace(failed);
  const batch2 = collectDreamBatch({ limit: 10 });
  const rules2 = applyDreamRules(mem, batch2.filter((b) => b.traceId === "t-fail"), {
    scope: { project: "default" },
  });
  assert.equal(rules2.lessonsStored, 1);
  assert.ok(existsSync(getDreamAuditPath()));
});

test("enrichDreamBatchWithLlm uses mock provider", async () => {
  const config = baseConfig();
  const items = [
    structureTraceForDream({
      id: "t-llm",
      prompt: "task",
      promptLength: 4,
      mode: "pipeline",
      steps: [],
      totalRounds: 0,
      finalStatus: "approved",
      totalDurationMs: 1,
      hasVerifyResults: false,
      timestamp: "2026-05-28T13:00:00.000Z",
    }),
  ];
  const { proposals, errors } = await enrichDreamBatchWithLlm(config, items);
  assert.equal(errors.length, 0);
  assert.ok(proposals.length >= 1);
  assert.equal(proposals[0]!.evidenceTraceId, "t-llm");
});

test("runDreamWorker end-to-end updates dream state", async () => {
  const config = baseConfig();
  const trace: PipelineTrace = {
    id: "t-worker",
    prompt: "dream worker test",
    promptLength: 17,
    mode: "pipeline",
    steps: [{ name: "draft", provider: "mock", durationMs: 5, round: 1 }],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 5,
    hasVerifyResults: false,
    timestamp: "2026-05-28T14:00:00.000Z",
    totalUsage: { promptTokens: 3, completionTokens: 2 },
    experiment: { experimentId: "ew", variant: "a", tags: [] },
  };
  seedTrace(trace);

  assert.equal(loadDreamState().lastDreamAt, null);
  const report = await runDreamWorker({ config, sinceLastRun: false, batchLimit: 20 });
  assert.ok(report.batchSize >= 1);
  assert.ok(report.rules.patternsAdded >= 0);
  assert.ok(report.llmProposals.length >= 0);
  assert.equal(loadDreamState().lastDreamAt !== null, true);

  const auditLines = readFileSync(getDreamAuditPath(), "utf8").trim().split("\n");
  assert.ok(auditLines.length >= 1);
});
