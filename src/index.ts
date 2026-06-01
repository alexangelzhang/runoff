#!/usr/bin/env node
/**
 * runoff MCP server entry point.
 * Tool implementations live in src/tools/*.ts.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./core/config.js";
import { activeWorkspaces } from "./runtime/workspace.js";
import { raceSessions, cleanupStaleRaceSessions } from "./runtime/race-registry.js";

import { register as registerRunStep } from "./tools/run-step.js";
import { register as registerShowConfig } from "./tools/show-config.js";
import { register as registerQueryTraces } from "./tools/query-traces.js";
import { register as registerScoreTrace } from "./tools/score-trace.js";
import { register as registerQueryExperiments } from "./tools/query-experiments.js";
import { register as registerMemoryStatus } from "./tools/memory-status.js";
import { register as registerQueryMemory } from "./tools/query-memory.js";
import { register as registerDreamRun } from "./tools/dream-run.js";
import { register as registerDreamifyTune } from "./tools/dreamify-tune.js";
import { register as registerDreamExport } from "./tools/dream-export.js";
import { register as registerRace } from "./tools/race.js";
import { register as registerRunPipeline } from "./tools/run-pipeline.js";
import { register as registerShowAgentGraph } from "./tools/show-agent-graph.js";
import { logger } from "./core/logger.js";

const initialConfig = loadConfig();

const server = new McpServer({
  name: "runoff",
  version: "3.0.0",
});

// Register all MCP tools
registerRunStep(server, initialConfig);
registerShowConfig(server);
registerQueryTraces(server);
registerScoreTrace(server);
registerQueryExperiments(server);
registerMemoryStatus(server);
registerQueryMemory(server);
registerDreamRun(server);
registerDreamifyTune(server);
registerDreamExport(server);
registerRace(server);
registerRunPipeline(server);
registerShowAgentGraph(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("server", "runoff MCP server v3.0 running on stdio");

  // Graceful shutdown
  const shutdown = () => {
    logger.info("server", "runoff MCP server shutting down...");
    // Race sessions currently store patch metadata only; no live workspace handles to destroy here.
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
    logger.error("server", "Uncaught exception", { err });
    shutdown();
  });
}

main().catch((err) => {
  logger.error("server", "Fatal startup error", { err });
  process.exit(1);
});
