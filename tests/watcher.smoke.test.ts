import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import test from "node:test";
import { SessionWorkspace } from "../src/workspace.ts";

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

function createGitRepo(dir: string): string {
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "watcher-smoke@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Watcher Smoke"], { cwd: repoDir });
  writeFileSync(join(repoDir, "note.txt"), "base\n", "utf-8");
  execFileSync("git", ["add", "note.txt"], { cwd: repoDir });
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

  // Unref so the child doesn't keep the event loop alive if we forget to stop
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

  // Kill the entire process group (shell + background python children)
  try {
    process.kill(-child.pid!, "SIGTERM");
  } catch {
    // Process may already be gone
  }

  const exitPromise = new Promise<void>((r) => {
    child.once("close", () => r());
  });
  await Promise.race([exitPromise, delay(2_000)]);

  if (child.exitCode === null) {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // Already gone
    }
    await Promise.race([
      new Promise<void>((r) => child.once("close", () => r())),
      delay(2_000),
    ]);
  }

  // Destroy streams to release pipe handles
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

test("watcher smoke: text task completes end-to-end", async () => {
  const sandboxDir = mkdtempSync(join(tmpdir(), "llm-watcher-text-"));
  const homeDir = join(sandboxDir, "home");
  mkdirSync(homeDir, { recursive: true });
  const realHomeDir = realpathSync(homeDir);

  const providerScript = createExecutableScript(
    sandboxDir,
    "fake-text-provider.sh",
    "#!/bin/sh\nprompt=\"$(cat)\"\nprintf 'text provider cwd=%s\\n' \"$PWD\"\nprintf '%s\\n' \"$prompt\"\n"
  );

  const watcher = startWatcher("fake", realHomeDir);
  try {
    const { resultFile } = enqueueTask(realHomeDir, "fake", {
      id: "textsmoke",
      provider: "fake",
      delegateArgv: [providerScript],
      prompt: "hello watcher",
      mode: "text",
      schemaVersion: 6,
      timestamp: new Date().toISOString(),
    });

    const result = await waitForJsonFile(resultFile);
    assert.equal(result.status, "success");
    assert.equal(result.schemaVersion, 5);
    assert.match(result.content, /text provider cwd=/);
    assert.match(result.content, /hello watcher/);
    console.log("WATCHER OUTPUT:", watcher.output()); assert.equal((watcher.output().match(/Started task/g) ?? []).length, 1);
  } finally {
    await stopWatcher(watcher.child);
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

test("watcher smoke: agent-write runs in isolated worktree and reapplies patch to source repo", async () => {
  const sandboxDir = mkdtempSync(join(tmpdir(), "llm-watcher-agent-"));
  const homeDir = join(sandboxDir, "home");
  mkdirSync(homeDir, { recursive: true });
  const realHomeDir = realpathSync(homeDir);

  const repoDir = realpathSync(createGitRepo(sandboxDir));
  const notePath = join(repoDir, "note.txt");
  const addedPath = join(repoDir, "added.txt");

  const providerScript = createExecutableScript(
    sandboxDir,
    "fake-agent-provider.sh",
    "#!/bin/sh\nprompt=\"$(cat)\"\nprintf 'updated by agent\\n' >> note.txt\nprintf 'new file\\n' > added.txt\nprintf 'agent cwd=%s\\n' \"$PWD\"\nsleep 1\nprintf '%s\\n' \"$prompt\"\n"
  );

  const watcher = startWatcher("fakeagent", realHomeDir);
  try {
    const { resultFile, logFile } = enqueueTask(realHomeDir, "fakeagent", {
      id: "agentsmoke",
      provider: "fakeagent",
      delegateArgv: [providerScript],
      prompt: "ship it",
      mode: "agent-write",
      schemaVersion: 6,
      workDir: repoDir,
      timestamp: new Date().toISOString(),
    });

    // Wait for the agent to start executing (log shows cwd)
    await waitForCondition(
      () => existsSync(logFile) && readFileSync(logFile, "utf-8").includes("Isolated worktree:"),
      10_000,
      "Timed out waiting for watcher log output",
    );

    // While agent is running in worktree, source repo must be untouched
    assert.equal(readFileSync(notePath, "utf-8"), "base\n");
    assert.equal(existsSync(addedPath), false);

    const result = await waitForJsonFile(resultFile, 15_000);
    const logContent = readFileSync(logFile, "utf-8");

    assert.equal(result.status, "success");
    assert.equal(result.schemaVersion, 5);
    assert.match(result.summary, /agent cwd=/);
    assert.match(result.summary, /ship it/);
    assert.match(result.changes, /updated by agent/);
    assert.match(logContent, /Isolated worktree:/);
    console.log("WATCHER OUTPUT:", watcher.output()); assert.equal((watcher.output().match(/Started task/g) ?? []).length, 1);
    assert.deepEqual(new Set(result.filesModified), new Set(["added.txt", "note.txt"]));

    // Verify patch was applied back to source repo
    assert.equal(readFileSync(notePath, "utf-8"), "base\nupdated by agent\n");
    assert.equal(readFileSync(addedPath, "utf-8"), "new file\n");

    // Strong isolation assertion: agent cwd must be the worktree, NOT the source repo
    const worktreeMatch = logContent.match(/Isolated worktree:\s*([^\s\x1b]+)/);
    assert.ok(worktreeMatch, "Log must contain worktree path");
    const worktreePath = worktreeMatch![1];

    const cwdMatch = result.summary.match(/agent cwd=([^\s\x1b]+)/);
    assert.ok(cwdMatch, "Output must contain agent cwd");
    const agentCwd = cwdMatch![1];

    // Agent must have run inside the worktree, not the source repo
    assert.ok(
      agentCwd.startsWith(worktreePath),
      `Agent cwd "${agentCwd}" must be inside worktree "${worktreePath}", not the source repo "${repoDir}"`,
    );
    assert.ok(
      !agentCwd.startsWith(repoDir) || worktreePath.startsWith(repoDir),
      `Agent cwd must not be the source repo`,
    );
  } finally {
    await stopWatcher(watcher.child);
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

test("watcher smoke: agent-write defer keeps source repo clean and returns workspace metadata", async () => {
  const previousHome = process.env.LLM_PIPELINE_HOME;
  const sandboxDir = mkdtempSync(join(tmpdir(), "llm-watcher-defer-"));
  const homeDir = join(sandboxDir, "home");
  mkdirSync(homeDir, { recursive: true });
  const realHomeDir = realpathSync(homeDir);
  process.env.LLM_PIPELINE_HOME = realHomeDir;

  const repoDir = realpathSync(createGitRepo(sandboxDir));
  const notePath = join(repoDir, "note.txt");

  const providerScript = createExecutableScript(
    sandboxDir,
    "fake-agent-defer-provider.sh",
    "#!/bin/sh\nprintf 'defer change\\n' >> note.txt\nprintf 'kept in workspace\\n' > deferred.txt\nprintf 'defer cwd=%s\\n' \"$PWD\"\n"
  );

  const watcher = startWatcher("fakedefer", realHomeDir);
  try {
    const { resultFile } = enqueueTask(realHomeDir, "fakedefer", {
      id: "defer-smoke",
      provider: "fakedefer",
      delegateArgv: [providerScript],
      prompt: "hold changes for judge",
      mode: "agent-write",
      finalizeStrategy: "defer",
      sharedLockKey: "trace-defer",
      sessionId: "trace-defer",
      schemaVersion: 6,
      workDir: repoDir,
      timestamp: new Date().toISOString(),
    });

    const result = await waitForJsonFile(resultFile, 15_000);

    assert.equal(result.status, "success");
    assert.equal(result.schemaVersion, 5);
    assert.equal(typeof result.workspacePath, "string");
    assert.equal(result.workspaceRepoRoot, repoDir);
    assert.equal(typeof result.workspaceBaseRef, "string");
    assert.equal(result.workspaceSharedLockKey, "trace-defer");
    assert.match(result.summary, /defer cwd=/);
    assert.deepEqual(new Set(result.filesModified), new Set(["deferred.txt", "note.txt"]));
    assert.equal(readFileSync(notePath, "utf-8"), "base\n");
    assert.equal(existsSync(join(repoDir, "deferred.txt")), false);
    assert.ok(existsSync(result.workspacePath), "deferred workspace should remain on disk");

    const resumed = await SessionWorkspace.resume(
      result.workspacePath,
      result.workspaceRepoRoot,
      result.workspaceBaseRef,
      "watcher-defer-test",
      result.workspaceSharedLockKey,
    );
    const patch = await resumed.collectPatch();
    assert.deepEqual(new Set(patch.filesModified), new Set(["deferred.txt", "note.txt"]));
    await resumed.destroy();
    assert.equal(existsSync(result.workspacePath), false);
    assert.equal(readFileSync(notePath, "utf-8"), "base\n");
  } finally {
    await stopWatcher(watcher.child);
    if (previousHome === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = previousHome;
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});
