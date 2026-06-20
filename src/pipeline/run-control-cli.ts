/**
 * CLI helpers for `pipeline runs` commands.
 */

import { loadConfigFromPath } from "../core/config.js";
import { createControlPlane } from "../orchestration/control-plane.js";
import type { RunStatus } from "../orchestration/run-store.js";
import { queryRuns, type RunSummary } from "../orchestration/run-query.js";

export type RunsListOptions = {
  configPath: string;
  status?: RunStatus;
  sessionId?: string;
  limit?: number;
  json?: boolean;
};

export type RunsShowOptions = {
  configPath: string;
  runId: string;
  json?: boolean;
};

export function runsList(opts: RunsListOptions): void {
  const config = loadConfigFromPath(opts.configPath);
  const controlPlane = createControlPlane(config);
  const result = queryRuns({
    runStore: controlPlane.runStore,
    eventLog: controlPlane.eventLog,
    controlPlaneMode: controlPlane.mode,
    status: opts.status,
    sessionId: opts.sessionId,
    limit: opts.limit,
    format: "summary",
  });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.runs.length === 0) {
    console.log(`No runs found. controlPlane=${result.controlPlaneMode}`);
    return;
  }

  for (const run of result.runs as RunSummary[]) {
    console.log(formatRunSummary(run));
  }
  console.log(`\n${result.count} run(s), controlPlane=${result.controlPlaneMode}, events=${result.eventCount ?? 0}`);
}

export function runsShow(opts: RunsShowOptions): void {
  const config = loadConfigFromPath(opts.configPath);
  const controlPlane = createControlPlane(config);
  const result = queryRuns({
    runStore: controlPlane.runStore,
    eventLog: controlPlane.eventLog,
    controlPlaneMode: controlPlane.mode,
    runId: opts.runId,
    format: opts.json ? "full" : "summary",
  });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const run = result.runs[0] as RunSummary | undefined;
  if (!run) throw new Error(`Run not found: ${opts.runId}`);
  console.log(formatRunDetails(run, result.controlPlaneMode, result.eventCount ?? 0));
}

function formatRunSummary(run: RunSummary): string {
  const pipelineStatus = run.pipelineStatus ? ` pipeline=${run.pipelineStatus}` : "";
  const cursor = run.eventCursor !== undefined ? ` event=${run.eventCursor}` : "";
  return `${new Date(run.updatedAt).toISOString()}  ${run.runId}  ${run.status.padEnd(17)}${pipelineStatus}  session=${run.sessionId} round=${run.round}${cursor} next=${run.nextAction}`;
}

function formatRunDetails(run: RunSummary, controlPlaneMode: string, eventCount: number): string {
  const lines = [
    `runId:        ${run.runId}`,
    `sessionId:    ${run.sessionId}`,
    `status:       ${run.status}`,
    `pipeline:     ${run.pipelineStatus ?? "—"}`,
    `round:        ${run.round}`,
    `resumeToken:  ${run.resumeToken ?? "—"}`,
    `eventCursor:  ${run.eventCursor ?? "—"}`,
    `controlPlane: ${controlPlaneMode}`,
    `events:       ${eventCount}`,
    `nextAction:   ${run.nextAction}`,
    `nextHint:     ${run.nextHint}`,
  ];
  if (run.pendingApproval) {
    lines.push(
      "",
      "pendingApproval:",
      `  requestId:   ${run.pendingApproval.requestId ?? "—"}`,
      `  phase:       ${run.pendingApproval.phase ?? "—"}`,
      `  agentId:     ${run.pendingApproval.agentId}`,
      `  action:      ${run.pendingApproval.action}`,
      `  description: ${run.pendingApproval.description}`,
    );
  }
  return lines.join("\n");
}
