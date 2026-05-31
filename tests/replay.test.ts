import assert from "node:assert/strict";
import test from "node:test";
import { agentId } from "../src/orchestration/multi-agent-types.ts";
import { InMemoryEventLog } from "../src/orchestration/event-log.ts";
import {
  enrichTraceWithEventLog,
  replayRunFromEventLog,
} from "../src/orchestration/replay.ts";
import type { PipelineTrace } from "../src/observability/trace.ts";

const A = agentId("worker");

test("replayRunFromEventLog preserves order and counts", () => {
  const log = new InMemoryEventLog();
  const runId = "run-replay";
  for (let i = 0; i < 50; i++) {
    log.append(runId, { type: "step_started", agentId: A, stepId: `s${i}` });
    log.append(runId, { type: "step_finished", agentId: A, stepId: `s${i}`, ok: true, durationMs: 10 });
  }
  log.append(runId, { type: "handoff", from: A, to: agentId("reviewer"), reason: "review" });

  const { records, summary } = replayRunFromEventLog(log, runId);
  assert.equal(records.length, 101);
  assert.equal(summary.stepStarted, 50);
  assert.equal(summary.stepFinished, 50);
  assert.equal(summary.handoffs, 1);
  assert.equal(records[0]!.seq, 1);
  assert.equal(records[records.length - 1]!.seq, 101);
});

test("enrichTraceWithEventLog attaches orchestrationEvents", () => {
  const log = new InMemoryEventLog();
  const runId = "t1";
  log.append(runId, { type: "plan_created", agentId: agentId("orchestrator"), steps: ["a", "b"] });
  log.append(runId, { type: "step_started", agentId: A, stepId: "a" });

  const base: PipelineTrace = {
    id: runId,
    prompt: "p",
    promptLength: 1,
    mode: "pipeline",
    steps: [],
    totalRounds: 0,
    finalStatus: "running",
    totalDurationMs: 0,
    hasVerifyResults: false,
    timestamp: new Date().toISOString(),
  };

  const enriched = enrichTraceWithEventLog(base, log, runId);
  assert.equal(enriched.orchestrationEvents?.length, 2);
  assert.equal(enriched.orchestrationEvents?.[0]?.type, "plan_created");
});
