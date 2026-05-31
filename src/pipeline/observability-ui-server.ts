/**
 * Local HTTP server for trace / experiment observability UI.
 */

import { createServer, type Server } from "node:http";
import { queryTraces, loadTraceById } from "../observability/trace.js";
import { buildTracePostmortem } from "../observability/trace-postmortem.js";
import { queryExperiments, summarizeExperiment } from "../observability/experiment-log.js";
import { buildExperimentEvalReport } from "../observability/observability-dataset.js";
import { observabilityUiHtml } from "./observability-ui-html.js";

export type ObservabilityUiServerOptions = {
  host?: string;
  port?: number;
};

export type ObservabilityUiServerHandle = {
  url: string;
  port: number;
  server: Server;
  close: () => Promise<void>;
};

function jsonResponse(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

function experimentSummaries(): Array<{ experimentId: string; runCount: number; variantCount: number }> {
  const entries = queryExperiments({});
  const byId = new Map<string, typeof entries>();
  for (const e of entries) {
    const list = byId.get(e.experimentId) ?? [];
    list.push(e);
    byId.set(e.experimentId, list);
  }
  return [...byId.entries()].map(([experimentId, list]) => {
    const variants = new Set(list.map((e) => e.variant));
    return { experimentId, runCount: list.length, variantCount: variants.size };
  });
}

export function startObservabilityUiServer(
  options: ObservabilityUiServerOptions = {},
): Promise<ObservabilityUiServerHandle> {
  const host = options.host ?? "127.0.0.1";

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    const path = url.pathname;

    if (req.method === "GET" && path === "/") {
      const baseUrl = `http://${host}:${(server.address() as { port: number }).port}`;
      const html = observabilityUiHtml(baseUrl);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && path === "/api/traces") {
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const traces = queryTraces({ limit: limit > 0 ? limit : 50 });
      jsonResponse(res, 200, {
        traces: traces.map((t) => ({
          id: t.id,
          sessionId: t.sessionId,
          finalStatus: t.finalStatus,
          mode: t.mode,
          stepCount: t.steps.length,
          totalDurationMs: t.totalDurationMs,
          timestamp: t.timestamp,
        })),
      });
      return;
    }

    if (req.method === "GET" && path.startsWith("/api/traces/")) {
      const id = decodeURIComponent(path.slice("/api/traces/".length));
      const trace = loadTraceById(id);
      if (!trace) {
        jsonResponse(res, 404, { error: "not found" });
        return;
      }
      jsonResponse(res, 200, { trace, postmortem: buildTracePostmortem(trace) });
      return;
    }

    if (req.method === "GET" && path === "/api/experiments") {
      jsonResponse(res, 200, { summaries: experimentSummaries() });
      return;
    }

    if (req.method === "GET" && path.startsWith("/api/experiments/") && path.endsWith("/eval-report")) {
      const parts = path.split("/").filter(Boolean);
      const experimentId = decodeURIComponent(parts[2] ?? "");
      if (!experimentId) {
        jsonResponse(res, 400, { error: "experimentId required" });
        return;
      }
      jsonResponse(res, 200, buildExperimentEvalReport(experimentId));
      return;
    }

    if (req.method === "GET" && path.startsWith("/api/experiments/")) {
      const experimentId = decodeURIComponent(path.slice("/api/experiments/".length));
      jsonResponse(res, 200, {
        experimentId,
        entries: queryExperiments({ experimentId }),
        variants: summarizeExperiment(experimentId),
      });
      return;
    }

    jsonResponse(res, 404, { error: "not found" });
  });

  return new Promise((resolvePromise) => {
    server.listen(options.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : options.port ?? 0;
      const baseUrl = `http://${host}:${port}`;
      resolvePromise({
        url: baseUrl,
        port,
        server,
        close: () =>
          new Promise((resolveClose, reject) => {
            server.close((err) => (err ? reject(err) : resolveClose()));
          }),
      });
    });
  });
}
