import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import test from "node:test";
import { SessionWorkspace, activeWorkspaces } from "../src/runtime/workspace.ts";
import { raceSessions } from "../src/runtime/race-registry.ts";
import { applyRaceSession, abortRaceSession } from "../src/tools/race.ts";
import { clearConfigCache } from "../src/core/config.js";
import { runPipelineMode } from "../src/tools/run-pipeline.js";
import { loadCheckpoint } from "../src/core/state.js";

const ROOT_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WATCHER_PATH = join(ROOT_DIR, "scripts", "shell", "watcher.sh");

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
      delegateArgv: [providerScript],
      prompt: "make the session workspace change",
      mode: "agent-write",
      schemaVersion: 6,
      workDir,
      timestamp: new Date().toISOString(),
    });

    await waitForCondition(
      () => existsSync(logFile) && readFileSync(logFile, "utf-8").includes("Session workspace (reusing):"),
      10_000,
      "Timed out waiting for watcher log output",
    );

    const result = await waitForJsonFile(resultFile, 15_000);
    const logContent = readFileSync(logFile, "utf-8");

    assert.equal(result.status, "success");
    assert.equal(result.schemaVersion, 6);
    assert.match(result.summary, /session cwd=/);
    assert.match(result.summary, /make the session workspace change/);
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

    await workspace.destroy();
    await resumed.applyToSource(resumedPatch.patch);
    assert.equal(readFileSync(join(repoDir, "src", "module.txt"), "utf-8"), "base module\nsession write\n");
    assert.equal(readFileSync(join(repoDir, "src", "generated.txt"), "utf-8"), "created in session\n");

    await resumed.destroy();
    assert.equal(activeWorkspaces.size, 0);
  } finally {
    await stopWatcher(watcher.child);
    process.env.LLM_PIPELINE_HOME = previousHome;
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

test("runPipelineMode agent race waits for judge and finalizes the chosen workspace", async () => {
  const previousHome = process.env.LLM_PIPELINE_HOME;
  const previousCwd = process.cwd();
  const sandboxDir = mkdtempSync(join(tmpdir(), "llm-orch-pipeline-race-"));
  const homeDir = join(sandboxDir, "home");
  const configDir = join(sandboxDir, "config");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  process.env.LLM_PIPELINE_HOME = homeDir;

  const repoDir = realpathSync(createGitRepo(sandboxDir, "pipeline-race-repo"));
  const repoSrcDir = join(repoDir, "src");
  let traceId: string | undefined;

  const winnerScript = createExecutableScript(
    sandboxDir,
    "pipeline-race-winner.sh",
    "#!/bin/sh\nprintf 'winner line\\n' >> module.txt\nprintf 'winner artifact\\n' > winner.txt\nprintf 'winner cwd=%s\\n' \"$PWD\"\n"
  );
  const loserScript = createExecutableScript(
    sandboxDir,
    "pipeline-race-loser.sh",
    "#!/bin/sh\nprintf 'loser line\\n' >> module.txt\nprintf 'loser artifact\\n' > loser.txt\nprintf 'loser cwd=%s\\n' \"$PWD\"\n"
  );

  writeFileSync(
    join(configDir, "pipeline.config.json"),
    JSON.stringify(
      {
        providers: {
          winner: { type: "cli", command: winnerScript, mode: "agent-write" },
          loser: { type: "cli", command: loserScript, mode: "agent-write" },
          judge: { type: "mock" },
        },
        pipeline: {
          implement: [["winner", "loser"]],
          review: ["judge", "implement"],
        },
        retry: {
          maxRounds: 1,
          reviewStep: "review",
        },
        routing: [],
      },
      null,
      2,
    ),
    "utf-8",
  );

  clearConfigCache();
  process.chdir(configDir);

  try {
    const result = await runPipelineMode({
      prompt: "Implement the requested change in the project",
      workDir: repoSrcDir,
      maxRounds: 1,
    });
    traceId = result.traceId;

    assert.equal(result.status, "awaiting_judge");

    const checkpoint = await loadCheckpoint(result.checkpointFile);
    assert.ok(checkpoint, "pipeline should persist a checkpoint while awaiting judge");
    assert.equal(checkpoint?.status, "awaiting_judge");
    assert.equal(checkpoint?.workspacePath, undefined, "agent race should not create a global session workspace");

    const raceSession = raceSessions.get(result.traceId);
    assert.ok(raceSession, "agent race should register a race session for later finalization");
    assert.equal(raceSession?.applyTargetPath, repoDir);
    assert.equal(raceSession?.candidates.length, 2);
    assert.deepEqual(
      raceSession?.candidates.map((candidate) => candidate.providerName),
      ["winner", "loser"],
    );
    assert.ok(raceSession?.candidates.every((candidate) => candidate.workspaceRepoRoot === repoDir));
    assert.ok(raceSession?.candidates.every((candidate) => candidate.workspaceSharedLockKey === result.traceId));
    assert.ok(raceSession?.candidates.every((candidate) => (candidate.filesModified ?? []).length > 0));

    const workspacePaths = raceSession!.candidates.map((candidate) => {
      assert.ok(candidate.workspacePath, `candidate ${candidate.providerName} should expose workspacePath`);
      return candidate.workspacePath!;
    });
    assert.notEqual(workspacePaths[0], workspacePaths[1]);
    for (const workspacePath of workspacePaths) {
      assert.equal(existsSync(workspacePath), true, `candidate workspace should exist before finalization: ${workspacePath}`);
    }

    assert.equal(readFileSync(join(repoDir, "src", "module.txt"), "utf-8"), "base module\n");
    assert.equal(existsSync(join(repoDir, "src", "winner.txt")), false);
    assert.equal(existsSync(join(repoDir, "src", "loser.txt")), false);

    raceSessions.clear();
    const applied = await applyRaceSession(result.traceId, 0);
    assert.equal(applied.status, "applied");
    assert.equal(applied.appliedVia, "workspace");
    assert.equal(applied.winnerProvider, "winner");
    assert.equal(applied.workspacesCleaned, 2);
    assert.equal(raceSessions.has(result.traceId), false);

    assert.equal(readFileSync(join(repoDir, "src", "module.txt"), "utf-8"), "base module\nwinner line\n");
    assert.equal(readFileSync(join(repoDir, "src", "winner.txt"), "utf-8"), "winner artifact\n");
    assert.equal(existsSync(join(repoDir, "src", "loser.txt")), false);
    const checkpointAfterApply = await loadCheckpoint(result.checkpointFile);
    assert.equal(checkpointAfterApply?.status, "approved");
    assert.equal(checkpointAfterApply?.pendingRaceTraceId, undefined);
    assert.equal(checkpointAfterApply?.raceCandidates, undefined);
    for (const workspacePath of workspacePaths) {
      assert.equal(existsSync(workspacePath), false, `candidate workspace should be cleaned after finalization: ${workspacePath}`);
    }
    assert.equal(activeWorkspaces.size, 0);
  } finally {
    if (traceId && raceSessions.has(traceId)) {
      await abortRaceSession(traceId, "test cleanup");
    }
    activeWorkspaces.clear();
    clearConfigCache();
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = previousHome;
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});


test("mixed standalone agent-write plus race stays isolated until winner apply", async () => {
  const previousHome = process.env.LLM_PIPELINE_HOME;
  const previousCwd = process.cwd();
  const sandboxDir = mkdtempSync(join(tmpdir(), "llm-orch-mixed-race-"));
  const homeDir = join(sandboxDir, "home");
  const configDir = join(sandboxDir, "config");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  process.env.LLM_PIPELINE_HOME = homeDir;

  const repoDir = realpathSync(createGitRepo(sandboxDir, "mixed-race-repo"));
  const repoSrcDir = join(repoDir, "src");
  let traceId: string | undefined;

  const draftScript = createExecutableScript(
    sandboxDir,
    "mixed-draft.sh",
    [
      "#!/bin/sh",
      "printf 'draft line\n' >> module.txt",
      "printf 'draft artifact\n' > draft.txt",
      "",
    ].join("\n")
  );
  const winnerScript = createExecutableScript(
    sandboxDir,
    "mixed-winner.sh",
    [
      "#!/bin/sh",
      "printf 'winner line\n' >> module.txt",
      "printf 'winner artifact\n' > winner.txt",
      "",
    ].join("\n")
  );
  const loserScript = createExecutableScript(
    sandboxDir,
    "mixed-loser.sh",
    [
      "#!/bin/sh",
      "printf 'loser line\n' >> module.txt",
      "printf 'loser artifact\n' > loser.txt",
      "",
    ].join("\n")
  );

  writeFileSync(
    join(configDir, "pipeline.config.json"),
    JSON.stringify(
      {
        providers: {
          draft: { type: "cli", command: draftScript, mode: "agent-write" },
          winner: { type: "cli", command: winnerScript, mode: "agent-write" },
          loser: { type: "cli", command: loserScript, mode: "agent-write" },
          judge: { type: "mock" },
        },
        pipeline: {
          draft: ["draft"],
          implement: [["winner", "loser"], "draft"],
          review: ["judge", "implement"],
        },
        retry: {
          maxRounds: 1,
          reviewStep: "review",
        },
        routing: [],
      },
      null,
      2,
    ),
    "utf-8",
  );

  clearConfigCache();
  process.chdir(configDir);

  try {
    const result = await runPipelineMode({
      prompt: "Implement the requested change in the project",
      workDir: repoSrcDir,
      maxRounds: 1,
    });
    traceId = result.traceId;

    assert.equal(result.status, "awaiting_judge");
    assert.equal(readFileSync(join(repoDir, "src", "module.txt"), "utf-8"), "base module\n");
    assert.equal(existsSync(join(repoDir, "src", "draft.txt")), false);
    assert.equal(existsSync(join(repoDir, "src", "winner.txt")), false);
    assert.equal(existsSync(join(repoDir, "src", "loser.txt")), false);

    const checkpoint = await loadCheckpoint(result.checkpointFile);
    assert.ok(checkpoint?.workspacePath, "mixed pipeline should keep a global session workspace for standalone steps");
    assert.equal(checkpoint?.status, "awaiting_judge");

    const raceSession = raceSessions.get(result.traceId);
    assert.ok(raceSession);
    assert.equal(raceSession?.candidates.length, 2);
    for (const candidate of raceSession?.candidates ?? []) {
      assert.ok(candidate.filesModified?.includes("src/draft.txt"), `candidate ${candidate.providerName} should include draft base changes`);
      assert.ok(candidate.filesModified?.includes("src/module.txt"), `candidate ${candidate.providerName} should include accumulated module diff`);
    }

    const applied = await applyRaceSession(result.traceId, 0);
    assert.equal(applied.status, "applied");
    assert.equal(readFileSync(join(repoDir, "src", "module.txt"), "utf-8"), "base module\ndraft line\nwinner line\n");
    assert.equal(readFileSync(join(repoDir, "src", "draft.txt"), "utf-8"), "draft artifact\n");
    assert.equal(readFileSync(join(repoDir, "src", "winner.txt"), "utf-8"), "winner artifact\n");
    assert.equal(existsSync(join(repoDir, "src", "loser.txt")), false);

    const checkpointAfterApply = await loadCheckpoint(result.checkpointFile);
    assert.equal(checkpointAfterApply?.status, "approved");
    assert.equal(checkpointAfterApply?.workspacePath, undefined);
    assert.equal(checkpointAfterApply?.pendingRaceTraceId, undefined);
  } finally {
    if (traceId && raceSessions.has(traceId)) {
      await abortRaceSession(traceId, "mixed race cleanup");
    }
    activeWorkspaces.clear();
    clearConfigCache();
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = previousHome;
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

test("runPipelineMode surfaces apply failures and preserves workspace for recovery", async () => {
  const previousHome = process.env.LLM_PIPELINE_HOME;
  const previousCwd = process.cwd();
  const sandboxDir = mkdtempSync(join(tmpdir(), "llm-orch-apply-fail-"));
  const homeDir = join(sandboxDir, "home");
  const configDir = join(sandboxDir, "config");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  process.env.LLM_PIPELINE_HOME = homeDir;

  const repoDir = realpathSync(createGitRepo(sandboxDir, "apply-fail-repo"));
  const repoSrcDir = join(repoDir, "src");
  const providerScript = createExecutableScript(
    sandboxDir,
    "apply-fail-writer.sh",
    [
      "#!/bin/sh",
      "printf 'session only line\n' >> module.txt",
      "printf 'apply fail artifact\n' > artifact.txt",
      "",
    ].join("\n")
  );

  writeFileSync(
    join(configDir, "pipeline.config.json"),
    JSON.stringify(
      {
        providers: {
          writer: { type: "cli", command: providerScript, mode: "agent-write" },
          judge: { type: "mock" },
        },
        pipeline: {
          implement: ["writer"],
          review: ["judge", "implement"],
        },
        retry: { maxRounds: 1, reviewStep: "review" },
        routing: [],
      },
      null,
      2,
    ),
    "utf-8",
  );

  clearConfigCache();
  process.chdir(configDir);

  const originalApplyToSource = SessionWorkspace.prototype.applyToSource;
  SessionWorkspace.prototype.applyToSource = async function () {
    throw new Error("synthetic apply failure");
  };

  try {
    await assert.rejects(
      () =>
        runPipelineMode({
          prompt: "Implement the requested change in the project",
          workDir: repoSrcDir,
          maxRounds: 1,
          sessionId: "apply-failure-session",
        }),
      /synthetic apply failure/,
    );

    assert.equal(readFileSync(join(repoDir, "src", "module.txt"), "utf-8"), "base module\n");
    assert.equal(existsSync(join(repoDir, "src", "artifact.txt")), false);

    const checkpoint = await loadCheckpoint("apply-failure-session");
    assert.equal(checkpoint?.status, "failed");
    assert.ok(checkpoint?.workspacePath, "failed finalize should preserve the workspace for recovery");
    assert.equal(existsSync(checkpoint!.workspacePath!), true);

    if (checkpoint?.workspacePath && checkpoint.workspaceRepoRoot && checkpoint.workspaceBaseRef) {
      const resumed = await SessionWorkspace.resume(
        checkpoint.workspacePath,
        checkpoint.workspaceRepoRoot,
        checkpoint.workspaceBaseRef,
        checkpoint.traceId,
      );
      await resumed.destroy();
    }
  } finally {
    SessionWorkspace.prototype.applyToSource = originalApplyToSource;
    activeWorkspaces.clear();
    clearConfigCache();
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = previousHome;
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

    raceSessions.set("race-trace", {
      traceId: "race-trace",
      applyTargetPath: repoDir,
      createdAt: Date.now(),
      candidates: [
        {
          providerName: "winner",
          workspacePath: winner.worktreePath,
          workspaceRepoRoot: repoDir,
          workspaceBaseRef: winner.baseRef,
          workspaceSharedLockKey: "race-trace",
          filesModified: winnerPatch.filesModified,
          diffStat: winnerPatch.diffStat,
        },
        {
          providerName: "loser",
          workspacePath: loser.worktreePath,
          workspaceRepoRoot: repoDir,
          workspaceBaseRef: loser.baseRef,
          workspaceSharedLockKey: "race-trace",
          filesModified: loserPatch.filesModified,
          diffStat: loserPatch.diffStat,
        },
      ],
    });

    const applied = await applyRaceSession("race-trace", 0);
    assert.equal(applied.status, "applied");
    assert.equal(applied.appliedVia, "workspace");
    assert.equal(applied.workspacesCleaned, 2);
    assert.equal(raceSessions.has("race-trace"), false);

    assert.equal(readFileSync(join(repoDir, "src", "module.txt"), "utf-8"), "winner module\n");
    assert.equal(readFileSync(join(repoDir, "src", "winner.txt"), "utf-8"), "winner only\n");
    assert.equal(existsSync(join(repoDir, "src", "loser.txt")), false);
    assert.equal(existsSync(winner.worktreePath), false);
    assert.equal(existsSync(loser.worktreePath), false);
    activeWorkspaces.clear();
    assert.equal(activeWorkspaces.size, 0);

    const abortRepoDir = realpathSync(createGitRepo(sandboxDir, "abort-repo"));
    const abortA = await SessionWorkspace.create({ repoRoot: abortRepoDir, sessionId: "race-abort-a", sharedLockKey: "race-abort" });
    const abortB = await SessionWorkspace.create({ repoRoot: abortRepoDir, sessionId: "race-abort-b", sharedLockKey: "race-abort" });

    writeFileSync(join(abortA.worktreePath, "src", "module.txt"), "abort A\n", "utf-8");
    writeFileSync(join(abortB.worktreePath, "src", "module.txt"), "abort B\n", "utf-8");

    const abortAPatch = await abortA.collectPatch();
    const abortBPatch = await abortB.collectPatch();

    raceSessions.set("race-abort", {
      traceId: "race-abort",
      applyTargetPath: abortRepoDir,
      createdAt: Date.now(),
      candidates: [
        {
          providerName: "abort-a",
          workspacePath: abortA.worktreePath,
          workspaceRepoRoot: abortRepoDir,
          workspaceBaseRef: abortA.baseRef,
          workspaceSharedLockKey: "race-abort",
          filesModified: abortAPatch.filesModified,
          diffStat: abortAPatch.diffStat,
        },
        {
          providerName: "abort-b",
          workspacePath: abortB.worktreePath,
          workspaceRepoRoot: abortRepoDir,
          workspaceBaseRef: abortB.baseRef,
          workspaceSharedLockKey: "race-abort",
          filesModified: abortBPatch.filesModified,
          diffStat: abortBPatch.diffStat,
        },
      ],
    });

    const aborted = await abortRaceSession("race-abort", "judge rejected all");
    assert.equal(aborted.status, "aborted");
    assert.equal(aborted.workspacesCleaned, 2);
    assert.equal(raceSessions.has("race-abort"), false);

    assert.equal(readFileSync(join(abortRepoDir, "src", "module.txt"), "utf-8"), "base module\n");
    assert.equal(existsSync(abortA.worktreePath), false);
    assert.equal(existsSync(abortB.worktreePath), false);
    activeWorkspaces.clear();
    assert.equal(activeWorkspaces.size, 0);
  } finally {
    process.env.LLM_PIPELINE_HOME = previousHome;
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});
