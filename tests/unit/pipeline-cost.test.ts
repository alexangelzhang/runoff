import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { loadConfigFromPath } from "../../src/core/config.js";
import { getRepoRoot } from "../../src/core/paths.js";
import {
  estimateLoopCost,
  inferLoopPattern,
  inferLoopLevel,
} from "../../src/pipeline/pipeline-cost.js";

test("inferLoopPattern maps example configs", () => {
  const triage = loadConfigFromPath(
    join(getRepoRoot(), "examples", "configs", "daily-triage.config.json"),
  );
  const pr = loadConfigFromPath(
    join(getRepoRoot(), "examples", "configs", "pr-babysitter.config.json"),
  );
  const ci = loadConfigFromPath(
    join(getRepoRoot(), "examples", "configs", "ci-sweeper.config.json"),
  );
  assert.equal(inferLoopPattern(triage), "daily-triage");
  assert.equal(inferLoopPattern(pr), "pr-babysitter");
  assert.equal(inferLoopPattern(ci), "ci-sweeper");
  assert.equal(inferLoopLevel(triage), "L1");
  assert.equal(inferLoopLevel(pr), "L2");
});

test("estimateLoopCost returns defaults without trace history", () => {
  const dir = mkdtempSync(join(tmpdir(), "lp-cost-"));
  const configPath = join(getRepoRoot(), "examples", "configs", "daily-triage.config.json");
  const estimate = estimateLoopCost({
    cadence: "1d",
    configPath,
    traceLimit: 1,
  });
  assert.equal(estimate.pattern, "daily-triage");
  assert.equal(estimate.runsPerDay, 1);
  assert.ok(estimate.estimatedDailyTokens > 0);
  assert.ok(estimate.warnings.length > 0);
  rmSync(dir, { recursive: true, force: true });
});

test("estimateLoopCost scales with cadence", () => {
  const configPath = join(getRepoRoot(), "examples", "configs", "pr-babysitter.config.json");
  const daily = estimateLoopCost({ cadence: "1d", configPath, pattern: "pr-babysitter", level: "L2" });
  const frequent = estimateLoopCost({ cadence: "5m", configPath, pattern: "pr-babysitter", level: "L2" });
  assert.ok(frequent.estimatedDailyCostUsd > daily.estimatedDailyCostUsd);
});
