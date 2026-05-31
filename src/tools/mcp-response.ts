/**
 * Shared MCP tool JSON responses.
 *
 * Contract: success bodies are JSON in content[0].text; errors use the same JSON
 * envelope `{ error, prefix? }` with isError:true. Semantic outcomes (pipeline status,
 * step status) live inside the JSON body — parse those fields, not isError alone.
 */

import type { PipelineStatus } from "../core/state.js";
import { PIPELINE_TERMINAL_FAILURE_STATUSES } from "../core/state.js";

export function mcpJson(payload: unknown, opts?: { isError?: boolean }) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    ...(opts?.isError ? { isError: true as const } : {}),
  };
}

export function mcpError(prefix: string, message: string) {
  return mcpJson({ error: message, prefix }, { isError: true });
}

export function mcpErrorFrom(prefix: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return mcpError(prefix, message);
}

/** MCP isError for terminal pipeline outcomes (pauses like awaiting_* stay false). */
export function pipelineMcpIsError(status: PipelineStatus): boolean {
  return (PIPELINE_TERMINAL_FAILURE_STATUSES as readonly string[]).includes(status);
}
