#!/usr/bin/env node
/**
 * Local soak: repeated mock pipeline runs to detect workspace leaks (S2.5).
 *
 *   npm run pipeline:soak
 *   SOAK_ROUNDS=20 npm run pipeline:soak
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanOrphanWorkspaces } from "../../../src/pipeline/workspace-orphans.js";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const rounds = Math.max(1, Number(process.env.SOAK_ROUNDS ?? 10));

const home = mkdtempSync(join(tmpdir(), "lp-soak-home-"));
const repo = mkdtempSync(join(tmpdir(), "lp-soak-repo-"));

process.env.RUNOFF_HOME = home;

try {
  execFileSync("git", ["init"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "soak@test"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Soak"], { cwd: repo });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repo });

  execFileSync(
    "npm",
    ["run", "pipeline:init", "--", "--work-dir", repo, "--profile", "mock"],
    { cwd: ROOT, stdio: "inherit", env: process.env },
  );

  const config = join(repo, "pipeline.config.json");
  for (let i = 1; i <= rounds; i++) {
    console.log(`\n▶ soak round ${i}/${rounds}`);
    execFileSync(
      "npm",
      [
        "run",
        "pipeline:run",
        "--",
        "--prompt",
        `soak round ${i}`,
        "--work-dir",
        repo,
        "--config",
        config,
        "--max-rounds",
        "1",
      ],
      { cwd: ROOT, stdio: "inherit", env: process.env },
    );
    const orphans = scanOrphanWorkspaces({ homeDir: home });
    if (orphans.length > 0) {
      console.error(`orphan worktrees after round ${i}:`, orphans.map((o) => o.name).join(", "));
      process.exit(1);
    }
  }
  console.log(`\n✓ soak complete (${rounds} rounds, 0 orphan worktrees)`);
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}
