import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPatchArtifactToSource,
  applyWorkspaceFromArtifacts,
  collectRunArtifacts,
  selectPatchArtifact,
} from "../../src/orchestration/artifact-workspace.ts";
import { createPatchArtifact, createDiffArtifact } from "../../src/orchestration/artifacts.ts";
import { SharedContext } from "../../src/orchestration/shared-context.ts";
import { agentId } from "../../src/orchestration/multi-agent-types.ts";
import type { SessionWorkspace } from "../../src/runtime/workspace.ts";

function mockWorkspace(overrides: Partial<SessionWorkspace> = {}): SessionWorkspace {
  return {
    baseRef: "deadbeef",
    repoRoot: "/repo",
    worktreePath: "/repo/.wt",
    sessionId: "s1",
    async collectPatch() {
      return { patch: Buffer.alloc(0), filesModified: [], diffStat: "" };
    },
    async applyToSource() {},
    ...overrides,
  } as SessionWorkspace;
}

test("selectPatchArtifact returns latest patch", () => {
  const a = createPatchArtifact("YQ==", "r1", [], "");
  const b = createPatchArtifact("Yg==", "r1", [], "");
  assert.equal(selectPatchArtifact([a, b])?.patchBase64, "Yg==");
});

test("applyPatchArtifactToSource decodes base64 patch", async () => {
  const applied: Buffer[] = [];
  const ws = mockWorkspace({
    async applyToSource(patch?: Buffer) {
      if (patch) applied.push(patch);
    },
  });
  await applyPatchArtifactToSource(ws, createPatchArtifact(Buffer.from("hello").toString("base64"), "r", [], ""));
  assert.equal(applied[0]?.toString(), "hello");
});

test("applyWorkspaceFromArtifacts prefers patch artifact over collect", async () => {
  let collectCalls = 0;
  const applied: Buffer[] = [];
  const ws = mockWorkspace({
    async collectPatch() {
      collectCalls++;
      return { patch: Buffer.from("fallback"), filesModified: [], diffStat: "" };
    },
    async applyToSource(patch?: Buffer) {
      if (patch) applied.push(patch);
    },
  });
  const result = await applyWorkspaceFromArtifacts(ws, [
    createPatchArtifact(Buffer.from("from-artifact").toString("base64"), "r", [], ""),
  ]);
  assert.equal(result.method, "patch-artifact");
  assert.equal(applied[0]?.toString(), "from-artifact");
  assert.equal(collectCalls, 0);
});

test("applyWorkspaceFromArtifacts uses collect-patch when diff artifacts present", async () => {
  let applyCalls = 0;
  const ws = mockWorkspace({
    async collectPatch() {
      return { patch: Buffer.from("wt-diff"), filesModified: ["f.ts"], diffStat: "1" };
    },
    async applyToSource(patch?: Buffer) {
      applyCalls++;
      assert.ok(patch === undefined || patch.length > 0);
    },
  });
  const result = await applyWorkspaceFromArtifacts(ws, [
    createDiffArtifact("+", "s", ["f.ts"], "1"),
  ]);
  assert.equal(result.method, "collect-patch");
  assert.equal(applyCalls, 1);
  assert.ok(result.patchArtifact?.patchBase64);
});

test("collectRunArtifacts merges shared context and step results", () => {
  const shared = new SharedContext();
  const branch = shared.createBranch(agentId("gen"));
  shared.addArtifact(branch.branchId, createDiffArtifact("+", "s", ["a.ts"], "1"), ["a.ts"]);
  shared.merge(branch.branchId, "pick-winner");

  const arts = collectRunArtifacts({
    sharedContext: shared,
    stepResults: {
      gen: {
        status: "success",
        artifacts: [createPatchArtifact("YQ==", "r", [], "")],
      },
    },
  });
  assert.equal(arts.length, 2);
});
