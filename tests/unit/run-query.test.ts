import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryEventLog } from "../../src/orchestration/event-log.ts";
import { agentId } from "../../src/orchestration/multi-agent-types.ts";
import { queryRuns, runNextAction, summarizeRun } from "../../src/orchestration/run-query.ts";
import { syncRunStoreFromPipeline } from "../../src/orchestration/run-control.ts";
import type { RunState, RunStore } from "../../src/orchestration/run-store.ts";

function makeRun(runId: string, overrides: Partial<RunState> = {}): RunState {
  const now = Date.now();
  return {
    runId,
    status: "running",
    sessionId: `session-${runId}`,
    round: 1,
    messageCursor: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("runNextAction maps control-plane states to host actions", () => {
  assert.equal(runNextAction(makeRun("active", { status: "running" })).action, "wait");
  assert.equal(runNextAction(makeRun("paused", { status: "paused" })).action, "resume_from_checkpoint");
  assert.equal(runNextAction(makeRun("approval", { status: "awaiting_approval" })).action, "approve_or_reject");
  assert.match(
    runNextAction(makeRun("judge", { status: "paused", metadata: { pipelineStatus: "awaiting_judge" } })).hint,
    /runoff_race_apply/,
  );
  assert.equal(runNextAction(makeRun("max", { status: "paused", metadata: { pipelineStatus: "max_rounds" } })).action, "inspect_trace");
  assert.equal(
    runNextAction(makeRun("scope", { status: "paused", metadata: { pipelineStatus: "needs_clarification" } })).action,
    "resume_from_checkpoint",
  );
  assert.equal(runNextAction(makeRun("failed", { status: "failed" })).action, "inspect_trace");
  assert.equal(runNextAction(makeRun("done", { status: "completed" })).action, "no_action");
});

test("summarizeRun includes pending approval and latest event cursor", () => {
  const eventLog = new InMemoryEventLog();
  const run = makeRun("run-a", {
    status: "awaiting_approval",
    metadata: { pipelineStatus: "awaiting_plan_approval" },
    pendingApproval: {
      agentId: agentId("agent-a"),
      action: "write_file",
      description: "patch src/index.ts",
      requestedAt: 123,
      requestId: "req-1",
      phase: "action",
    },
  });
  eventLog.append("run-a", { type: "step_started", agentId: agentId("agent-a"), stepId: "gen" });
  eventLog.append("run-a", { type: "step_finished", agentId: agentId("agent-a"), stepId: "gen", success: true });

  const summary = summarizeRun(run, eventLog);

  assert.equal(summary.nextAction, "approve_or_reject");
  assert.equal(summary.pipelineStatus, "awaiting_plan_approval");
  assert.equal(summary.pendingApproval?.requestId, "req-1");
  assert.equal(summary.eventCursor, 2);
});

test("summarizeRun includes compact resumePlanner mark when stored on run metadata", () => {
  const summary = summarizeRun(
    makeRun("resume-mark", {
      metadata: {
        resumePlanner: {
          round: 1,
          rerun: 2,
          skipped: 1,
          rerunSteps: [],
          skippedHidden: 1,
        },
      },
    }),
  );
  assert.deepEqual(summary.resumePlanner, { rerun: 2, skipped: 1 });
});

test("queryRuns filters, sorts newest first, and supports full format", () => {
  const older = makeRun("older", { sessionId: "session-a", status: "completed", updatedAt: 10 });
  const newer = makeRun("newer", { sessionId: "session-a", status: "failed", updatedAt: 20 });
  const other = makeRun("other", { sessionId: "session-b", status: "failed", updatedAt: 30 });
  const runs = [older, newer, other];
  const store: RunStore = {
    save: () => {},
    load: (runId) => runs.find((run) => run.runId === runId),
    list: (filter) => runs.filter((run) => {
      if (filter?.status && run.status !== filter.status) return false;
      if (filter?.sessionId && run.sessionId !== filter.sessionId) return false;
      return true;
    }),
    delete: () => false,
    get size() {
      return runs.length;
    },
    clear: () => {},
  };

  const failed = queryRuns({
    runStore: store,
    controlPlaneMode: "memory",
    status: "failed",
    format: "summary",
  });
  assert.equal(failed.count, 2);
  assert.deepEqual(failed.runs.map((run) => run.runId), ["other", "newer"]);

  const full = queryRuns({
    runStore: store,
    controlPlaneMode: "memory",
    sessionId: "session-a",
    format: "full",
  });
  assert.equal(full.format, "full");
  assert.equal(full.count, 2);
  assert.equal("nextAction" in full.runs[0]!, false);
});

test("queryRuns full format exposes resume planner summary and summary includes compact mark", () => {
  const runs: RunState[] = [];
  const store: RunStore = {
    save: (run) => {
      const index = runs.findIndex((item) => item.runId === run.runId);
      if (index >= 0) runs[index] = run;
      else runs.push(run);
    },
    load: (runId) => runs.find((run) => run.runId === runId),
    list: () => runs,
    delete: () => false,
    get size() {
      return runs.length;
    },
    clear: () => {
      runs.length = 0;
    },
  };

  syncRunStoreFromPipeline(store, {
    runId: "trace-resume",
    sessionId: "session-resume",
    round: 1,
    pipelineStatus: "approved",
    resumeToken: "session-resume",
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
        {
          stepName: "format",
          decision: "skipped",
          reason: "resume metadata allows skip",
          round: 1,
          evidenceRefs: ["stepResults.format.resumeMetadata"],
        },
      ],
      summary: { skipped: 1, rerun: 2 },
      evidenceRefs: [
        "stepResults.generate.resumeMetadata",
        "stepResults.review.resumeMetadata",
        "stepResults.format.resumeMetadata",
      ],
    },
  });

  const summary = queryRuns({
    runStore: store,
    controlPlaneMode: "memory",
    format: "summary",
  });
  assert.equal("resumePlanner" in summary.runs[0]!, true);
  assert.deepEqual(summary.runs[0]?.resumePlanner, { rerun: 2, skipped: 1 });

  const full = queryRuns({
    runStore: store,
    controlPlaneMode: "memory",
    format: "full",
  });

  assert.deepEqual(full.runs[0]?.resumePlanner, {
    round: 1,
    rerun: 2,
    skipped: 1,
    rerunSteps: [
      {
        stepName: "generate",
        reason: "artifact completeness is partial",
        downstreamOf: undefined,
      },
      {
        stepName: "review",
        reason: "downstream dependency generate must rerun on resume",
        downstreamOf: "generate",
      },
    ],
    skippedHidden: 1,
  });
});
