import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAgentMemory } from "../src/orchestration/memory.ts";
import { PatternCache } from "../src/orchestration/pattern-cache.ts";
import { redactSecrets } from "../src/orchestration/memory-redaction.ts";
import {
  judgeExperiment,
  type JudgeDimensionScores,
} from "../src/orchestration/experiment-judge.ts";
import type { PipelineTrace } from "../src/observability/trace.ts";
import { InMemoryEventLog } from "../src/orchestration/event-log.ts";
import { OrchestrationEventEmitter } from "../src/orchestration/events.ts";
import { agentId } from "../src/orchestration/multi-agent-types.ts";
import { createStepSpanId } from "../src/observability/trace.ts";
import {
  bucketTracesByTime,
  detectTraceDrift,
} from "../src/orchestration/trace-drift.ts";
import { AgentCardRegistry } from "../src/orchestration/a2a/agent-card.ts";
import { buildAgentCardRegistry } from "../src/orchestration/a2a/config-bridge.ts";
import { HttpA2ATransport } from "../src/orchestration/a2a/http-transport.ts";
import type { PipelineConfig } from "../src/core/config.ts";

function makeTrace(overrides: Partial<PipelineTrace> = {}): PipelineTrace {
  return {
    id: "t1",
    prompt: "fix",
    promptLength: 3,
    mode: "pipeline",
    hasVerifyResults: false,
    steps: [{ name: "gen", provider: "mock", durationMs: 10, round: 1 }],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 100,
    timestamp: new Date().toISOString(),
    lifecycle: "final",
    ...overrides,
  };
}

test("8.1.7 buildAssociativeContext includes file-linked patterns", () => {
  const mem = new InMemoryAgentMemory();
  const cache = new PatternCache(mem, { project: "assoc" });

  const base: PipelineTrace = {
    ...makeTrace({ id: "a", prompt: "auth module refactor" }),
    steps: [
      { name: "gen", provider: "mock", durationMs: 1, round: 1, filesModified: ["src/auth.ts"] },
    ],
  };
  const linked: PipelineTrace = {
    ...makeTrace({ id: "b", prompt: "unrelated oauth task" }),
    steps: [
      { name: "gen", provider: "mock-pro", durationMs: 1, round: 1, filesModified: ["src/auth.ts"] },
    ],
  };

  cache.storeFromTrace(base);
  cache.storeFromTrace(linked);

  const ctx = cache.buildAssociativeContext("auth module refactor", 2);
  assert.match(ctx, /mock-pro/);
  assert.match(ctx, /Prior successful patterns/);
});

test("memory redaction strips api keys on store", () => {
  const mem = new InMemoryAgentMemory();
  const stored = mem.store({
    agentId: agentId("w"),
    scope: { project: "p" },
    category: "lesson",
    content: "use api_key=sk-abcdefghijklmnopqrstuvwxyz1234567890",
    metadata: {},
  });
  assert.match(stored.content, /\[REDACTED\]/);
  assert.ok(!stored.content.includes("sk-abc"));
});

test("8.3.7 judgeExperiment returns multidimensional scores", () => {
  const baseline = makeTrace({ totalUsage: { promptTokens: 1000, completionTokens: 500 } });
  const candidate = makeTrace({
    id: "c",
    totalUsage: { promptTokens: 400, completionTokens: 200 },
  });
  const result = judgeExperiment(baseline, candidate);
  const scores: JudgeDimensionScores = result.scores;
  assert.equal(scores.correctness, 1);
  assert.ok(scores.tokenEfficiency > 0.9);
  assert.ok(scores.overall > 0.7);
});

test("8.3.8 detectTraceDrift flags approval regression", () => {
  const now = Date.now();
  const traces: PipelineTrace[] = [];
  for (let i = 0; i < 8; i++) {
    traces.push(
      makeTrace({
        id: `old-${i}`,
        timestamp: new Date(now - 120_000 + i * 1000).toISOString(),
        finalStatus: "approved",
        totalDurationMs: 100,
        totalUsage: { promptTokens: 100, completionTokens: 50 },
      }),
    );
  }
  for (let i = 0; i < 8; i++) {
    traces.push(
      makeTrace({
        id: `new-${i}`,
        timestamp: new Date(now - 30_000 + i * 1000).toISOString(),
        finalStatus: "failed",
        totalDurationMs: 400,
        totalUsage: { promptTokens: 400, completionTokens: 200 },
      }),
    );
  }
  const buckets = bucketTracesByTime(traces, 60_000);
  const alerts = detectTraceDrift(buckets, { threshold: 0.2, minBucketCount: 1 });
  assert.ok(alerts.some((a) => a.metric === "approvalRate"));
});

test("8.3.9 EventLogEntry carries spanId from step events", () => {
  const log = new InMemoryEventLog();
  const emitter = new OrchestrationEventEmitter(log, "run-span");
  const spanId = createStepSpanId();
  emitter.stepStarted(agentId("w"), "generate", { spanId });
  emitter.stepFinished(agentId("w"), "generate", true, 5, { spanId });

  const entries = log.replay("run-span");
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.spanId, spanId);
  assert.equal(entries[1]!.spanId, spanId);
});

test("A2A HTTP: discovery + bearer auth", async () => {
  const config: PipelineConfig = {
    providers: { mock: { type: "mock" } },
    pipeline: { stepA: ["mock"] },
    agents: { worker: { role: "worker", provider: "mock" } },
  };
  const registry = buildAgentCardRegistry(config);
  const transport = new HttpA2ATransport({
    auth: { bearerTokens: ["secret-token"] },
    registry,
    clientToken: "secret-token",
  });
  const { url } = await transport.start();

  const discovery = await fetch(`${url}/a2a/agents`);
  assert.equal(discovery.status, 200);
  const body = (await discovery.json()) as { agents: unknown[] };
  assert.equal(body.agents.length, 1);

  const bad = await fetch(`${url}/a2a/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      from: "worker",
      to: "worker",
      method: "ping",
      payload: {},
      timestamp: 0,
    }),
  });
  assert.equal(bad.status, 401);

  let got = false;
  transport.onMessage(agentId("worker"), async () => {
    got = true;
    return { ok: true };
  });
  await transport.send({
    id: "",
    from: agentId("worker"),
    to: agentId("worker"),
    method: "ping",
    payload: {},
    timestamp: 0,
  });
  assert.equal(got, true);
  await transport.stop();
});
