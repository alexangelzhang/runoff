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
