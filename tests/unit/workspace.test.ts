import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionWorkspace } from "../../src/runtime/workspace.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function createTestRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "llm-ws-test-"));
  git(["init"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "file.txt"), "initial content\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

test("SessionWorkspace create and destroy lifecycle", async () => {
  const previousHome = process.env.LLM_PIPELINE_HOME;
  const homeDir = mkdtempSync(join(tmpdir(), "llm-pipeline-ws-"));
  process.env.LLM_PIPELINE_HOME = homeDir;
  const repo = createTestRepo();

  try {
    const ws = await SessionWorkspace.create({ repoRoot: repo, sessionId: "test-lc" });

    assert.ok(existsSync(ws.worktreePath), "worktree should exist");
    assert.ok(existsSync(join(ws.worktreePath, "file.txt")), "file.txt should be in worktree");
    assert.equal(ws.repoRoot, repo);
    assert.equal(ws.sessionId, "test-lc");

    await ws.destroy();
    assert.ok(!existsSync(ws.worktreePath), "worktree should be cleaned up");
  } finally {
    if (previousHome === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = previousHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("SessionWorkspace resolveWorkDir maps original path into worktree", async () => {
  const previousHome = process.env.LLM_PIPELINE_HOME;
  const homeDir = mkdtempSync(join(tmpdir(), "llm-pipeline-ws-"));
  process.env.LLM_PIPELINE_HOME = homeDir;
  const repo = createTestRepo();

  try {
    const ws = await SessionWorkspace.create({ repoRoot: repo, sessionId: "test-rw" });

    const resolved = await ws.resolveWorkDir(repo);
    assert.equal(resolved, ws.worktreePath);

    // Subdir
    const subDir = join(repo, "src", "lib");
    const resolvedSub = await ws.resolveWorkDir(subDir);
    assert.equal(resolvedSub, join(ws.worktreePath, "src", "lib"));
    assert.ok(existsSync(resolvedSub), "subdir should be created");

    await ws.destroy();
  } finally {
    if (previousHome === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = previousHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("SessionWorkspace collectPatch and applyToSource", async () => {
  const previousHome = process.env.LLM_PIPELINE_HOME;
  const homeDir = mkdtempSync(join(tmpdir(), "llm-pipeline-ws-"));
  process.env.LLM_PIPELINE_HOME = homeDir;
  const repo = createTestRepo();

  try {
    const ws = await SessionWorkspace.create({ repoRoot: repo, sessionId: "test-pa" });

    // Make changes in worktree
    writeFileSync(join(ws.worktreePath, "file.txt"), "modified content\n");
    writeFileSync(join(ws.worktreePath, "new-file.txt"), "new file\n");

    const patch = await ws.collectPatch();
    assert.ok(patch.patch.length > 0, "patch should not be empty");
    assert.ok(patch.filesModified.includes("file.txt"));
    assert.ok(patch.filesModified.includes("new-file.txt"));
    assert.ok(patch.diffStat.length > 0);

    // Source repo should still have original content
    const originalContent = execFileSync("cat", [join(repo, "file.txt")], { encoding: "utf-8" });
    assert.equal(originalContent, "initial content\n");
    assert.ok(!existsSync(join(repo, "new-file.txt")));

    // Apply patch to source
    await ws.applyToSource(patch.patch);

    const updatedContent = execFileSync("cat", [join(repo, "file.txt")], { encoding: "utf-8" });
    assert.equal(updatedContent, "modified content\n");
    assert.ok(existsSync(join(repo, "new-file.txt")));

    await ws.destroy();
  } finally {
    if (previousHome === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = previousHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("SessionWorkspace resume reuses existing worktree", async () => {
  const previousHome = process.env.LLM_PIPELINE_HOME;
  const homeDir = mkdtempSync(join(tmpdir(), "llm-pipeline-ws-"));
  process.env.LLM_PIPELINE_HOME = homeDir;
  const repo = createTestRepo();

  try {
    const ws = await SessionWorkspace.create({ repoRoot: repo, sessionId: "test-rs" });
    const worktreePath = ws.worktreePath;
    const baseRef = ws.baseRef;

    // Make changes
    writeFileSync(join(worktreePath, "file.txt"), "resumed content\n");

    // Release lock (simulating checkpoint save + process exit)
    await ws.releaseLock();

    // Resume
    const ws2 = await SessionWorkspace.resume(worktreePath, repo, baseRef, "test-rs");
    assert.equal(ws2.worktreePath, worktreePath);
    assert.ok(existsSync(join(ws2.worktreePath, "file.txt")));

    // Changes should still be there
    const patch = await ws2.collectPatch();
    assert.ok(patch.filesModified.includes("file.txt"));

    await ws2.destroy();
    assert.ok(!existsSync(worktreePath));
  } finally {
    if (previousHome === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = previousHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("SessionWorkspace resume rejects missing worktree", async () => {
  await assert.rejects(
    () => SessionWorkspace.resume("/nonexistent/path", "/tmp", "HEAD", "test-x"),
    /Session workspace not found/
  );
});

test("SessionWorkspace no-op applyToSource with empty patch", async () => {
  const previousHome = process.env.LLM_PIPELINE_HOME;
  const homeDir = mkdtempSync(join(tmpdir(), "llm-pipeline-ws-"));
  process.env.LLM_PIPELINE_HOME = homeDir;
  const repo = createTestRepo();

  try {
    const ws = await SessionWorkspace.create({ repoRoot: repo, sessionId: "test-ep" });

    // No changes — collectPatch should return empty
    const patch = await ws.collectPatch();
    assert.equal(patch.filesModified.length, 0);

    // applyToSource with empty patch should be a no-op
    await ws.applyToSource(patch.patch);

    await ws.destroy();
  } finally {
    if (previousHome === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = previousHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});
