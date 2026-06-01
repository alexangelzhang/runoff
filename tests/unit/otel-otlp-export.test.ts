import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import {
  createTraceExporterFromConfig,
  InMemoryTraceExporter,
  OtlpHttpTraceExporter,
  resolveOtlpTracesEndpoint,
  toOtlpBinaryId,
  traceToOtlpHttpBody,
} from "../../src/observability/trace-exporter.ts";
import type { PipelineConfig } from "../../src/core/config.ts";
import type { PipelineTrace } from "../../src/observability/trace.ts";

const sampleTrace: PipelineTrace = {
  id: "trace-uuid-1234",
  prompt: "fix",
  promptLength: 3,
  mode: "pipeline",
  hasVerifyResults: false,
  steps: [
    {
      name: "generate",
      provider: "mock",
      durationMs: 100,
      round: 1,
      spanId: "abcd1234abcd1234",
    },
  ],
  totalRounds: 1,
  finalStatus: "approved",
  totalDurationMs: 100,
  timestamp: new Date().toISOString(),
  lifecycle: "final",
};

test("resolveOtlpTracesEndpoint appends /v1/traces", () => {
  assert.equal(resolveOtlpTracesEndpoint("http://localhost:4318"), "http://localhost:4318/v1/traces");
  assert.equal(
    resolveOtlpTracesEndpoint("http://localhost:4318/v1/traces"),
    "http://localhost:4318/v1/traces",
  );
});

test("traceToOtlpHttpBody produces resourceSpans", () => {
  const body = traceToOtlpHttpBody(sampleTrace, "runoff-test");
  const spans = (body.resourceSpans as Array<{ scopeSpans: Array<{ spans: unknown[] }> }>)[0]!
    .scopeSpans[0]!.spans;
  assert.equal(spans.length, 1);
  assert.ok(toOtlpBinaryId("abcd1234abcd1234", 8).length > 0);
});

test("createTraceExporterFromConfig uses memory without endpoint", () => {
  const config: PipelineConfig = {
    providers: { mock: { type: "mock" } },
    pipeline: { s: ["mock"] },
    runtime: { otelExport: true },
  };
  const exp = createTraceExporterFromConfig(config);
  assert.ok(exp instanceof InMemoryTraceExporter);
});

test("OtlpHttpTraceExporter POSTs to collector", async () => {
  let received = "";
  let server: Server | undefined;
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/traces") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          received = Buffer.concat(chunks).toString("utf-8");
          res.writeHead(200);
          res.end("ok");
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server!.address();
  assert.ok(addr && typeof addr !== "string");
  const exporter = new OtlpHttpTraceExporter({
    endpoint: `http://127.0.0.1:${addr.port}`,
  });
  await exporter.export(sampleTrace);
  server!.close();

  assert.ok(received.includes("resourceSpans"));
  assert.ok(received.includes("generate"));
});
