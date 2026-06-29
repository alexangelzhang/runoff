import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { agentId } from "../../src/orchestration/multi-agent-types.ts";
import { FileMessageBus } from "../../src/orchestration/durable-bus.ts";
import { FileEventLog } from "../../src/orchestration/durable-event-log.ts";
import { FileRunStore } from "../../src/orchestration/durable-run-store.ts";
import { createControlPlane } from "../../src/orchestration/control-plane.ts";
import {
  pauseRunForApproval,
  resumeRunAfterApproval,
  syncRunStoreFromPipeline,
} from "../../src/orchestration/run-control.ts";
import type { RunState } from "../../src/orchestration/run-store.ts";

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

test("FileRunStore survives restart (new instance, same dir)", () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-runs-"));
  try {
    const store1 = new FileRunStore(join(dir, "runs"));
    store1.save(makeRun("trace-1"));
    store1.save({ ...makeRun("trace-1"), round: 2, status: "paused" });

    const store2 = new FileRunStore(join(dir, "runs"));
    const loaded = store2.load("trace-1");
    assert.equal(loaded?.round, 2);
    assert.equal(loaded?.status, "paused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileEventLog append-only with 100+ events in order after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-events-"));
  try {
    const logPath = join(dir, "events.jsonl");
    const metaPath = join(dir, "events-meta.json");
    const log1 = new FileEventLog(logPath, metaPath);
    const seqs: number[] = [];
    for (let i = 0; i < 120; i++) {
      seqs.push(log1.append("run-a", { type: "step_started", agentId: A, stepId: `s${i}` }));
    }

    const log2 = new FileEventLog(logPath, metaPath);
    const replayed = log2.replay("run-a");
    assert.equal(replayed.length, 120);
    assert.deepEqual(replayed.map((e) => e.seq), seqs);
    assert.equal(replayed[0]?.event.type, "step_started");
    assert.equal(replayed[119]?.event.type, "step_started");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileMessageBus persists messages for query after restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-bus-"));
  try {
    const path = join(dir, "messages.jsonl");
    const bus1 = new FileMessageBus(path);
    bus1.send({
      type: "task_delegation",
      from: A,
      to: agentId("agent-b"),
      payload: { stepName: "gen", prompt: "p", round: 1 },
    });

    const bus2 = new FileMessageBus(path);
    assert.equal(bus2.messageCount, 1);
    assert.equal(bus2.query({ from: A }).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createControlPlane file mode uses durable adapters", () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-cp-"));
  try {
    const cp = createControlPlane({ providers: {}, pipeline: {}, runtime: { controlPlane: "file" } }, dir);
    assert.equal(cp.mode, "file");
    cp.runStore.save(makeRun("r1"));
    const reloaded = createControlPlane({ providers: {}, pipeline: {}, runtime: { controlPlane: "file" } }, dir);
    assert.equal(reloaded.runStore.load("r1")?.runId, "r1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approval pause and resume updates FileRunStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-approval-"));
  try {
    const store = new FileRunStore(join(dir, "runs"));
    const run = makeRun("run-approval");
    store.save(run);

    pauseRunForApproval(store, run, {
      agentId: A,
      action: "write_file",
      description: "patch main.ts",
      requestedAt: Date.now(),
    });
    assert.equal(store.load("run-approval")?.status, "awaiting_approval");

    const resumed = resumeRunAfterApproval(store, "run-approval", { decision: "approve" });
    assert.equal(resumed?.status, "running");
    assert.equal(resumed?.pendingApproval, undefined);

    pauseRunForApproval(store, run, {
      agentId: A,
      action: "delete_file",
      description: "rm -rf",
      requestedAt: Date.now(),
    });
    const rejected = resumeRunAfterApproval(store, "run-approval", {
      decision: "reject",
      reason: "too risky",
    });
    assert.equal(rejected?.status, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncRunStoreFromPipeline preserves exact pipeline status in metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-sync-status-"));
  try {
    const store = new FileRunStore(join(dir, "runs"));
    const run = syncRunStoreFromPipeline(store, {
      runId: "trace-awaiting-judge",
      sessionId: "session-awaiting-judge",
      round: 2,
      pipelineStatus: "awaiting_judge",
      resumeToken: "resume-1",
    });

    assert.equal(run.status, "paused");
    assert.equal(run.metadata?.pipelineStatus, "awaiting_judge");
    assert.equal(store.load("trace-awaiting-judge")?.metadata?.pipelineStatus, "awaiting_judge");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncRunStoreFromPipeline stores resume planner summary in metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-sync-resume-planner-"));
  try {
    const store = new FileRunStore(join(dir, "runs"));
    syncRunStoreFromPipeline(store, {
      runId: "trace-resume-planner",
      sessionId: "session-resume-planner",
      round: 1,
      pipelineStatus: "approved",
      resumeToken: "session-resume-planner",
      resumeReusePlan: {
        schemaVersion: 1,
        round: 1,
        entries: [
          {
            stepName: "generate",
            decision: "rerun",
            reason: "artifact completeness is partial",
            round: 1,
            evidenceRefs: ["stepResults.generate.resumeMetadata"],
          },
          {
            stepName: "review",
            decision: "rerun",
            reason: "downstream dependency generate must rerun on resume",
            round: 1,
            downstreamOf: "generate",
            evidenceRefs: ["stepResults.review.resumeMetadata"],
          },
        ],
        summary: { skipped: 0, rerun: 2 },
        evidenceRefs: ["stepResults.generate.resumeMetadata", "stepResults.review.resumeMetadata"],
      },
    });

    const stored = store.load("trace-resume-planner");
    assert.deepEqual(stored?.metadata?.resumePlanner, {
      round: 1,
      rerun: 2,
      skipped: 0,
      rerunSteps: [
        {
          stepName: "generate",
          reason: "artifact completeness is partial",
        },
        {
          stepName: "review",
          reason: "downstream dependency generate must rerun on resume",
          downstreamOf: "generate",
        },
      ],
      skippedHidden: 0,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
