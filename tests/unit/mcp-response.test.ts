import assert from "node:assert/strict";
import test from "node:test";
import {
  mcpError,
  mcpErrorFrom,
  mcpJson,
  pipelineMcpIsError,
} from "../../src/tools/mcp-response.ts";

test("mcpJson returns JSON text without isError by default", () => {
  const res = mcpJson({ ok: true, n: 1 });
  assert.equal(res.isError, undefined);
  assert.deepEqual(JSON.parse(res.content[0]!.text), { ok: true, n: 1 });
});

test("mcpJson sets isError when requested", () => {
  const res = mcpJson({ status: "error" }, { isError: true });
  assert.equal(res.isError, true);
});

test("mcpError returns JSON envelope with prefix and error", () => {
  const res = mcpError("Tool error", "something broke");
  assert.equal(res.isError, true);
  const body = JSON.parse(res.content[0]!.text) as { error: string; prefix: string };
  assert.equal(body.error, "something broke");
  assert.equal(body.prefix, "Tool error");
});

test("mcpErrorFrom handles Error and non-Error values", () => {
  const fromErr = mcpErrorFrom("X", new Error("boom"));
  const fromStr = mcpErrorFrom("X", "plain");
  assert.equal(JSON.parse(fromErr.content[0]!.text).error, "boom");
  assert.equal(JSON.parse(fromStr.content[0]!.text).error, "plain");
});

test("pipelineMcpIsError covers terminal failures only", () => {
  assert.equal(pipelineMcpIsError("failed"), true);
  assert.equal(pipelineMcpIsError("aborted"), true);
  assert.equal(pipelineMcpIsError("max_rounds"), true);
  assert.equal(pipelineMcpIsError("awaiting_judge"), false);
  assert.equal(pipelineMcpIsError("awaiting_approval"), false);
  assert.equal(pipelineMcpIsError("awaiting_plan_approval"), false);
  assert.equal(pipelineMcpIsError("running"), false);
  assert.equal(pipelineMcpIsError("queued"), false);
  assert.equal(pipelineMcpIsError("approved"), false);
});
