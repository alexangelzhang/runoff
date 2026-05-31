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
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function run(label: string, args: string[]): void {
  console.log(`\n▶ ${label}`);
  execFileSync("npm", args, { cwd: ROOT, stdio: "inherit", env: process.env });
}

const argv = process.argv.slice(2);
const withSmoke = argv.includes("--smoke");
const allowSkip = argv.includes("--allow-skip");

run("check-ipc-sync", ["run", "check-ipc-sync"]);
run("check-benchmark-pins", ["run", "check-benchmark-pins"]);
run("gate2", ["run", "test:gate2"]);
run("gate3", ["run", "test:gate3"]);
run("unit tests", ["test"]);

if (process.env.CI_SDK_MEMORY === "1") {
  run("sdk memory integration (optional packages)", ["run", "test:sdk-memory"]);
}

if (withSmoke) {
  const smokeArgs = ["run", "smoke:real:pre-release"];
  if (allowSkip) smokeArgs.push("--", "--allow-skip");
  run("real-provider smoke (pre-release profile)", smokeArgs);
}

console.log("\n✓ All CI gates passed");
