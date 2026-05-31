import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CHECKPOINT_SCHEMA_VERSION,
  assertResumeCompatible,
  assertStepTransition,
  assertPipelineTransition,
  buildResumeMetadata,
  createConfigHash,
  deleteCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
  type PipelineState,
} from "../src/core/state.ts";

function withPipelineHome(fn: (homeDir: string) => void | Promise<void>): Promise<void> | void {
  const previousHome = process.env.LLM_PIPELINE_HOME;
  const homeDir = mkdtempSync(join(tmpdir(), "llm-pipeline-test-"));
  process.env.LLM_PIPELINE_HOME = homeDir;

  const cleanup = () => {
    if (previousHome === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = previousHome;
    rmSync(homeDir, { recursive: true, force: true });
  };

  const result = fn(homeDir);
  if (result && typeof (result as Promise<void>).then === "function") {
    return (result as Promise<void>).finally(cleanup);
  }
  cleanup();
}

function createResumeRequest() {
  return {
    mode: "pipeline" as const,
    prompt: "implement feature",
    language: "typescript",
    context: "existing context",
    workDir: "/tmp/project-a",
    acceptanceCriteria: ["criterion 1"],
    verifyResults: "tests passed",
    configHash: createConfigHash({ pipeline: ["generate", "review"] }),
  };
}

function createState(overrides: Partial<PipelineState> = {}): PipelineState {
  const resumeRequest = createResumeRequest();
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    sessionId: "session-a",
    prompt: resumeRequest.prompt,
    round: 1,
    maxRounds: 2,
    lastCode: "",
    lastReviewFeedback: "",
    approved: false,
    stepResults: {},
    stepTraces: [],
    globalKnowledge: {},
    traceId: "trace-a",
    timestamp: new Date().toISOString(),
    status: "running",
    resume: buildResumeMetadata(resumeRequest),
    ...overrides,
  };
}

test("saveCheckpoint persists state with schemaVersion and deleteCheckpoint cleans it up", async () => {
  await withPipelineHome(async (homeDir) => {
    const state = createState({ lastCode: "diff --git a/file.ts b/file.ts" });

    await saveCheckpoint(state.sessionId, state);
    const loaded = await loadCheckpoint(state.sessionId);

    assert.ok(loaded);
    assert.equal(loaded?.schemaVersion, CHECKPOINT_SCHEMA_VERSION);
    assert.equal(loaded?.traceId, state.traceId);
    assert.deepEqual(loaded?.resume, state.resume);

    const checkpointFile = join(homeDir, "sessions", `${state.sessionId}.checkpoint.json`);
    assert.ok(existsSync(checkpointFile));
    const raw = JSON.parse(readFileSync(checkpointFile, "utf-8"));
    assert.equal(raw.schemaVersion, CHECKPOINT_SCHEMA_VERSION);

    await deleteCheckpoint(state.sessionId);
    assert.equal(await loadCheckpoint(state.sessionId), null);
  });
});

test("assertResumeCompatible rejects mismatched resume context", () => {
  const resumeRequest = createResumeRequest();
  const state = createState();

  assert.doesNotThrow(() => assertResumeCompatible(state, resumeRequest));
  assert.throws(() => assertResumeCompatible(state, { ...resumeRequest, workDir: "/tmp/project-b" }), /workDir/);
  assert.throws(() => assertResumeCompatible(state, { ...resumeRequest, verifyResults: "tests failed" }), /verifyResults/);
});

test("assertResumeCompatible rejects legacy checkpoints without schemaVersion", () => {
  const legacyState = { ...createState(), schemaVersion: undefined } as PipelineState;
  assert.throws(() => assertResumeCompatible(legacyState, createResumeRequest()), /older pipeline version/);
});

test("assertResumeCompatible rejects newer checkpoints", () => {
  const futureState = createState({ schemaVersion: CHECKPOINT_SCHEMA_VERSION + 1 });
  assert.throws(() => assertResumeCompatible(futureState, createResumeRequest()), /newer pipeline version/);
});

test("loadCheckpoint rejects newer schemaVersion", async () => {
  await withPipelineHome(async (homeDir) => {
    const checkpointDir = join(homeDir, "sessions");
    const checkpointFile = join(checkpointDir, "future.checkpoint.json");
    await saveCheckpoint("seed", createState());
    writeFileSync(
      checkpointFile,
      JSON.stringify({ ...createState(), sessionId: "future", schemaVersion: CHECKPOINT_SCHEMA_VERSION + 1 }, null, 2),
    );
    assert.equal(await loadCheckpoint("future"), null);
  });
});

test("loadCheckpoint rejects legacy checkpoint without schemaVersion", async () => {
  await withPipelineHome(async (homeDir) => {
    const checkpointDir = join(homeDir, "sessions");
    const checkpointFile = join(checkpointDir, "legacy.checkpoint.json");
    await saveCheckpoint("seed", createState());
    writeFileSync(
      checkpointFile,
      JSON.stringify({ ...createState(), sessionId: "legacy", schemaVersion: undefined }, null, 2),
    );
    assert.equal(await loadCheckpoint("legacy"), null);
  });
});

test("assertStepTransition allows queued to running", () => {
  assert.doesNotThrow(() => assertStepTransition("queued", "running"));
});

test("assertStepTransition allows queued to skipped", () => {
  assert.doesNotThrow(() => assertStepTransition("queued", "skipped"));
});

test("assertStepTransition allows running to success", () => {
  assert.doesNotThrow(() => assertStepTransition("running", "success"));
});

test("assertStepTransition allows running to failed", () => {
  assert.doesNotThrow(() => assertStepTransition("running", "failed"));
});

test("assertStepTransition rejects queued to success", () => {
  assert.throws(() => assertStepTransition("queued", "success"), /Invalid step status transition: "queued"/);
});

test("assertStepTransition rejects success to running", () => {
  assert.throws(() => assertStepTransition("success", "running"), /Invalid step status transition: "success"/);
});

test("assertStepTransition includes step name in error", () => {
  assert.throws(() => assertStepTransition("success", "failed", "generate"), /for step "generate"/);
});

test("assertPipelineTransition allows running to approved", () => {
  assert.doesNotThrow(() => assertPipelineTransition("running", "approved"));
});

test("assertPipelineTransition allows running to failed", () => {
  assert.doesNotThrow(() => assertPipelineTransition("running", "failed"));
});

test("assertPipelineTransition allows running to max_rounds", () => {
  assert.doesNotThrow(() => assertPipelineTransition("running", "max_rounds"));
});

test("assertPipelineTransition allows failed to running", () => {
  assert.doesNotThrow(() => assertPipelineTransition("failed", "running"));
});

test("assertPipelineTransition allows awaiting_judge to aborted", () => {
  assert.doesNotThrow(() => assertPipelineTransition("awaiting_judge", "aborted"));
});

test("assertPipelineTransition rejects approved to running", () => {
  assert.throws(() => assertPipelineTransition("approved", "running"), /Invalid pipeline status transition: "approved"/);
});

test("assertPipelineTransition rejects queued to approved", () => {
  assert.throws(() => assertPipelineTransition("queued", "approved"), /Invalid pipeline status transition: "queued"/);
});

test("assertPipelineTransition includes session id in error", () => {
  assert.throws(() => assertPipelineTransition("approved", "failed", "sess-123"), /for session "sess-123"/);
});

test("assertResumeCompatible rejects approved checkpoint", () => {
  const state = createState({ sessionId: "session-done", traceId: "trace-done", approved: true, status: "approved" });
  assert.throws(() => assertResumeCompatible(state, createResumeRequest()), /already approved/);
});

test("assertResumeCompatible rejects awaiting_judge checkpoint", () => {
  const state = createState({ sessionId: "session-awaiting", traceId: "trace-awaiting", status: "awaiting_judge" });
  assert.throws(() => assertResumeCompatible(state, createResumeRequest()), /awaiting judge/);
});
