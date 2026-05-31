/**
 * Local HTTP server for AgentGraph editor — POST /api/save writes pipeline.config.json.
 */

import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import type { AgentGraphSnapshot } from "../orchestration/agent-graph-io.js";
import { loadConfigFromPath, clearConfigCache } from "../core/config.js";
import { saveFullConfigToFile, saveGraphSnapshotToConfigFile } from "./config-persist.js";
import { pipelineConfigToEditorHtml } from "./pipeline-config-editor-html.js";

export type ConfigEditorServerOptions = {
  configPath: string;
  host?: string;
  port?: number;
};

export type ConfigEditorServerHandle = {
  url: string;
  port: number;
  configPath: string;
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

function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolvePromise(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function buildEditorHtml(configPath: string, saveUrl: string): string {
  const config = loadConfigFromPath(configPath);
  const title = `Pipeline config — ${basename(configPath)}`;
  return pipelineConfigToEditorHtml(config, title, {
    saveUrl,
    configPathLabel: configPath,
  });
}

export function startConfigEditorServer(
  options: ConfigEditorServerOptions,
): Promise<ConfigEditorServerHandle> {
  const configPath = resolve(options.configPath);
  const host = options.host ?? "127.0.0.1";

  let editorHtml = "";
  let baseUrl = "";

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(editorHtml);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/save") {
      try {
        const body = (await readJsonBody(req)) as {
          config?: unknown;
          snapshot?: AgentGraphSnapshot;
        };

        let result;
        if (body?.config && typeof body.config === "object" && !Array.isArray(body.config)) {
          result = saveFullConfigToFile(configPath, body.config);
        } else if (body?.snapshot && Array.isArray(body.snapshot.nodes)) {
          result = saveGraphSnapshotToConfigFile(configPath, body.snapshot);
        } else {
          jsonResponse(res, 400, {
            ok: false,
            error: "Body must include config object or snapshot.nodes",
          });
          return;
        }

        if (!result.ok) {
          jsonResponse(res, 400, { ok: false, error: result.error });
          return;
        }
        clearConfigCache();
        if (baseUrl) {
          editorHtml = buildEditorHtml(configPath, `${baseUrl}/api/save`);
        }
        jsonResponse(res, 200, { ok: true, configPath: result.configPath });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        jsonResponse(res, 500, { ok: false, error: message });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  let boundPort = options.port ?? 0;

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(boundPort, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to bind config editor server"));
        return;
      }
      boundPort = addr.port;
      baseUrl = `http://${host}:${boundPort}`;
      editorHtml = buildEditorHtml(configPath, `${baseUrl}/api/save`);

      resolvePromise({
        url: baseUrl,
        port: boundPort,
        configPath,
        server,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

/** Open default browser (best-effort). */
export function openInBrowser(url: string): void {
  const { platform } = process;
  if (platform === "darwin") {
    execFile("open", [url], () => undefined);
  } else if (platform === "win32") {
    execFile("cmd", ["/c", "start", "", url], () => undefined);
  } else {
    execFile("xdg-open", [url], () => undefined);
  }
}
