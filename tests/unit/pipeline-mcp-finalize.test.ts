import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PipelineConfig } from "../../src/core/config.ts";
import { finalizePipelineRunResult } from "../../src/orchestration/pipeline-mcp-finalize.ts";
import { PipelineHooks } from "../../src/pipeline/pipeline-hooks.ts";
import { CostTracker } from "../../src/routing/pricing.ts";

test("finalizePipelineRunResult returns pipeline-level observation", async () => {
  const previousHome = process.env.RUNOFF_HOME;
  const home = mkdtempSync(join(tmpdir(), "runoff-finalize-"));
  process.env.RUNOFF_HOME = home;

  try {
    const config: PipelineConfig = {
      providers: { mock: { type: "mock" } },
      pipeline: { implement: ["mock"] },
      retry: { maxRounds: 1, reviewStep: "review" },
    };

    const result = await finalizePipelineRunResult({
      traceId: "trace-finalize",
      sessionId: "session-finalize",
      prompt: "implement feature",
      stepTraces: [{ name: "implement", provider: "mock", durationMs: 1, round: 1 }],
      completedRounds: 1,
      finalStatus: "approved",
      startTime: Date.now() - 10,
      costTracker: new CostTracker(),
      stepResults: {
        implement: {
          status: "success",
          round: 1,
          summary: "implemented feature",
        },
      },
      globalKnowledge: {},
      runtimeConfig: config,
      controlPlaneMode: "memory",
      hooks: new PipelineHooks(config, "trace-finalize", "session-finalize"),
    });

    assert.equal(result.observation?.schemaVersion, 1);
    assert.equal(result.observation?.status, "approved");
    assert.equal(result.observation?.traceRef.traceId, "trace-finalize");
    assert.deepEqual(result.observation?.checkpointRef, { sessionId: "session-finalize", status: "approved" });
    assert.equal(result.observation?.stepRefs[0]?.stepName, "implement");
    assert.equal(result.observation?.stepRefs[0]?.summary, "implemented feature");
  } finally {
    if (previousHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
