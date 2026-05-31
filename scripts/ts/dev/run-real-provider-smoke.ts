import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateRealProviderSmokeOutcome,
  loadRealProviderSmokeCases,
  parseRealProviderSmokeArgs,
  renderRealProviderSmokeSummaryMarkdown,
  type RealProviderSmokeOptions,
  type RealProviderSmokeSummary,
  type RealSmokeCaseMetadata,
} from "../../../src/pipeline/real-provider-smoke-runner.js";
import {
  applyRealProviderArgvDefaults,
  formatPrecheckIssues,
  precheckRealProviderCliEnv,
} from "../../../src/pipeline/real-provider-cli-precheck.js";

const ROOT_DIR = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const TEST_ENTRY = join(ROOT_DIR, "tests", "integration", "real-provider.integration.test.ts");
const HOME_SNAPSHOT_DIRS = ["traces", "sessions", "tasks"] as const;

type Options = RealProviderSmokeOptions;
type CaseMetadata = RealSmokeCaseMetadata;
type Summary = RealProviderSmokeSummary;

function parseArgs(argv: string[]): Options {
  return parseRealProviderSmokeArgs(argv, ROOT_DIR);
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeText(filePath: string, content: string): void {
  writeFileSync(filePath, content, "utf-8");
}

function fileExists(path: string | undefined): path is string {
  return typeof path === "string" && path.length > 0 && existsSync(path);
}

function listTree(dir: string, depth = 4, prefix = ""): string[] {
  if (!existsSync(dir) || depth < 0) {
    return [];
  }

  const entries = readdirSync(dir).sort();
  const lines: string[] = [];
  for (const entry of entries) {
    const entryPath = join(dir, entry);
    try {
      const stats = statSync(entryPath);
      const suffix = stats.isDirectory() ? "/" : ` (${stats.size} bytes)`;
      lines.push(`${prefix}${entry}${suffix}`);
      if (stats.isDirectory() && depth > 0) {
        lines.push(...listTree(entryPath, depth - 1, `${prefix}  `));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`${prefix}${entry} (error: ${message})`);
    }
  }
  return lines;
}

function safeExec(cwd: string, command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf-8" });
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error) {
      const stdout = String((error as { stdout?: unknown }).stdout ?? "");
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      return [stdout, stderr].filter(Boolean).join("\n").trim();
    }
    return error instanceof Error ? error.message : String(error);
  }
}

function writeTreeArtifact(targetDir: string, name: string, dir: string | undefined): void {
  if (!fileExists(dir)) {
    return;
  }
  const tree = listTree(dir, 5).join("\n");
  writeText(join(targetDir, `${name}-tree.txt`), tree);
}

function copyDirectoryIfExists(sourceDir: string | undefined, targetDir: string): void {
  if (!fileExists(sourceDir)) {
    return;
  }
  cpSync(sourceDir, targetDir, { recursive: true });
}

function copyFileIfExists(sourceFile: string | undefined, targetFile: string): void {
  if (!fileExists(sourceFile)) {
    return;
  }
  writeText(targetFile, readFileSync(sourceFile, "utf-8"));
}

function writeRepoDiagnostics(targetDir: string, repoDir: string): void {
  writeText(join(targetDir, "repo-status.txt"), safeExec(repoDir, "git", ["status", "--short"]));
  writeText(join(targetDir, "repo-head.txt"), safeExec(repoDir, "git", ["rev-parse", "HEAD"]));
  writeText(join(targetDir, "repo-diff-stat.txt"), safeExec(repoDir, "git", ["diff", "--stat", "HEAD"]));
  writeText(join(targetDir, "repo-diff.patch"), safeExec(repoDir, "git", ["diff", "HEAD"]));
  writeText(
    join(targetDir, "repo-untracked.txt"),
    safeExec(repoDir, "git", ["ls-files", "--others", "--exclude-standard"]),
  );
}

function writeHomeDiagnostics(targetDir: string, homeDir: string): void {
  writeTreeArtifact(targetDir, "home", homeDir);
  for (const subdir of HOME_SNAPSHOT_DIRS) {
    const sourceDir = join(homeDir, subdir);
    writeTreeArtifact(targetDir, subdir, sourceDir);
    copyDirectoryIfExists(sourceDir, join(targetDir, "home-snapshots", subdir));
  }
}

function writeCaseDiagnostics(reportDir: string, metadata: CaseMetadata): void {
  const diagDir = join(reportDir, "diagnostics", metadata.caseId);
  ensureDir(diagDir);

  writeJson(join(diagDir, "metadata.json"), metadata);
  writeTreeArtifact(diagDir, "sandbox", metadata.sandboxDir);
  writeTreeArtifact(diagDir, "repo", metadata.repoDir);
  writeTreeArtifact(diagDir, "workdir", metadata.workDir);
  writeTreeArtifact(diagDir, "config", metadata.configDir);

  if (fileExists(metadata.repoDir)) {
    writeRepoDiagnostics(diagDir, metadata.repoDir);
  }

  if (fileExists(metadata.homeDir)) {
    writeHomeDiagnostics(diagDir, metadata.homeDir);
  }

  if (fileExists(metadata.configDir)) {
    copyFileIfExists(join(metadata.configDir, "pipeline.config.json"), join(diagDir, "pipeline.config.json"));
  }
}

function writeRunnerDiagnostics(reportDir: string, options: Options, runnerError?: string): void {
  const diagDir = join(reportDir, "diagnostics", "runner");
  ensureDir(diagDir);

  writeJson(join(diagDir, "context.json"), {
    generatedAt: new Date().toISOString(),
    reportDir,
    mode: options.mode,
    runRace: options.runRace,
    requireNoSkip: options.requireNoSkip,
    keepSuccessSandboxes: options.keepSuccessSandboxes,
    nodeVersion: process.version,
    platform: process.platform,
    testEntry: TEST_ENTRY,
    runnerError,
  });

  writeTreeArtifact(diagDir, "report", reportDir);
  writeRepoDiagnostics(diagDir, ROOT_DIR);
}

async function runIntegrationTest(options: Options, reportDir: string): Promise<number> {
  const logsDir = join(reportDir, "logs");
  const caseDir = join(reportDir, "cases");
  const sandboxDir = join(reportDir, "sandboxes");
  ensureDir(logsDir);
  ensureDir(caseDir);
  ensureDir(sandboxDir);

  const stdoutLog = createWriteStream(join(logsDir, "stdout.log"), { flags: "w" });
  const stderrLog = createWriteStream(join(logsDir, "stderr.log"), { flags: "w" });

  const env = {
    ...process.env,
    LLM_PIPELINE_RUN_REAL_PROVIDER_SMOKE: "1",
    LLM_PIPELINE_RUN_REAL_RACE_SMOKE: options.runRace ? "1" : "0",
    LLM_PIPELINE_REAL_SMOKE_ARTIFACT_ROOT: caseDir,
    LLM_PIPELINE_REAL_SMOKE_SANDBOX_ROOT: sandboxDir,
    LLM_PIPELINE_REAL_SMOKE_KEEP_SANDBOX: "1",
  };

  writeJson(join(reportDir, "invocation.json"), {
    generatedAt: new Date().toISOString(),
    mode: options.mode,
    reportDir,
    testEntry: TEST_ENTRY,
    runRace: options.runRace,
    requireNoSkip: options.requireNoSkip,
    keepSuccessSandboxes: options.keepSuccessSandboxes,
    env: {
      LLM_PIPELINE_RUN_REAL_PROVIDER_SMOKE: env.LLM_PIPELINE_RUN_REAL_PROVIDER_SMOKE,
      LLM_PIPELINE_RUN_REAL_RACE_SMOKE: env.LLM_PIPELINE_RUN_REAL_RACE_SMOKE,
      LLM_PIPELINE_REAL_SMOKE_ARTIFACT_ROOT: env.LLM_PIPELINE_REAL_SMOKE_ARTIFACT_ROOT,
      LLM_PIPELINE_REAL_SMOKE_SANDBOX_ROOT: env.LLM_PIPELINE_REAL_SMOKE_SANDBOX_ROOT,
      LLM_PIPELINE_REAL_SMOKE_KEEP_SANDBOX: env.LLM_PIPELINE_REAL_SMOKE_KEEP_SANDBOX,
      LLM_PIPELINE_REAL_TIMEOUT_MS: env.LLM_PIPELINE_REAL_TIMEOUT_MS,
    },
  });

  const child = spawn(process.execPath, ["--import", "tsx", "--test", TEST_ENTRY], {
    cwd: ROOT_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
    stdoutLog.write(chunk);
  });

  child.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
    stderrLog.write(chunk);
  });

  try {
    return await new Promise<number>((resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("close", (code) => resolvePromise(code ?? 1));
    });
  } finally {
    stdoutLog.end();
    stderrLog.end();
  }
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const options = parseArgs(process.argv.slice(2));
  ensureDir(options.reportDir);

  applyRealProviderArgvDefaults();
  const precheck = precheckRealProviderCliEnv();
  if (precheck.length) {
    writeText(join(options.reportDir, "precheck.txt"), formatPrecheckIssues(precheck));
    const errors = precheck.filter((i) => i.severity === "error");
    if (errors.length && options.mode !== "manual") {
      console.error(formatPrecheckIssues(errors));
      process.exitCode = 1;
      return;
    }
    for (const issue of precheck) {
      console.warn(`[real-provider-precheck] ${issue.envVar}: ${issue.message}`);
    }
  }

  let commandExitCode = 1;
  let runnerError: string | undefined;
  try {
    commandExitCode = await runIntegrationTest(options, options.reportDir);
  } catch (error) {
    runnerError = error instanceof Error ? error.stack ?? error.message : String(error);
    writeText(join(options.reportDir, "runner-error.txt"), runnerError);
  }

  writeRunnerDiagnostics(options.reportDir, options, runnerError);

  const caseDir = join(options.reportDir, "cases");
  const cases = loadRealProviderSmokeCases(caseDir);
  for (const metadata of cases) {
    writeCaseDiagnostics(options.reportDir, metadata);
  }

  const outcome = evaluateRealProviderSmokeOutcome({
    options,
    cases,
    commandExitCode,
    runnerError,
  });
  const finishedAt = new Date();
  const summary: Summary = {
    mode: options.mode,
    reportDir: options.reportDir,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    runRace: options.runRace,
    requireNoSkip: options.requireNoSkip,
    keepSuccessSandboxes: options.keepSuccessSandboxes,
    commandExitCode,
    runnerError,
    cases,
    ...outcome,
  };

  writeJson(join(options.reportDir, "summary.json"), summary);
  writeText(join(options.reportDir, "summary.md"), renderRealProviderSmokeSummaryMarkdown(summary));

  if (summary.overallStatus === "passed" && !options.keepSuccessSandboxes) {
    rmSync(join(options.reportDir, "sandboxes"), { recursive: true, force: true });
  }

  console.log(`real-provider-smoke: ${summary.overallStatus.toUpperCase()} (${options.mode})`);
  console.log(`real-provider-smoke: report dir ${options.reportDir}`);

  if (summary.overallStatus !== "passed") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`real-provider-smoke runner error: ${message}`);
  process.exitCode = 1;
});
