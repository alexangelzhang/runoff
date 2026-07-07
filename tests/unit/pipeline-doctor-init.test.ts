import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runDoctor, evaluateLoopReadiness, formatLoopReadinessBadge } from "../../src/pipeline/pipeline-doctor.js";
import { pipelineInit } from "../../src/pipeline/pipeline-init.js";
import { saveFullConfigToFile } from "../../src/pipeline/config-persist.js";
import { loadConfigFromPath } from "../../src/core/config.js";
import { getRepoRoot } from "../../src/core/paths.js";
import { join } from "node:path";

test("pipelineInit creates feature profile config", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-init-"));
  const result = pipelineInit(dir, "feature");
  assert.ok(result.configPath.endsWith("pipeline.config.json"));
  const cfg = JSON.parse(readFileSync(result.configPath, "utf-8")) as { pipeline: Record<string, unknown> };
  assert.ok(cfg.pipeline.implement);
  rmSync(dir, { recursive: true, force: true });
});

test("pipelineInit pr-babysitter scaffolds AGENTS.md and STATE.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-loop-init-"));
  const result = pipelineInit(dir, "pr-babysitter");
  assert.equal(result.profile, "pr-babysitter");
  assert.ok(existsSync(join(dir, "AGENTS.md")));
  assert.ok(existsSync(join(dir, "STATE.md")));
  assert.ok(result.scaffoldedFiles.some((p) => p.endsWith("AGENTS.md")));
  const cfg = JSON.parse(readFileSync(result.configPath, "utf-8")) as {
    pipeline: Record<string, string[]>;
  };
  assert.ok(cfg.pipeline.triage);
  assert.ok(cfg.pipeline.review);
  rmSync(dir, { recursive: true, force: true });
});

test("pipelineInit daily-triage is L1 single-step config", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-triage-init-"));
  const result = pipelineInit(dir, "daily-triage");
  const cfg = JSON.parse(readFileSync(result.configPath, "utf-8")) as {
    pipeline: Record<string, string[]>;
  };
  assert.deepEqual(Object.keys(cfg.pipeline), ["triage"]);
  assert.ok(existsSync(join(dir, "STATE.md")));
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

test("pr-babysitter example scores L2+ loop readiness", () => {
  const configPath = join(getRepoRoot(), "examples", "configs", "pr-babysitter.config.json");
  const config = loadConfigFromPath(configPath);
  const { report } = evaluateLoopReadiness(config, join(getRepoRoot(), "examples", "configs"));
  assert.ok(["L2", "L3"].includes(report.level), `expected L2 or L3, got ${report.level} (${report.score})`);
  assert.ok(report.score >= 55);
  const doctor = runDoctor({ configPath });
  assert.ok(doctor.loopReadiness);
  assert.equal(doctor.loopReadiness?.level, report.level);
});

test("race-pr-babysitter config validates and scores L2+", () => {
  const configPath = join(getRepoRoot(), "examples", "configs", "race-pr-babysitter.config.json");
  const config = loadConfigFromPath(configPath);
  const fixStep = config.pipeline.fix;
  assert.ok(Array.isArray(fixStep?.[0]));
  const { report } = evaluateLoopReadiness(config, join(getRepoRoot(), "examples", "configs"));
  assert.ok(["L2", "L3"].includes(report.level));
});

test("formatLoopReadinessBadge emits shields markdown", () => {
  const badge = formatLoopReadinessBadge({
    level: "L3",
    score: 90,
    maxScore: 100,
    suggestions: [],
  });
  assert.match(badge, /!\[Loop Ready L3/);
  assert.match(badge, /img\.shields\.io/);
  assert.match(badge, /L3_90%2F100/);
});

test("evaluateLoopReadiness warns when review step missing from retry config", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-loop-"));
  const configPath = join(dir, "pipeline.config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        providers: { a: { type: "mock" } },
        pipeline: { implement: ["a"] },
        retry: { maxRounds: 1, reviewStep: "review" },
      },
      null,
      2,
    )}\n`,
  );
  const config = loadConfigFromPath(configPath);
  const { checks, report } = evaluateLoopReadiness(config, dir);
  assert.ok(checks.some((c) => c.name === "loop-review-step" && c.status === "warn"));
  assert.equal(report.level, "L0");
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
