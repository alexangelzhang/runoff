import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadConfigFromPath } from "../../src/core/config.js";
import { getRepoRoot } from "../../src/core/paths.js";
import {
  configFingerprint,
  evaluateLoopSync,
  writeLoopManifest,
} from "../../src/pipeline/loop-sync.js";
import { pipelineInit } from "../../src/pipeline/pipeline-init.js";

test("writeLoopManifest and evaluateLoopSync detect config drift", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-sync-"));
  const configPath = join(dir, "pipeline.config.json");
  const config = loadConfigFromPath(
    join(getRepoRoot(), "examples", "configs", "daily-triage.config.json"),
  );
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeLoopManifest(dir, "daily-triage", config);

  const ok = evaluateLoopSync(dir, config);
  assert.ok(ok.some((c) => c.name === "loop-sync-config" && c.status === "ok"));

  config.retry = { maxRounds: 5, reviewStep: "review" };
  const drifted = evaluateLoopSync(dir, config);
  assert.ok(drifted.some((c) => c.name === "loop-sync-config" && c.status === "warn"));

  rmSync(dir, { recursive: true, force: true });
});

test("evaluateLoopSync warns on AGENTS L1 vs fix config", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-sync-agents-"));
  writeFileSync(
    join(dir, "AGENTS.md"),
    "# AGENTS\n\n**Level:** L1 report-only\n",
  );
  const config = loadConfigFromPath(
    join(getRepoRoot(), "examples", "configs", "pr-babysitter.config.json"),
  );
  const checks = evaluateLoopSync(dir, config);
  assert.ok(checks.some((c) => c.name === "loop-sync-agents-level" && c.status === "warn"));
  rmSync(dir, { recursive: true, force: true });
});

test("pipelineInit writes loop manifest for loop profiles", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-manifest-"));
  const result = pipelineInit(dir, "ci-sweeper");
  assert.ok(result.scaffoldedFiles.some((p) => p.includes("loop-manifest.json")));
  const manifest = JSON.parse(readFileSync(join(dir, ".runoff", "loop-manifest.json"), "utf-8")) as {
    profile: string;
    configFingerprint: string;
  };
  assert.equal(manifest.profile, "ci-sweeper");
  const config = loadConfigFromPath(result.configPath);
  assert.equal(manifest.configFingerprint, configFingerprint(config));
  rmSync(dir, { recursive: true, force: true });
});
