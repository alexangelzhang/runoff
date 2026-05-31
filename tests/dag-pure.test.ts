import assert from "node:assert/strict";
import test from "node:test";
import { computePipelineStages } from "../src/orchestration/dag.ts";
import { getDagStages, type PipelineConfig } from "../src/core/config.js";

function assertStagesMatch(
  pipeline: Record<string, [string | string[], ...string[]]>,
  label: string
): void {
  const fromPure = computePipelineStages(pipeline);
  const config = {
    providers: { m: { type: "mock" as const } },
    pipeline,
  } satisfies PipelineConfig;
  const fromConfig = getDagStages(config);
  assert.deepEqual(
    fromPure,
    fromConfig,
    `${label}: computePipelineStages must match getDagStages for the same shape`
  );
}

test("computePipelineStages matches getDagStages — linear chain", () => {
  assertStagesMatch(
    {
      x: ["m"],
      y: ["m", "x"],
      z: ["m", "y"],
    },
    "linear"
  );
});

test("computePipelineStages matches getDagStages — parallel after shared dep", () => {
  assertStagesMatch(
    {
      a: ["m"],
      b: ["m", "a"],
      c: ["m", "a"],
      d: ["m", "b", "c"],
    },
    "parallel"
  );
});

test("computePipelineStages matches getDagStages — race tuple does not affect deps", () => {
  assertStagesMatch(
    {
      r: [["m", "m"], "x"],
      x: ["m"],
    },
    "race tuple"
  );
});

test("computePipelineStages matches getDagStages — empty pipeline", () => {
  assert.deepEqual(computePipelineStages({}), []);
  assert.deepEqual(getDagStages({ providers: { m: { type: "mock" } }, pipeline: {} }), []);
});

test("computePipelineStages throws on circular dependency", () => {
  assert.throws(
    () =>
      computePipelineStages({
        a: ["m", "b"],
        b: ["m", "a"],
      }),
    /Circular dependency detected/
  );
});
