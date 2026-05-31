import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAgentMemory } from "../../src/orchestration/memory.ts";
import {
  dominantVerdictForFile,
  extractEntityTriples,
  queryEntityVerdicts,
  storeEntityTriplesFromTrace,
  tripleKey,
} from "../../src/orchestration/trace-entities.ts";
import {
  PipelineHooks,
  getPipelineSharedMemory,
  resetSharedMemory,
  flushPipelineMemoryFormationQueue,
} from "../../src/pipeline/pipeline-hooks.ts";
import { CostTracker } from "../../src/routing/pricing.ts";
import type { PipelineTrace } from "../../src/observability/trace.ts";
import type { PipelineConfig } from "../../src/core/config.ts";

function makeTrace(overrides: Partial<PipelineTrace> = {}): PipelineTrace {
  return {
    id: "t-entity",
    prompt: "fix auth",
    promptLength: 8,
    mode: "pipeline",
    hasVerifyResults: false,
    steps: [],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 50,
    timestamp: new Date().toISOString(),
    lifecycle: "final",
    ...overrides,
  };
}

test("extractEntityTriples: one triple per provider+file+verdict", () => {
  const trace = makeTrace({
    steps: [
      {
        name: "gen",
        provider: "mock-pro",
        durationMs: 10,
        round: 1,
        verdict: "approved",
        filesModified: ["src/auth.ts", "src/auth.ts"],
      },
      {
        name: "review",
        provider: "mock",
        durationMs: 5,
        round: 1,
        verdict: "needs_revision",
        filesModified: ["src/auth.ts"],
      },
    ],
  });

  const triples = extractEntityTriples(trace);
  assert.equal(triples.length, 2);
  assert.ok(triples.some((t) => tripleKey(t.provider, t.file, t.verdict) === "mock-pro|src/auth.ts|approved"));
  assert.ok(triples.some((t) => tripleKey(t.provider, t.file, t.verdict) === "mock|src/auth.ts|needs_revision"));
});

test("storeEntityTriplesFromTrace upserts and dominantVerdictForFile prefers approved", () => {
  const mem = new InMemoryAgentMemory();
  const scope = { project: "entity-test" };

  const approved = makeTrace({
    id: "t1",
    steps: [
      { name: "g", provider: "mock-pro", durationMs: 1, round: 1, filesModified: ["lib/x.ts"], verdict: "approved" },
    ],
  });
  const failed = makeTrace({
    id: "t2",
    finalStatus: "failed",
    steps: [
      { name: "g", provider: "mock-pro", durationMs: 1, round: 1, filesModified: ["lib/x.ts"], error: "boom" },
    ],
  });

  assert.equal(storeEntityTriplesFromTrace(mem, approved, scope), 1);
  assert.equal(storeEntityTriplesFromTrace(mem, failed, scope), 1);

  const dominant = dominantVerdictForFile(mem, { provider: "mock-pro", file: "lib/x.ts", scope });
  assert.equal(dominant, "approved");
});

test("PipelineHooks onPipelineEnd stores entity relations", async () => {
  resetSharedMemory();

  const config: PipelineConfig = {
    providers: { mock: { type: "mock" } },
    pipeline: { stepA: ["mock"] },
  };
  const hooks = new PipelineHooks(config, "trace-entity-hook", "sess-entity");
  const trace = makeTrace({
    id: "trace-entity-hook",
    steps: [
      { name: "stepA", provider: "mock", durationMs: 1, round: 1, filesModified: ["src/hook.ts"] },
    ],
  });

  await hooks.onPipelineEnd({ trace, costTracker: new CostTracker() });
  await flushPipelineMemoryFormationQueue();

  const edges = queryEntityVerdicts(getPipelineSharedMemory(), {
    provider: "mock",
    file: "src/hook.ts",
    scope: { project: "default" },
  });
  assert.ok(edges.length >= 1);
  assert.equal(edges[0]!.verdict, "approved");
});
