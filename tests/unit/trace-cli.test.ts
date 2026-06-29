import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recordTrace, type PipelineTrace } from "../../src/observability/trace.ts";
import { tracesShow } from "../../src/pipeline/trace-cli.ts";
import {
  formatResumePlannerRunShowSection,
  formatResumePlannerTraceShowSection,
} from "../../src/pipeline/resume-planner-format.ts";

function captureStdout(fn: () => void): string {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.join(" "));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

const sampleResumePlan = {
  schemaVersion: 1 as const,
  round: 1,
  entries: [
    {
      stepName: "generate",
      decision: "rerun" as const,
      reason: "artifact completeness is partial",
      round: 1,
      evidenceRefs: ["stepResults.generate.resumeMetadata"],
    },
    {
      stepName: "validate",
      decision: "rerun" as const,
      reason: "downstream dependency generate must rerun on resume",
      downstreamOf: "generate",
      round: 1,
      evidenceRefs: ["stepResults.validate.resumeMetadata"],
    },
    {
      stepName: "format",
      decision: "skipped" as const,
      reason: "resume metadata allows skip",
      round: 1,
      evidenceRefs: ["stepResults.format.resumeMetadata"],
    },
  ],
  summary: { skipped: 1, rerun: 2 },
  evidenceRefs: [
    "stepResults.generate.resumeMetadata",
    "stepResults.validate.resumeMetadata",
    "stepResults.format.resumeMetadata",
  ],
};

test("formatResumePlannerTraceShowSection matches trace CLI layout", () => {
  const lines = formatResumePlannerTraceShowSection(sampleResumePlan);
  const text = lines.join("\n");
  assert.match(text, /resumePlanner:/);
  assert.match(text, /rerun=2 skipped=1/);
  assert.match(text, /- generate: artifact completeness is partial$/m);
  assert.match(
    text,
    /- validate: downstream dependency generate must rerun on resume \(downstreamOf=generate\)$/m,
  );
  assert.match(text, /skipped hidden; use --json for audit/);
  assert.doesNotMatch(text, /resume metadata allows skip/);
});

test("formatResumePlannerRunShowSection keeps runs show layout", () => {
  const lines = formatResumePlannerRunShowSection({
    round: 1,
    rerun: 2,
    skipped: 1,
    rerunSteps: [
      { stepName: "generate", reason: "artifact completeness is partial" },
      {
        stepName: "validate",
        reason: "downstream dependency generate must rerun on resume",
        downstreamOf: "generate",
      },
    ],
    skippedHidden: 1,
  });
  const text = lines.join("\n");
  assert.match(text, /round:\s+1/);
  assert.match(text, /rerunSteps:/);
  assert.match(text, /skippedDetails: hidden/);
});

test("tracesShow non-JSON output includes resumePlanner when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-resume-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = dir;
    const trace: PipelineTrace = {
      id: "trace-resume-cli",
      sessionId: "session-resume",
      prompt: "resume test",
      promptLength: 11,
      mode: "pipeline",
      steps: [{ name: "generate", provider: "mock", durationMs: 10, round: 1 }],
      totalRounds: 1,
      finalStatus: "approved",
      totalDurationMs: 10,
      hasVerifyResults: false,
      timestamp: "2026-06-27T12:00:00.000Z",
      resumeReusePlan: sampleResumePlan,
    };
    recordTrace(trace);

    const show = captureStdout(() => tracesShow("trace-resume-cli", {}));
    assert.match(show, /trace=trace-resume-cli/);
    assert.match(show, /resumePlanner:/);
    assert.match(show, /rerun=2 skipped=1/);
    assert.match(show, /- generate: artifact completeness is partial$/m);
    assert.match(show, /skipped hidden; use --json for audit/);
    assert.doesNotMatch(show, /resume metadata allows skip/);

    const json = captureStdout(() => tracesShow("trace-resume-cli", { json: true }));
    assert.match(json, /"resumeReusePlan"/);
  } finally {
    if (oldHome !== undefined) process.env.RUNOFF_HOME = oldHome;
    else delete process.env.RUNOFF_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tracesShow omits resumePlanner when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-cli-plain-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = dir;
    recordTrace({
      id: "trace-plain",
      prompt: "plain",
      promptLength: 5,
      mode: "pipeline",
      steps: [],
      totalRounds: 1,
      finalStatus: "approved",
      totalDurationMs: 1,
      hasVerifyResults: false,
      timestamp: "2026-06-27T12:00:00.000Z",
    });

    const show = captureStdout(() => tracesShow("trace-plain", {}));
    assert.doesNotMatch(show, /resumePlanner:/);
  } finally {
    if (oldHome !== undefined) process.env.RUNOFF_HOME = oldHome;
    else delete process.env.RUNOFF_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});
