import assert from "node:assert/strict";
import test from "node:test";
import { agentId } from "../../src/orchestration/multi-agent-types.ts";
import { SharedContext } from "../../src/orchestration/shared-context.ts";
import { createCodeArtifact, createDiffArtifact } from "../../src/orchestration/artifacts.ts";
import { InMemoryEventLog } from "../../src/orchestration/event-log.ts";
import { OrchestrationEventEmitter } from "../../src/orchestration/events.ts";
import {
  PolicyEngine,
  type PolicyRule,
} from "../../src/orchestration/policy.ts";
import {
  TripwireError,
  CostLimitGuardrail,
  SuccessGuardrail,
  runInputGuardrails,
  runOutputGuardrails,
  type InputGuardrail,
  type OutputGuardrail,
} from "../../src/orchestration/guardrails.ts";
import type { AgentTask, AgentResult } from "../../src/orchestration/agent.ts";
import type { TextResponse } from "../../src/providers/types.ts";

const A = agentId("agent-a");
const B = agentId("agent-b");

// ============================================================
// SharedContext (Wave 7.4)
// ============================================================

test("SharedContext: createBranch returns unique ids", () => {
  const ctx = new SharedContext();
  const b1 = ctx.createBranch(A);
  const b2 = ctx.createBranch(B);
  assert.notEqual(b1.branchId, b2.branchId);
  assert.equal(b1.ownerId, A);
  assert.equal(b2.ownerId, B);
  assert.equal(ctx.branchCount, 2);
});

test("SharedContext: addArtifact tracks artifacts and files", () => {
  const ctx = new SharedContext();
  const branch = ctx.createBranch(A);
  const art = createCodeArtifact("src/main.ts", "console.log('hi')", "ts");
  ctx.addArtifact(branch.branchId, art, ["src/main.ts"]);

  const b = ctx.getBranch(branch.branchId)!;
  assert.equal(b.artifacts.length, 1);
  assert.deepEqual(b.filesModified, ["src/main.ts"]);
});

test("SharedContext: addArtifact deduplicates files", () => {
  const ctx = new SharedContext();
  const branch = ctx.createBranch(A);
  const art1 = createCodeArtifact("a.ts", "x", "ts");
  const art2 = createCodeArtifact("a.ts", "y", "ts");
  ctx.addArtifact(branch.branchId, art1, ["a.ts"]);
  ctx.addArtifact(branch.branchId, art2, ["a.ts"]);

  assert.equal(ctx.getBranch(branch.branchId)!.filesModified.length, 1);
  assert.equal(ctx.getBranch(branch.branchId)!.artifacts.length, 2);
});

test("SharedContext: addArtifact throws on unknown branch", () => {
  const ctx = new SharedContext();
  const art = createCodeArtifact("a.ts", "x", "ts");
  assert.throws(() => ctx.addArtifact("nope", art), /Branch not found/);
});

test("SharedContext: addArtifact throws on merged branch", () => {
  const ctx = new SharedContext();
  const branch = ctx.createBranch(A);
  ctx.merge(branch.branchId);
  const art = createCodeArtifact("a.ts", "x", "ts");
  assert.throws(() => ctx.addArtifact(branch.branchId, art), /already merged/);
});

test("SharedContext: detectConflicts finds overlapping files", () => {
  const ctx = new SharedContext();
  const b1 = ctx.createBranch(A);
  const b2 = ctx.createBranch(B);
  ctx.addArtifact(b1.branchId, createCodeArtifact("shared.ts", "a", "ts"), ["shared.ts", "a.ts"]);
  ctx.addArtifact(b2.branchId, createCodeArtifact("shared.ts", "b", "ts"), ["shared.ts", "b.ts"]);

  const conflicts = ctx.detectConflicts(b1.branchId, b2.branchId);
  assert.deepEqual(conflicts, ["shared.ts"]);
});

test("SharedContext: detectConflicts returns empty for no overlap", () => {
  const ctx = new SharedContext();
  const b1 = ctx.createBranch(A);
  const b2 = ctx.createBranch(B);
  ctx.addArtifact(b1.branchId, createCodeArtifact("a.ts", "a", "ts"), ["a.ts"]);
  ctx.addArtifact(b2.branchId, createCodeArtifact("b.ts", "b", "ts"), ["b.ts"]);

  assert.deepEqual(ctx.detectConflicts(b1.branchId, b2.branchId), []);
});

test("SharedContext: merge auto-merge succeeds without conflicts", () => {
  const ctx = new SharedContext();
  const b1 = ctx.createBranch(A);
  ctx.addArtifact(b1.branchId, createCodeArtifact("a.ts", "a", "ts"), ["a.ts"]);

  const result = ctx.merge(b1.branchId);
  assert.equal(result.success, true);
  assert.equal(result.strategy, "auto-merge");
  assert.equal(result.mergedArtifacts.length, 1);
  assert.equal(ctx.getMainArtifacts().length, 1);
});

test("SharedContext: merge auto-merge fails on conflict", () => {
  const ctx = new SharedContext();
  const b1 = ctx.createBranch(A);
  const b2 = ctx.createBranch(B);
  ctx.addArtifact(b1.branchId, createCodeArtifact("x.ts", "a", "ts"), ["x.ts"]);
  ctx.addArtifact(b2.branchId, createCodeArtifact("x.ts", "b", "ts"), ["x.ts"]);

  ctx.merge(b1.branchId); // succeeds first
  const result = ctx.merge(b2.branchId, "auto-merge");
  assert.equal(result.success, false);
  assert.deepEqual(result.conflicts, ["x.ts"]);
});

test("SharedContext: merge pick-winner succeeds despite conflicts", () => {
  const ctx = new SharedContext();
  const b1 = ctx.createBranch(A);
  const b2 = ctx.createBranch(B);
  ctx.addArtifact(b1.branchId, createCodeArtifact("x.ts", "a", "ts"), ["x.ts"]);
  ctx.addArtifact(b2.branchId, createCodeArtifact("x.ts", "b", "ts"), ["x.ts"]);

  ctx.merge(b1.branchId);
  const result = ctx.merge(b2.branchId, "pick-winner");
  assert.equal(result.success, true);
  assert.equal(result.conflicts.length, 1);
  assert.equal(ctx.getMainArtifacts().length, 2);
});

test("SharedContext: merge manual fails on conflict", () => {
  const ctx = new SharedContext();
  const b1 = ctx.createBranch(A);
  const b2 = ctx.createBranch(B);
  ctx.addArtifact(b1.branchId, createCodeArtifact("x.ts", "a", "ts"), ["x.ts"]);
  ctx.addArtifact(b2.branchId, createCodeArtifact("x.ts", "b", "ts"), ["x.ts"]);

  ctx.merge(b1.branchId);
  const result = ctx.merge(b2.branchId, "manual");
  assert.equal(result.success, false);
});

test("SharedContext: merge throws on already merged branch", () => {
  const ctx = new SharedContext();
  const b = ctx.createBranch(A);
  ctx.merge(b.branchId);
  assert.throws(() => ctx.merge(b.branchId), /already merged/);
});

test("SharedContext: getActiveBranches excludes merged", () => {
  const ctx = new SharedContext();
  const b1 = ctx.createBranch(A);
  const b2 = ctx.createBranch(B);
  ctx.merge(b1.branchId);

  const active = ctx.getActiveBranches();
  assert.equal(active.length, 1);
  assert.equal(active[0].branchId, b2.branchId);
});

test("SharedContext: getBranchesForAgent filters by owner", () => {
  const ctx = new SharedContext();
  ctx.createBranch(A);
  ctx.createBranch(A);
  ctx.createBranch(B);

  assert.equal(ctx.getBranchesForAgent(A).length, 2);
  assert.equal(ctx.getBranchesForAgent(B).length, 1);
});

test("SharedContext: clear resets everything", () => {
  const ctx = new SharedContext();
  ctx.createBranch(A);
  ctx.createBranch(B);
  ctx.clear();
  assert.equal(ctx.branchCount, 0);
  assert.equal(ctx.getMainArtifacts().length, 0);
});

// ============================================================
// OrchestrationEventEmitter (Wave 7.6)
// ============================================================

test("EventEmitter: agentRegistered emits and logs", () => {
  const log = new InMemoryEventLog();
  const emitter = new OrchestrationEventEmitter(log, "run-1");
  const seq = emitter.agentRegistered(A, "worker");
  assert.equal(seq, 1);
  assert.equal(log.length, 1);
  const entries = log.query({ runId: "run-1" });
  assert.equal(entries[0].event.type, "agent_registered");
});

test("EventEmitter: stepStarted and stepFinished", () => {
  const log = new InMemoryEventLog();
  const emitter = new OrchestrationEventEmitter(log, "run-1");
  emitter.stepStarted(A, "gen");
  emitter.stepFinished(A, "gen", true, 150);

  const entries = log.query({ runId: "run-1" });
  assert.equal(entries.length, 2);
  assert.equal(entries[1].event.type, "step_finished");
});

test("EventEmitter: handoff event", () => {
  const log = new InMemoryEventLog();
  const emitter = new OrchestrationEventEmitter(log, "run-1");
  emitter.handoff(A, B, "review needed");

  const entries = log.query({ eventType: "handoff" });
  assert.equal(entries.length, 1);
});

test("EventEmitter: knowledgeShared event", () => {
  const log = new InMemoryEventLog();
  const emitter = new OrchestrationEventEmitter(log, "run-1");
  emitter.knowledgeShared(A, B, ["pattern", "style"]);

  const entries = log.query({ eventType: "knowledge_shared" });
  assert.equal(entries.length, 1);
});

test("EventEmitter: external listener receives events", () => {
  const log = new InMemoryEventLog();
  const emitter = new OrchestrationEventEmitter(log, "run-1");
  const received: Array<{ type: string; seq: number }> = [];
  emitter.addListener((event, seq) => received.push({ type: event.type, seq }));

  emitter.agentRegistered(A, "worker");
  emitter.stepStarted(A, "gen");

  assert.equal(received.length, 2);
  assert.equal(received[0].type, "agent_registered");
  assert.equal(received[1].seq, 2);
});

test("EventEmitter: removeListener stops delivery", () => {
  const log = new InMemoryEventLog();
  const emitter = new OrchestrationEventEmitter(log, "run-1");
  const received: string[] = [];
  const listener = (event: { type: string }) => received.push(event.type);
  emitter.addListener(listener);
  emitter.agentRegistered(A, "worker");
  emitter.removeListener(listener);
  emitter.stepStarted(A, "gen");

  assert.equal(received.length, 1);
});

test("EventEmitter: graphPatched event", () => {
  const log = new InMemoryEventLog();
  const emitter = new OrchestrationEventEmitter(log, "run-1");
  emitter.graphPatched("patch-1", "added review step");

  const entries = log.query({ eventType: "graph_patched" });
  assert.equal(entries.length, 1);
});

test("EventEmitter: agentDisposed event", () => {
  const log = new InMemoryEventLog();
  const emitter = new OrchestrationEventEmitter(log, "run-1");
  emitter.agentDisposed(A);

  const entries = log.query({ eventType: "agent_disposed" });
  assert.equal(entries.length, 1);
});

// ============================================================
// PolicyEngine (Wave 7.7)
// ============================================================

test("PolicyEngine: default allow when no rules", () => {
  const engine = new PolicyEngine();
  const result = engine.evaluate({ agentId: A, role: "worker", action: "write_file" });
  assert.equal(result.decision, "allow");
  assert.ok(result.reason?.includes("default"));
});

test("PolicyEngine: default deny when configured", () => {
  const engine = new PolicyEngine("deny");
  const result = engine.evaluate({ agentId: A, role: "worker", action: "write_file" });
  assert.equal(result.decision, "deny");
});

test("PolicyEngine: rule matches by role", () => {
  const engine = new PolicyEngine();
  engine.addRule({ name: "deny-reviewers-write", role: "reviewer", action: "write_file", decision: "deny" });

  const workerResult = engine.evaluate({ agentId: A, role: "worker", action: "write_file" });
  assert.equal(workerResult.decision, "allow"); // no match, falls to default

  const reviewerResult = engine.evaluate({ agentId: B, role: "reviewer", action: "write_file" });
  assert.equal(reviewerResult.decision, "deny");
  assert.equal(reviewerResult.matchedRule, "deny-reviewers-write");
});

test("PolicyEngine: rule matches by action", () => {
  const engine = new PolicyEngine();
  engine.addRule({ name: "approve-delete", action: "delete_file", decision: "require-approval" });

  const result = engine.evaluate({ agentId: A, role: "worker", action: "delete_file" });
  assert.equal(result.decision, "require-approval");
});

test("PolicyEngine: rule matches by pathPrefix", () => {
  const engine = new PolicyEngine();
  engine.addRule({ name: "deny-config", pathPrefix: "/etc/", decision: "deny" });

  const safe = engine.evaluate({ agentId: A, role: "worker", action: "write", targetPath: "/src/main.ts" });
  assert.equal(safe.decision, "allow");

  const blocked = engine.evaluate({ agentId: A, role: "worker", action: "write", targetPath: "/etc/passwd" });
  assert.equal(blocked.decision, "deny");
});

test("PolicyEngine: first match wins", () => {
  const engine = new PolicyEngine();
  engine.addRule({ name: "allow-all-workers", role: "worker", decision: "allow" });
  engine.addRule({ name: "deny-all", decision: "deny" });

  const workerResult = engine.evaluate({ agentId: A, role: "worker", action: "anything" });
  assert.equal(workerResult.decision, "allow");
  assert.equal(workerResult.matchedRule, "allow-all-workers");

  const reviewerResult = engine.evaluate({ agentId: B, role: "reviewer", action: "anything" });
  assert.equal(reviewerResult.decision, "deny");
  assert.equal(reviewerResult.matchedRule, "deny-all");
});

test("PolicyEngine: removeRule", () => {
  const engine = new PolicyEngine("deny");
  engine.addRule({ name: "allow-workers", role: "worker", decision: "allow" });
  assert.equal(engine.getRules().length, 1);

  assert.equal(engine.removeRule("allow-workers"), true);
  assert.equal(engine.getRules().length, 0);
  assert.equal(engine.removeRule("nonexistent"), false);
});

test("PolicyEngine: clearRules", () => {
  const engine = new PolicyEngine();
  engine.addRule({ name: "r1", decision: "deny" });
  engine.addRule({ name: "r2", decision: "deny" });
  engine.clearRules();
  assert.equal(engine.getRules().length, 0);
});

test("PolicyEngine: pathPrefix requires targetPath", () => {
  const engine = new PolicyEngine();
  engine.addRule({ name: "path-rule", pathPrefix: "/src/", decision: "deny" });

  // No targetPath → rule doesn't match → falls to default allow
  const result = engine.evaluate({ agentId: A, role: "worker", action: "write" });
  assert.equal(result.decision, "allow");
});

// ============================================================
// Guardrails (Wave 7.7)
// ============================================================

function makeTask(prompt: string): AgentTask {
  return { stepName: "gen", prompt, round: 1, sessionId: "sess-1" };
}

function makeResult(failed: boolean, error?: string): AgentResult {
  const response: TextResponse = {
    type: "text",
    text: failed ? "" : "ok",
    failed,
    error,
    durationMs: 100,
    providerName: "mock",
  };
  return { agentId: A, stepName: "gen", response, durationMs: 100 };
}

test("CostLimitGuardrail: passes under limit", async () => {
  const g = new CostLimitGuardrail(1000);
  const result = await g.check(makeTask("short prompt"));
  assert.equal(result.tripwire, false);
});

test("CostLimitGuardrail: trips over limit", async () => {
  const g = new CostLimitGuardrail(10);
  const result = await g.check(makeTask("this prompt is way too long"));
  assert.equal(result.tripwire, true);
  assert.ok(result.reason?.includes("exceeds"));
});

test("SuccessGuardrail: passes on success", async () => {
  const g = new SuccessGuardrail();
  const result = await g.check(makeResult(false));
  assert.equal(result.tripwire, false);
});

test("SuccessGuardrail: trips on failure", async () => {
  const g = new SuccessGuardrail();
  const result = await g.check(makeResult(true, "timeout"));
  assert.equal(result.tripwire, true);
  assert.ok(result.reason?.includes("timeout"));
});

test("runInputGuardrails: runs all and returns results", async () => {
  const g1 = new CostLimitGuardrail(10000);
  const g2: InputGuardrail = { name: "noop", async check() { return { tripwire: false }; } };
  const results = await runInputGuardrails([g1, g2], makeTask("hello"));
  assert.equal(results.length, 2);
  assert.equal(results[0].tripwire, false);
});

test("runInputGuardrails: throws TripwireError on first trip", async () => {
  const g1 = new CostLimitGuardrail(5);
  const g2: InputGuardrail = { name: "never-reached", async check() { return { tripwire: false }; } };

  await assert.rejects(
    () => runInputGuardrails([g1, g2], makeTask("too long prompt")),
    (err: unknown) => {
      assert.ok(err instanceof TripwireError);
      assert.equal(err.guardrailName, "CostLimitGuardrail");
      return true;
    }
  );
});

test("runOutputGuardrails: throws TripwireError on failure", async () => {
  const g = new SuccessGuardrail();
  await assert.rejects(
    () => runOutputGuardrails([g], makeResult(true, "crash")),
    (err: unknown) => {
      assert.ok(err instanceof TripwireError);
      assert.equal(err.guardrailName, "SuccessGuardrail");
      return true;
    }
  );
});

test("runOutputGuardrails: passes on success", async () => {
  const g = new SuccessGuardrail();
  const results = await runOutputGuardrails([g], makeResult(false));
  assert.equal(results.length, 1);
  assert.equal(results[0].tripwire, false);
});

test("TripwireError: has correct properties", () => {
  const err = new TripwireError("TestGuard", "bad input");
  assert.equal(err.name, "TripwireError");
  assert.equal(err.guardrailName, "TestGuard");
  assert.equal(err.reason, "bad input");
  assert.ok(err.message.includes("TestGuard"));
});
