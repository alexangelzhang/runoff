import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  evaluateRealProviderSmokeOutcome,
  loadRealProviderSmokeCases,
  parseRealProviderSmokeArgs,
  preReleaseMatrixFailures,
  renderRealProviderSmokeSummaryMarkdown,
} from "../../src/pipeline/real-provider-smoke-runner.ts";

const ROOT = "/tmp/runoff-test-root";

test("parseRealProviderSmokeArgs: nightly defaults are strict + race", () => {
  const options = parseRealProviderSmokeArgs(["--mode", "nightly"], ROOT, join(ROOT, "reports"));
  assert.equal(options.mode, "nightly");
  assert.equal(options.runRace, true);
  assert.equal(options.requireNoSkip, true);
  assert.match(options.reportDir, /reports\/.+-nightly$/);
});

test("parseRealProviderSmokeArgs: manual allows skip and disables race by default", () => {
  const options = parseRealProviderSmokeArgs(["--mode", "manual", "--allow-skip"], ROOT, join(ROOT, "reports"));
  assert.equal(options.runRace, false);
  assert.equal(options.requireNoSkip, false);
});

test("parseRealProviderSmokeArgs: explicit flags override mode defaults", () => {
  const options = parseRealProviderSmokeArgs(
    ["--mode", "nightly", "--no-run-race", "--allow-skip", "--report-dir", "/tmp/smoke-report"],
    ROOT,
  );
  assert.equal(options.reportDir, "/tmp/smoke-report");
  assert.equal(options.runRace, false);
  assert.equal(options.requireNoSkip, false);
});

test("evaluateRealProviderSmokeOutcome: strict mode fails on skipped cases", () => {
  const outcome = evaluateRealProviderSmokeOutcome({
    options: { requireNoSkip: true },
    commandExitCode: 0,
    cases: [
      {
        caseId: "codex-standalone",
        label: "codex",
        result: "skipped",
        skipReason: "missing argv",
        startedAt: new Date().toISOString(),
        providerEnvNames: ["RUNOFF_REAL_CODEX_ARGV_JSON"],
      },
    ],
  });
  assert.equal(outcome.overallStatus, "failed");
  assert.ok(outcome.failureReasons.some((reason) => reason.includes("skipped")));
});

test("evaluateRealProviderSmokeOutcome: all passed with exit 0 succeeds", () => {
  const outcome = evaluateRealProviderSmokeOutcome({
    options: { requireNoSkip: true },
    commandExitCode: 0,
    cases: [
      {
        caseId: "codex-standalone",
        label: "codex",
        result: "passed",
        startedAt: new Date().toISOString(),
        providerEnvNames: ["RUNOFF_REAL_CODEX_ARGV_JSON"],
      },
    ],
  });
  assert.equal(outcome.overallStatus, "passed");
  assert.deepEqual(outcome.failureReasons, []);
});

test("loadRealProviderSmokeCases: reads case metadata from report dir", () => {
  const caseDir = mkdtempSync(join(tmpdir(), "llm-smoke-cases-"));
  writeFileSync(
    join(caseDir, "codex-standalone.json"),
    JSON.stringify({
      caseId: "codex-standalone",
      label: "codex",
      result: "passed",
      startedAt: "2026-05-26T00:00:00.000Z",
      providerEnvNames: ["RUNOFF_REAL_CODEX_ARGV_JSON"],
    }),
    "utf-8",
  );
  const cases = loadRealProviderSmokeCases(caseDir);
  assert.equal(cases.length, 1);
  assert.equal(cases[0]?.caseId, "codex-standalone");
});

test("preReleaseMatrixFailures: requires four passed cases", () => {
  const failures = preReleaseMatrixFailures([
    { caseId: "codex-standalone", label: "c", result: "passed", startedAt: "", providerEnvNames: [] },
    { caseId: "gemini-standalone", label: "g", result: "skipped", startedAt: "", providerEnvNames: [] },
  ]);
  assert.ok(failures.some((f) => f.includes("gemini-standalone")));
  assert.ok(failures.some((f) => f.includes("provider-race")));
});

test("evaluateRealProviderSmokeOutcome: pre-release fails when matrix incomplete", () => {
  const outcome = evaluateRealProviderSmokeOutcome({
    options: { requireNoSkip: true, mode: "pre-release" },
    commandExitCode: 0,
    cases: [
      {
        caseId: "codex-standalone",
        label: "codex",
        result: "passed",
        startedAt: new Date().toISOString(),
        providerEnvNames: [],
      },
    ],
  });
  assert.equal(outcome.overallStatus, "failed");
  assert.ok(outcome.failureReasons.some((r) => r.includes("pre-release matrix")));
});

test("renderRealProviderSmokeSummaryMarkdown: includes failure reasons", () => {
  const md = renderRealProviderSmokeSummaryMarkdown({
    mode: "nightly",
    reportDir: "/tmp/report",
    startedAt: "2026-05-26T00:00:00.000Z",
    finishedAt: "2026-05-26T00:01:00.000Z",
    durationMs: 60_000,
    runRace: true,
    requireNoSkip: true,
    keepSuccessSandboxes: false,
    commandExitCode: 1,
    skippedCount: 1,
    passedCount: 0,
    failedCount: 0,
    totalCases: 1,
    overallStatus: "failed",
    failureReasons: ["1 smoke case(s) were skipped under strict mode"],
    cases: [
      {
        caseId: "codex-standalone",
        label: "codex",
        result: "skipped",
        skipReason: "missing argv",
        startedAt: "2026-05-26T00:00:00.000Z",
        providerEnvNames: [],
      },
    ],
  });
  assert.match(md, /Overall status: `failed`/);
  assert.match(md, /Failure Reasons/);
});
