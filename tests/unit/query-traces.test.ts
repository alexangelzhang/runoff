import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordTrace, type PipelineTrace } from "../../src/observability/trace.ts";
import { buildTraceListPayload } from "../../src/observability/trace-list-format.ts";

let home: string;
let origHome: string | undefined;

function makeTrace(id: string): PipelineTrace {
  return {
    id,
    prompt: "p",
    promptLength: 1,
    mode: "pipeline",
    steps: [],
    totalRounds: 0,
    finalStatus: "approved",
    totalDurationMs: 0,
    hasVerifyResults: false,
    timestamp: new Date().toISOString(),
    lifecycle: "final",
  };
}

test.beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "query-traces-test-"));
  origHome = process.env.RUNOFF_HOME;
  process.env.RUNOFF_HOME = home;
});

test.afterEach(() => {
  if (origHome !== undefined) process.env.RUNOFF_HOME = origHome;
  else delete process.env.RUNOFF_HOME;
  rmSync(home, { recursive: true, force: true });
});

test("buildTraceListPayload legacy omits format wrapper", () => {
  const traces = [makeTrace("t-legacy")];
  recordTrace(traces[0]!);
  const legacy = buildTraceListPayload(traces, "summary", { legacy: true });
  assert.equal(legacy.format, undefined);
  assert.ok(Array.isArray(legacy.traces));
  assert.equal(legacy.count, 1);

  const modern = buildTraceListPayload(traces, "summary", {});
  assert.equal(modern.format, "summary");
});
