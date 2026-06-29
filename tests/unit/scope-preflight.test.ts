import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PipelineConfig } from "../../src/core/config.ts";
import { runScopePreflight } from "../../src/orchestration/scope-preflight.ts";

function agentWriteConfig(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    providers: { codex: { type: "mock", mode: "agent-write" } },
    pipeline: { implement: ["codex"] },
    ...overrides,
  };
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "runoff-preflight-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "file.txt"), "dirty\n");
  return dir;
}

test("scope preflight pauses agent-write runs without workDir", () => {
  const report = runScopePreflight({
    config: agentWriteConfig(),
    prompt: "implement feature",
    configHash: "hash-a",
  });

  assert.equal(report.decision, "needs_clarification");
  assert.ok(report.blockers.some((blocker) => /workDir/.test(blocker)));
  assert.ok(report.clarificationQuestions.some((question) => /workDir/.test(question)));
});

test("scope preflight blocks dirty agent worktree unless explicitly allowed", () => {
  const repo = makeGitRepo();
  try {
    const blocked = runScopePreflight({
      config: agentWriteConfig(),
      prompt: "implement feature",
      workDir: repo,
      configHash: "hash-b",
      overrides: { verificationCommand: "npm test" },
    });
    assert.equal(blocked.decision, "needs_clarification");
    assert.ok(blocked.blockers.some((blocker) => /dirty/.test(blocker)));

    const allowed = runScopePreflight({
      config: agentWriteConfig(),
      prompt: "implement feature",
      workDir: repo,
      configHash: "hash-c",
      overrides: { allowDirtyWorktree: true, verificationCommand: "npm test" },
    });
    assert.equal(allowed.decision, "proceed");
    assert.ok(allowed.assumptions.some((assumption) => /dirty worktree/.test(assumption)));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("scope preflight requireCleanWorktree blocks dirty or unverifiable worktrees", () => {
  const repo = makeGitRepo();
  const nonGitDir = mkdtempSync(join(tmpdir(), "runoff-preflight-nongit-"));
  try {
    const dirty = runScopePreflight({
      config: agentWriteConfig(),
      prompt: "implement feature",
      workDir: repo,
      configHash: "hash-clean-dirty",
      overrides: {
        allowDirtyWorktree: true,
        requireCleanWorktree: true,
        verificationCommand: "npm test",
      },
    });
    assert.equal(dirty.decision, "needs_clarification");
    assert.ok(dirty.blockers.some((blocker) => /dirty/.test(blocker)));

    const unverifiable = runScopePreflight({
      config: {
        providers: { mock: { type: "mock" } },
        pipeline: { summarize: ["mock"] },
      },
      prompt: "summarize this code",
      workDir: nonGitDir,
      configHash: "hash-clean-nongit",
      overrides: {
        requireCleanWorktree: true,
        verificationCommand: "npm test",
      },
    });
    assert.equal(unverifiable.decision, "needs_clarification");
    assert.ok(unverifiable.blockers.some((blocker) => /dirty-state protection/.test(blocker)));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(nonGitDir, { recursive: true, force: true });
  }
});

test("scope preflight treats docs intent and required verification as clarifications", () => {
  const docs = runScopePreflight({
    config: {
      providers: { mock: { type: "mock" } },
      pipeline: { summarize: ["mock"] },
    },
    prompt: "Update README.md with the new workflow",
    configHash: "hash-docs",
  });
  assert.equal(docs.decision, "needs_clarification");
  assert.ok(docs.blockers.some((blocker) => /documentation/.test(blocker)));

  const verification = runScopePreflight({
    config: {
      providers: { mock: { type: "mock" } },
      pipeline: { implement: ["mock"] },
      runtime: { scopePreflight: { requireVerificationCommand: true } },
    },
    prompt: "implement feature",
    configHash: "hash-verify",
  });
  assert.equal(verification.decision, "needs_clarification");
  assert.ok(verification.blockers.some((blocker) => /verification/.test(blocker)));
});
