import assert from "node:assert/strict";
import test from "node:test";
import type { PipelineConfig } from "../src/core/config.ts";
import {
  describeMemoryBackend,
  queryPipelineMemoryMerged,
} from "../src/memory/memory-backend-status.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentId } from "../src/orchestration/multi-agent-types.ts";

let memDir: string;
let origHome: string | undefined;

test.beforeEach(() => {
  memDir = mkdtempSync(join(tmpdir(), "mem-status-"));
  origHome = process.env.LLM_PIPELINE_HOME;
  process.env.LLM_PIPELINE_HOME = memDir;
});

test.afterEach(() => {
  if (origHome !== undefined) process.env.LLM_PIPELINE_HOME = origHome;
  else delete process.env.LLM_PIPELINE_HOME;
  rmSync(memDir, { recursive: true, force: true });
});

const baseConfig: PipelineConfig = {
  providers: { m: { type: "mock" } },
  pipeline: { s: ["m"] },
};

test("describeMemoryBackend local defaults", () => {
  const s = describeMemoryBackend(baseConfig);
  assert.equal(s.effectiveType, "local");
  assert.equal(s.layered, false);
  assert.equal(s.readPath, "local-sync");
});

test("describeMemoryBackend zep binds pipeline sessionId", () => {
  const config: PipelineConfig = {
    ...baseConfig,
    orchestration: {
      mode: "dag",
      memoryBackend: { type: "zep", apiKey: "z-key", userId: "u1" },
    },
  };
  const s = describeMemoryBackend(config, { pipelineSessionId: "run-abc" });
  assert.equal(s.effectiveType, "zep");
  assert.equal(s.sessionId, "run-abc");
  assert.equal(s.layered, true);
});

test("queryPipelineMemoryMerged returns local entries", async () => {
  const config: PipelineConfig = { ...baseConfig };
  const mem = await import("../src/orchestration/memory-factory.ts");
  const store = mem.createPipelineMemory(config);
  store.store({
    agentId: agentId("test"),
    scope: { project: "p1" },
    category: "lesson",
    content: "always validate IPC schema",
  });

  const { entries, layered } = await queryPipelineMemoryMerged(config, {
    semanticQuery: "IPC schema",
    limit: 5,
  });
  assert.equal(layered, false);
  assert.ok(entries.length >= 1);
  assert.match(entries[0]!.content, /IPC/);
});
