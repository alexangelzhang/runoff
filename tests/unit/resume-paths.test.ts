import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { calculateConfigHash, clearConfigCache, type PipelineConfig } from "../../src/core/config.js";
import {
  assertResumeCompatible,
  CHECKPOINT_SCHEMA_VERSION,
  buildResumeMetadata,
  type PipelineState,
  type ResumeRequest,
} from "../../src/core/state.js";
import { applyRaceSession } from "../../src/runtime/race-finalize.js";
import { runPipelineMode } from "../../src/tools/run-pipeline.js";
import { raceSessions } from "../../src/runtime/race-registry.js";
import { loadCheckpoint } from "../../src/core/state.js";

function baseResumeRequest(configHash: string): ResumeRequest {
  return {
    mode: "pipeline",
    prompt: "p",
    language: "typescript",
    context: "",
    workDir: "/tmp/w",
    acceptanceCriteria: [],
    verifyResults: "",
    configHash,
  };
}

function mockCheckpoint(overrides: Partial<PipelineState>): PipelineState {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    sessionId: "sess-1",
    prompt: "p",
    round: 1,
    maxRounds: 2,
    lastCode: "",
    lastReviewFeedback: "",
    approved: false,
    stepResults: {},
    stepTraces: [],
    traceId: "trace-1",
    timestamp: new Date().toISOString(),
    status: "running",
    resume: buildResumeMetadata(baseResumeRequest("hash")),
    ...overrides,
  };
}

test("assertResumeCompatible rejects awaiting_judge (use race apply)", () => {
  const config: PipelineConfig = {
    providers: { mock: { type: "mock" } },
    pipeline: { a: ["mock"] },
    retry: { maxRounds: 1 },
  };
  const hash = calculateConfigHash(config);
  const state = mockCheckpoint({
    status: "awaiting_judge",
    resume: buildResumeMetadata(baseResumeRequest(hash)),
  });
  assert.throws(
    () => assertResumeCompatible(state, baseResumeRequest(hash)),
    /awaiting judge/i,
  );
});

test("assertResumeCompatible rejects awaiting_approval without operator decision", () => {
  const config: PipelineConfig = {
    providers: { mock: { type: "mock" } },
    pipeline: { a: ["mock"] },
    retry: { maxRounds: 1 },
  };
  const hash = calculateConfigHash(config);
  const state = mockCheckpoint({
    status: "awaiting_approval",
    resume: buildResumeMetadata(baseResumeRequest(hash)),
  });
  assert.throws(
    () => assertResumeCompatible(state, baseResumeRequest(hash)),
    /awaiting operator approval/i,
  );
});

test("mock race defer: apply then checkpoint is approved", async () => {
  const previousHome = process.env.RUNOFF_HOME;
  const sandbox = mkdtempSync(join(tmpdir(), "lp-resume-race-"));
  process.env.RUNOFF_HOME = join(sandbox, "home");
  const configDir = join(sandbox, "cfg");
  const repoDir = join(sandbox, "repo");
  mkdirSync(join(process.env.RUNOFF_HOME!), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(repoDir, "src"), { recursive: true });
  execFileSync("git", ["init"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "t@test"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "T"], { cwd: repoDir });
  writeFileSync(join(repoDir, "src", "m.txt"), "base\n");
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });

  const winnerSh = join(sandbox, "w.sh");
  const loserSh = join(sandbox, "l.sh");
  writeFileSync(winnerSh, "#!/bin/sh\nprintf 'w\\n' >> m.txt\n");
  writeFileSync(loserSh, "#!/bin/sh\nprintf 'l\\n' >> m.txt\n");
  execFileSync("chmod", ["+x", winnerSh, loserSh]);

  writeFileSync(
    join(configDir, "pipeline.config.json"),
    JSON.stringify({
      providers: {
        winner: { type: "cli", command: winnerSh, args: [], mode: "agent-write" },
        loser: { type: "cli", command: loserSh, args: [], mode: "agent-write" },
        judge: { type: "mock" },
      },
      pipeline: {
        implement: [["winner", "loser"]],
        review: ["judge", "implement"],
      },
      retry: { maxRounds: 1, reviewStep: "review" },
    }),
  );

  const previousCwd = process.cwd();
  process.chdir(configDir);
  clearConfigCache();
  try {
    const result = await runPipelineMode({
      prompt: "change",
      workDir: join(repoDir, "src"),
      maxRounds: 1,
    });
    assert.equal(result.status, "awaiting_judge");
    const applied = await applyRaceSession(result.traceId, 0);
    assert.equal(applied.status, "applied");
    const cp = await loadCheckpoint(result.checkpointFile);
    assert.equal(cp?.status, "approved");
    assert.equal(raceSessions.has(result.traceId), false);
  } finally {
    clearConfigCache();
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = previousHome;
    rmSync(sandbox, { recursive: true, force: true });
  }
});
