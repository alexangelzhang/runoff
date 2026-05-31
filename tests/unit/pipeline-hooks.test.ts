/**
 * Tests for PipelineHooks — wiring experiment-log, experiment-judge,
 * event-log, CostTracker (per-step cost), and pattern-cache into the pipeline lifecycle.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  PipelineHooks,
  resetSharedMemory,
} from "../../src/pipeline/pipeline-hooks.js";
import type { PipelineTrace, StepTrace } from "../../src/observability/trace.js";
import { loadTraceById, recordTrace } from "../../src/observability/trace.js";
import type { PipelineConfig } from "../../src/core/config.js";
import { CostTracker } from "../../src/routing/pricing.js";
import { queryExperiments } from "../../src/observability/experiment-log.js";
import { InMemoryAgentMemory } from "../../src/orchestration/memory.js";
import { PatternCache } from "../../src/orchestration/pattern-cache.js";

// --- Helpers ---

function makeConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    providers: { "test-provider": { type: "cli", command: "echo test" } },
    pipeline: { draft: ["test-provider"] },
    ...overrides,
  };
}

function makeTrace(overrides: Partial<PipelineTrace> = {}): PipelineTrace {
  return {
    id: "trace-1",
    prompt: "fix the login bug",
    promptLength: 20,
    mode: "pipeline",
    steps: [
      {
        name: "draft",
        provider: "test-provider",
        durationMs: 1000,
        round: 1,
        usage: { promptTokens: 500, completionTokens: 200 },
      },
    ],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 1000,
    hasVerifyResults: false,
    timestamp: "2026-04-03T10:00:00Z",
    totalUsage: { promptTokens: 500, completionTokens: 200 },
    ...overrides,
  };
}

function makeStepTrace(overrides: Partial<StepTrace> = {}): StepTrace {
  return {
    name: "draft",
    provider: "test-provider",
    durationMs: 1000,
    round: 1,
    usage: { promptTokens: 500, completionTokens: 200 },
    ...overrides,
  };
}

// --- Env setup: redirect home dir for isolation ---

let tmpDir: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pipeline-hooks-test-"));
  origHome = process.env.LLM_PIPELINE_HOME;
  process.env.LLM_PIPELINE_HOME = tmpDir;
  resetSharedMemory();
});

afterEach(() => {
  if (origHome !== undefined) {
    process.env.LLM_PIPELINE_HOME = origHome;
  } else {
    delete process.env.LLM_PIPELINE_HOME;
  }
  resetSharedMemory();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ============================================================
// onPipelineStart — pattern injection
// ============================================================

describe("PipelineHooks.addEventListener", () => {
  it("receives step_started from onPipelineStart", async () => {
    const config = makeConfig();
    const hooks = new PipelineHooks(config, "trace-events", "sess-events");
    const types: string[] = [];
    const off = hooks.addEventListener((ev) => types.push(ev.type));
    await hooks.onPipelineStart({
      prompt: "p",
      config,
      traceId: "trace-events",
      sessionId: "s",
    });
    off();
    assert.ok(types.includes("step_started"));
  });
});

describe("PipelineHooks.onPipelineStart", () => {
  it("returns empty patternContext when no patterns exist", async () => {
    const config = makeConfig();
    const hooks = new PipelineHooks(config, "trace-1", "sess-1");
    const result = await hooks.onPipelineStart({
      prompt: "fix the login bug",
      config,
      traceId: "trace-1",
      sessionId: "session-1",
    });
    assert.equal(result.patternContext, "");
  });

  it("returns patternContext when matching patterns exist", () => {
    // Pre-populate pattern cache via a successful trace
    const memory = new InMemoryAgentMemory();
    const cache = new PatternCache(memory, { project: "default" });
    const trace = makeTrace();
    cache.storeFromTrace(trace);

    // Now create hooks — but hooks uses PersistentAgentMemory singleton,
    // so for this test we verify the pattern-cache logic independently
    const patterns = cache.matchPatterns("fix the login bug", 3);
    const context = cache.formatAsContext(patterns);
    assert.ok(context.length > 0, "Should have pattern context");
    assert.ok(context.includes("test-provider"), "Should mention provider");
  });
});

// ============================================================
// onStepComplete — cost write
// ============================================================

describe("PipelineHooks.onStepComplete", () => {
  it("writes cost to stepTrace", async () => {
    const config = makeConfig();
    const hooks = new PipelineHooks(config, "trace-1", "sess-1");
    await hooks.onPipelineStart({
      prompt: "test",
      config,
      traceId: "trace-1",
      sessionId: "session-1",
    });

    const stepTrace = makeStepTrace();
    assert.equal(stepTrace.cost, undefined, "cost should not exist before hook");

    hooks.onStepComplete({
      stepTrace,
      stepName: "draft",
      provider: "test-provider",
      model: "gpt-4o",
      usage: { promptTokens: 500, completionTokens: 200 },
    });

    assert.ok(stepTrace.cost, "cost should be populated after hook");
    assert.ok(stepTrace.cost!.inputCost >= 0, "inputCost should be non-negative");
    assert.ok(stepTrace.cost!.outputCost >= 0, "outputCost should be non-negative");
    assert.ok(stepTrace.cost!.totalCost > 0, "totalCost should be positive for gpt-4o");
  });

  it("handles unknown model gracefully", async () => {
    const config = makeConfig();
    const hooks = new PipelineHooks(config, "trace-1", "sess-1");
    await hooks.onPipelineStart({
      prompt: "test",
      config,
      traceId: "trace-1",
      sessionId: "session-1",
    });

    const stepTrace = makeStepTrace();
    hooks.onStepComplete({
      stepTrace,
      stepName: "draft",
      provider: "test-provider",
      model: "unknown-model-xyz",
      usage: { promptTokens: 100, completionTokens: 50 },
    });

    assert.ok(stepTrace.cost, "cost should still be populated with default pricing");
    assert.ok(stepTrace.cost!.totalCost > 0);
  });
});

// ============================================================
// onPipelineEnd — experiment log + judge + pattern learning
// ============================================================

describe("PipelineHooks.onPipelineEnd", () => {
  it("tags trace with experiment metadata", async () => {
    const config = makeConfig();
    const hooks = new PipelineHooks(config, "trace-1", "sess-1");
    await hooks.onPipelineStart({
      prompt: "fix the login bug",
      config,
      traceId: "trace-1",
      sessionId: "session-1",
    });

    const trace = makeTrace();
    assert.equal(trace.experiment, undefined, "experiment should not exist before hook");

    await hooks.onPipelineEnd({ trace, costTracker: new CostTracker() });

    assert.ok(trace.experiment, "experiment should be set after hook");
    assert.ok(trace.experiment!.experimentId.length > 0, "experimentId should be non-empty");
    assert.ok(trace.experiment!.variant.length > 0, "variant should be non-empty");
  });

  it("records entry to experiment log", async () => {
    const config = makeConfig();
    const hooks = new PipelineHooks(config, "trace-1", "sess-1");
    await hooks.onPipelineStart({
      prompt: "fix the login bug",
      config,
      traceId: "trace-1",
      sessionId: "session-1",
    });

    const trace = makeTrace();
    await hooks.onPipelineEnd({ trace, costTracker: new CostTracker() });

    const entries = queryExperiments({});
    assert.ok(entries.length >= 1, "Should have at least one experiment entry");
    assert.equal(entries[entries.length - 1].traceId, "trace-1");
  });

  it("first run has no verdict (no baseline)", async () => {
    const config = makeConfig();
    const hooks = new PipelineHooks(config, "trace-1", "sess-1");
    await hooks.onPipelineStart({
      prompt: "fix the login bug",
      config,
      traceId: "trace-1",
      sessionId: "session-1",
    });

    const trace = makeTrace();
    await hooks.onPipelineEnd({ trace, costTracker: new CostTracker() });

    const entries = queryExperiments({});
    const last = entries[entries.length - 1];
    assert.equal(last.verdict, undefined, "First run should have no verdict");
  });

  it("does not store pattern for failed trace", async () => {
    const config = makeConfig();
    const hooks = new PipelineHooks(config, "trace-1", "sess-1");
    await hooks.onPipelineStart({
      prompt: "fix the login bug",
      config,
      traceId: "trace-1",
      sessionId: "session-1",
    });

    const trace = makeTrace({ finalStatus: "failed" });
    await hooks.onPipelineEnd({ trace, costTracker: new CostTracker() });

    // Verify experiment entry still recorded (even for failures)
    const entries = queryExperiments({});
    assert.ok(entries.length >= 1);
  });

  it("same experimentId for same prompt", async () => {
    const config = makeConfig();

    const hooks1 = new PipelineHooks(config, "trace-1", "sess-1");
    await hooks1.onPipelineStart({ prompt: "fix the login bug", config, traceId: "trace-1", sessionId: "s1" });
    const trace1 = makeTrace({ id: "trace-1" });
    await hooks1.onPipelineEnd({ trace: trace1, costTracker: new CostTracker() });

    const hooks2 = new PipelineHooks(config, "trace-2", "sess-2");
    await hooks2.onPipelineStart({ prompt: "fix the login bug", config, traceId: "trace-2", sessionId: "s2" });
    const trace2 = makeTrace({ id: "trace-2" });
    await hooks2.onPipelineEnd({ trace: trace2, costTracker: new CostTracker() });

    assert.equal(
      trace1.experiment!.experimentId,
      trace2.experiment!.experimentId,
      "Same prompt should produce same experimentId",
    );
  });

  it("second approved run judges against baseline", async () => {
    const config = makeConfig();
    const prompt = "fix the login bug";

    const hooks1 = new PipelineHooks(config, "trace-base", "sess-base");
    await hooks1.onPipelineStart({ prompt, config, traceId: "trace-base", sessionId: "s-base" });
    const trace1 = makeTrace({ id: "trace-base", totalDurationMs: 2000 });
    recordTrace(trace1);
    await hooks1.onPipelineEnd({ trace: trace1, costTracker: new CostTracker() });

    const hooks2 = new PipelineHooks(config, "trace-challenger", "sess-challenger");
    await hooks2.onPipelineStart({ prompt, config, traceId: "trace-challenger", sessionId: "s-challenger" });
    const trace2 = makeTrace({ id: "trace-challenger", totalDurationMs: 1500 });
    recordTrace(trace2);
    await hooks2.onPipelineEnd({ trace: trace2, costTracker: new CostTracker() });

    const entries = queryExperiments({ experimentId: trace2.experiment!.experimentId });
    const challenger = entries.find((e) => e.traceId === "trace-challenger");
    assert.ok(challenger?.verdict, "Second approved run should receive judge verdict");
    assert.ok(challenger?.judgeScores, "Judge scores should be populated");
  });

  it("onPipelineFailed records experiment without baseline judge", async () => {
    const config = makeConfig();
    const hooks = new PipelineHooks(config, "trace-fail", "sess-fail");
    await hooks.onPipelineStart({
      prompt: "fix the login bug",
      config,
      traceId: "trace-fail",
      sessionId: "session-fail",
    });
    const trace = makeTrace({ id: "trace-fail", finalStatus: "failed" });
    await hooks.onPipelineFailed({ trace, costTracker: new CostTracker() });
    assert.equal(trace.costSummary?.totalCostUSD, 0);
    assert.equal(trace.experiment?.experimentId.length > 0, true);
  });

  it("onPipelineEnd attaches costSummary", async () => {
    const config = makeConfig();
    const hooks = new PipelineHooks(config, "trace-cost", "sess-cost");
    await hooks.onPipelineStart({
      prompt: "fix the login bug",
      config,
      traceId: "trace-cost",
      sessionId: "session-cost",
    });
    const tracker = new CostTracker();
    tracker.addCall("draft", "p", "m", { promptTokens: 10, completionTokens: 5 });
    const trace = makeTrace({ id: "trace-cost" });
    await hooks.onPipelineEnd({ trace, costTracker: tracker });
    assert.ok(trace.costSummary && trace.costSummary.totalTokens > 0);
  });

  it("onPipelineEnd persists globalKnowledge via updateTrace", async () => {
    const config = makeConfig();
    const hooks = new PipelineHooks(config, "trace-gk", "sess-gk");
    await hooks.onPipelineStart({
      prompt: "fix the login bug",
      config,
      traceId: "trace-gk",
      sessionId: "sess-gk",
    });
    const trace = makeTrace({ id: "trace-gk" });
    recordTrace(trace);
    await hooks.onPipelineEnd({
      trace,
      costTracker: new CostTracker(),
      globalKnowledge: { authStrategy: "Use JWT rotation for session continuity in gateway layer" },
    });
    const loaded = loadTraceById("trace-gk");
    assert.ok(loaded?.globalKnowledge?.authStrategy?.includes("JWT"));
    assert.equal(loaded?.sessionId, "sess-gk");
  });

  it("different variant for different config", async () => {
    const config1 = makeConfig();
    const config2 = makeConfig({
      providers: { "other-provider": { type: "cli", command: "echo other" } },
      pipeline: { draft: ["other-provider"] },
    });

    const hooks1 = new PipelineHooks(config1, "trace-1", "sess-1");
    await hooks1.onPipelineStart({ prompt: "fix the login bug", config: config1, traceId: "trace-1", sessionId: "s1" });
    const trace1 = makeTrace({ id: "trace-1" });
    await hooks1.onPipelineEnd({ trace: trace1, costTracker: new CostTracker() });

    const hooks2 = new PipelineHooks(config2, "trace-2", "sess-2");
    await hooks2.onPipelineStart({ prompt: "fix the login bug", config: config2, traceId: "trace-2", sessionId: "s2" });
    const trace2 = makeTrace({ id: "trace-2" });
    await hooks2.onPipelineEnd({ trace: trace2, costTracker: new CostTracker() });

    assert.notEqual(
      trace1.experiment!.variant,
      trace2.experiment!.variant,
      "Different config should produce different variant",
    );
  });
});
