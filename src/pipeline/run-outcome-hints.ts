/**
 * Structured CLI hints after pipeline run (stability S3.1).
 */

import type { PipelineResult } from "../core/pipeline-run-types.js";
import type { StepResult } from "../core/state.js";

function findLastFailedStep(stepResults: Record<string, StepResult>): {
  name: string;
  step: StepResult;
} | null {
  let best: { name: string; step: StepResult; round: number } | null = null;
  for (const [name, step] of Object.entries(stepResults)) {
    if (step.status !== "failed") continue;
    const round = step.round ?? 0;
    if (!best || round >= best.round) {
      best = { name, step, round };
    }
  }
  return best ? { name: best.name, step: best.step } : null;
}

/** Multi-line operator hints (stdout). */
export function formatPipelineRunOutcomeHints(
  result: PipelineResult,
  options?: { sessionId?: string },
): string {
  const session = options?.sessionId ?? result.checkpointFile;
  const lines: string[] = [
    "",
    "--- next steps ---",
    `status:      ${result.status}`,
    `traceId:     ${result.traceId}`,
    `session:     ${session}`,
    `checkpoint:  ~/.runoff/sessions/${session}.json`,
  ];

  if (result.error) {
    lines.push(`error:       ${result.error}`);
  }

  const failed = findLastFailedStep(result.stepResults);
  if (failed) {
    lines.push(`failed step: ${failed.name} (${failed.step.provider ?? "unknown"})`);
    if (failed.step.error) lines.push(`step error:  ${failed.step.error}`);
    if (failed.step.reason) lines.push(`reason:      ${failed.step.reason}`);
  }

  lines.push("");
  lines.push("inspect:");
  lines.push(`  ls ~/.runoff/traces/${result.traceId}.json`);
  lines.push("  npm run pipeline:doctor");

  switch (result.status) {
    case "awaiting_judge":
      lines.push("");
      lines.push("race finalize:");
      lines.push(`  npm run pipeline:race:apply -- --session ${session} --winner 0`);
      lines.push(`  npm run pipeline:race:abort -- --trace-id ${result.traceId}`);
      break;
    case "awaiting_approval":
    case "awaiting_plan_approval":
      lines.push("");
      lines.push("resume after approval (MCP llm_run_pipeline with same sessionId + approvalDecision):");
      lines.push(`  sessionId: ${session}`);
      break;
    case "max_rounds":
      lines.push("");
      lines.push("resume:");
      lines.push(
        `  npm run pipeline:run -- --prompt "<same>" --work-dir <repo> --config <path>  # pass session via MCP for resume`,
      );
      break;
    case "failed":
    case "aborted":
      if (session) {
        lines.push("");
        lines.push("retry from checkpoint (MCP): llm_run_pipeline with sessionId + matching prompt/config");
      }
      break;
    default:
      break;
  }

  return lines.join("\n");
}
