import assert from "node:assert/strict";
import test from "node:test";
import { agentId } from "../src/orchestration/multi-agent-types.ts";
import { InMemoryMessageBus } from "../src/orchestration/bus.ts";
import { InMemoryEventLog } from "../src/orchestration/event-log.ts";
import { InMemoryRunStore, type RunState } from "../src/orchestration/run-store.ts";
import type { AgentMessage } from "../src/orchestration/messages.ts";

const A = agentId("agent-a");
const B = agentId("agent-b");
const C = agentId("agent-c");

// ============================================================
// MessageBus
// ============================================================

test("MessageBus: send assigns id and timestamp", () => {
  const bus = new InMemoryMessageBus();
  const msg = bus.send({
    type: "task_delegation",
    from: A,
    to: B,
    payload: { stepName: "gen", prompt: "do it", round: 1 },
  });
  assert.ok(msg.id.length > 0);
  assert.ok(msg.timestamp > 0);
  assert.equal(bus.messageCount, 1);
});

test("MessageBus: subscribe receives targeted messages", () => {
  const bus = new InMemoryMessageBus();
  const received: AgentMessage[] = [];
  bus.subscribe(B, (m) => received.push(m));

  bus.send({ type: "task_delegation", from: A, to: B, payload: { stepName: "s", prompt: "p", round: 1 } });
  bus.send({ type: "feedback", from: A, to: C, payload: { approved: true, feedback: "ok" } });

  assert.equal(received.length, 1);
  assert.equal(received[0].to, B);
  bus.clear();
});

test("MessageBus: subscribeAll receives all messages", () => {
  const bus = new InMemoryMessageBus();
  const all: AgentMessage[] = [];
  bus.subscribeAll((m) => all.push(m));

  bus.send({ type: "task_delegation", from: A, to: B, payload: { stepName: "s", prompt: "p", round: 1 } });
  bus.send({ type: "feedback", from: B, to: C, payload: { approved: false, feedback: "no" } });

  assert.equal(all.length, 2);
  bus.clear();
});

test("MessageBus: unsubscribe stops delivery", () => {
  const bus = new InMemoryMessageBus();
  const received: AgentMessage[] = [];
  const sub = bus.subscribe(B, (m) => received.push(m));

  bus.send({ type: "knowledge_share", from: A, to: B, payload: { entries: { k: "v" } } });
  sub.unsubscribe();
  bus.send({ type: "knowledge_share", from: A, to: B, payload: { entries: { k: "v2" } } });

  assert.equal(received.length, 1);
  bus.clear();
});

test("MessageBus: query filters by from/to/type", () => {
  const bus = new InMemoryMessageBus();
  bus.send({ type: "task_delegation", from: A, to: B, payload: { stepName: "s", prompt: "p", round: 1 } });
  bus.send({ type: "result_report", from: B, to: A, payload: { stepName: "s", success: true, durationMs: 100 } });
  bus.send({ type: "feedback", from: A, to: B, payload: { approved: true, feedback: "ok" } });

  assert.equal(bus.query({ from: A }).length, 2);
  assert.equal(bus.query({ to: B }).length, 2);
  assert.equal(bus.query({ type: "result_report" }).length, 1);
  assert.equal(bus.query({ from: A, type: "feedback" }).length, 1);
  bus.clear();
});

test("MessageBus: query with correlationId", () => {
  const bus = new InMemoryMessageBus();
  bus.send({ type: "task_delegation", from: A, to: B, correlationId: "req-1", payload: { stepName: "s", prompt: "p", round: 1 } });
  bus.send({ type: "result_report", from: B, to: A, correlationId: "req-1", payload: { stepName: "s", success: true, durationMs: 50 } });
  bus.send({ type: "feedback", from: A, to: C, payload: { approved: true, feedback: "ok" } });

  assert.equal(bus.query({ correlationId: "req-1" }).length, 2);
  bus.clear();
});

test("MessageBus: query with limit", () => {
  const bus = new InMemoryMessageBus();
  for (let i = 0; i < 10; i++) {
    bus.send({ type: "knowledge_share", from: A, to: B, payload: { entries: { i: String(i) } } });
  }
  assert.equal(bus.query({ limit: 3 }).length, 3);
  bus.clear();
});

test("MessageBus: clear resets everything", () => {
  const bus = new InMemoryMessageBus();
  bus.send({ type: "handoff", from: A, to: B, payload: { reason: "done" } });
  assert.equal(bus.messageCount, 1);
  bus.clear();
  assert.equal(bus.messageCount, 0);
  assert.equal(bus.query({}).length, 0);
});

// ============================================================
// EventLog
// ============================================================

test("EventLog: append returns monotonic seq", () => {
  const log = new InMemoryEventLog();
  const s1 = log.append("run-1", { type: "agent_registered", agentId: A, role: "worker" });
  const s2 = log.append("run-1", { type: "step_started", agentId: A, stepId: "gen" });
  assert.equal(s1, 1);
  assert.equal(s2, 2);
  assert.equal(log.length, 2);
});

test("EventLog: query by runId", () => {
  const log = new InMemoryEventLog();
  log.append("run-1", { type: "agent_registered", agentId: A, role: "worker" });
  log.append("run-2", { type: "agent_registered", agentId: B, role: "reviewer" });
  log.append("run-1", { type: "step_started", agentId: A, stepId: "gen" });

  assert.equal(log.query({ runId: "run-1" }).length, 2);
  assert.equal(log.query({ runId: "run-2" }).length, 1);
});

test("EventLog: query by eventType", () => {
  const log = new InMemoryEventLog();
  log.append("r", { type: "step_started", agentId: A, stepId: "s1" });
  log.append("r", { type: "step_finished", agentId: A, stepId: "s1", ok: true, durationMs: 100 });
  log.append("r", { type: "step_started", agentId: B, stepId: "s2" });

  assert.equal(log.query({ eventType: "step_started" }).length, 2);
  assert.equal(log.query({ eventType: "step_finished" }).length, 1);
});

test("EventLog: query afterSeq", () => {
  const log = new InMemoryEventLog();
  log.append("r", { type: "agent_registered", agentId: A, role: "worker" });
  log.append("r", { type: "step_started", agentId: A, stepId: "s" });
  log.append("r", { type: "step_finished", agentId: A, stepId: "s", ok: true });

  assert.equal(log.query({ afterSeq: 2 }).length, 2); // seq 2 and 3
  assert.equal(log.query({ afterSeq: 3 }).length, 1); // seq 3 only
});

test("EventLog: query with limit", () => {
  const log = new InMemoryEventLog();
  for (let i = 0; i < 10; i++) {
    log.append("r", { type: "step_started", agentId: A, stepId: `s${i}` });
  }
  assert.equal(log.query({ limit: 3 }).length, 3);
});

test("EventLog: replay returns events for run in order", () => {
  const log = new InMemoryEventLog();
  log.append("r1", { type: "agent_registered", agentId: A, role: "worker" });
  log.append("r1", { type: "step_started", agentId: A, stepId: "gen" });
  log.append("r2", { type: "agent_registered", agentId: B, role: "reviewer" });
  log.append("r1", { type: "step_finished", agentId: A, stepId: "gen", ok: true });

  const events = log.replay("r1");
  assert.equal(events.length, 3);
  assert.equal(events[0].event.type, "agent_registered");
  assert.equal(events[2].event.type, "step_finished");
});

test("EventLog: replay with afterSeq for incremental replay", () => {
  const log = new InMemoryEventLog();
  log.append("r", { type: "agent_registered", agentId: A, role: "worker" });
  const s2 = log.append("r", { type: "step_started", agentId: A, stepId: "s" });
  log.append("r", { type: "step_finished", agentId: A, stepId: "s", ok: true });

  const events = log.replay("r", s2);
  assert.equal(events.length, 1); // only seq 3 (after seq 2)
  assert.equal(events[0].event.type, "step_finished");
});

test("EventLog: clear resets everything", () => {
  const log = new InMemoryEventLog();
  log.append("r", { type: "step_started", agentId: A, stepId: "s" });
  log.clear();
  assert.equal(log.length, 0);
  assert.equal(log.query({}).length, 0);
});

// ============================================================
// RunStore
// ============================================================

function makeRun(runId: string, status: RunState["status"] = "running"): RunState {
  return {
    runId,
    status,
    sessionId: `sess-${runId}`,
    round: 1,
    messageCursor: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

test("RunStore: save and load", () => {
  const store = new InMemoryRunStore();
  const run = makeRun("r1");
  store.save(run);

  const loaded = store.load("r1");
  assert.ok(loaded);
  assert.equal(loaded.runId, "r1");
  assert.equal(loaded.status, "running");
  assert.equal(store.size, 1);
});

test("RunStore: load returns undefined for missing run", () => {
  const store = new InMemoryRunStore();
  assert.equal(store.load("nope"), undefined);
});

test("RunStore: save updates existing run", () => {
  const store = new InMemoryRunStore();
  store.save(makeRun("r1"));
  store.save({ ...makeRun("r1"), status: "completed", round: 3 });

  const loaded = store.load("r1");
  assert.equal(loaded?.status, "completed");
  assert.equal(loaded?.round, 3);
  assert.equal(store.size, 1);
});

test("RunStore: list all runs", () => {
  const store = new InMemoryRunStore();
  store.save(makeRun("r1", "running"));
  store.save(makeRun("r2", "completed"));
  store.save(makeRun("r3", "failed"));

  assert.equal(store.list().length, 3);
});

test("RunStore: list filters by status", () => {
  const store = new InMemoryRunStore();
  store.save(makeRun("r1", "running"));
  store.save(makeRun("r2", "completed"));
  store.save(makeRun("r3", "running"));

  assert.equal(store.list({ status: "running" }).length, 2);
  assert.equal(store.list({ status: "completed" }).length, 1);
  assert.equal(store.list({ status: "failed" }).length, 0);
});

test("RunStore: list filters by sessionId", () => {
  const store = new InMemoryRunStore();
  store.save({ ...makeRun("r1"), sessionId: "s1" });
  store.save({ ...makeRun("r2"), sessionId: "s2" });
  store.save({ ...makeRun("r3"), sessionId: "s1" });

  assert.equal(store.list({ sessionId: "s1" }).length, 2);
});

test("RunStore: delete removes run", () => {
  const store = new InMemoryRunStore();
  store.save(makeRun("r1"));
  assert.equal(store.delete("r1"), true);
  assert.equal(store.load("r1"), undefined);
  assert.equal(store.size, 0);
  assert.equal(store.delete("r1"), false);
});

test("RunStore: save with pendingApproval", () => {
  const store = new InMemoryRunStore();
  const run: RunState = {
    ...makeRun("r1"),
    status: "awaiting_approval",
    pendingApproval: {
      agentId: A,
      action: "write_file",
      description: "Write to /src/main.ts",
      requestedAt: Date.now(),
    },
  };
  store.save(run);

  const loaded = store.load("r1");
  assert.equal(loaded?.status, "awaiting_approval");
  assert.equal(loaded?.pendingApproval?.agentId, "agent-a");
  assert.equal(loaded?.pendingApproval?.action, "write_file");
});

test("RunStore: save with resumeToken", () => {
  const store = new InMemoryRunStore();
  store.save({ ...makeRun("r1"), resumeToken: "tok-abc" });
  assert.equal(store.load("r1")?.resumeToken, "tok-abc");
});

test("RunStore: clear resets everything", () => {
  const store = new InMemoryRunStore();
  store.save(makeRun("r1"));
  store.save(makeRun("r2"));
  store.clear();
  assert.equal(store.size, 0);
});

test("RunStore: load returns a copy (not a reference)", () => {
  const store = new InMemoryRunStore();
  store.save(makeRun("r1"));
  const a = store.load("r1")!;
  const b = store.load("r1")!;
  a.round = 99;
  assert.equal(b.round, 1); // b should not be affected
});
