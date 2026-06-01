import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDelegateArgv } from "../../src/providers/delegate-argv.js";

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
