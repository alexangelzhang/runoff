#!/usr/bin/env node
/**
 * Verify OTLP/HTTP export against a self-hosted or corporate collector.
 *
 * - Default: SKIP if nothing listens (CI gates without a local collector).
 * - RUNOFF_OTEL_COLLECTOR_REQUIRED=1: fail if export fails.
 * - Start collector first: npm run otel-collector:start (native / download / docker).
 * - External collector only: RUNOFF_OTEL_SKIP_START=1 + OTEL_EXPORTER_OTLP_ENDPOINT=...
 */

import assert from "node:assert/strict";
import type { PipelineTrace } from "../../../src/observability/trace.js";
import {
  OtlpHttpTraceExporter,
  resolveOtlpTracesEndpoint,
} from "../../../src/observability/trace-exporter.js";
import { parseOtlpHttpEndpoint, probeOtlpTcp } from "../../../src/observability/otel-collector-probe.js";

const endpoint =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
  ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  ?? "http://127.0.0.1:4318";

const required = process.env.RUNOFF_OTEL_COLLECTOR_REQUIRED === "1";

const trace: PipelineTrace = {
  id: "otel-collector-verify",
  prompt: "collector smoke",
  promptLength: 15,
  mode: "pipeline",
  hasVerifyResults: false,
  steps: [{ name: "smoke", provider: "mock", durationMs: 2, round: 1, spanId: "span-smoke" }],
  totalRounds: 1,
  finalStatus: "approved",
  totalDurationMs: 2,
  timestamp: new Date().toISOString(),
  lifecycle: "final",
};

function skipOrFail(message: string): never {
  if (required) {
    console.error(message);
    process.exit(1);
  }
  console.log(`SKIP ${message}`);
  console.log(
    "Hint: npm run otel-collector:start  (native brew/binary, optional download, or docker fallback)",
  );
  console.log(
    "      or set OTEL_EXPORTER_OTLP_ENDPOINT + RUNOFF_OTEL_SKIP_START=1 for an existing collector",
  );
  process.exit(0);
}

async function main(): Promise<void> {
  const tracesUrl = resolveOtlpTracesEndpoint(endpoint);
  const { host, port } = parseOtlpHttpEndpoint(endpoint);

  if (!(await probeOtlpTcp(host, port))) {
    skipOrFail(`OTel collector not reachable at ${host}:${port} (${endpoint})`);
  }

  const exporter = new OtlpHttpTraceExporter({
    endpoint,
    serviceName: "runoff",
  });

  try {
    await exporter.export(trace);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    skipOrFail(`OTel collector export failed: ${message}`);
  }

  assert.ok(true);
  console.log(`OK otel collector export → ${tracesUrl}`);
}

main();
