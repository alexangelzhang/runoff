import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearConfigCache } from "../../src/core/config.js";
import { getSessionsDir } from "../../src/core/paths.js";
import { loadCheckpoint } from "../../src/core/state.js";
import { loadTraceById } from "../../src/observability/trace.js";
import { createControlPlane } from "../../src/orchestration/control-plane.js";
import { queryRuns } from "../../src/orchestration/run-query.js";
import { runPipelineMode } from "../../src/tools/run-pipeline.js";

function createGitRepo(dir: string): string {
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "resume-calibration@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Resume Calibration"], { cwd: repoDir });
  writeFileSync(join(repoDir, "input.txt"), "base\n", "utf-8");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
  return realpathSync(repoDir);
}

test("checkpoint resume persists resume reuse plan in result, observation, trace, and checkpoint", async () => {
  const previousHome = process.env.RUNOFF_HOME;
  const previousCwd = process.cwd();
  const sandboxDir = mkdtempSync(join(tmpdir(), "runoff-resume-reuse-plan-"));
  const homeDir = join(sandboxDir, "home");
  const configDir = join(sandboxDir, "config");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  process.env.RUNOFF_HOME = homeDir;

  try {
    const repoDir = createGitRepo(sandboxDir);
    writeFileSync(
      join(configDir, "pipeline.config.json"),
      JSON.stringify(
        {
          providers: {
            mock: { type: "mock" },
          },
          pipeline: {
            generate: ["mock"],
            validate: ["mock", "generate"],
          },
          retry: { maxRounds: 1, reviewStep: "review" },
          runtime: { controlPlane: "file" },
          routing: [],
        },
        null,
        2,
      ),
      "utf-8",
    );

    clearConfigCache();
    process.chdir(configDir);

    const first = await runPipelineMode({
      prompt: "calibrate resume reuse plan",
      workDir: repoDir,
      maxRounds: 1,
      scopePreflight: { allowDirtyWorktree: true },
    });

    assert.equal(first.status, "approved");
    assert.equal(first.stepResults.generate?.status, "success");
    assert.equal(first.stepResults.validate?.status, "success");

    const checkpointPath = join(getSessionsDir(), `${first.checkpointFile}.checkpoint.json`);
    assert.equal(existsSync(checkpointPath), true, "first run should persist checkpoint");

    const checkpointFixture = JSON.parse(readFileSync(checkpointPath, "utf-8"));
    checkpointFixture.status = "failed";
    checkpointFixture.approved = false;
    checkpointFixture.round = 1;
    checkpointFixture.stepResults.generate.resumeMetadata = {
      ...checkpointFixture.stepResults.generate.resumeMetadata,
      artifactCompleteness: "partial",
      canSkipOnResume: false,
      mustRerunReason: "calibration forces generate rerun",
      evidenceRefs: [
        ...(checkpointFixture.stepResults.generate.resumeMetadata?.evidenceRefs ?? []),
        "calibration.checkpointMutation.generate.partial",
      ],
    };
    writeFileSync(checkpointPath, JSON.stringify(checkpointFixture, null, 2), "utf-8");

    const resumed = await runPipelineMode({
      prompt: "calibrate resume reuse plan",
      workDir: repoDir,
      sessionId: first.checkpointFile,
      maxRounds: 1,
      scopePreflight: { allowDirtyWorktree: true },
    });

    assert.equal(resumed.status, "approved");
    assert.equal(resumed.checkpointFile, first.checkpointFile);
    assert.equal(resumed.traceId, first.traceId);
    assert.deepEqual(resumed.resumeReusePlan?.summary, { skipped: 0, rerun: 2 });
    assert.deepEqual(
      resumed.resumeReusePlan?.entries.map((entry) => [entry.stepName, entry.decision, entry.downstreamOf]),
      [
        ["generate", "rerun", undefined],
        ["validate", "rerun", "generate"],
      ],
    );
    assert.equal(resumed.observation?.resumeReusePlan?.summary.rerun, 2);
    assert.ok(
      resumed.observation?.coverageGaps.includes(
        "Resume planner reruns validate: downstream dependency generate must rerun on resume",
      ),
    );

    const trace = loadTraceById(resumed.traceId);
    assert.equal(trace?.lifecycle, "final");
    assert.equal(trace?.finalStatus, "approved");
    assert.deepEqual(trace?.resumeReusePlan?.summary, resumed.resumeReusePlan?.summary);
    assert.deepEqual(
      trace?.resumeReusePlan?.entries.map((entry) => [entry.stepName, entry.decision, entry.downstreamOf]),
      [
        ["generate", "rerun", undefined],
        ["validate", "rerun", "generate"],
      ],
    );
    assert.deepEqual(trace?.observation?.resumeReusePlan?.summary, resumed.observation?.resumeReusePlan?.summary);

    const checkpoint = await loadCheckpoint(resumed.checkpointFile);
    assert.equal(checkpoint?.status, "approved");
    assert.deepEqual(checkpoint?.resumeReusePlan?.summary, resumed.resumeReusePlan?.summary);
    assert.equal(
      checkpoint?.resumeReusePlan?.entries.find((entry) => entry.stepName === "validate")?.downstreamOf,
      "generate",
    );

    const controlPlane = createControlPlane({
      providers: { mock: { type: "mock" } },
      pipeline: {
        generate: ["mock"],
        validate: ["mock", "generate"],
      },
      retry: { maxRounds: 1, reviewStep: "review" },
      runtime: { controlPlane: "file" },
    });
    const fullRuns = queryRuns({
      runStore: controlPlane.runStore,
      eventLog: controlPlane.eventLog,
      controlPlaneMode: controlPlane.mode,
      runId: resumed.traceId,
      format: "full",
    });
    assert.deepEqual(fullRuns.runs[0]?.resumePlanner, {
      round: 1,
      rerun: 2,
      skipped: 0,
      rerunSteps: [
        {
          stepName: "generate",
          reason: "calibration forces generate rerun",
        },
        {
          stepName: "validate",
          reason: "downstream dependency generate must rerun on resume",
          downstreamOf: "generate",
        },
      ],
      skippedHidden: 0,
    });
  } finally {
    clearConfigCache();
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = previousHome;
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});
