import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createControlPlane } from "../../src/orchestration/control-plane.ts";
import { agentId } from "../../src/orchestration/multi-agent-types.ts";
import { syncRunStoreFromPipeline } from "../../src/orchestration/run-control.ts";
import { runsList, runsShow } from "../../src/pipeline/run-control-cli.ts";
import type { PipelineConfig } from "../../src/core/config.ts";

const config: PipelineConfig = {
  providers: { mock: { type: "mock" } },
  pipeline: { implement: ["mock"] },
  runtime: { controlPlane: "file" },
};

function captureStdout(fn: () => void): string {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

test("runsList and runsShow format durable control-plane runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-control-cli-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    const configPath = join(dir, "pipeline.config.json");
    writeFileSync(configPath, JSON.stringify(config), "utf-8");
    const controlPlane = createControlPlane(config);
    syncRunStoreFromPipeline(controlPlane.runStore, {
      runId: "trace-one",
      sessionId: "session-one",
      round: 2,
      pipelineStatus: "awaiting_judge",
      resumeToken: "session-one",
    });
    controlPlane.eventLog.append("trace-one", { type: "step_started", agentId: agentId("agent-a"), stepId: "implement" });

    const list = captureStdout(() => runsList({ configPath }));
    assert.match(list, /trace-one/);
    assert.match(list, /pipeline=awaiting_judge/);
    assert.match(list, /next=approve_or_reject/);

    const show = captureStdout(() => runsShow({ configPath, runId: "trace-one" }));
    assert.match(show, /nextHint:\s+Choose a race winner/);
    assert.match(show, /eventCursor:\s+1/);
  } finally {
    if (oldHome !== undefined) process.env.RUNOFF_HOME = oldHome;
    else delete process.env.RUNOFF_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runsList includes compact resume mark when resumePlanner present", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-control-cli-list-resume-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    const configPath = join(dir, "pipeline.config.json");
    writeFileSync(configPath, JSON.stringify(config), "utf-8");
    const controlPlane = createControlPlane(config);
    syncRunStoreFromPipeline(controlPlane.runStore, {
      runId: "trace-resume-list",
      sessionId: "session-resume-list",
      round: 1,
      pipelineStatus: "running",
      resumeToken: "session-resume-list",
      resumeReusePlan: {
        round: 1,
        entries: [
          {
            stepName: "generate",
            decision: "rerun",
            reason: "artifact completeness is partial",
            round: 1,
            evidenceRefs: [],
          },
        ],
        summary: { skipped: 1, rerun: 1 },
        evidenceRefs: [],
      },
    });

    const list = captureStdout(() => runsList({ configPath }));
    assert.match(list, /resume=rerun:1,skipped:1/);
  } finally {
    if (oldHome !== undefined) process.env.RUNOFF_HOME = oldHome;
    else delete process.env.RUNOFF_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runsShow non-JSON output includes resumePlanner when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-control-cli-resume-"));
  const oldHome = process.env.RUNOFF_HOME;
  try {
    process.env.RUNOFF_HOME = join(dir, "home");
    const configPath = join(dir, "pipeline.config.json");
    writeFileSync(configPath, JSON.stringify(config), "utf-8");
    const controlPlane = createControlPlane(config);
    syncRunStoreFromPipeline(controlPlane.runStore, {
      runId: "trace-resume",
      sessionId: "session-resume",
      round: 1,
      pipelineStatus: "running",
      resumeToken: "session-resume",
      resumeReusePlan: {
        round: 1,
        entries: [
          {
            stepName: "generate",
            decision: "rerun",
            reason: "artifact completeness is partial",
            round: 1,
            evidenceRefs: ["stepResults.generate.resumeMetadata"],
          },
          {
            stepName: "validate",
            decision: "rerun",
            reason: "downstream dependency generate must rerun on resume",
            downstreamOf: "generate",
            round: 1,
            evidenceRefs: ["stepResults.validate.resumeMetadata"],
          },
          {
            stepName: "format",
            decision: "skipped",
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
      },
    });

    const show = captureStdout(() => runsShow({ configPath, runId: "trace-resume" }));
    assert.match(show, /resumePlanner:/);
    assert.match(show, /round:\s+1/);
    assert.match(show, /rerun:\s+2/);
    assert.match(show, /skipped:\s+1/);
    assert.match(show, /rerunSteps:/);
    assert.match(show, /- generate: artifact completeness is partial$/m);
    assert.match(
      show,
      /- validate: downstream dependency generate must rerun on resume \(downstreamOf=generate\)$/m,
    );
    assert.match(show, /skippedDetails: hidden; use --json for audit\/debug/);
    assert.doesNotMatch(show, /resume metadata allows skip/);
  } finally {
    if (oldHome !== undefined) process.env.RUNOFF_HOME = oldHome;
    else delete process.env.RUNOFF_HOME;
    rmSync(dir, { recursive: true, force: true });
  }
});
