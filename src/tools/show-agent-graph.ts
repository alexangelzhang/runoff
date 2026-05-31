import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../core/config.js";
import { getAgentGraphCanvasPath, getAgentGraphEditorPath } from "../core/paths.js";
import {
  agentGraphFromConfig,
  applyAgentGraphToPipeline,
  compileAgentGraphFromSnapshot,
  serializeAgentGraph,
  parseAgentGraphFromMermaid,
  validateAgentGraphSnapshot,
  type AgentGraphSnapshot,
} from "../orchestration/agent-graph-io.js";
import { agentGraphToCanvasHtml } from "../orchestration/agent-graph-canvas.js";
import { agentGraphToEditorHtml } from "../orchestration/agent-graph-editor.js";
import { agentGraphToHtml, agentGraphToMermaid } from "../orchestration/agent-graph-viz.js";
import { mcpJson, mcpErrorFrom } from "./mcp-response.js";

export function register(server: McpServer) {
  server.tool(
    "llm_show_agent_graph",
    "Export or patch the runtime AgentGraph (JSON / Mermaid / HTML / editor / canvas). Config pipeline remains declaration SoT.",
    {
      action: z
        .enum(["show", "apply"])
        .optional()
        .describe("show: compile from config; apply: merge snapshot nodes into config pipeline"),
      format: z
        .enum(["json", "mermaid", "html", "editor", "canvas"])
        .optional()
        .describe("Output format for show; editor/canvas write HTML under ~/.llm-pipeline/"),
      writeEditor: z
        .boolean()
        .optional()
        .describe("When format=editor, write HTML to pipeline home (default true)"),
      snapshot: z
        .string()
        .optional()
        .describe("JSON AgentGraphSnapshot for apply"),
      mermaid: z
        .string()
        .optional()
        .describe("Mermaid flowchart for apply (alternative to snapshot JSON)"),
    },
    async ({ action = "show", format = "json", snapshot, mermaid, writeEditor = true }) => {
      try {
        const config = loadConfig();
        if (action === "apply") {
          if (!snapshot && !mermaid) {
            throw new Error("snapshot JSON or mermaid text required for action=apply");
          }
          const raw = mermaid
            ? parseAgentGraphFromMermaid(mermaid)
            : (JSON.parse(snapshot!) as AgentGraphSnapshot);
          const check = validateAgentGraphSnapshot(raw);
          if (!check.valid) {
            throw new Error(
              check.cycle
                ? `cycle: ${check.cycle.join(" → ")}`
                : `missing deps: ${check.missingDeps?.join(", ")}`,
            );
          }
          applyAgentGraphToPipeline(raw, config.pipeline, { skipValidation: true });
          const graph = compileAgentGraphFromSnapshot(raw, config.pipeline);
          const snap = serializeAgentGraph(graph);
          return mcpJson({
            applied: true,
            pipeline: config.pipeline,
            graph: snap,
            mermaid: agentGraphToMermaid(snap),
          });
        }

        const graph = agentGraphFromConfig(config);
        const snap = serializeAgentGraph(graph);

        if (format === "mermaid") {
          return {
            content: [{ type: "text", text: agentGraphToMermaid(snap) }],
          };
        }
        if (format === "html") {
          return {
            content: [{ type: "text", text: agentGraphToHtml(snap, "llm-pipeline AgentGraph") }],
          };
        }
        if (format === "editor") {
          const html = agentGraphToEditorHtml(snap, "llm-pipeline AgentGraph");
          const editorPath = getAgentGraphEditorPath();
          if (writeEditor) {
            mkdirSync(dirname(editorPath), { recursive: true });
            writeFileSync(editorPath, html, "utf-8");
          }
          return {
            content: [
              {
                type: "text",
                text: writeEditor
                  ? `AgentGraph editor written to ${editorPath}\n\nOpen in a browser, edit nodes, copy JSON, then llm_show_agent_graph action=apply snapshot=<json>`
                  : html,
              },
            ],
          };
        }
        if (format === "canvas") {
          const html = agentGraphToCanvasHtml(snap, "llm-pipeline AgentGraph Canvas");
          const canvasPath = getAgentGraphCanvasPath();
          if (writeEditor) {
            mkdirSync(dirname(canvasPath), { recursive: true });
            writeFileSync(canvasPath, html, "utf-8");
          }
          return {
            content: [
              {
                type: "text",
                text: writeEditor
                  ? `AgentGraph canvas written to ${canvasPath}\n\nOpen in browser; click A then B to add dependency A→B; copy JSON for apply`
                  : html,
              },
            ],
          };
        }

        return mcpJson({
          pipeline: config.pipeline,
          graph: snap,
          mermaid: agentGraphToMermaid(snap),
        });
      } catch (err: unknown) {
        return mcpErrorFrom("Agent graph error", err);
      }
    },
  );
}
