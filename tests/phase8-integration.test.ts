import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentCardRegistry, wireA2ATransportFromRegistry } from "../src/orchestration/a2a/config-bridge.ts";
import { InMemoryA2ATransport } from "../src/orchestration/a2a/transport.ts";
import { agentId } from "../src/orchestration/multi-agent-types.ts";
import type { PipelineConfig } from "../src/core/config.ts";
import { traceToOtelPayload, InMemoryTraceExporter } from "../src/observability/trace-exporter.ts";
import type { PipelineTrace } from "../src/observability/trace.ts";
import {
  PipelineHooks,
  getPipelineOtelMemoryExporter,
  resetPipelineOtelExporter,
  resetSharedMemory,
} from "../src/pipeline/pipeline-hooks.ts";
import type { PipelineCostAccumulator } from "../src/routing/pricing.ts";

const baseConfig: PipelineConfig = {
  providers: { mock: { type: "mock", mode: "text" } },
  pipeline: { stepA: ["mock"], stepB: ["mock", "stepA"] },
  agents: {
    worker: { role: "worker", provider: "mock", capabilities: ["implement"] },
  },
};

test("buildAgentCardRegistry: registers config agents", () => {
  const reg = buildAgentCardRegistry(baseConfig);
  assert.equal(reg.size, 1);
  assert.ok(reg.get(agentId("worker")));
});

test("wireA2ATransportFromRegistry: delivers messages", async () => {
  const reg = buildAgentCardRegistry(baseConfig);
  const transport = new InMemoryA2ATransport();
  wireA2ATransportFromRegistry(reg, transport);
  await transport.send({
    id: "",
    from: agentId("worker"),
    to: agentId("worker"),
    method: "ping",
    payload: {},
    timestamp: 0,
  });
  assert.equal(transport.getMessageLog().length, 1);
});

test("traceToOtelPayload: emits spans per step", () => {
  const trace: PipelineTrace = {
    id: "trace-uuid",
    prompt: "fix bug",
    promptLength: 7,
    mode: "pipeline",
    hasVerifyResults: false,
    steps: [
      {
        name: "stepA",
        provider: "mock",
        durationMs: 100,
        round: 1,
        spanId: "span-a-1234567890ab",
      },
    ],
    totalRounds: 1,
    finalStatus: "approved",
    totalDurationMs: 100,
    timestamp: new Date().toISOString(),
    lifecycle: "final",
  };
  const payload = traceToOtelPayload(trace);
  assert.equal(payload.spans.length, 1);
  assert.equal(payload.spans[0]!.name, "stepA");
});

test("PipelineHooks otelExport captures trace", () => {
  resetPipelineOtelExporter();
  resetSharedMemory();
  const config: PipelineConfig = {
    ...baseConfig,
    runtime: { otelExport: true },
  };
  const hooks = new PipelineHooks(config, "trace-otel", "sess-otel");
  const costTracker = { getSummary: () => ({ totalTokens: 0, totalCostUSD: 0 }) } as PipelineCostAccumulator;
  hooks.onPipelineEnd({
    trace: {
      id: "trace-otel",
      prompt: "p",
      promptLength: 1,
      mode: "pipeline",
      hasVerifyResults: false,
      steps: [],
      totalRounds: 0,
      finalStatus: "failed",
      totalDurationMs: 0,
      timestamp: new Date().toISOString(),
      lifecycle: "final",
    },
    costTracker,
    config,
  });
  const exp = getPipelineOtelMemoryExporter();
  assert.ok(exp && exp.payloads.length === 1);
});
