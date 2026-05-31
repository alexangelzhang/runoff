import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type RealProviderSmokeMode = "manual" | "nightly" | "pre-release";
export type RealProviderSmokeOverallStatus = "passed" | "failed";
export type RealSmokeResult = "running" | "passed" | "failed" | "skipped";

export type RealProviderSmokeOptions = {
  mode: RealProviderSmokeMode;
  reportDir: string;
  runRace: boolean;
  requireNoSkip: boolean;
  keepSuccessSandboxes: boolean;
};

export type RealSmokeCaseMetadata = {
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

export type RealProviderSmokeSummary = {
  mode: RealProviderSmokeMode;
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
  overallStatus: RealProviderSmokeOverallStatus;
  failureReasons: string[];
  cases: RealSmokeCaseMetadata[];
};

const MODE_DEFAULTS: Record<
  RealProviderSmokeMode,
  Pick<RealProviderSmokeOptions, "runRace" | "requireNoSkip" | "keepSuccessSandboxes">
> = {
  manual: { runRace: false, requireNoSkip: false, keepSuccessSandboxes: false },
  nightly: { runRace: true, requireNoSkip: true, keepSuccessSandboxes: false },
  "pre-release": { runRace: true, requireNoSkip: true, keepSuccessSandboxes: false },
};

export function parseRealProviderSmokeArgs(
  argv: string[],
  rootDir: string,
  defaultReportRoot = join(rootDir, "tmp", "real-provider-smoke"),
): RealProviderSmokeOptions {
  let mode: RealProviderSmokeMode = "manual";
  let reportDir: string | undefined;
  let runRace: boolean | undefined;
  let requireNoSkip: boolean | undefined;
  let keepSuccessSandboxes = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--mode") {
      const value = argv[index + 1] as RealProviderSmokeMode | undefined;
      if (!value || !["manual", "nightly", "pre-release"].includes(value)) {
        throw new Error("--mode must be one of: manual, nightly, pre-release");
      }
      mode = value;
      index += 1;
      continue;
    }

    if (arg === "--report-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--report-dir requires a value");
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

  const defaults = MODE_DEFAULTS[mode];
  const tag = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    mode,
    reportDir: reportDir ?? join(defaultReportRoot, `${tag}-${mode}`),
    runRace: runRace ?? defaults.runRace,
    requireNoSkip: requireNoSkip ?? defaults.requireNoSkip,
    keepSuccessSandboxes: keepSuccessSandboxes || defaults.keepSuccessSandboxes,
  };
}

export function loadRealProviderSmokeCases(caseDir: string): RealSmokeCaseMetadata[] {
  if (!existsSync(caseDir)) return [];

  return readdirSync(caseDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(caseDir, name), "utf-8")) as RealSmokeCaseMetadata);
}

export function evaluateRealProviderSmokeOutcome(input: {
  options: Pick<RealProviderSmokeOptions, "requireNoSkip">;
  cases: RealSmokeCaseMetadata[];
  commandExitCode: number;
  runnerError?: string;
}): Pick<
  RealProviderSmokeSummary,
  "skippedCount" | "passedCount" | "failedCount" | "totalCases" | "overallStatus" | "failureReasons"
> {
  const skippedCount = input.cases.filter((item) => item.result === "skipped").length;
  const passedCount = input.cases.filter((item) => item.result === "passed").length;
  const failedCount = input.cases.filter((item) => item.result === "failed").length;
  const failureReasons: string[] = [];

  if (input.runnerError) {
    failureReasons.push(`real-provider smoke runner crashed: ${input.runnerError.split("\n", 1)[0]}`);
  }
  if (input.commandExitCode !== 0) {
    failureReasons.push(`real-provider integration test process exited with code ${input.commandExitCode}`);
  }
  if (input.cases.length === 0) {
    failureReasons.push("no case metadata was produced by tests/real-provider.integration.test.ts");
  }
  if (failedCount > 0) {
    failureReasons.push(`${failedCount} smoke case(s) reported failed`);
  }
  if (input.options.requireNoSkip && skippedCount > 0) {
    failureReasons.push(`${skippedCount} smoke case(s) were skipped under strict mode`);
  }

  return {
    skippedCount,
    passedCount,
    failedCount,
    totalCases: input.cases.length,
    overallStatus: failureReasons.length === 0 ? "passed" : "failed",
    failureReasons,
  };
}

export function renderRealProviderSmokeSummaryMarkdown(summary: RealProviderSmokeSummary): string {
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

  const footer =
    summary.failureReasons.length > 0
      ? ["", "## Failure Reasons", "", ...summary.failureReasons.map((item) => `- ${item}`)]
      : [];

  return [...header, ...rows, ...footer, ""].join("\n");
}
