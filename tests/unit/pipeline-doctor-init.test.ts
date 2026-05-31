import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runDoctor } from "../../src/pipeline/pipeline-doctor.js";
import { pipelineInit } from "../../src/pipeline/pipeline-init.js";
import { saveFullConfigToFile } from "../../src/pipeline/config-persist.js";
import { loadConfigFromPath } from "../../src/core/config.js";

test("pipelineInit creates feature profile config", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-init-"));
  const result = pipelineInit(dir, "feature");
  assert.ok(result.configPath.endsWith("pipeline.config.json"));
  const cfg = JSON.parse(readFileSync(result.configPath, "utf-8")) as { pipeline: Record<string, unknown> };
  assert.ok(cfg.pipeline.implement);
  rmSync(dir, { recursive: true, force: true });
});

test("runDoctor passes with valid config", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-doc-"));
  const { configPath } = pipelineInit(dir, "mock");
  const report = runDoctor({ configPath });
  assert.equal(report.ok, true);
  assert.ok(report.checks.some((c) => c.name === "config" && c.status === "ok"));
  rmSync(dir, { recursive: true, force: true });
});

test("saveFullConfigToFile round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-full-"));
  const { configPath } = pipelineInit(dir, "feature");
  const cfg = loadConfigFromPath(configPath);
  cfg.retry = { maxRounds: 5, reviewStep: "review" };
  const result = saveFullConfigToFile(configPath, cfg);
  assert.equal(result.ok, true);
  const reloaded = loadConfigFromPath(configPath);
  assert.equal(reloaded.retry?.maxRounds, 5);
  rmSync(dir, { recursive: true, force: true });
});
