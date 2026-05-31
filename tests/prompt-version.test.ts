import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executePipelineStep } from "../src/orchestration/step-execution.ts";
import type { PipelineConfig } from "../src/core/config.ts";
import {
  isPromptVersionStoreEnabled,
  latestPromptVersion,
  queryPromptVersions,
  readPromptVersionsForTrace,
  replayPromptVersion,
  recordPromptVersion,
} from "../src/observability/prompt-version.ts";
import { buildGeneratePrompt, renderPrompt } from "../src/pipeline/prompt.ts";

let versionsDir: string;

test.beforeEach(() => {
  versionsDir = mkdtempSync(join(tmpdir(), "prompt-versions-"));
  process.env.LLM_PROMPT_VERSIONS_DIR = versionsDir;
});

test.afterEach(() => {
  delete process.env.LLM_PROMPT_VERSIONS_DIR;
  rmSync(versionsDir, { recursive: true, force: true });
});

test("recordPromptVersion + replayPromptVersion round-trip", () => {
  const structured = buildGeneratePrompt({ spec: "add logging", round: 1 });
  const rendered = renderPrompt(structured);
  const record = recordPromptVersion({
    traceId: "trace-a",
    stepName: "generate",
    round: 1,
    structured,
    rendered,
  });

  assert.equal(record.traceId, "trace-a");
  assert.equal(record.stepName, "generate");
  assert.equal(readPromptVersionsForTrace("trace-a").length, 1);

  const replayed = replayPromptVersion(record.id, "trace-a");
  assert.ok(replayed);
  assert.equal(replayed!.rendered, rendered);
  assert.equal(replayed!.structured.system, structured.system);
});

test("queryPromptVersions filters by step and round", () => {
  const structured = buildGeneratePrompt({ spec: "x", round: 1 });
  recordPromptVersion({ traceId: "t2", stepName: "gen", round: 1, structured });
  recordPromptVersion({ traceId: "t2", stepName: "review", round: 1, structured });
  recordPromptVersion({ traceId: "t2", stepName: "gen", round: 2, structured });

  assert.equal(queryPromptVersions({ traceId: "t2", stepName: "gen" }).length, 2);
  assert.equal(queryPromptVersions({ traceId: "t2", round: 2 }).length, 1);
  assert.ok(latestPromptVersion({ traceId: "t2", stepName: "gen", round: 2 }));
});

test("isPromptVersionStoreEnabled respects env and config flag", () => {
  assert.equal(isPromptVersionStoreEnabled(), true);
  assert.equal(isPromptVersionStoreEnabled(false), false);
  process.env.LLM_PROMPT_VERSIONS = "0";
  assert.equal(isPromptVersionStoreEnabled(), false);
  delete process.env.LLM_PROMPT_VERSIONS;
});

test("executePipelineStep stores promptVersionId on StepTrace", async () => {
  const config: PipelineConfig = {
    providers: { mock: { type: "mock", mode: "text" } },
    pipeline: { generate: ["mock"] },
    runtime: { promptVersionStore: true },
  };
  const outcome = await executePipelineStep(config, "generate", {
    prompt: "implement feature X",
    sessionId: "sched-trace-1",
    round: 1,
    globalKnowledge: {},
    candidate: { code: "", changes: "", filesModified: [] },
    promptVersionStore: true,
  });

  assert.ok(outcome.trace.promptVersionId);
  const versions = queryPromptVersions({
    traceId: "sched-trace-1",
    stepName: "generate",
    round: 1,
    id: outcome.trace.promptVersionId,
  });
  assert.equal(versions.length, 1);
  assert.ok(versions[0]!.rendered.includes("implement feature X"));
});
