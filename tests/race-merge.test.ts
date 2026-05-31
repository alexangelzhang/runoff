import assert from "node:assert/strict";
import test from "node:test";
import { autoMergeCandidates, resolveProviderRaceWinner } from "../src/orchestration/race-merge.js";
import { MockProvider } from "../src/providers/mock.js";
import type { LLMResponse } from "../src/providers/types.js";

test("autoMergeCandidates merges disjoint file sets", () => {
  const result = autoMergeCandidates([
    { changes: "patch-a", filesModified: ["a.ts"], isAgent: true },
    { changes: "patch-b", filesModified: ["b.ts"], isAgent: true },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.merged.filesModified, ["a.ts", "b.ts"]);
  assert.match(result.merged.changes ?? "", /patch-a/);
  assert.match(result.merged.changes ?? "", /patch-b/);
});

test("autoMergeCandidates fails on overlapping files", () => {
  const result = autoMergeCandidates([
    { changes: "v1", filesModified: ["shared.ts"], isAgent: true },
    { changes: "v2", filesModified: ["shared.ts"], isAgent: true },
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.conflicts, ["shared.ts"]);
});

test("resolveProviderRaceWinner auto-merge for text race without file overlap", async () => {
  const a: LLMResponse = {
    kind: "text",
    model: "mock-a",
    content: "code-a",
    code: "const a = 1;",
    explanation: "a",
    failed: false,
  };
  const b: LLMResponse = {
    kind: "text",
    model: "mock-b",
    content: "code-b",
    code: "const b = 2;",
    explanation: "b",
    failed: false,
  };
  const pick = await resolveProviderRaceWinner(
    [
      { provider: new MockProvider("a"), providerName: "a", resp: a },
      { provider: new MockProvider("b"), providerName: "b", resp: b },
    ],
    "auto-merge",
    { stepName: "implement", prompt: "add feature" },
  );
  assert.equal(pick.merged, false);
  assert.equal(pick.mergeStrategy, "pick-winner");
  assert.ok(pick.conflictFiles?.includes("<content>"));
});

test("resolveProviderRaceWinner pick-winner prefers syntax-valid mock output", async () => {
  const bad: LLMResponse = {
    kind: "text",
    model: "mock-lite",
    content: "bad",
    code: "export class X { ",
    explanation: "bad",
    failed: false,
  };
  const good: LLMResponse = {
    kind: "text",
    model: "mock-pro",
    content: "good",
    code: "export class X { async run() { return 1; } }",
    explanation: "good",
    failed: false,
  };
  const pick = await resolveProviderRaceWinner(
    [
      { provider: new MockProvider("openai-lite"), providerName: "openai-lite", resp: bad },
      { provider: new MockProvider("mock-pro"), providerName: "mock-pro", resp: good },
    ],
    "pick-winner",
    { stepName: "refactor", prompt: "refactor" },
  );
  assert.equal(pick.entry.providerName, "mock-pro");
  assert.equal(pick.merged, false);
});
