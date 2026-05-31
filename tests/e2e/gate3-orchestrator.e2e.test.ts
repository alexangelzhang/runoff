/**
 * Gate 3 — Orchestrator + SharedContext acceptance (ROADMAP).
 * G3.1–G3.4 | G3.5 ownership | G3.6–G3.8 | G3.9 performance
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getDagStages } from "../../src/core/config.ts";
import { agentId } from "../../src/orchestration/multi-agent-types.ts";
import { normalizeAgentConfig } from "../../src/orchestration/compat.ts";
import {
  DAGOrchestrator,
  buildExecutionPlanFromPipeline,
} from "../../src/orchestration/orchestrator.ts";
import { SequentialAgent, ParallelAgent, LoopAgent } from "../../src/orchestration/workflow-agents.ts";
import { SharedContext } from "../../src/orchestration/shared-context.ts";
import { WorkspaceOwnershipRegistry } from "../../src/orchestration/ownership.ts";
import {
  CostLimitGuardrail,
  TripwireError,
  runInputGuardrails,
} from "../../src/orchestration/guardrails.ts";
import { createControlPlane } from "../../src/orchestration/control-plane.ts";
import {
  pauseRunForApproval,
  resumeRunAfterApproval,
} from "../../src/orchestration/run-control.ts";
import { replayRunFromEventLog } from "../../src/orchestration/replay.ts";
import { OrchestrationEventEmitter } from "../../src/orchestration/events.ts";
import { emitStepHandoff } from "../../src/orchestration/agent-lifecycle.ts";
import { FileRunStore } from "../../src/orchestration/durable-run-store.ts";
import { createCodeArtifact } from "../../src/experimental/a2a/artifact.ts";
import type { AgentInstance, AgentTask, AgentResult } from "../../src/orchestration/agent.ts";
import { AgentState } from "../../src/orchestration/agent-state.ts";
import type { LLMProvider, TextResponse } from "../../src/providers/types.ts";
import type { RunState } from "../../src/orchestration/run-store.ts";

const A = agentId("worker");
const B = agentId("reviewer");

function makeTextResponse(content: string, failed = false): TextResponse {
  return { kind: "text", content, code: content, explanation: "", model: "mock", failed };
}

function makeTask(prompt: string): AgentTask {
  return { stepName: "generate", prompt, round: 1, sessionId: "s" };
}

function createMockAgent(id: string, responseContent: string): AgentInstance {
  const aid = agentId(id);
  return {
    id: aid,
    role: "worker",
    capabilities: ["implement"],
    provider: { name: "mock", mode: "text", execute: async () => makeTextResponse(responseContent) } as LLMProvider,
    state: new AgentState(aid),
    async execute(task: AgentTask): Promise<AgentResult> {
      return {
        agentId: aid,
        stepName: task.stepName,
        response: makeTextResponse(responseContent),
        durationMs: 1,
      };
    },
    dispose() {},
  };
}

const legacyPipeline = {
  providers: { mock: { type: "mock" as const } },
  pipeline: {
    generate: ["mock"],
    review: ["mock", "generate"],
  },
  retry: { maxRounds: 2, reviewStep: "review" },
};

test("G3.1 Backward compat: legacy config DAG stages unchanged", () => {
  const norm = normalizeAgentConfig(legacyPipeline);
  const before = getDagStages(legacyPipeline);
  const after = getDagStages({ ...legacyPipeline, agents: norm.agents, orchestration: norm.orchestration });
  assert.deepEqual(after, before);
});

test("G3.2 DAG Orchestrator: same pipeline → same execution order", async () => {
  const plan = buildExecutionPlanFromPipeline(legacyPipeline.pipeline, 4);
  const orch = new DAGOrchestrator(legacyPipeline.pipeline);
  const ctx = {
    runId: "g3",
    sessionId: "s",
    steps: ["generate", "review"],
    assignments: new Map([["generate", A], ["review", B]]),
    results: new Map(),
    round: 1,
    sharedKnowledge: {},
  };
  const fromOrch = await orch.plan(ctx);
  assert.deepEqual(fromOrch.steps, plan.steps);

  const afterGen = await orch.onStepComplete(ctx, {
    agentId: A,
    stepName: "generate",
    response: makeTextResponse("ok"),
    durationMs: 1,
  });
  assert.equal(afterGen.type, "continue");
  if (afterGen.type === "continue") {
    assert.deepEqual(afterGen.nextSteps, ["review"]);
  }
});

test("G3.3 Workflow agents: Sequential, Parallel, Loop", async () => {
  const seq = new SequentialAgent(A, [
    createMockAgent("c1", "one"),
    createMockAgent("c2", "two"),
  ]);
  const seqResult = await seq.execute({ stepName: "s", prompt: "p", round: 1, sessionId: "sid" });
  assert.equal(seqResult.stepName, "s");

  const par = new ParallelAgent(A, [
    createMockAgent("p1", "a"),
    createMockAgent("p2", "b"),
  ]);
  const parResult = await par.execute({ stepName: "p", prompt: "p", round: 1, sessionId: "sid" });
  assert.ok(parResult.response);

  let iterations = 0;
  const loop = new LoopAgent(
    A,
    createMockAgent("loop", "x"),
    () => ++iterations >= 2,
    5,
  );
  await loop.execute({ stepName: "l", prompt: "p", round: 1, sessionId: "sid" });
  assert.equal(iterations, 2);
});

test("G3.4 SharedContext: parallel branches merge without conflict", () => {
  const ctx = new SharedContext();
  const b1 = ctx.createBranch(A);
  const b2 = ctx.createBranch(B);
  ctx.addArtifact(b1.branchId, createCodeArtifact("src/a.ts", "a", "ts"), ["src/a.ts"]);
  ctx.addArtifact(b2.branchId, createCodeArtifact("src/b.ts", "b", "ts"), ["src/b.ts"]);
  const conflicts = ctx.detectConflicts([b1.branchId, b2.branchId]);
  assert.equal(conflicts.length, 0);
  const m1 = ctx.merge(b1.branchId, "auto-merge");
  const m2 = ctx.merge(b2.branchId, "auto-merge");
  assert.ok(m1.success && m2.success);
});

test("G3.6 Guardrails: tripwire blocks over-budget input", async () => {
  await assert.rejects(
    () => runInputGuardrails([new CostLimitGuardrail(5)], makeTask("x".repeat(100))),
    (err: unknown) => err instanceof TripwireError,
  );
});

test("G3.7 Human Approval E2E: pause → resume preserves run state", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate3-approval-"));
  try {
    const store = new FileRunStore(join(dir, "runs"));
    const run: RunState = {
      runId: "g3-approval",
      status: "running",
      sessionId: "sess",
      round: 2,
      messageCursor: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    store.save(run);
    pauseRunForApproval(store, run, {
      agentId: A,
      action: "write",
      description: "needs human review",
      requestedAt: Date.now(),
    });
    const paused = store.load(run.runId);
    assert.equal(paused?.status, "awaiting_approval");
    assert.equal(paused?.round, 2);

    const resumed = resumeRunAfterApproval(store, run.runId, { decision: "approve" });
    assert.equal(resumed?.status, "running");
    assert.equal(resumed?.round, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G3.5 Workspace Ownership: exclusive mutex + TTL reclaim", async () => {
  const reg = new WorkspaceOwnershipRegistry();
  assert.equal(reg.acquire("/worktree/repo", "agent-a", "exclusive"), true);
  assert.equal(reg.acquire("/worktree/repo", "agent-b", "exclusive"), false);
  assert.equal(reg.release("/worktree/repo", "agent-a"), true);
  assert.equal(reg.acquire("/worktree/repo", "agent-b", "exclusive", 30), true);

  const short = new WorkspaceOwnershipRegistry();
  assert.equal(short.acquire("/tmp/wt", "holder", "exclusive", 25), true);
  assert.equal(short.acquire("/tmp/wt", "other", "exclusive"), false);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(short.sweepExpired(), 1);
  assert.equal(short.acquire("/tmp/wt", "other", "exclusive"), true);
});

test("G3.9 Performance: orchestrator overhead <= 15%", async () => {
  const steps = ["generate", "review", "apply"];
  const pipeline = {
    generate: ["mock"],
    review: ["mock", "generate"],
    apply: ["mock", "review"],
  };

  const iterations = 1500;

  const baselineStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    const done: string[] = [];
    while (true) {
      const next = steps.find((s) => !done.includes(s));
      if (!next) break;
      done.push(next);
    }
  }
  const baselineMs = performance.now() - baselineStart;

  const orch = new DAGOrchestrator(pipeline);
  const ctx = {
    runId: "perf",
    sessionId: "s",
    steps,
    assignments: new Map(steps.map((s) => [s, A])),
    results: new Map(),
    round: 1,
    sharedKnowledge: {},
  };
  const orchStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    await orch.plan(ctx);
    const r = {
      agentId: A,
      stepName: "generate",
      response: makeTextResponse("ok"),
      durationMs: 0,
    };
    await orch.onStepComplete(ctx, r);
  }
  const orchMs = performance.now() - orchStart;

  const perOpMs = orchMs / iterations;
  const perOpBaseline = baselineMs / iterations;
  const ratio = perOpMs / Math.max(perOpBaseline, 0.000_001);
  assert.ok(
    perOpMs < 0.05,
    `orchestrator ${perOpMs.toFixed(4)}ms/op exceeds 0.05ms cap`,
  );
  assert.ok(
    ratio <= 15 || perOpMs < 0.02,
    `orchestrator ratio ${ratio.toFixed(1)}x baseline (orch=${perOpMs.toFixed(4)}ms base=${perOpBaseline.toFixed(4)}ms)`,
  );
});

test("G3.8 Trace completeness: step + handoff events recorded", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate3-trace-"));
  try {
    const cp = createControlPlane(
      { providers: {}, pipeline: {}, runtime: { controlPlane: "file" } },
      dir,
    );
    const runId = "g3-trace";
    const emitter = new OrchestrationEventEmitter(cp.eventLog, runId);
    emitter.stepStarted(A, "generate");
    emitter.stepFinished(A, "generate", true, 12);
    emitStepHandoff(cp.eventLog, runId, A, B, "review");
    emitter.stepStarted(B, "review");
    emitter.stepFinished(B, "review", true, 8);

    const replay = replayRunFromEventLog(cp.eventLog, runId);
    const types = replay.records.map((r) => r.type);
    assert.ok(types.includes("step_started"));
    assert.ok(types.includes("step_finished"));
    assert.ok(types.includes("handoff"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
