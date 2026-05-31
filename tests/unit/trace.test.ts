import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTraceId,
  recordTrace,
  updateTrace,
  listTraces,
  queryTraces,
  aggregateTraceStats,
} from "../../src/observability/trace.ts";
import type { PipelineTrace } from "../../src/observability/trace.ts";

function makeTmpTracesDir(): string {
  const dir = join(import.meta.dirname!, ".tmp-traces-" + Math.random().toString(36).slice(2, 8));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTrace(overrides: Partial<PipelineTrace> = {}): PipelineTrace {
  return {
    id: createTraceId(),
    prompt: "test prompt",
    promptLength: 11,
    mode: "pipeline",
    steps: [],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 1000,
    hasVerifyResults: false,
    timestamp: "2026-03-28T12:00:00.000Z",
    ...overrides,
  };
}

// --- createTraceId ---

test("createTraceId returns 8-char hex string", () => {
  const id = createTraceId();
  assert.equal(id.length, 8);
  assert.match(id, /^[0-9a-f]{8}$/);
});

test("createTraceId returns unique values", () => {
  const ids = new Set(Array.from({ length: 20 }, () => createTraceId()));
  assert.equal(ids.size, 20);
});

// --- recordTrace ---

test("recordTrace writes JSON file to traces dir", () => {
  const dir = makeTmpTracesDir();
  const origEnv = process.env.LLM_PIPELINE_HOME;
  // getTracesDir uses getPipelineHomeDir() + "/traces"
  // We set LLM_PIPELINE_HOME so getTracesDir returns dir's parent + "/traces"
  const parentDir = join(dir, "..");
  process.env.LLM_PIPELINE_HOME = parentDir;
  // Ensure the traces subdir exists
  const tracesDir = join(parentDir, "traces");
  mkdirSync(tracesDir, { recursive: true });

  try {
    const trace = makeTrace({ id: "abcd1234", timestamp: "2026-03-28T12:00:00.000Z" });
    recordTrace(trace);

    const files = readdirSync(tracesDir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);
    assert.match(files[0], /2026-03-28_abcd1234\.json/);

    const content = JSON.parse(readFileSync(join(tracesDir, files[0]), "utf-8"));
    assert.equal(content.id, "abcd1234");
    assert.equal(content.finalStatus, "approved");
  } finally {
    if (origEnv === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = origEnv;
    rmSync(tracesDir, { recursive: true, force: true });
  }
});

test("updateTrace selects file by _traceId.json suffix (not substring of another id)", () => {
  const dir = makeTmpTracesDir();
  const tracesDir = join(dir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const origEnv = process.env.LLM_PIPELINE_HOME;
  process.env.LLM_PIPELINE_HOME = dir;

  try {
    const inner = "ab12cd34";
    const outer = `xx${inner}yy`;
    recordTrace(makeTrace({ id: outer, timestamp: "2026-03-28T10:00:00.000Z", finalStatus: "approved" }));
    recordTrace(makeTrace({ id: inner, timestamp: "2026-03-28T11:00:00.000Z", finalStatus: "approved" }));

    const ok = updateTrace(inner, { finalStatus: "failed" });
    assert.equal(ok, true);

    const outerPath = join(tracesDir, `2026-03-28_${outer}.json`);
    const innerPath = join(tracesDir, `2026-03-28_${inner}.json`);
    const outerContent = JSON.parse(readFileSync(outerPath, "utf-8"));
    const innerContent = JSON.parse(readFileSync(innerPath, "utf-8"));
    assert.equal(outerContent.finalStatus, "approved");
    assert.equal(innerContent.finalStatus, "failed");
  } finally {
    if (origEnv === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = origEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- listTraces ---

test("listTraces reads all trace files from directory", () => {
  const dir = makeTmpTracesDir();
  const tracesDir = join(dir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const origEnv = process.env.LLM_PIPELINE_HOME;
  process.env.LLM_PIPELINE_HOME = dir;

  try {
    const t1 = makeTrace({ id: "aaaa1111", timestamp: "2026-03-27T10:00:00.000Z", finalStatus: "approved" });
    const t2 = makeTrace({ id: "bbbb2222", timestamp: "2026-03-28T10:00:00.000Z", finalStatus: "failed" });
    recordTrace(t1);
    recordTrace(t2);

    const traces = listTraces();
    assert.equal(traces.length, 2);
    const ids = traces.map((t) => t.id).sort();
    assert.deepEqual(ids, ["aaaa1111", "bbbb2222"]);
  } finally {
    if (origEnv === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = origEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listTraces returns empty array when no traces dir", () => {
  const origEnv = process.env.LLM_PIPELINE_HOME;
  process.env.LLM_PIPELINE_HOME = "/tmp/nonexistent-" + Math.random().toString(36).slice(2);
  try {
    const traces = listTraces();
    assert.deepEqual(traces, []);
  } finally {
    if (origEnv === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = origEnv;
  }
});

// --- queryTraces ---

test("queryTraces filters by status", () => {
  const dir = makeTmpTracesDir();
  const tracesDir = join(dir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const origEnv = process.env.LLM_PIPELINE_HOME;
  process.env.LLM_PIPELINE_HOME = dir;

  try {
    recordTrace(makeTrace({ id: "aa000001", finalStatus: "approved", timestamp: "2026-03-28T10:00:00.000Z" }));
    recordTrace(makeTrace({ id: "bb000002", finalStatus: "failed", timestamp: "2026-03-28T11:00:00.000Z" }));
    recordTrace(makeTrace({ id: "cc000003", finalStatus: "max_rounds", timestamp: "2026-03-28T12:00:00.000Z" }));

    const approved = queryTraces({ status: "approved" });
    assert.equal(approved.length, 1);
    assert.equal(approved[0].id, "aa000001");

    const failed = queryTraces({ status: "failed" });
    assert.equal(failed.length, 1);
    assert.equal(failed[0].id, "bb000002");
  } finally {
    if (origEnv === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = origEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryTraces filters by mode", () => {
  const dir = makeTmpTracesDir();
  const tracesDir = join(dir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const origEnv = process.env.LLM_PIPELINE_HOME;
  process.env.LLM_PIPELINE_HOME = dir;

  try {
    recordTrace(makeTrace({ id: "pp000001", mode: "pipeline", timestamp: "2026-03-28T10:00:00.000Z" }));
    recordTrace(makeTrace({ id: "rr000002", mode: "race", timestamp: "2026-03-28T11:00:00.000Z" }));

    const pipelines = queryTraces({ mode: "pipeline" });
    assert.equal(pipelines.length, 1);
    assert.equal(pipelines[0].mode, "pipeline");

    const races = queryTraces({ mode: "race" });
    assert.equal(races.length, 1);
    assert.equal(races[0].mode, "race");
  } finally {
    if (origEnv === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = origEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryTraces respects limit", () => {
  const dir = makeTmpTracesDir();
  const tracesDir = join(dir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const origEnv = process.env.LLM_PIPELINE_HOME;
  process.env.LLM_PIPELINE_HOME = dir;

  try {
    for (let i = 0; i < 5; i++) {
      recordTrace(makeTrace({ id: `lim${String(i).padStart(5, "0")}`, timestamp: `2026-03-28T1${i}:00:00.000Z` }));
    }
    const limited = queryTraces({ limit: 2 });
    assert.equal(limited.length, 2);
  } finally {
    if (origEnv === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = origEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("queryTraces filters by since/until date range", () => {
  const dir = makeTmpTracesDir();
  const tracesDir = join(dir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const origEnv = process.env.LLM_PIPELINE_HOME;
  process.env.LLM_PIPELINE_HOME = dir;

  try {
    recordTrace(makeTrace({ id: "dt000001", timestamp: "2026-03-26T10:00:00.000Z" }));
    recordTrace(makeTrace({ id: "dt000002", timestamp: "2026-03-27T10:00:00.000Z" }));
    recordTrace(makeTrace({ id: "dt000003", timestamp: "2026-03-28T10:00:00.000Z" }));

    const sinceOnly = queryTraces({ since: "2026-03-27T00:00:00.000Z" });
    assert.equal(sinceOnly.length, 2);

    const untilOnly = queryTraces({ until: "2026-03-27T23:59:59.999Z" });
    assert.equal(untilOnly.length, 2);

    const range = queryTraces({ since: "2026-03-27T00:00:00.000Z", until: "2026-03-27T23:59:59.999Z" });
    assert.equal(range.length, 1);
    assert.equal(range[0].id, "dt000002");
  } finally {
    if (origEnv === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = origEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listTraces skips corrupt JSON files without losing valid traces", () => {
  const dir = makeTmpTracesDir();
  const tracesDir = join(dir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const origEnv = process.env.LLM_PIPELINE_HOME;
  process.env.LLM_PIPELINE_HOME = dir;

  try {
    recordTrace(makeTrace({ id: "ok000001", timestamp: "2026-03-28T10:00:00.000Z" }));
    // Write a corrupt file
    writeFileSync(join(tracesDir, "2026-03-28_corrupt1.json"), "NOT VALID JSON{{{");
    recordTrace(makeTrace({ id: "ok000002", timestamp: "2026-03-28T11:00:00.000Z" }));

    const traces = listTraces();
    assert.equal(traces.length, 2);
    const ids = traces.map((t) => t.id).sort();
    assert.deepEqual(ids, ["ok000001", "ok000002"]);
  } finally {
    if (origEnv === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = origEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- aggregateTraceStats ---

test("aggregateTraceStats computes correct statistics", () => {
  const dir = makeTmpTracesDir();
  const tracesDir = join(dir, "traces");
  mkdirSync(tracesDir, { recursive: true });
  const origEnv = process.env.LLM_PIPELINE_HOME;
  process.env.LLM_PIPELINE_HOME = dir;

  try {
    const recent = new Date().toISOString();
    recordTrace(makeTrace({
      id: "st000001", finalStatus: "approved", totalDurationMs: 1000,
      totalRounds: 1, timestamp: recent,
      steps: [{ name: "generate", provider: "codex", durationMs: 800, round: 1 }],
    }));
    recordTrace(makeTrace({
      id: "st000002", finalStatus: "approved", totalDurationMs: 2000,
      totalRounds: 2, timestamp: recent,
      steps: [
        { name: "generate", provider: "codex", durationMs: 700, round: 1 },
        { name: "generate", provider: "gemini", durationMs: 900, round: 2 },
      ],
    }));
    recordTrace(makeTrace({
      id: "st000003", finalStatus: "failed", totalDurationMs: 500,
      totalRounds: 1, timestamp: recent,
      steps: [{ name: "generate", provider: "codex", durationMs: 500, round: 1 }],
    }));

    const stats = aggregateTraceStats();
    assert.equal(stats.totalTraces, 3);
    assert.equal(stats.approvedCount, 2);
    assert.equal(stats.failedCount, 1);
    assert.ok(Math.abs(stats.approvalRate - 2 / 3) < 0.01);
    assert.ok(Math.abs(stats.avgDurationMs - (1000 + 2000 + 500) / 3) < 1);
    assert.ok(Math.abs(stats.avgRounds - (1 + 2 + 1) / 3) < 0.01);

    // Provider stats
    assert.ok(stats.providerStats["codex"]);
    assert.equal(stats.providerStats["codex"].stepCount, 3);
    assert.ok((stats.providerStats["codex"].durationP50Ms ?? 0) > 0);
    assert.ok(stats.providerStats["gemini"]);
    assert.equal(stats.providerStats["gemini"].stepCount, 1);
  } finally {
    if (origEnv === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = origEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aggregateTraceStats returns zeros for empty traces", () => {
  const origEnv = process.env.LLM_PIPELINE_HOME;
  process.env.LLM_PIPELINE_HOME = "/tmp/nonexistent-" + Math.random().toString(36).slice(2);
  try {
    const stats = aggregateTraceStats();
    assert.equal(stats.totalTraces, 0);
    assert.equal(stats.approvedCount, 0);
    assert.equal(stats.approvalRate, 0);
    assert.equal(stats.avgDurationMs, 0);
    assert.deepEqual(stats.providerStats, {});
  } finally {
    if (origEnv === undefined) delete process.env.LLM_PIPELINE_HOME;
    else process.env.LLM_PIPELINE_HOME = origEnv;
  }
});
