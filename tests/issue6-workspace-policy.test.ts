import assert from "node:assert/strict";
import test from "node:test";
import { shouldFinalizeAgentWorkspace } from "../src/orchestration/workspace-policy.js";

test("shouldFinalizeAgentWorkspace is true only for approved", () => {
  assert.equal(shouldFinalizeAgentWorkspace("approved"), true);
  assert.equal(shouldFinalizeAgentWorkspace("failed"), false);
  assert.equal(shouldFinalizeAgentWorkspace("max_rounds"), false);
  assert.equal(shouldFinalizeAgentWorkspace("running"), false);
  assert.equal(shouldFinalizeAgentWorkspace("aborted"), false);
});
