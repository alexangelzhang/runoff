import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDelegateArgv, injectDirFlag } from "../../src/providers/delegate-argv.js";

// Gemini CLI v0.44+ reads stdin without -p; normalizeDelegateArgv is now a pass-through.
test("normalizeDelegateArgv passes gemini argv unchanged (v0.44+)", () => {
  const argv = ["gemini", "--yolo"];
  assert.deepEqual(normalizeDelegateArgv(argv), argv);
});

test("normalizeDelegateArgv leaves codex argv unchanged", () => {
  const argv = ["codex", "exec", "--full-auto"];
  assert.deepEqual(normalizeDelegateArgv(argv), argv);
});

test("normalizeDelegateArgv passes empty argv unchanged", () => {
  assert.deepEqual(normalizeDelegateArgv([]), []);
});

// injectDirFlag: opencode gets --dir injected so it resolves the worktree as project root.
test("injectDirFlag injects --dir for opencode when workDir is set", () => {
  const argv = ["opencode", "run"];
  const result = injectDirFlag(argv, "/repo/worktree");
  assert.deepEqual(result, ["opencode", "run", "--dir", "/repo/worktree"]);
});

test("injectDirFlag does not inject when --dir already present", () => {
  const argv = ["opencode", "run", "--dir", "/existing"];
  const result = injectDirFlag(argv, "/other");
  assert.deepEqual(result, ["opencode", "run", "--dir", "/existing"]);
});

test("injectDirFlag leaves non-opencode argv unchanged", () => {
  const argv = ["claude", "--dangerously-skip-permissions"];
  assert.deepEqual(injectDirFlag(argv, "/repo"), argv);
});

test("injectDirFlag is a no-op when workDir is empty", () => {
  const argv = ["opencode", "run"];
  assert.deepEqual(injectDirFlag(argv, ""), argv);
  assert.deepEqual(injectDirFlag(argv, undefined), argv);
});
