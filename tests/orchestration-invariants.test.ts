/**
 * Pure DAG staging (orchestration/dag) must stay aligned with config.getDagStages
 * for the same pipeline shape — including the loadConfig + cache path.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { PipelineConfig } from "../src/config.js";
import { computePipelineStages } from "../src/orchestration/dag.ts";

async function withDag(
  t: TestContext,
  fn: (compute: typeof computePipelineStages) => void | Promise<void>
) {
  await fn(computePipelineStages);
}

test("computePipelineStages matches getDagStages for the same pipeline (fresh config, no cache identity)", async (t) => {
  await withDag(t, async (computePipelineStages) => {
    const { getDagStages } = await import("../src/config.ts");
    const config = {
      providers: { m: { type: "mock" as const } },
      pipeline: {
        x: ["m"],
        y: ["m", "x"],
        z: ["m", "y"],
      },
    } satisfies PipelineConfig;
    assert.deepEqual(computePipelineStages(config.pipeline), getDagStages(config));
  });
});

test("after clearConfigCache + loadConfig, getDagStages matches compute on config.pipeline", async (t) => {
  await withDag(t, async (computePipelineStages) => {
    const { loadConfig, getDagStages, clearConfigCache } = await import("../src/config.ts");
    clearConfigCache();
    const config = loadConfig();
    const fromPure = computePipelineStages(config.pipeline);
    const fromGetter = getDagStages(config);
    assert.deepEqual(fromPure, fromGetter);
    assert.equal(fromPure.length, fromGetter.length);
  });
});

try {
  const phaseBHref = pathToFileURL(join(import.meta.dirname, "orchestration-phase-b-invariants.ts")).href;
  const phaseB: Record<string, unknown> = await import(phaseBHref);
  const reg = phaseB.registerOrchestrationPhaseBInvariants;
  if (typeof reg === "function") {
    (reg as (t: typeof test, a: typeof assert, c: typeof computePipelineStages) => void)(
      test,
      assert,
      computePipelineStages
    );
  }
} catch {
  /* optional Phase B hook module not present */
}
