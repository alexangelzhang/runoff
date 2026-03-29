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

const ROOT_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_REPORT_ROOT = join(ROOT_DIR, "tmp", "real-provider-smoke");
const TEST_ENTRY = join(ROOT_DIR, "tests", "real-provider.integration.test.ts");
const HOME_SNAPSHOT_DIRS = ["traces", "sessions", "tasks"] as const;

type Mode = "manual" | "nightly" | "pre-release";
type OverallStatus = "passed" | "failed";
type RealSmokeResult = "running" | "passed" | "failed" | "skipped";

type Options = {
  mode: Mode;
  reportDir: string;
  runRace: boolean;
  requireNoSkip: boolean;
  keepSuccessSandboxes: boolean;
};

type CaseMetadata = {
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

type Summary = {
  mode: Mode;
  reportDir: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  runRace: boolean;
  requireNoSkip: boolean;
  keepSuccessSandboxes: boolean;
  commandExitCode: number;
  runnerError?: string;
  skippedCount: number;
  passedCount: number;
  failedCount: number;
  totalCases: number;
  overallStatus: OverallStatus;
  failureReasons: string[];
  cases: CaseMetadata[];
};

function parseArgs(argv: string[]): Options {
  let mode: Mode = "manual";
  let reportDir: string | undefined;
  let runRace: boolean | undefined;
  let requireNoSkip: boolean | undefined;
  let keepSuccessSandboxes = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--mode") {
      const value = argv[index + 1] as Mode | undefined;
      if (!value || !["manual", "nightly", "pre-release"].includes(value)) {
        throw new Error("--mode must be one of: manual, nightly, pre-release");
      }
      mode = value;
      index += 1;
      continue;
    }

    if (arg === "--report-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--report-dir requires a value");
      }
      reportDir = resolve(value);
      index += 1;
      continue;
    }

    if (arg === "--run-race") {
      runRace = true;
      continue;
    }

    if (arg === "--no-run-race") {
      runRace = false;
      continue;
    }

    if (arg === "--require-no-skip") {
      requireNoSkip = true;
      continue;
    }

    if (arg === "--allow-skip") {
      requireNoSkip = false;
      continue;
    }

    if (arg === "--keep-success-sandboxes") {
      keepSuccessSandboxes = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  const defaultsByMode: Record<Mode, Pick<Options, "runRace" | "requireNoSkip" | "keepSuccessSandboxes">> = {
    manual: {
      runRace: false,
      requireNoSkip: false,
      keepSuccessSandboxes: false,
    },
    nightly: {
      runRace: true,
      requireNoSkip: true,
      keepSuccessSandboxes: false,
    },
    "pre-release": {
      runRace: true,
      requireNoSkip: true,
      keepSuccessSandboxes: false,
    },
  };

  const defaults = defaultsByMode[mode];
  const tag = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    mode,
    reportDir: reportDir ?? join(DEFAULT_REPORT_ROOT, `${tag}-${mode}`),
    runRace: runRace ?? defaults.runRace,
    requireNoSkip: requireNoSkip ?? defaults.requireNoSkip,
    keepSuccessSandboxes: keepSuccessSandboxes || defaults.keepSuccessSandboxes,
  };
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

function loadCaseMetadata(caseDir: string): CaseMetadata[] {
  if (!existsSync(caseDir)) {
    return [];
  }

  return readdirSync(caseDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(caseDir, name), "utf-8")) as CaseMetadata);
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

function renderSummaryMarkdown(summary: Summary): string {
  const header = [
    "# Real Provider Smoke Report",
    "",
    `- Mode: \`${summary.mode}\``,
    `- Overall status: \`${summary.overallStatus}\``,
    `- Command exit code: \`${summary.commandExitCode}\``,
    `- Started: ${summary.startedAt}`,
    `- Finished: ${summary.finishedAt}`,
    `- Duration: ${summary.durationMs} ms`,
    `- Report dir: \`${summary.reportDir}\``,
    `- Race enabled: \`${summary.runRace}\``,
    `- Require no skip: \`${summary.requireNoSkip}\``,
    `- Keep success sandboxes: \`${summary.keepSuccessSandboxes}\``,
    `- Cases: ${summary.totalCases} total / ${summary.passedCount} passed / ${summary.failedCount} failed / ${summary.skippedCount} skipped`,
    "",
    "## Cases",
    "",
    "| Case | Result | Pipeline | Trace | Note | Sandbox |",
    "|------|--------|----------|-------|------|---------|",
  ];

  const rows = summary.cases.map((item) => {
    const note = (item.skipReason ?? item.errorMessage ?? "")
      .replace(/\|/g, "\\|")
      .replace(/\r?\n/g, "<br>");
    return `| ${item.caseId} | ${item.result} | ${item.pipelineStatus ?? ""} | ${item.traceId ?? ""} | ${note} | ${item.sandboxDir ?? ""} |`;
  });

  const footer = summary.failureReasons.length > 0
    ? ["", "## Failure Reasons", "", ...summary.failureReasons.map((item) => `- ${item}`)]
    : [];

  return [...header, ...rows, ...footer, ""].join("\n");
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
  const cases = loadCaseMetadata(caseDir);
  for (const metadata of cases) {
    writeCaseDiagnostics(options.reportDir, metadata);
  }

  const skippedCount = cases.filter((item) => item.result === "skipped").length;
  const passedCount = cases.filter((item) => item.result === "passed").length;
  const failedCount = cases.filter((item) => item.result === "failed").length;
  const failureReasons: string[] = [];

  if (runnerError) {
    failureReasons.push(`real-provider smoke runner crashed: ${runnerError.split("\n", 1)[0]}`);
  }
  if (commandExitCode !== 0) {
    failureReasons.push(`real-provider integration test process exited with code ${commandExitCode}`);
  }
  if (cases.length === 0) {
    failureReasons.push("no case metadata was produced by tests/real-provider.integration.test.ts");
  }
  if (failedCount > 0) {
    failureReasons.push(`${failedCount} smoke case(s) reported failed`);
  }
  if (options.requireNoSkip && skippedCount > 0) {
    failureReasons.push(`${skippedCount} smoke case(s) were skipped under strict mode`);
  }

  const overallStatus: OverallStatus = failureReasons.length === 0 ? "passed" : "failed";
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
    skippedCount,
    passedCount,
    failedCount,
    totalCases: cases.length,
    overallStatus,
    failureReasons,
    cases,
  };

  writeJson(join(options.reportDir, "summary.json"), summary);
  writeText(join(options.reportDir, "summary.md"), renderSummaryMarkdown(summary));

  if (overallStatus === "passed" && !options.keepSuccessSandboxes) {
    rmSync(join(options.reportDir, "sandboxes"), { recursive: true, force: true });
  }

  console.log(`real-provider-smoke: ${overallStatus.toUpperCase()} (${options.mode})`);
  console.log(`real-provider-smoke: report dir ${options.reportDir}`);

  if (overallStatus !== "passed") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`real-provider-smoke runner error: ${message}`);
  process.exitCode = 1;
});
