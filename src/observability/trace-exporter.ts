/**
 * Phase 8.3.10 — OpenTelemetry-oriented trace export (JSON resourceSpans + OTLP/HTTP).
 */

import { Buffer } from "node:buffer";
import type { PipelineConfig } from "../core/config.js";
import type { PipelineTrace, StepTrace } from "./trace.js";

export interface OtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number | boolean>;
  status: { code: "OK" | "ERROR"; message?: string };
}

export interface OtelExportPayload {
  resource: { serviceName: string; traceId: string };
  spans: OtelSpan[];
}

export interface TraceExporter {
  export(trace: PipelineTrace): Promise<void>;
}

function isoToNano(iso: string, offsetMs = 0): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(Date.now() * 1_000_000);
  return String((ms + offsetMs) * 1_000_000);
}

/** Convert PipelineTrace to a minimal OTel-compatible JSON structure. */
export function traceToOtelPayload(
  trace: PipelineTrace,
  serviceName = "runoff",
): OtelExportPayload {
  const traceId = trace.id.replace(/-/g, "").slice(0, 32);
  let offset = 0;
  const spans: OtelSpan[] = trace.steps.map((step: StepTrace) => {
    const spanId = (step.spanId ?? step.name).replace(/-/g, "").slice(0, 16);
    const start = isoToNano(trace.timestamp, offset);
    offset += step.durationMs;
    const end = isoToNano(trace.timestamp, offset);
    return {
      traceId,
      spanId,
      parentSpanId: step.parentSpanId,
      name: step.name,
      startTimeUnixNano: start,
      endTimeUnixNano: end,
      attributes: {
        provider: step.provider,
        round: step.round,
        cached: step.cached ?? false,
        ...(step.cost ? { costUsd: step.cost.totalCost } : {}),
      },
      status: step.error
        ? { code: "ERROR" as const, message: step.error }
        : { code: "OK" as const },
    };
  });

  return {
    resource: {
      serviceName,
      traceId,
    },
    spans,
  };
}

/** In-memory exporter for tests and local debugging. */
export class InMemoryTraceExporter implements TraceExporter {
  readonly payloads: OtelExportPayload[] = [];

  async export(trace: PipelineTrace): Promise<void> {
    this.payloads.push(traceToOtelPayload(trace));
  }
}

// --- OTLP/HTTP (Backlog B1: Jaeger / Tempo / OTLP collector) ---

type OtlpAttributeValue =
  | { stringValue: string }
  | { intValue: string }
  | { boolValue: boolean };

function otlpAttr(key: string, value: string | number | boolean): { key: string; value: OtlpAttributeValue } {
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") return { key, value: { intValue: String(value) } };
  return { key, value: { stringValue: value } };
}

/** OTLP JSON trace_id / span_id (base64-encoded fixed-width bytes). */
export function toOtlpBinaryId(raw: string, byteLength: number): string {
  const hex = raw.replace(/-/g, "").padEnd(byteLength * 2, "0").slice(0, byteLength * 2);
  return Buffer.from(hex, "hex").toString("base64");
}

/** Build OTLP HTTP JSON body for POST /v1/traces. */
export function traceToOtlpHttpBody(
  trace: PipelineTrace,
  serviceName = "runoff",
): Record<string, unknown> {
  const payload = traceToOtelPayload(trace, serviceName);
  const traceIdB64 = toOtlpBinaryId(payload.resource.traceId, 16);

  const spans = payload.spans.map((span) => ({
    traceId: toOtlpBinaryId(span.traceId, 16),
    spanId: toOtlpBinaryId(span.spanId, 8),
    ...(span.parentSpanId
      ? { parentSpanId: toOtlpBinaryId(span.parentSpanId, 8) }
      : {}),
    name: span.name,
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    kind: 1,
    status: { code: span.status.code === "OK" ? 1 : 2, message: span.status.message },
    attributes: Object.entries(span.attributes).map(([key, value]) => otlpAttr(key, value)),
  }));

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [otlpAttr("service.name", serviceName)],
        },
        scopeSpans: [
          {
            scope: { name: "runoff" },
            spans,
          },
        ],
      },
    ],
  };
}

export interface OtlpHttpExporterOptions {
  /** Full URL, e.g. http://localhost:4318/v1/traces */
  endpoint: string;
  serviceName?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export function resolveOtlpTracesEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/$/, "");
  if (trimmed.endsWith("/v1/traces")) return trimmed;
  return `${trimmed}/v1/traces`;
}

/** POST OTLP/HTTP JSON to collector (Jaeger, Grafana Tempo, etc.). */
export class OtlpHttpTraceExporter implements TraceExporter {
  constructor(private readonly options: OtlpHttpExporterOptions) {}

  async export(trace: PipelineTrace): Promise<void> {
    const url = resolveOtlpTracesEndpoint(this.options.endpoint);
    const serviceName = this.options.serviceName ?? "runoff";
    const body = JSON.stringify(traceToOtlpHttpBody(trace, serviceName));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...this.options.headers,
    };

    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), this.options.timeoutMs ?? 10_000);
    try {
      const res = await fetch(url, { method: "POST", headers, body, signal: ac.signal });
      if (!res.ok) {
        throw new Error(`OTLP export failed: HTTP ${res.status} ${res.statusText}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

export type OtelExporterKind = "memory" | "otlp";

/** Resolve exporter from config / env (`OTEL_EXPORTER_OTLP_ENDPOINT`). */
export function createTraceExporterFromConfig(
  config: PipelineConfig,
): TraceExporter | null {
  if (!config.runtime?.otelExport) return null;

  const kind = config.runtime.otelExporter ?? (resolveOtlpEndpoint(config) ? "otlp" : "memory");
  if (kind === "otlp") {
    const endpoint = resolveOtlpEndpoint(config);
    if (!endpoint) {
      return new InMemoryTraceExporter();
    }
    return new OtlpHttpTraceExporter({
      endpoint,
      serviceName: config.runtime.otelServiceName ?? "runoff",
      headers: config.runtime.otelHeaders,
    });
  }

  return new InMemoryTraceExporter();
}

function resolveOtlpEndpoint(config: PipelineConfig): string | undefined {
  const fromConfig = config.runtime?.otelEndpoint?.trim();
  if (fromConfig) return fromConfig;
  const fromEnv = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
    ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return fromEnv || undefined;
}
