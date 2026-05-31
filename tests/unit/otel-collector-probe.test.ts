import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseOtlpHttpEndpoint } from "../../src/observability/otel-collector-probe.js";

describe("otel-collector-probe", () => {
  it("parseOtlpHttpEndpoint defaults port 4318", () => {
    assert.deepEqual(parseOtlpHttpEndpoint("http://127.0.0.1:4318"), {
      host: "127.0.0.1",
      port: 4318,
    });
  });

  it("parseOtlpHttpEndpoint honors explicit host:port", () => {
    assert.deepEqual(parseOtlpHttpEndpoint("http://collector.local:9999/v1/traces"), {
      host: "collector.local",
      port: 9999,
    });
  });
});
