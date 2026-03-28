import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import test from "node:test";
import { SessionWorkspace, activeWorkspaces } from "../src/workspace.ts";

const ROOT_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WATCHER_PATH = join(ROOT_DIR, "scripts", "watcher.sh");

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForCondition(check: () => boolean, timeoutMs: number, message: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(message);
    await delay(50);
  }
}

async function waitForJsonFile(path: string, timeoutMs = 10_000): Promise<any> {
  let parsed: any;
  await waitForCondition(() => {
    if (!existsSync(path)) return false;
    try {
      parsed = JSON.parse(readFileSync(path, "utf-8"));
      return true;
    } catch {
      return false;
    }
  }, timeoutMs, `Timed out waiting for JSON file: ${path}`);
  return parsed;
}

function createExecutableScript(dir: string, name: string, content: string): string {
  const scriptPath = join(dir, name);
  writeFileSync(scriptPath, content, "utf-8");
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function createGitRepo(dir: string, name = "repo"): string {
  const repoDir = join(dir, name);
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "orchestration-smoke@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Orchestration Smoke"], { cwd: repoDir });
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "module.txt"), "base module\n", "utf-8");
  writeFileSync(join(repoDir, "root.txt"), "base root\n", "utf-8");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
  return repoDir;
}

function startWatcher(provider: string, homeDir: string): { child: ChildProcess; output: () => string } {
  let combinedOutput = "";
  const child = spawn("zsh", [WATCHER_PATH, provider], {
    cwd: ROOT_DIR,
    detached: true,
    env: {
      ...process.env,
      LLM_PIPELINE_HOME: homeDir,
      LLM_PIPELINE_MAX_CONCURRENT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.unref();
  child.stdout?.on("data", (chunk: Buffer | string) => { combinedOutput += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer | string) => { combinedOutput += chunk.toString(); });

  return { child, output: () => combinedOutput };
}

async function stopWatcher(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    return;
  }

  try {
    process.kill(-child.pid!, "SIGTERM");
  } catch {
    // Process may already be gone.
  }

  const exitPromise = new Promise<void>((r) => {
    child.once("close", () => r());
  });
  await Promise.race([exitPromise, delay(2_000)]);

  if (child.exitCode === null) {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // Already gone.
    }
    await Promise.race([
      new Promise<void>((r) => child.once("close", () => r())),
      delay(2_000),
    ]);
  }

  child.stdout?.destroy();
  child.stderr?.destroy();
}

function enqueueTask(homeDir: string, provider: string, task: Record<string, unknown>): { resultFile: string; logFile: string } {
  const tasksDir = join(homeDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  const taskId = String(task.id);
  const taskFile = join(tasksDir, `${provider}.${taskId}.task.json`);
  const resultFile = join(tasksDir, `${provider}.${taskId}.result.json`);
  const logFile = join(tasksDir, `${provider}.${taskId}.run.log`);
  const tmpFile = `${taskFile}.${process.pid}.tmp`;

  writeFileSync(tmpFile, JSON.stringify(task, null, 2), "utf-8");
  renameSync(tmpFile, taskFile);
  return { resultFile, logFile };
}

test("session workspace agent-write keeps source repo untouched until finalize and survives resume", async () => {
  const previousHome = process.env.LLM_PIPELINE_HOME;
  const sandboxDir = mkdtempSync(join(tmpdir(), "llm-orch-session-"));
  const homeDir = join(sandboxDir, "home");
  mkdirSync(homeDir, { recursive: true });
  process.env.LLM_PIPELINE_HOME = homeDir;

  const repoDir = realpathSync(createGitRepo(sandboxDir, "winner-repo"));

  const providerScript = createExecutableScript(
    sandboxDir,
    "fake-session-provider.sh",
    "#!/bin/sh\nprompt=\"$(cat)\"\nprintf 'session cwd=%s\\n' \"$PWD\"\nprintf 'session write\\n' >> module.txt\nprintf 'created in session\\n' > generated.txt\nprintf '%s\\n' \"$prompt\"\n"
  );

  const watcher = startWatcher("sessionfake", homeDir);
  const workspace = await SessionWorkspace.create({ repoRoot: repoDir, sessionId: "session-smoke" });
  try {
    const workDir = await workspace.resolveWorkDir(join(repoDir, "src"));
    const { resultFile, logFile } = enqueueTask(homeDir, "sessionfake", {
      id: "session-smoke",
      provider: "sessionfake",
      command: providerScript,
      args: [],
      prompt: "make the session workspace change",
      mode: "agent-write",
      schemaVersion: 1,
      workDir,
      timestamp: new Date().toISOString(),
    });

    await waitForCondition(
      () => existsSync(logFile) && readFileSync(logFile, "utf-8").includes("session cwd="),
      10_000,
      "Timed out waiting for watcher log output",
    );

    const result = await waitForJsonFile(resultFile, 15_000);
    const logContent = readFileSync(logFile, "utf-8");

    assert.equal(result.status, "done");
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.sessionWorkspace, true);
    assert.match(result.output, /session cwd=/);
    assert.match(result.output, /make the session workspace change/);
    assert.match(logContent, /Session workspace \(reusing\):/);
    assert.match(result.changes, /session write/);
    assert.deepEqual(new Set(result.filesModified), new Set(["src/generated.txt", "src/module.txt"]));

    assert.equal(readFileSync(join(repoDir, "src", "module.txt"), "utf-8"), "base module\n");
    assert.equal(existsSync(join(repoDir, "src", "generated.txt")), false);

    const patchBeforeFinalize = await workspace.collectPatch();
    assert.deepEqual(new Set(patchBeforeFinalize.filesModified), new Set(["src/generated.txt", "src/module.txt"]));

    await workspace.releaseLock();
    const resumed = await SessionWorkspace.resume(workspace.worktreePath, repoDir, workspace.baseRef, workspace.sessionId);
    const resumedPatch = await resumed.collectPatch();
    assert.deepEqual(resumedPatch.filesModified, patchBeforeFinalize.filesModified);

    await resumed.applyToSource(resumedPatch.patch);
    assert.equal(readFileSync(join(repoDir, "src", "module.txt"), "utf-8"), "base module\nsession write\n");
    assert.equal(readFileSync(join(repoDir, "src", "generated.txt"), "utf-8"), "created in session\n");

    await resumed.destroy();
    await workspace.destroy();
    assert.equal(activeWorkspaces.size, 0);
  } finally {
    await stopWatcher(watcher.child);
    process.env.LLM_PIPELINE_HOME = previousHome;
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

test("race-style finalize applies the winner patch and abort cleans up candidates", async () => {
  const previousHome = process.env.LLM_PIPELINE_HOME;
  const sandboxDir = mkdtempSync(join(tmpdir(), "llm-orch-race-"));
  const homeDir = join(sandboxDir, "home");
  mkdirSync(homeDir, { recursive: true });
  process.env.LLM_PIPELINE_HOME = homeDir;

  const repoDir = realpathSync(createGitRepo(sandboxDir));

  try {
    const winner = await SessionWorkspace.create({ repoRoot: repoDir, sessionId: "race-winner", sharedLockKey: "race-trace" });
    const loser = await SessionWorkspace.create({ repoRoot: repoDir, sessionId: "race-loser", sharedLockKey: "race-trace" });

    writeFileSync(join(winner.worktreePath, "src", "module.txt"), "winner module\n", "utf-8");
    writeFileSync(join(winner.worktreePath, "src", "winner.txt"), "winner only\n", "utf-8");
    writeFileSync(join(loser.worktreePath, "src", "module.txt"), "loser module\n", "utf-8");
    writeFileSync(join(loser.worktreePath, "src", "loser.txt"), "loser only\n", "utf-8");

    const winnerPatch = await winner.collectPatch();
    const loserPatch = await loser.collectPatch();

    assert.ok(winnerPatch.filesModified.length > 0);
    assert.ok(loserPatch.filesModified.length > 0);

    await winner.applyToSource(winnerPatch.patch);
    await winner.destroy();
    await loser.destroy();

    assert.equal(readFileSync(join(repoDir, "src", "module.txt"), "utf-8"), "winner module\n");
    assert.equal(readFileSync(join(repoDir, "src", "winner.txt"), "utf-8"), "winner only\n");
    assert.equal(existsSync(join(repoDir, "src", "loser.txt")), false);
    assert.equal(activeWorkspaces.size, 0);

    const abortRepoDir = realpathSync(createGitRepo(sandboxDir, "abort-repo"));
    const abortA = await SessionWorkspace.create({ repoRoot: abortRepoDir, sessionId: "race-abort-a", sharedLockKey: "race-abort" });
    const abortB = await SessionWorkspace.create({ repoRoot: abortRepoDir, sessionId: "race-abort-b", sharedLockKey: "race-abort" });

    writeFileSync(join(abortA.worktreePath, "src", "module.txt"), "abort A\n", "utf-8");
    writeFileSync(join(abortB.worktreePath, "src", "module.txt"), "abort B\n", "utf-8");

    await abortA.collectPatch();
    await abortB.collectPatch();
    await abortA.destroy();
    await abortB.destroy();

    assert.equal(readFileSync(join(abortRepoDir, "src", "module.txt"), "utf-8"), "base module\n");
    assert.equal(activeWorkspaces.size, 0);
  } finally {
    process.env.LLM_PIPELINE_HOME = previousHome;
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});
