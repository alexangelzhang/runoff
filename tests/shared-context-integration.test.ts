import assert from "node:assert/strict";
import test from "node:test";
import { emptyCandidate } from "../src/core/candidate.ts";
import type { PipelineConfig } from "../src/core/config.ts";
import { runPipelineDAGLoop } from "../src/orchestration/pipeline-runner.ts";
import {
  candidateFromArtifacts,
  mergeParallelStageBranches,
  resolveMergeStrategy,
} from "../src/orchestration/context-integration.ts";
import { SharedContext } from "../src/orchestration/shared-context.ts";
import { WorkspaceOwnershipRegistry } from "../src/orchestration/ownership.ts";
import { createDiffArtifact, createCodeArtifact } from "../src/orchestration/artifacts.ts";
import { agentId } from "../src/orchestration/multi-agent-types.ts";
import { CostTracker } from "../src/routing/pricing.ts";
import type { SchedulerContext, StepOutcome } from "../src/orchestration/step-execution.ts";
import { artifactsFromStepResponse } from "../src/orchestration/artifact-bridge.ts";

test("mergeParallelStageBranches auto-merge succeeds for disjoint files", () => {
  const shared = new SharedContext();
  const a = shared.createBranch(agentId("stepA"));
  const b = shared.createBranch(agentId("stepB"));
  shared.addArtifact(a.branchId, createDiffArtifact("+a", "a", ["a.ts"], "1"), ["a.ts"]);
  shared.addArtifact(b.branchId, createDiffArtifact("+b", "b", ["b.ts"], "1"), ["b.ts"]);

  const outcome = mergeParallelStageBranches(
    shared,
    new Map([
      ["stepA", a.branchId],
      ["stepB", b.branchId],
    ]),
    "auto-merge",
  );
  assert.equal(outcome.success, true);
  assert.deepEqual(outcome.candidate.filesModified?.sort(), ["a.ts", "b.ts"]);
});

test("mergeParallelStageBranches auto-merge fails on file conflict", () => {
  const shared = new SharedContext();
  const a = shared.createBranch(agentId("stepA"));
  const b = shared.createBranch(agentId("stepB"));
  shared.addArtifact(a.branchId, createDiffArtifact("+a", "a", ["x.ts"], "1"), ["x.ts"]);
  shared.addArtifact(b.branchId, createDiffArtifact("+b", "b", ["x.ts"], "1"), ["x.ts"]);

  const outcome = mergeParallelStageBranches(
    shared,
    new Map([
      ["stepA", a.branchId],
      ["stepB", b.branchId],
    ]),
    "auto-merge",
  );
  assert.equal(outcome.success, false);
  assert.ok(outcome.conflicts.includes("x.ts"));
});

test("candidateFromArtifacts merges code and diff layers", () => {
  const arts = [
    createCodeArtifact("const x=1", "init"),
    createDiffArtifact("+y", "patch", ["f.ts"], "1 file"),
  ];
  const c = candidateFromArtifacts(arts);
  assert.equal(c.code, "const x=1");
  assert.equal(c.changes, "+y");
  assert.ok(c.isAgent);
});

test("WorkspaceOwnershipRegistry exclusive vs shared", () => {
  const reg = new WorkspaceOwnershipRegistry();
  assert.equal(reg.acquire("/repo", "a", "exclusive"), true);
  assert.equal(reg.acquire("/repo", "b", "exclusive"), false);
  assert.equal(reg.acquire("/repo", "b", "shared"), false);
  reg.release("/repo", "a");
  assert.equal(reg.acquire("/repo", "b", "shared"), true);
  assert.equal(reg.acquire("/repo", "c", "shared"), true);
});

test("runPipelineDAGLoop parallel stage merges branches into candidate", async () => {
  const config: PipelineConfig = {
    providers: { mock: { type: "mock" } },
    pipeline: {
      alpha: ["mock"],
      beta: ["mock"],
      review: ["mock", "alpha", "beta"],
    },
    retry: { maxRounds: 1, reviewStep: "review" },
    orchestration: { mode: "dag", conflictResolution: "auto-merge" },
  };

  const scheduler = {
    async executeStep(stepName: string, ctx: SchedulerContext): Promise<StepOutcome> {
      const file = stepName === "alpha" ? "a.ts" : stepName === "beta" ? "b.ts" : "r.ts";
      const response =
        stepName === "review"
          ? {
              kind: "text" as const,
              content: "VERDICT: APPROVED",
              code: "",
              explanation: "",
              model: "mock",
            }
          : {
              kind: "agent" as const,
              summary: stepName,
              changes: `+${file}`,
              filesModified: [file],
              diffStat: "1",
              model: "mock",
            };
      const artifacts = artifactsFromStepResponse(response, {
        stepName,
        verdict:
          stepName === "review"
            ? { approved: true, feedback: "ok" }
            : undefined,
      });
      return {
        stepName,
        usedProvider: "mock",
        upgraded: false,
        durationMs: 1,
        trace: { name: stepName, provider: "mock", durationMs: 1, round: ctx.round },
        response,
        artifacts,
        verdict: stepName === "review" ? { approved: true, feedback: "ok" } : undefined,
      };
    },
  };

  const state = {
    stepResults: {},
    stepTraces: [],
    globalKnowledge: {},
    candidate: emptyCandidate(),
    approved: false,
    lastReviewFeedback: "",
  };

  const result = await runPipelineDAGLoop({
    runtimeConfig: config,
    stepRunner: scheduler as never,
    costTracker: new CostTracker(),
    state,
    pipelineSessionId: "sess-parallel",
    startRound: 1,
    maxRounds: 1,
    reviewStepName: "review",
    traceId: "trace-parallel",
    prompt: "p",
    onRoundComplete: async () => {},
  });

  assert.equal(result.finalStatus, "approved");
  assert.deepEqual(state.candidate.filesModified?.sort(), ["a.ts", "b.ts"]);
  assert.equal(resolveMergeStrategy(config), "auto-merge");
});
