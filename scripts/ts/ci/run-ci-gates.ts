#!/usr/bin/env node
/**
 * CI gate runner: ipc-sync + gate2 + gate3 + unit tests (+ optional real-provider smoke).
 *
 * Usage:
 *   npx tsx scripts/ts/ci/run-ci-gates.ts
 *   npx tsx scripts/ts/ci/run-ci-gates.ts --smoke
 *   npx tsx scripts/ts/ci/run-ci-gates.ts --smoke --allow-skip
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatDoctorReport, runDoctor } from "../../../src/pipeline/pipeline-doctor.js";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

if (!process.env.LLM_PIPELINE_HOME) {
  const ciHome = mkdtempSync(join(tmpdir(), "lp-ci-home-"));
  mkdirSync(join(ciHome, "tmp"), { recursive: true });
  process.env.LLM_PIPELINE_HOME = ciHome;
  process.env.TMPDIR = join(ciHome, "tmp");
}

function run(label: string, args: string[]): void {
  console.log(`\n▶ ${label}`);
  execFileSync("npm", args, { cwd: ROOT, stdio: "inherit", env: process.env });
}

const argv = process.argv.slice(2);
const withSmoke = argv.includes("--smoke");
const allowSkip = argv.includes("--allow-skip");

run("check-ipc-sync", ["run", "check-ipc-sync"]);
run("typecheck", ["run", "typecheck"]);
run("check-benchmark-pins", ["run", "check-benchmark-pins"]);
run("gate2", ["run", "test:gate2"]);
run("gate3", ["run", "test:gate3"]);
run("check-examples-experimental", ["run", "check:examples-experimental"]);
run("verify-otel-export", ["run", "verify:otel-export"]);
run("verify-otel-collector (skip if down)", ["run", "verify:otel-collector"]);
run("unit tests", ["run", "test:ci"]);

console.log("\n▶ example config doctor");
const examplesDir = join(ROOT, "examples", "configs");
const exampleConfigs = readdirSync(examplesDir).filter((f) => f.endsWith(".config.json"));
let doctorFailed = false;
for (const file of exampleConfigs) {
  const configPath = join(examplesDir, file);
  const report = runDoctor({ configPath });
  if (!report.ok) {
    doctorFailed = true;
    console.error(formatDoctorReport(report));
  } else {
    console.log(`  OK ${file}`);
  }
}
if (doctorFailed) {
  process.exit(1);
}

if (process.env.CI_SDK_MEMORY === "1") {
  run("sdk memory integration (optional packages)", ["run", "test:sdk-memory"]);
}

if (withSmoke) {
  const smokeArgs = ["run", "smoke:real:pre-release"];
  if (allowSkip) smokeArgs.push("--", "--allow-skip");
  run("real-provider smoke (pre-release profile)", smokeArgs);
}

console.log("\n✓ All CI gates passed");
