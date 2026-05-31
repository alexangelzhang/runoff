import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig } from "../../src/core/config.ts";
import type { PipelineTrace } from "../../src/observability/trace.ts";
import { recordTrace } from "../../src/observability/trace.ts";
import { appendExperimentEntry } from "../../src/observability/experiment-log.ts";
import { resetPipelineMemoryRegistry, getPipelineLocalMemory } from "../../src/memory/pipeline-memory.ts";
import { structureTraceForDream, collectDreamBatch } from "../../src/dream/dream-structured.ts";
import { applyDreamRules, getDreamAuditPath } from "../../src/dream/dream-rules.ts";
import { enrichDreamBatchWithLlm } from "../../src/dream/dream-llm.ts";
import { runDreamWorker } from "../../src/dream/dream-worker.ts";
import { loadDreamState, touchDreamState } from "../../src/memory/dream-state.ts";
import { hashPrompt } from "../../src/orchestration/pattern-cache.ts";

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

test("collectDreamBatch sinceLastRun excludes experiments before lastDreamAt", () => {
  touchDreamState(new Date("2026-05-28T12:00:00.000Z"));
  const older: PipelineTrace = {
    id: "t-old",
    prompt: "old run",
    promptLength: 7,
    mode: "pipeline",
    steps: [{ name: "draft", provider: "mock", durationMs: 10, round: 1 }],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 10,
    hasVerifyResults: false,
    timestamp: "2026-05-28T11:00:00.000Z",
    totalUsage: { promptTokens: 10, completionTokens: 5 },
    experiment: { experimentId: "e-old", variant: "v", tags: [] },
  };
  const newer: PipelineTrace = {
    ...older,
    id: "t-new",
    timestamp: "2026-05-28T13:00:00.000Z",
    experiment: { experimentId: "e-new", variant: "v", tags: [] },
  };
  seedTrace(older);
  seedTrace(newer);

  const batch = collectDreamBatch({ sinceLastRun: true, limit: 10 });
  assert.ok(batch.some((b) => b.traceId === "t-new"));
  assert.ok(!batch.some((b) => b.traceId === "t-old"));
});

test("applyDreamRules B7 promotes globalKnowledge on approved runs when enabled", () => {
  const mem = getPipelineLocalMemory();
  const approved: PipelineTrace = {
    id: "t-gk",
    prompt: "build feature Z",
    promptLength: 16,
    mode: "pipeline",
    steps: [{ name: "draft", provider: "mock", durationMs: 10, round: 1 }],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 10,
    hasVerifyResults: false,
    timestamp: "2026-05-28T13:00:00.000Z",
    totalUsage: { promptTokens: 10, completionTokens: 5 },
    experiment: { experimentId: "e-gk", variant: "v", tags: [] },
    globalKnowledge: {
      authStrategy: "Use JWT with refresh rotation for session continuity in API gateway",
      _internal: "should skip underscore keys",
    },
  };
  seedTrace(approved);
  const item = structureTraceForDream(approved);
  assert.ok(item.globalKnowledge?.authStrategy);

  const rules = applyDreamRules(mem, [item], {
    scope: { project: "default" },
    promoteGlobalKnowledge: true,
    globalKnowledgeMinLength: 20,
  });
  assert.equal(rules.globalKnowledgePromoted, 1);
  const lessons = mem.retrieve({ category: "lesson", scope: { project: "default" }, limit: 10 });
  assert.ok(lessons.some((l) => l.content.includes("authStrategy")));
});

test("applyDreamRules B7 skips when promoteGlobalKnowledge false", () => {
  const mem = getPipelineLocalMemory();
  const item = structureTraceForDream({
    id: "t-gk-off",
    prompt: "x",
    promptLength: 1,
    mode: "pipeline",
    steps: [],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 1,
    hasVerifyResults: false,
    timestamp: "2026-05-28T13:30:00.000Z",
    globalKnowledge: { note: "This insight is long enough to pass min length filter" },
  });
  const rules = applyDreamRules(mem, [item], {
    scope: { project: "default" },
    promoteGlobalKnowledge: false,
  });
  assert.equal(rules.globalKnowledgePromoted, 0);
});

test("applyDreamRules B7 skips short values and non-string entries", () => {
  const mem = getPipelineLocalMemory();
  const trace: PipelineTrace = {
    id: "t-gk-edge",
    prompt: "x",
    promptLength: 1,
    mode: "pipeline",
    steps: [],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 1,
    hasVerifyResults: false,
    timestamp: "2026-05-28T14:00:00.000Z",
    experiment: { experimentId: "e-edge", variant: "v", tags: [] },
    globalKnowledge: {
      short: "too short",
      bad: 42,
      good: "This insight is long enough to pass the minimum length filter easily",
    } as unknown as Record<string, string>,
  };
  seedTrace(trace);
  const item = structureTraceForDream(trace);
  const rules = applyDreamRules(mem, [item], {
    scope: { project: "default" },
    promoteGlobalKnowledge: true,
    globalKnowledgeMinLength: 24,
  });
  assert.equal(rules.globalKnowledgePromoted, 1);
});

test("applyDreamRules B7 dry-run counts without storing", () => {
  const mem = getPipelineLocalMemory();
  const trace: PipelineTrace = {
    id: "t-gk-dry",
    prompt: "x",
    promptLength: 1,
    mode: "pipeline",
    steps: [],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 1,
    hasVerifyResults: false,
    timestamp: "2026-05-28T14:30:00.000Z",
    experiment: { experimentId: "e-dry", variant: "v", tags: [] },
    globalKnowledge: { note: "Dry run insight long enough to pass minimum length filter" },
  };
  seedTrace(trace);
  const item = structureTraceForDream(trace);
  const rules = applyDreamRules(mem, [item], {
    scope: { project: "default" },
    promoteGlobalKnowledge: true,
    dryRun: true,
  });
  assert.equal(rules.globalKnowledgePromoted, 1);
  const lessons = mem.retrieve({ category: "lesson", scope: { project: "default" }, limit: 10 });
  assert.equal(lessons.some((l) => l.content.includes("Dry run insight")), false);
});

test("applyDreamRules B7 skips duplicate keys on re-run", () => {
  const mem = getPipelineLocalMemory();
  const trace: PipelineTrace = {
    id: "t-gk-dup",
    prompt: "x",
    promptLength: 1,
    mode: "pipeline",
    steps: [],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 1,
    hasVerifyResults: false,
    timestamp: "2026-05-28T15:00:00.000Z",
    experiment: { experimentId: "e-dup", variant: "v", tags: [] },
    globalKnowledge: { note: "Duplicate promotion test insight with sufficient length" },
  };
  seedTrace(trace);
  const item = structureTraceForDream(trace);
  const opts = { scope: { project: "default" }, promoteGlobalKnowledge: true };
  const first = applyDreamRules(mem, [item], opts);
  const second = applyDreamRules(mem, [item], opts);
  assert.equal(first.globalKnowledgePromoted, 1);
  assert.equal(second.globalKnowledgePromoted, 0);
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

test("runDreamWorker promotes globalKnowledge when orchestration.dream.promoteGlobalKnowledge true", async () => {
  const config = baseConfig();
  config.orchestration = {
    ...config.orchestration,
    dream: { enabled: true, promoteGlobalKnowledge: true, llmEnabled: false },
  };
  const trace: PipelineTrace = {
    id: "t-worker-gk",
    prompt: "worker gk promotion test",
    promptLength: 24,
    mode: "pipeline",
    steps: [{ name: "draft", provider: "mock", durationMs: 5, round: 1 }],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 5,
    hasVerifyResults: false,
    timestamp: "2026-05-28T15:30:00.000Z",
    totalUsage: { promptTokens: 3, completionTokens: 2 },
    experiment: { experimentId: "ew-gk", variant: "a", tags: [] },
    globalKnowledge: {
      deployNote: "Use blue-green deploy with health checks before traffic shift",
    },
  };
  seedTrace(trace);

  const report = await runDreamWorker({ config, sinceLastRun: false, batchLimit: 20, llmEnabled: false });
  assert.ok(report.rules.globalKnowledgePromoted >= 1);
});
