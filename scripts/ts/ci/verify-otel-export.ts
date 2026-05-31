#!/usr/bin/env node
/**
 * CI / pre-release: verify in-memory OTel export path (S3.2).
 */

import assert from "node:assert/strict";
import {
  createTraceExporterFromConfig,
  InMemoryTraceExporter,
} from "../../../src/observability/trace-exporter.js";
import type { PipelineConfig } from "../../../src/core/config.js";
import type { PipelineTrace } from "../../../src/observability/trace.js";

const config: PipelineConfig = {
  providers: { mock: { type: "mock" } },
  pipeline: { s: ["mock"] },
  retry: { maxRounds: 1, reviewStep: "review" },
  runtime: { otelExport: true },
};

const trace: PipelineTrace = {
  id: "otel-verify",
  prompt: "p",
  promptLength: 1,
  mode: "pipeline",
  hasVerifyResults: false,
  steps: [{ name: "s", provider: "mock", durationMs: 1, round: 1, spanId: "span-1" }],
  totalRounds: 1,
  finalStatus: "approved",
  totalDurationMs: 1,
  timestamp: new Date().toISOString(),
  lifecycle: "final",
};

const exporter = createTraceExporterFromConfig(config);
assert.ok(exporter instanceof InMemoryTraceExporter, "expected InMemoryTraceExporter without endpoint");
await exporter.export(trace);
const payloads = exporter.payloads;
assert.ok(payloads.length >= 1, "export should record payloads");
console.log(`OK otel in-memory export (${payloads.length} payload(s))`);
