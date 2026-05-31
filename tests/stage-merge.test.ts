import assert from "node:assert/strict";
import test from "node:test";
import { agentId } from "../src/orchestration/multi-agent-types.ts";
import { SharedContext } from "../src/orchestration/shared-context.ts";
import { createDiffArtifact } from "../src/orchestration/artifacts.ts";
import {
  mergeParallelStageBranchesAsync,
  resolveStageMergeMode,
} from "../src/orchestration/stage-merge.ts";
import type { PipelineConfig } from "../src/core/config.ts";
import { getCandidateContent } from "../src/core/candidate.ts";

test("resolveStageMergeMode maps conflictResolution", () => {
  const base: PipelineConfig = {
    providers: { m: { type: "mock" } },
    pipeline: { a: ["m"] },
  };
  assert.equal(
    resolveStageMergeMode({ ...base, orchestration: { mode: "dag", conflictResolution: "llm-merge" } }),
    "llm-merge",
  );
  assert.equal(
    resolveStageMergeMode({ ...base, orchestration: { mode: "dag", conflictResolution: "auto-merge" } }),
    "auto-merge",
  );
});

test("mergeParallelStageBranchesAsync llm-merge resolves file conflict", async () => {
  const shared = new SharedContext();
  const a = shared.createBranch(agentId("stepA"));
  const b = shared.createBranch(agentId("stepB"));
  shared.addArtifact(a.branchId, createDiffArtifact("+a", "a", ["x.ts"], "1"), ["x.ts"]);
  shared.addArtifact(b.branchId, createDiffArtifact("+b", "b", ["x.ts"], "1"), ["x.ts"]);

  const config: PipelineConfig = {
    providers: { mock: { type: "mock" } },
    pipeline: { stepA: ["mock"], stepB: ["mock"] },
    orchestration: { mode: "dag", conflictResolution: "llm-merge" },
  };

  const outcome = await mergeParallelStageBranchesAsync(
    shared,
    new Map([
      ["stepA", a.branchId],
      ["stepB", b.branchId],
    ]),
    "llm-merge",
    { prompt: "merge parallel outputs", config },
  );

  assert.equal(outcome.success, true);
  assert.ok(getCandidateContent(outcome.candidate).length > 0);
});
