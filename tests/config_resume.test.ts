import { test } from "node:test";
import assert from "node:assert";
import { calculateConfigHash, type PipelineConfig } from "../src/config.js";
import {
  assertResumeCompatible,
  CHECKPOINT_SCHEMA_VERSION,
  type PipelineState,
  type ResumeRequest,
} from "../src/state.js";

test("Checkpoint Resume - P1: Config Checksum Validation", async (t) => {
  const config1: PipelineConfig = {
    providers: { "llm": { type: "openai", model: "gpt-4o" } },
    pipeline: { "review": ["llm"] },
    retry: { maxRounds: 1 }
  };

  const config2: PipelineConfig = {
    providers: { "llm": { type: "anthropic", model: "claude-3" } }, // Changed provider type
    pipeline: { "review": ["llm"] },
    retry: { maxRounds: 1 }
  };

  const hash1 = calculateConfigHash(config1);
  const hash2 = calculateConfigHash(config2);

  assert.notStrictEqual(hash1, hash2, "Hashes should differ for different configs");

  const mockState: PipelineState = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    sessionId: "s1",
    prompt: "test",
    round: 1,
    maxRounds: 1,
    lastCode: "",
    lastReviewFeedback: "",
    approved: false,
    stepResults: {},
    stepTraces: [],
    traceId: "t1",
    timestamp: new Date().toISOString(),
    status: "running",
    resume: {
      mode: "pipeline",
      promptHash: "p1",
      contextHash: "c1",
      language: "typescript",
      workDir: "/tmp",
      acceptanceCriteriaHash: "h1",
      verifyResultsHash: "v1",
      configHash: hash1 // Built with hash1
    }
  };

  const resumeRequest: ResumeRequest = {
    mode: "pipeline",
    prompt: "test",
    language: "typescript",
    context: "",
    workDir: "/tmp",
    acceptanceCriteria: [],
    verifyResults: "",
    configHash: hash2 // Attempt to resume with hash2
  };

  await t.test("Should fail resume if config hash mismatch", () => {
    assert.throws(
      () => assertResumeCompatible(mockState, resumeRequest),
      /pipelineConfig/,
      "Expect configHash mismatch error"
    );
  });
});
