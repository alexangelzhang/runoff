import assert from "node:assert/strict";
import test from "node:test";
import { composeEffectivePipelineContext } from "../../src/pipeline/pipeline-context.ts";

test("composeEffectivePipelineContext appends pattern context when both are present", () => {
  assert.equal(
    composeEffectivePipelineContext("user ctx", "pattern ctx"),
    "user ctx\n\npattern ctx",
  );
});

test("composeEffectivePipelineContext returns user context when pattern is empty", () => {
  assert.equal(composeEffectivePipelineContext("user ctx", ""), "user ctx");
});

test("composeEffectivePipelineContext returns pattern only when user context is missing", () => {
  assert.equal(composeEffectivePipelineContext(undefined, "pattern ctx"), "pattern ctx");
});
