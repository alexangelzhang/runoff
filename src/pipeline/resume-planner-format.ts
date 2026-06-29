/**
 * Shared resume planner text formatting for CLI, trace show, and outcome hints.
 */

import type { ResumeReusePlanReport } from "../core/state.js";
import type { RunResumePlannerSummary } from "../orchestration/run-control.js";
import { summarizeResumeReusePlanForRun } from "../orchestration/run-control.js";

export function formatResumePlannerSummaryMark(
  planner: Pick<RunResumePlannerSummary, "rerun" | "skipped">,
): string {
  return ` resume=rerun:${planner.rerun},skipped:${planner.skipped}`;
}

function formatRerunStepLine(
  step: { stepName: string; reason: string; downstreamOf?: string },
  indent: string,
): string {
  const downstream = step.downstreamOf ? ` (downstreamOf=${step.downstreamOf})` : "";
  return `${indent}- ${step.stepName}: ${step.reason}${downstream}`;
}

/** `pipeline runs show` non-JSON section. */
export function formatResumePlannerRunShowSection(planner: RunResumePlannerSummary): string[] {
  const lines = [
    "",
    "resumePlanner:",
    `  round:   ${planner.round}`,
    `  rerun:   ${planner.rerun}`,
    `  skipped: ${planner.skipped}`,
  ];
  if (planner.rerunSteps.length > 0) {
    lines.push("  rerunSteps:");
    for (const step of planner.rerunSteps) {
      lines.push(formatRerunStepLine(step, "    "));
    }
  }
  if (planner.skipped > 0) {
    lines.push("  skippedDetails: hidden; use --json for audit/debug");
  }
  return lines;
}

/** `pipeline traces show` non-JSON section. */
export function formatResumePlannerTraceShowSection(
  report: ResumeReusePlanReport | undefined,
): string[] {
  const planner = summarizeResumeReusePlanForRun(report);
  if (!planner || (planner.rerun === 0 && planner.skipped === 0)) return [];

  const lines = [
    "",
    "resumePlanner:",
    `  rerun=${planner.rerun} skipped=${planner.skipped}`,
  ];
  for (const step of planner.rerunSteps) {
    lines.push(formatRerunStepLine(step, "  "));
  }
  if (planner.skipped > 0) {
    lines.push("  skipped hidden; use --json for audit");
  }
  return lines;
}

/** Pipeline run outcome hints (stdout footer). */
export function formatResumePlannerOutcomeHints(
  report: ResumeReusePlanReport | undefined,
): string[] {
  if (!report?.entries.length) return [];

  const planner = summarizeResumeReusePlanForRun(report);
  if (!planner || (planner.rerun === 0 && planner.skipped === 0)) return [];

  const lines = ["", `resume planner: rerun=${planner.rerun}, skipped=${planner.skipped}`];
  for (const step of planner.rerunSteps) {
    const downstream = step.downstreamOf ? ` downstreamOf=${step.downstreamOf}` : "";
    lines.push(`  • rerun ${step.stepName}: ${step.reason}${downstream}`);
  }
  if (planner.skipped > 0) {
    lines.push(
      `  • skipped entries hidden by default; inspect resumeReusePlan for ${planner.skipped} audit/debug item(s)`,
    );
  }
  return lines;
}
