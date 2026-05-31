import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig } from "../src/core/config.ts";
import { createPipelineMemory, resolveMemoryBackendConfig } from "../src/orchestration/memory-factory.ts";
import { LayeredAgentMemory } from "../src/orchestration/http-memory-client.ts";
import { agentId } from "../src/orchestration/multi-agent-types.ts";

let memDir: string;
let origHome: string | undefined;

test.beforeEach(() => {
  memDir = mkdtempSync(join(tmpdir(), "mem-factory-"));
  origHome = process.env.LLM_PIPELINE_HOME;
  process.env.LLM_PIPELINE_HOME = memDir;
});

test.afterEach(() => {
  if (origHome !== undefined) process.env.LLM_PIPELINE_HOME = origHome;
  else delete process.env.LLM_PIPELINE_HOME;
  rmSync(memDir, { recursive: true, force: true });
});

test("resolveMemoryBackendConfig defaults to local", () => {
  const config: PipelineConfig = {
    providers: { m: { type: "mock" } },
    pipeline: { s: ["m"] },
  };
  assert.equal(resolveMemoryBackendConfig(config).type, "local");
});

test("resolveMemoryBackendConfig mem0 platform", () => {
  const config: PipelineConfig = {
    providers: { m: { type: "mock" } },
    pipeline: { s: ["m"] },
    orchestration: {
      mode: "dag",
      memoryBackend: { type: "mem0", apiKey: "tok", userId: "u1" },
    },
  };
  const mb = resolveMemoryBackendConfig(config);
  assert.equal(mb.type, "mem0");
  if (mb.type === "mem0") {
    assert.match(mb.baseUrl, /mem0/);
    assert.equal(mb.apiKey, "tok");
  }
});

test("resolveMemoryBackendConfig zep uses pipelineSessionId fallback", () => {
  const config: PipelineConfig = {
    providers: { m: { type: "mock" } },
    pipeline: { s: ["m"] },
    orchestration: { mode: "dag", memoryBackend: { type: "zep", apiKey: "z" } },
  };
  const mb = resolveMemoryBackendConfig(config, { pipelineSessionId: "sess-1" });
  assert.equal(mb.type, "zep");
  if (mb.type === "zep") assert.equal(mb.sessionId, "sess-1");
});

test("resolveMemoryBackendConfig zep requires apiKey", () => {
  const withKey: PipelineConfig = {
    providers: { m: { type: "mock" } },
    pipeline: { s: ["m"] },
    orchestration: { mode: "dag", memoryBackend: { type: "zep", apiKey: "z" } },
  };
  assert.equal(resolveMemoryBackendConfig(withKey).type, "zep");
  const noKey: PipelineConfig = {
    providers: { m: { type: "mock" } },
    pipeline: { s: ["m"] },
    orchestration: { mode: "dag", memoryBackend: { type: "zep" } },
  };
  assert.equal(resolveMemoryBackendConfig(noKey).type, "local");
});

test("createPipelineMemory http uses LayeredAgentMemory when URL set", () => {
  const config: PipelineConfig = {
    providers: { m: { type: "mock" } },
    pipeline: { s: ["m"] },
    orchestration: {
      mode: "dag",
      memoryBackend: { type: "http", baseUrl: "http://127.0.0.1:19999" },
    },
  };
  const mem = createPipelineMemory(config);
  assert.equal(mem instanceof LayeredAgentMemory, true);
  mem.store({
    agentId: agentId("test"),
    scope: { project: "p" },
    category: "pattern",
    content: "hello",
  });
  assert.equal(mem.size, 1);
});
