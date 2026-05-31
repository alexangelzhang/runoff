/**
 * Gate 2 — Durable Control Plane acceptance (ROADMAP).
 * G2.1–G2.4 persist/bus/approval | G2.5 lifecycle | G2.6 config compat | G2.7 typed artifacts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentId } from "../src/orchestration/multi-agent-types.ts";
import { createControlPlane } from "../src/orchestration/control-plane.ts";
import { FileRunStore } from "../src/orchestration/durable-run-store.ts";
import { FileEventLog } from "../src/orchestration/durable-event-log.ts";
import { FileMessageBus } from "../src/orchestration/durable-bus.ts";
import {
  pauseRunForApproval,
  resumeRunAfterApproval,
} from "../src/orchestration/run-control.ts";
import { replayRunFromEventLog } from "../src/orchestration/replay.ts";
import type { RunState } from "../src/orchestration/run-store.ts";
import { AgentRegistry } from "../src/orchestration/registry.ts";
import { MockProvider } from "../src/providers/mock.ts";
import {
  disposeRegistryTracked,
  emitRegistryRegistered,
  emitStepHandoff,
  lifecycleBalanced,
  summarizeLifecycle,
} from "../src/orchestration/agent-lifecycle.ts";
import { OrchestrationEventEmitter } from "../src/orchestration/events.ts";
import { normalizeAgentConfig } from "../src/orchestration/compat.ts";
import { artifactsFromStepResponse } from "../src/orchestration/artifact-bridge.ts";
import { isCodeArtifact, isVerdictArtifact } from "../src/orchestration/artifacts.ts";
import type { TextResponse } from "../src/providers/types.ts";

const A = agentId("agent-a");

function makeRun(runId: string): RunState {
  const now = Date.now();
  return {
    runId,
    status: "running",
    sessionId: `sess-${runId}`,
    round: 1,
    messageCursor: 0,
    createdAt: now,
    updatedAt: now,
  };
}

test("G2.1 Run Store: kill process → new store → state intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate2-runs-"));
  try {
    const path = join(dir, "runs");
    new FileRunStore(path).save({ ...makeRun("kill-test"), round: 3, resumeToken: "tok-1" });
    const reloaded = new FileRunStore(path).load("kill-test");
    assert.equal(reloaded?.round, 3);
    assert.equal(reloaded?.resumeToken, "tok-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G2.2 Event Log: 120 events survive restart with strict ordering", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate2-events-"));
  try {
    const logPath = join(dir, "events.jsonl");
    const metaPath = join(dir, "events-meta.json");
    const log1 = new FileEventLog(logPath, metaPath);
    const seqs: number[] = [];
    for (let i = 0; i < 120; i++) {
      seqs.push(log1.append("run-g2", { type: "step_started", agentId: A, stepId: `s${i}` }));
    }
    const log2 = new FileEventLog(logPath, metaPath);
    const replayed = replayRunFromEventLog(log2, "run-g2");
    assert.equal(replayed.records.length, 120);
    assert.deepEqual(replayed.records.map((r) => r.seq), seqs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G2.3 Message Bus: messages queryable after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate2-bus-"));
  try {
    const busPath = join(dir, "messages.jsonl");
    const bus1 = new FileMessageBus(busPath);
    bus1.send({
      type: "task_delegation",
      from: A,
      to: agentId("b"),
      payload: { stepName: "s", prompt: "p", round: 1 },
    });
    const bus2 = new FileMessageBus(busPath);
    assert.equal(bus2.query({ from: A }).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G2.4 Approval: pause does not advance round; resume continues", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate2-approval-"));
  try {
    const store = new FileRunStore(join(dir, "runs"));
    const run = makeRun("appr-run");
    store.save(run);
    pauseRunForApproval(store, run, {
      agentId: A,
      action: "write",
      description: "patch",
      requestedAt: Date.now(),
    });
    const paused = new FileRunStore(join(dir, "runs")).load("appr-run");
    assert.equal(paused?.status, "awaiting_approval");
    assert.equal(paused?.round, 1);

    const resumed = resumeRunAfterApproval(
      new FileRunStore(join(dir, "runs")),
      "appr-run",
      { decision: "approve" },
    );
    assert.equal(resumed?.status, "running");
    assert.equal(resumed?.round, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G2.5 Agent lifecycle: register → execute → handoff → dispose, no leak", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate2-lifecycle-"));
  try {
    const logPath = join(dir, "events.jsonl");
    const metaPath = join(dir, "events-meta.json");
    const log = new FileEventLog(logPath, metaPath);
    const runId = "life-run";
    const worker = agentId("generate");
    const reviewer = agentId("review");

    const registry = AgentRegistry.fromConfigs(
      [
        { id: worker, role: "worker", providerName: "mock", capabilities: ["implement"] },
        { id: reviewer, role: "reviewer", providerName: "mock", capabilities: ["review"] },
      ],
      () => new MockProvider(),
    );
    emitRegistryRegistered(registry, log, runId);

    const emitter = new OrchestrationEventEmitter(log, runId);
    emitter.stepStarted(worker, "generate");
    await registry.getOrThrow(worker).execute({
      stepName: "generate",
      prompt: "p",
      round: 1,
      sessionId: "s",
    });
    emitter.stepFinished(worker, "generate", true, 1);
    emitStepHandoff(log, runId, worker, reviewer, "review");
    emitter.stepStarted(reviewer, "review");
    emitter.stepFinished(reviewer, "review", true, 1);

    disposeRegistryTracked(registry, log, runId);

    const summary = summarizeLifecycle(log, runId);
    assert.ok(lifecycleBalanced(summary, registry.size));
    assert.equal(summary.registered, 2);
    assert.equal(summary.disposed, 2);
    assert.equal(summary.handoffs, 1);
    assert.equal(summary.stepStarted, 2);
    assert.equal(summary.stepFinished, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G2.6 Config compat: legacy pipeline → agents equivalence", () => {
  const config = {
    providers: { mock: { type: "mock" as const } },
    pipeline: {
      generate: ["mock"],
      review: ["mock", "generate"],
    },
    retry: { maxRounds: 2, reviewStep: "review" },
  };
  const norm = normalizeAgentConfig(config);
  assert.equal(norm.agents.generate.role, "worker");
  assert.equal(norm.agents.generate.provider, "mock");
  assert.equal(norm.agents.review.role, "reviewer");
  assert.equal(norm.orchestration.mode, "dag");
});

test("G2.7 Typed artifacts: discriminated kinds from step response", () => {
  const text: TextResponse = {
    kind: "text",
    content: "ok",
    code: "const x = 1;",
    explanation: "assign",
    model: "mock",
  };
  const codeArts = artifactsFromStepResponse(text, { stepName: "generate" });
  assert.equal(codeArts.length, 1);
  assert.ok(isCodeArtifact(codeArts[0]!));

  const withVerdict = artifactsFromStepResponse(text, {
    stepName: "review",
    verdict: { approved: true, feedback: "LGTM" },
    reviewText: "LGTM",
  });
  assert.equal(withVerdict.length, 3);
  assert.ok(isVerdictArtifact(withVerdict.find((a) => a.kind === "verdict")!));
  for (const a of withVerdict) {
    assert.ok(typeof a.kind === "string");
    assert.ok(a.createdAt > 0);
  }
});

test("G2 factory: file control plane round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate2-factory-"));
  try {
    const cp1 = createControlPlane({ providers: {}, pipeline: {}, runtime: { controlPlane: "file" } }, dir);
    cp1.runStore.save(makeRun("factory"));
    cp1.eventLog.append("factory", { type: "agent_registered", agentId: A, role: "worker" });

    const cp2 = createControlPlane({ providers: {}, pipeline: {}, runtime: { controlPlane: "file" } }, dir);
    assert.equal(cp2.runStore.load("factory")?.runId, "factory");
    assert.equal(cp2.eventLog.replay("factory").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
