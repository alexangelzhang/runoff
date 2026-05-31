import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDelegateArgv } from "../../src/providers/delegate-argv.js";

test("normalizeDelegateArgv adds -y -p for gemini without headless flags", () => {
  const out = normalizeDelegateArgv(["gemini"]);
  assert.deepEqual(out, ["gemini", "-y", "-p"]);
});

test("normalizeDelegateArgv leaves codex argv unchanged", () => {
  const argv = ["codex", "exec", "--full-auto"];
  assert.deepEqual(normalizeDelegateArgv(argv), argv);
});
