import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { clearConfigCache } from "../../src/core/config.js";
import { raceSessions } from "../../src/runtime/race-registry.js";
import { abortRaceSession } from "../../src/runtime/race-finalize.js";
import { runPipelineMode } from "../../src/tools/run-pipeline.js";

/**
 * Opt-in integration smoke against real CLI agents.
 *
 * Examples:
 *   LLM_PIPELINE_RUN_REAL_PROVIDER_SMOKE=1 \
 *   LLM_PIPELINE_REAL_CODEX_ARGV_JSON='["codex","exec","--full-auto","--skip-git-repo-check"]' \
 *   npm run test:real-providers
 *
 *   LLM_PIPELINE_RUN_REAL_PROVIDER_SMOKE=1 \
 *   LLM_PIPELINE_RUN_REAL_RACE_SMOKE=1 \
 *   LLM_PIPELINE_REAL_CODEX_ARGV_JSON='["codex","exec","--full-auto","--skip-git-repo-check"]' \
 *   LLM_PIPELINE_REAL_GEMINI_ARGV_JSON='["gemini","-y","-p"]' \
 *   npm run test:real-providers
 */

const RUN_REAL_PROVIDER_SMOKE = process.env.LLM_PIPELINE_RUN_REAL_PROVIDER_SMOKE === "1";
const RUN_REAL_RACE_SMOKE = process.env.LLM_PIPELINE_RUN_REAL_RACE_SMOKE === "1";
const REAL_TIMEOUT_MS = Number(process.env.LLM_PIPELINE_REAL_TIMEOUT_MS ?? 300_000);
const REAL_SMOKE_ARTIFACT_ROOT = process.env.LLM_PIPELINE_REAL_SMOKE_ARTIFACT_ROOT;
const REAL_SMOKE_SANDBOX_ROOT = process.env.LLM_PIPELINE_REAL_SMOKE_SANDBOX_ROOT;
const KEEP_SANDBOX = process.env.LLM_PIPELINE_REAL_SMOKE_KEEP_SANDBOX === "1";

type RealSmokeResult = "running" | "passed" | "failed" | "skipped";

type RealSmokeCaseMetadata = {
  caseId: string;
  label: string;
  result: RealSmokeResult;
  startedAt: string;
  finishedAt?: string;
  skipReason?: string;
  errorMessage?: string;
  providerEnvNames: string[];
  traceId?: string;
  pipelineStatus?: string;
  sandboxDir?: string;
  homeDir?: string;
  configDir?: string;
  repoDir?: string;
  workDir?: string;
  artifactName?: string;
  artifactContent?: string;
  expectedLine?: string;
};

function writeCaseMetadata(metadata: RealSmokeCaseMetadata): void {
  if (!REAL_SMOKE_ARTIFACT_ROOT) return;
  mkdirSync(REAL_SMOKE_ARTIFACT_ROOT, { recursive: true });
  writeFileSync(
    join(REAL_SMOKE_ARTIFACT_ROOT, `${metadata.caseId}.json`),
    JSON.stringify(metadata, null, 2),
    "utf-8",
  );
}

function markSkippedCase(caseId: string, label: string, providerEnvNames: string[], skipReason: string): void {
  writeCaseMetadata({
    caseId,
    label,
    result: "skipped",
    skipReason,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    providerEnvNames,
  });
}

function makeSandbox(prefix: string): string {
  const root = REAL_SMOKE_SANDBOX_ROOT ?? tmpdir();
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, prefix));
}

function createGitRepo(dir: string, name: string): string {
  const repoDir = join(dir, name);
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "real-provider-smoke@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Real Provider Smoke"], { cwd: repoDir });
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "src", "note.txt"), "base note\n", "utf-8");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });
  return repoDir;
}

function parseArgvEnv(name: string): string[] | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${name} must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${name} must be a non-empty JSON array of non-empty strings`);
  }

  return parsed as string[];
}

function assertContainsLine(content: string, expectedLine: string): void {
  const lines = content.split(/\r?\n/).filter(Boolean);
  assert.ok(lines.includes(expectedLine), `Expected line ${JSON.stringify(expectedLine)} in file content: ${content}`);
}

function requireOptInArgv(
  t: TestContext,
  caseId: string,
  label: string,
  envName: string,
  providerEnvNames: string[],
): string[] | null {
  if (!RUN_REAL_PROVIDER_SMOKE) {
    const reason = `set LLM_PIPELINE_RUN_REAL_PROVIDER_SMOKE=1 to run real ${label} smoke`;
    markSkippedCase(caseId, label, providerEnvNames, reason);
    t.skip(reason);
    return null;
  }

  const argv = parseArgvEnv(envName);
  if (!argv) {
    const reason = `set ${envName} to run real ${label} smoke`;
    markSkippedCase(caseId, label, providerEnvNames, reason);
    t.skip(reason);
    return null;
  }

  return argv;
}

async function runSingleProviderSmoke(
  t: TestContext,
  caseId: string,
  label: string,
  argvEnvName: string,
  expectedLine: string,
): Promise<void> {
  const providerEnvNames = [argvEnvName];
  const argv = requireOptInArgv(t, caseId, label, argvEnvName, providerEnvNames);
  if (!argv) return;

  const previousHome = process.env.LLM_PIPELINE_HOME;
  const previousCwd = process.cwd();
  const sandboxDir = makeSandbox(`llm-real-${label}-`);
  const homeDir = join(sandboxDir, "home");
  const configDir = join(sandboxDir, "config");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  process.env.LLM_PIPELINE_HOME = homeDir;

  const repoDir = createGitRepo(sandboxDir, `${label}-repo`);
  const workDir = join(repoDir, "src");
  const artifactName = `${label}-smoke.txt`;
  const artifactContent = `${label} artifact`;
  const metadata: RealSmokeCaseMetadata = {
    caseId,
    label,
    result: "running",
    startedAt: new Date().toISOString(),
    providerEnvNames,
    sandboxDir,
    homeDir,
    configDir,
    repoDir,
    workDir,
    artifactName,
    artifactContent,
    expectedLine,
  };
  writeCaseMetadata(metadata);

  writeFileSync(
    join(configDir, "pipeline.config.json"),
    JSON.stringify(
      {
        providers: {
          agent: {
            type: "cli",
            command: argv[0],
            args: argv.slice(1),
            mode: "agent-write",
            timeoutMs: REAL_TIMEOUT_MS,
          },
          judge: {
            type: "mock",
          },
        },
        pipeline: {
          implement: ["agent"],
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
      prompt:
        `In the current working directory, append the exact line "${expectedLine}" to note.txt ` +
        `and create ${artifactName} with the exact content "${artifactContent}". ` +
        `Keep the change minimal and briefly summarize what you changed.`,
      workDir,
      maxRounds: 1,
    });

    metadata.pipelineStatus = result.status;
    assert.equal(result.status, "approved");

    const noteContent = readFileSync(join(workDir, "note.txt"), "utf-8");
    assertContainsLine(noteContent, expectedLine);
    assert.equal(existsSync(join(workDir, artifactName)), true);
    assert.equal(readFileSync(join(workDir, artifactName), "utf-8").trim(), artifactContent);

    metadata.result = "passed";
  } catch (err) {
    metadata.result = "failed";
    metadata.errorMessage = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    metadata.finishedAt = new Date().toISOString();
    writeCaseMetadata(metadata);

    clearConfigCache();
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = previousHome;

    if (!KEEP_SANDBOX) {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  }
}

test("real codex provider smoke: standalone agent-write pipeline can modify a repo", async (t) => {
  await runSingleProviderSmoke(t, "codex-standalone", "codex", "LLM_PIPELINE_REAL_CODEX_ARGV_JSON", "codex real smoke ok");
});

test("real gemini provider smoke: standalone agent-write pipeline can modify a repo", async (t) => {
  await runSingleProviderSmoke(t, "gemini-standalone", "gemini", "LLM_PIPELINE_REAL_GEMINI_ARGV_JSON", "gemini real smoke ok");
});

test("real provider race smoke: codex + gemini can reach awaiting_judge with deferred workspaces", async (t) => {
  const caseId = "provider-race";
  const label = "codex+gemini race";
  const providerEnvNames = ["LLM_PIPELINE_REAL_CODEX_ARGV_JSON", "LLM_PIPELINE_REAL_GEMINI_ARGV_JSON"];

  if (!RUN_REAL_PROVIDER_SMOKE) {
    const reason = "set LLM_PIPELINE_RUN_REAL_PROVIDER_SMOKE=1 to run real race smoke";
    markSkippedCase(caseId, label, providerEnvNames, reason);
    t.skip(reason);
    return;
  }

  if (!RUN_REAL_RACE_SMOKE) {
    const reason = "set LLM_PIPELINE_RUN_REAL_RACE_SMOKE=1 to run real race smoke";
    markSkippedCase(caseId, label, providerEnvNames, reason);
    t.skip(reason);
    return;
  }

  const codexArgv = parseArgvEnv("LLM_PIPELINE_REAL_CODEX_ARGV_JSON");
  const geminiArgv = parseArgvEnv("LLM_PIPELINE_REAL_GEMINI_ARGV_JSON");
  if (!codexArgv || !geminiArgv) {
    const reason = "set both LLM_PIPELINE_REAL_CODEX_ARGV_JSON and LLM_PIPELINE_REAL_GEMINI_ARGV_JSON to run real race smoke";
    markSkippedCase(caseId, label, providerEnvNames, reason);
    t.skip(reason);
    return;
  }

  const previousHome = process.env.LLM_PIPELINE_HOME;
  const previousCwd = process.cwd();
  const sandboxDir = makeSandbox("llm-real-race-");
  const homeDir = join(sandboxDir, "home");
  const configDir = join(sandboxDir, "config");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  process.env.LLM_PIPELINE_HOME = homeDir;

  const repoDir = createGitRepo(sandboxDir, "real-race-repo");
  const workDir = join(repoDir, "src");
  const metadata: RealSmokeCaseMetadata = {
    caseId,
    label,
    result: "running",
    startedAt: new Date().toISOString(),
    providerEnvNames,
    sandboxDir,
    homeDir,
    configDir,
    repoDir,
    workDir,
    artifactName: "race-smoke.txt",
    artifactContent: "race artifact",
    expectedLine: "real race smoke",
  };
  writeCaseMetadata(metadata);

  writeFileSync(
    join(configDir, "pipeline.config.json"),
    JSON.stringify(
      {
        providers: {
          codex: {
            type: "cli",
            command: codexArgv[0],
            args: codexArgv.slice(1),
            mode: "agent-write",
            timeoutMs: REAL_TIMEOUT_MS,
          },
          gemini: {
            type: "cli",
            command: geminiArgv[0],
            args: geminiArgv.slice(1),
            mode: "agent-write",
            timeoutMs: REAL_TIMEOUT_MS,
          },
          judge: {
            type: "mock",
          },
        },
        pipeline: {
          implement: [["codex", "gemini"]],
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
      prompt:
        `In the current working directory, append the exact line "real race smoke" to note.txt ` +
        `and create race-smoke.txt with the exact content "race artifact". Keep the change minimal.`,
      workDir,
      maxRounds: 1,
    });

    metadata.traceId = result.traceId;
    metadata.pipelineStatus = result.status;

    assert.equal(result.status, "awaiting_judge");
    assert.equal(readFileSync(join(workDir, "note.txt"), "utf-8"), "base note\n");
    assert.equal(existsSync(join(workDir, "race-smoke.txt")), false);

    const raceSession = raceSessions.get(result.traceId);
    assert.ok(raceSession, "real provider race should register a race session");
    assert.deepEqual(
      raceSession?.candidates.map((candidate) => candidate.providerName),
      ["codex", "gemini"],
    );
    assert.ok(raceSession?.candidates.some((candidate) => !!candidate.workspacePath));
    assert.ok(raceSession?.candidates.every((candidate) => candidate.workspaceRepoRoot === repoDir));
    assert.ok(raceSession?.candidates.every((candidate) => candidate.workspaceSharedLockKey === result.traceId));
    for (const candidate of raceSession?.candidates ?? []) {
      if (!candidate.workspacePath) continue;
      assert.equal(existsSync(candidate.workspacePath), true);
    }

    metadata.result = "passed";
  } catch (err) {
    metadata.result = "failed";
    metadata.errorMessage = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    if (metadata.traceId && raceSessions.has(metadata.traceId)) {
      const aborted = await abortRaceSession(metadata.traceId, "real integration smoke cleanup");
      assert.equal(aborted.status, "aborted");
      assert.equal(raceSessions.has(metadata.traceId), false);
    }

    metadata.finishedAt = new Date().toISOString();
    writeCaseMetadata(metadata);

    clearConfigCache();
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = previousHome;

    if (!KEEP_SANDBOX) {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  }
});

test("real provider race auto-pick smoke: codex + gemini finishes approved", async (t) => {
  const caseId = "provider-race-autopick";
  const label = "codex+gemini race auto-pick";
  const providerEnvNames = ["LLM_PIPELINE_REAL_CODEX_ARGV_JSON", "LLM_PIPELINE_REAL_GEMINI_ARGV_JSON"];

  if (!RUN_REAL_PROVIDER_SMOKE) {
    markSkippedCase(caseId, label, providerEnvNames, "set LLM_PIPELINE_RUN_REAL_PROVIDER_SMOKE=1");
    t.skip("opt-in");
    return;
  }
  if (!RUN_REAL_RACE_SMOKE) {
    markSkippedCase(caseId, label, providerEnvNames, "set LLM_PIPELINE_RUN_REAL_RACE_SMOKE=1");
    t.skip("opt-in race");
    return;
  }

  const codexArgv = parseArgvEnv("LLM_PIPELINE_REAL_CODEX_ARGV_JSON");
  const geminiArgv = parseArgvEnv("LLM_PIPELINE_REAL_GEMINI_ARGV_JSON");
  if (!codexArgv || !geminiArgv) {
    markSkippedCase(caseId, label, providerEnvNames, "missing codex or gemini argv secrets");
    t.skip("missing argv");
    return;
  }

  const previousHome = process.env.LLM_PIPELINE_HOME;
  const previousCwd = process.cwd();
  const sandboxDir = makeSandbox("llm-real-race-autopick-");
  const homeDir = join(sandboxDir, "home");
  const configDir = join(sandboxDir, "config");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  process.env.LLM_PIPELINE_HOME = homeDir;

  const repoDir = createGitRepo(sandboxDir, "real-race-autopick-repo");
  const workDir = join(repoDir, "src");
  const metadata: RealSmokeCaseMetadata = {
    caseId,
    label,
    result: "running",
    startedAt: new Date().toISOString(),
    providerEnvNames,
    sandboxDir,
    homeDir,
    configDir,
    repoDir,
    workDir,
  };
  writeCaseMetadata(metadata);

  writeFileSync(
    join(configDir, "pipeline.config.json"),
    JSON.stringify(
      {
        providers: {
          codex: {
            type: "cli",
            command: codexArgv[0],
            args: codexArgv.slice(1),
            mode: "agent-write",
            timeoutMs: REAL_TIMEOUT_MS,
          },
          gemini: {
            type: "cli",
            command: geminiArgv[0],
            args: geminiArgv.slice(1),
            mode: "agent-write",
            timeoutMs: REAL_TIMEOUT_MS,
          },
          judge: { type: "mock" },
        },
        pipeline: {
          implement: [["codex", "gemini"]],
          review: ["judge", "implement"],
        },
        retry: { maxRounds: 1, reviewStep: "review" },
        runtime: { raceFinalize: "auto-pick" },
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
      prompt:
        'In the current working directory, append the exact line "race autopick ok" to note.txt. Keep the change minimal.',
      workDir,
      maxRounds: 1,
    });
    metadata.traceId = result.traceId;
    metadata.pipelineStatus = result.status;
    assert.equal(result.status, "approved");
    assert.equal(raceSessions.has(result.traceId), false);
    metadata.result = "passed";
  } catch (err) {
    metadata.result = "failed";
    metadata.errorMessage = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    if (metadata.traceId && raceSessions.has(metadata.traceId)) {
      await abortRaceSession(metadata.traceId, "autopick smoke cleanup");
    }
    metadata.finishedAt = new Date().toISOString();
    writeCaseMetadata(metadata);
    clearConfigCache();
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = previousHome;
    if (!KEEP_SANDBOX) rmSync(sandboxDir, { recursive: true, force: true });
  }
});
