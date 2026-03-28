import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../config.js";
import { getStepProviderMode } from "../config.js";

export function register(server: McpServer) {
  server.tool(
    "llm_show_config",
    "Display current pipeline configuration and provider details.",
    {},
    async () => {
      try {
        const config = loadConfig();
        const pipelineSteps = Object.entries(config.pipeline).map(([stepName, stepConfig]) => {
          const providerName = stepConfig[0];
          const pc = config.providers[providerName];
          const mode = getStepProviderMode(stepName, config);
          
          return {
            step: stepName,
            provider: providerName,
            providerType: pc?.type,
            model: pc?.model,
            mode,
            dependsOn: stepConfig.slice(1)
          };
        });

        const output = {
          configPath: "pipeline.config.json",
          steps: pipelineSteps,
          routingRules: config.routing || [],
          retryPolicy: config.retry || { maxRounds: 1 }
        };

        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }]
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error loading config: ${err.message}` }],
          isError: true
        };
      }
    }
  );
}
