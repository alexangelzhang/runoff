import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PipelineConfig } from "../src/core/config.ts";
import { resetPipelineMemoryRegistry, getPipelineLocalMemory } from "../src/memory/pipeline-memory.ts";
import { PatternCache } from "../src/orchestration/pattern-cache.ts";
import { storeEntityTriplesFromTrace } from "../src/orchestration/trace-entities.ts";
import type { PipelineTrace } from "../src/observability/trace.ts";
import { agentId } from "../src/orchestration/multi-agent-types.ts";
import {
  resolveDreamifyRetrieval,
  setDreamifyRetrievalOverride,
} from "../src/dreamify/dreamify-params.ts";
import { matchPatternEntriesMultiStrategy } from "../src/dreamify/dreamify-multi-retrieve.ts";
import { exportDreamMemoryJsonl } from "../src/dream/dream-export.ts";
import { describeDreamifyStatus } from "../src/dreamify/dreamify-status.ts";

let home: string;
let origHome: string | undefined;

test.beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dream-m4-"));
  origHome = process.env.LLM_PIPELINE_HOME;
  process.env.LLM_PIPELINE_HOME = home;
  resetPipelineMemoryRegistry();
  setDreamifyRetrievalOverride(null);
});

test.afterEach(() => {
  if (origHome !== undefined) process.env.LLM_PIPELINE_HOME = origHome;
  else delete process.env.LLM_PIPELINE_HOME;
  setDreamifyRetrievalOverride(null);
  rmSync(home, { recursive: true, force: true });
});

test("resolveDreamifyRetrieval merges multiStrategy from config", () => {
  const config: PipelineConfig = {
    providers: { m: { type: "mock" } },
    pipeline: { s: ["m"] },
    orchestration: { mode: "dag", dreamify: { multiStrategy: true } },
  };
  const r = resolveDreamifyRetrieval(config);
  assert.equal(r.multiStrategy, true);
});

test("entity triple stores validAt and recordedAt", () => {
  const mem = getPipelineLocalMemory();
  const trace: PipelineTrace = {
    id: "t-m4-entity",
    prompt: "touch src/foo.ts",
    promptLength: 10,
    mode: "pipeline",
    steps: [
      {
        name: "draft",
        provider: "mock",
        durationMs: 1,
        round: 1,
        filesModified: ["src/foo.ts"],
        verdict: "approved",
      },
    ],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 1,
    hasVerifyResults: false,
    timestamp: "2026-05-20T08:00:00.000Z",
  };
  storeEntityTriplesFromTrace(mem, trace);
  const entries = mem.retrieve({
    scope: { project: "default" },
    textSearch: "src/foo.ts",
    limit: 5,
  });
  assert.ok(entries.some((e) => e.metadata?.validAt === trace.timestamp));
  assert.ok(entries.some((e) => typeof e.metadata?.recordedAt === "string"));
});

test("exportDreamMemoryJsonl writes schema rows", () => {
  const mem = getPipelineLocalMemory();
  mem.store({
    agentId: agentId("dream-rules"),
    scope: { project: "default" },
    category: "lesson",
    content: "export me",
    metadata: { evidenceTraceId: "t1" },
  });
  const { path, rowCount } = exportDreamMemoryJsonl(mem, { scope: { project: "default" } });
  assert.ok(rowCount >= 1);
  const line = readFileSync(path, "utf8").trim().split("\n")[0]!;
  const row = JSON.parse(line) as { schema: string; category: string };
  assert.equal(row.schema, "llm-pipeline-dream-export-v1");
  assert.equal(row.category, "lesson");
});

test("describeDreamifyStatus includes active params", () => {
  const config: PipelineConfig = {
    providers: { m: { type: "mock" } },
    pipeline: { s: ["m"] },
    orchestration: { mode: "dag", dreamify: { experimentId: "exp-x", multiStrategy: true } },
  };
  setDreamifyRetrievalOverride({
    minSemanticSimilarity: 0.4,
    patternLimit: 4,
    decayHalfLifeMs: 604800000,
    fileLinkMinOverlap: 2,
    multiStrategy: true,
  });
  const status = describeDreamifyStatus(config);
  assert.equal(status.active.patternLimit, 4);
  assert.equal(status.active.multiStrategy, true);
  assert.equal(status.config.experimentId, "exp-x");
});

test("multiStrategy match returns entries for stored pattern", () => {
  const mem = getPipelineLocalMemory();
  const prompt = "refactor src/bar.ts module";
  const trace: PipelineTrace = {
    id: "t-ms",
    prompt,
    promptLength: prompt.length,
    mode: "pipeline",
    steps: [
      {
        name: "draft",
        provider: "mock",
        durationMs: 1,
        round: 1,
        filesModified: ["src/bar.ts"],
      },
    ],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 1,
    hasVerifyResults: false,
    timestamp: "2026-05-28T16:00:00.000Z",
  };
  new PatternCache(mem).storeFromTrace(trace);
  const hits = matchPatternEntriesMultiStrategy(mem, { project: "default" }, prompt, {
    minSemanticSimilarity: 0.2,
    patternLimit: 3,
    decayHalfLifeMs: 7 * 24 * 60 * 60 * 1000,
    fileLinkMinOverlap: 1,
    multiStrategy: true,
  });
  assert.ok(hits.length >= 1);
});
