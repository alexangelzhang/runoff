import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../core/config.js";
import { getStepProviderMode } from "../core/config.js";
import { describeMemoryBackend } from "../memory/memory-backend-status.js";
import { describeDreamifyStatus } from "../dreamify/dreamify-status.js";
import { getDreamExportPath } from "../dream/dream-export.js";
import { loadDreamState } from "../memory/dream-state.js";

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
          const primaryProvider = Array.isArray(providerName) ? providerName[0] : providerName;
          const pc = config.providers[primaryProvider];
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
          pipelineDSL: "tuple-v1",
          steps: pipelineSteps,
          routingRules: config.routing || [],
          retryPolicy: config.retry || { maxRounds: 1 },
          memoryBackend: describeMemoryBackend(config),
          dreamify: describeDreamifyStatus(config),
          dream: {
            config: config.orchestration?.dream,
            state: loadDreamState(),
            exportPath: getDreamExportPath(),
          },
        };

        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }]
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error loading config: ${message}` }],
          isError: true
        };
      }
    }
  );
}
