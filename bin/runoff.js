#!/usr/bin/env node
// runoff CLI entry point — delegates to pipeline-cli.ts via tsx
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const cliScript = join(repoRoot, "scripts", "ts", "dev", "pipeline-cli.ts");

const result = spawnSync(
  process.execPath,
  ["--import", "tsx/esm", cliScript, ...process.argv.slice(2)],
  { stdio: "inherit", cwd: process.cwd() }
);

process.exit(result.status ?? 1);
