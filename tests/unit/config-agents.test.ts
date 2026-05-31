import assert from "node:assert/strict";
import test from "node:test";
import {
  createPlanArtifact,
  createCodeArtifact,
  createDiffArtifact,
  createVerdictArtifact,
  createPatchArtifact,
  isPlanArtifact,
  isCodeArtifact,
  isDiffArtifact,
  isVerdictArtifact,
  isPatchArtifact,
  type Artifact,
} from "../../src/orchestration/artifacts.ts";
import { normalizeAgentConfig } from "../../src/orchestration/compat.ts";
import { validateConfig, type PipelineConfig } from "../../src/core/config.ts";

// --- Typed Artifacts ---

test("createPlanArtifact produces valid plan", () => {
  const a = createPlanArtifact("Refactor auth module", { steps: ["step1", "step2"], producedBy: "planner" });
  assert.equal(a.kind, "plan");
  assert.equal(a.summary, "Refactor auth module");
  assert.deepEqual(a.steps, ["step1", "step2"]);
  assert.equal(a.producedBy, "planner");
  assert.ok(a.createdAt > 0);
});

test("createCodeArtifact produces valid code", () => {
  const a = createCodeArtifact("const x = 1;", "Simple assignment", { language: "typescript" });
  assert.equal(a.kind, "code");
  assert.equal(a.code, "const x = 1;");
  assert.equal(a.explanation, "Simple assignment");
  assert.equal(a.language, "typescript");
});

test("createDiffArtifact produces valid diff", () => {
  const a = createDiffArtifact("+line", "Added line", ["file.ts"], "1 file changed");
  assert.equal(a.kind, "diff");
  assert.equal(a.changes, "+line");
  assert.deepEqual(a.filesModified, ["file.ts"]);
});

test("createVerdictArtifact produces valid verdict", () => {
  const approved = createVerdictArtifact(true, "Looks good");
  assert.equal(approved.approved, true);
  const rejected = createVerdictArtifact(false, "Needs work", { sourceReview: "full review text" });
  assert.equal(rejected.approved, false);
  assert.equal(rejected.sourceReview, "full review text");
});

test("createPatchArtifact produces valid patch", () => {
  const a = createPatchArtifact("YmluYXJ5", "abc123", ["a.ts"], "1 file");
  assert.equal(a.kind, "patch");
  assert.equal(a.patchBase64, "YmluYXJ5");
  assert.equal(a.baseRef, "abc123");
});

test("type guards correctly discriminate artifacts", () => {
  const artifacts: Artifact[] = [
    createPlanArtifact("plan"),
    createCodeArtifact("code", "exp"),
    createDiffArtifact("diff", "sum", [], ""),
    createVerdictArtifact(true, "ok"),
    createPatchArtifact("p", "ref", [], ""),
  ];

  assert.ok(isPlanArtifact(artifacts[0]));
  assert.ok(!isCodeArtifact(artifacts[0]));
  assert.ok(isCodeArtifact(artifacts[1]));
  assert.ok(isDiffArtifact(artifacts[2]));
  assert.ok(isVerdictArtifact(artifacts[3]));
  assert.ok(isPatchArtifact(artifacts[4]));
});

// --- Config Schema Extension ---

test("validateConfig accepts config with agents section", () => {
  const config = {
    providers: { "openai-pro": { type: "mock" } },
    pipeline: { generate: ["openai-pro"] },
    agents: {
      planner: { role: "orchestrator", provider: "openai-pro", capabilities: ["plan", "delegate"] },
      coder: { role: "worker", provider: "openai-pro", capabilities: ["implement"] },
    },
  };
  assert.ok(validateConfig(config));
});

test("validateConfig accepts config with orchestration section", () => {
  const config = {
    providers: { "openai-pro": { type: "mock" } },
    pipeline: { generate: ["openai-pro"] },
    orchestration: { mode: "dag", maxHandoffs: 10, conflictResolution: "pick-winner" },
  };
  assert.ok(validateConfig(config));
});

test("validateConfig rejects invalid agent role", () => {
  const config = {
    providers: { p: { type: "mock" } },
    pipeline: { s: ["p"] },
    agents: { bad: { role: "invalid", provider: "p" } },
  };
  assert.throws(() => validateConfig(config), /role must be one of/);
});

test("validateConfig rejects agent referencing unknown provider", () => {
  const config = {
    providers: { p: { type: "mock" } },
    pipeline: { s: ["p"] },
    agents: { a: { role: "worker", provider: "nonexistent" } },
  };
  assert.throws(() => validateConfig(config), /unknown provider/);
});

test("validateConfig rejects invalid orchestration mode", () => {
  const config = {
    providers: { p: { type: "mock" } },
    pipeline: { s: ["p"] },
    orchestration: { mode: "invalid" },
  };
  assert.throws(() => validateConfig(config), /orchestration\.mode must be one of/);
});

test("validateConfig rejects negative maxHandoffs", () => {
  const config = {
    providers: { p: { type: "mock" } },
    pipeline: { s: ["p"] },
    orchestration: { mode: "dag", maxHandoffs: -1 },
  };
  assert.throws(() => validateConfig(config), /maxHandoffs/);
});

test("validateConfig rejects invalid conflictResolution", () => {
  const config = {
    providers: { p: { type: "mock" } },
    pipeline: { s: ["p"] },
    orchestration: { mode: "dag", conflictResolution: "bad" },
  };
  assert.throws(() => validateConfig(config), /conflictResolution/);
});

test("validateConfig still works with legacy config (no agents/orchestration)", () => {
  const config = {
    providers: { "openai-pro": { type: "mock" }, "openai-lite": { type: "mock" } },
    pipeline: {
      analyze: ["openai-lite"],
      refactor: [["openai-pro", "openai-lite"], "analyze"],
      review: ["openai-pro", "refactor"],
    },
    retry: { maxRounds: 3, reviewStep: "review" },
  };
  assert.ok(validateConfig(config));
});

// --- Compat Layer ---

test("normalizeAgentConfig converts legacy pipeline to agents", () => {
  const config: PipelineConfig = {
    providers: { "openai-pro": { type: "mock" }, "openai-lite": { type: "mock" } },
    pipeline: {
      analyze: ["openai-lite"],
      review: ["openai-pro", "analyze"],
    },
    retry: { maxRounds: 3, reviewStep: "review" },
  };

  const result = normalizeAgentConfig(config);

  assert.equal(Object.keys(result.agents).length, 2);
  assert.equal(result.agents["analyze"].role, "worker");
  assert.equal(result.agents["analyze"].provider, "openai-lite");
  assert.ok(result.agents["analyze"].capabilities?.includes("implement"));

  assert.equal(result.agents["review"].role, "reviewer");
  assert.equal(result.agents["review"].provider, "openai-pro");
  assert.ok(result.agents["review"].capabilities?.includes("review"));

  assert.equal(result.orchestration.mode, "dag");
});

test("normalizeAgentConfig passes through explicit agents", () => {
  const config: PipelineConfig = {
    providers: { p: { type: "mock" } },
    pipeline: { s: ["p"] },
    agents: {
      custom: { role: "orchestrator", provider: "p", capabilities: ["plan"] },
    },
    orchestration: { mode: "llm-driven", maxHandoffs: 5 },
  };

  const result = normalizeAgentConfig(config);
  assert.equal(result.agents["custom"].role, "orchestrator");
  assert.equal(result.orchestration.mode, "llm-driven");
  assert.equal(result.orchestration.maxHandoffs, 5);
});

test("normalizeAgentConfig handles race mode (picks first provider)", () => {
  const config: PipelineConfig = {
    providers: { a: { type: "mock" }, b: { type: "mock" } },
    pipeline: { step: [["a", "b"]] },
  };

  const result = normalizeAgentConfig(config);
  assert.equal(result.agents["step"].provider, "a");
});
