#!/usr/bin/env node
/**
 * llm-pipeline MCP server entry point.
 * Tool implementations live in src/tools/*.ts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { activeWorkspaces } from "./workspace.js";
import { raceSessions, cleanupStaleRaceSessions } from "./tools/helpers.js";

import { register as registerRunStep } from "./tools/run-step.js";
import { register as registerShowConfig } from "./tools/show-config.js";
import { register as registerQueryTraces } from "./tools/query-traces.js";
import { register as registerRace } from "./tools/race.js";
import { register as registerRunPipeline } from "./tools/run-pipeline.js";

const initialConfig = loadConfig();

const server = new McpServer({
  name: "llm-pipeline",
  version: "3.0.0",
});

// Register all MCP tools
registerRunStep(server, initialConfig);
registerShowConfig(server);
registerQueryTraces(server);
registerRace(server);
registerRunPipeline(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("llm-pipeline MCP server v3.0 running on stdio");

  // Graceful shutdown
  const shutdown = () => {
    console.error("llm-pipeline MCP server shutting down...");
    // Destroy race session workspaces
    for (const [, session] of raceSessions) {
      for (const c of session.candidates) {
        c.workspace?.destroySync();
      }
    }
    raceSessions.clear();
    for (const ws of activeWorkspaces) {
      ws.destroySync();
    }
    server.close().catch(() => {});
    process.exit(130);
  };

  // Periodic race session TTL cleanup (every 5 minutes)
  const cleanupInterval = setInterval(cleanupStaleRaceSessions, 5 * 60 * 1000);
  cleanupInterval.unref();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
    shutdown();
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
