/**
 * Structured CLI hints after pipeline run (stability S3.1).
 */

import type { PipelineResult } from "../core/pipeline-run-types.js";
import type { StepResult } from "../core/state.js";
import { formatResumePlannerOutcomeHints } from "./resume-planner-format.js";

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

function collectClaimEvidenceRefs(result: PipelineResult, limit = 8): { refs: string[]; omitted: number } {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const claim of result.observation?.claims ?? []) {
    for (const ref of claim.evidenceRefs) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      if (refs.length < limit) refs.push(ref);
    }
  }
  return { refs, omitted: Math.max(0, seen.size - refs.length) };
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
    `checkpoint:  ~/.runoff/sessions/${session}.checkpoint.json`,
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

  const claimEvidence = collectClaimEvidenceRefs(result);
  if (claimEvidence.refs.length) {
    lines.push("");
    lines.push("claim evidence refs (for final summaries / PR comments):");
    for (const ref of claimEvidence.refs) {
      lines.push(`  • ${ref}`);
    }
    if (claimEvidence.omitted > 0) {
      lines.push(`  • ... ${claimEvidence.omitted} more`);
    }
  }

  lines.push(
    ...formatResumePlannerOutcomeHints(result.resumeReusePlan ?? result.observation?.resumeReusePlan),
  );

  lines.push("");
  lines.push("inspect:");
  lines.push(`  ls ~/.runoff/traces/${result.traceId}.json`);
  lines.push("  npm run pipeline:doctor");

  switch (result.status) {
    case "needs_clarification":
      lines.push("");
      lines.push("scope clarification:");
      for (const question of result.scopePreflight?.clarificationQuestions ?? []) {
        lines.push(`  • ${question}`);
      }
      lines.push(`  rerun runoff_run_pipeline with sessionId: ${session}`);
      break;
    case "awaiting_judge":
      lines.push("");
      lines.push("race finalize:");
      lines.push(`  npm run pipeline:race:apply -- --session ${session} --winner 0`);
      lines.push(`  npm run pipeline:race:abort -- --trace-id ${result.traceId}`);
      if (result.historicalPatterns && result.historicalPatterns.length > 0) {
        lines.push("");
        lines.push("historical patterns (past races — evidenceTraceId links to the run that produced each):");
        for (const p of result.historicalPatterns) {
          const winner = p.winnerProvider ? ` [winner: ${p.winnerProvider}]` : "";
          lines.push(`  • ${p.summary.split("\n")[0]}${winner}`);
          lines.push(`    evidence: ~/.runoff/traces/${p.evidenceTraceId}.json`);
        }
      }
      break;
    case "awaiting_approval":
    case "awaiting_plan_approval":
      lines.push("");
      lines.push("resume after approval (MCP runoff_run_pipeline with same sessionId + approvalDecision):");
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
        lines.push("retry from checkpoint (MCP): runoff_run_pipeline with sessionId + matching prompt/config");
      }
      break;
    default:
      break;
  }

  return lines.join("\n");
}
