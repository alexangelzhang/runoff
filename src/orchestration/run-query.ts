import type { EventLog } from "./event-log.js";
import type { RunState, RunStatus, RunStore } from "./run-store.js";

export type RunNextAction =
  | "wait"
  | "approve_or_reject"
  | "inspect_trace"
  | "resume_from_checkpoint"
  | "no_action";

export interface RunSummary {
  runId: string;
  sessionId: string;
  status: RunStatus;
  pipelineStatus?: string;
  round: number;
  resumeToken?: string;
  pendingApproval?: RunState["pendingApproval"];
  createdAt: number;
  updatedAt: number;
  eventCursor?: number;
  nextAction: RunNextAction;
  nextHint: string;
}

export interface RunQueryResult {
  format: "summary" | "full";
  controlPlaneMode: "memory" | "file";
  runs: Array<RunSummary | RunState>;
  count: number;
  eventCount?: number;
}

export function runNextAction(run: RunState): { action: RunNextAction; hint: string } {
  const pipelineStatus = typeof run.metadata?.pipelineStatus === "string" ? run.metadata.pipelineStatus : undefined;
  if (pipelineStatus === "awaiting_judge") {
    return { action: "approve_or_reject", hint: "Choose a race winner with runoff_race_apply or abort with runoff_race_abort." };
  }
  if (pipelineStatus === "awaiting_plan_approval" || pipelineStatus === "awaiting_approval") {
    return { action: "approve_or_reject", hint: "Resume with runoff_run_pipeline and approvalDecision approve or reject." };
  }
  if (pipelineStatus === "max_rounds") {
    return { action: "inspect_trace", hint: "Inspect the trace/postmortem; max rounds were reached before approval." };
  }

  switch (run.status) {
    case "running":
      return { action: "wait", hint: "Run is active; poll runoff_query_runs or inspect trace output." };
    case "paused":
      return { action: "resume_from_checkpoint", hint: "Resume with runoff_run_pipeline using sessionId/resumeToken and matching request fields." };
    case "awaiting_approval":
      return { action: "approve_or_reject", hint: "Resume with runoff_run_pipeline and approvalDecision approve or reject." };
    case "failed":
      return { action: "inspect_trace", hint: "Inspect the trace/postmortem before retrying or changing the prompt/config." };
    case "completed":
    case "cancelled":
      return { action: "no_action", hint: "Run is terminal; inspect trace only if audit details are needed." };
  }
}

export function summarizeRun(run: RunState, eventLog?: EventLog): RunSummary {
  const next = runNextAction(run);
  const events = eventLog?.replay(run.runId);
  const pipelineStatus = typeof run.metadata?.pipelineStatus === "string" ? run.metadata.pipelineStatus : undefined;
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    status: run.status,
    pipelineStatus,
    round: run.round,
    resumeToken: run.resumeToken,
    pendingApproval: run.pendingApproval,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    eventCursor: events?.at(-1)?.seq,
    nextAction: next.action,
    nextHint: next.hint,
  };
}

export function queryRuns(args: {
  runStore: RunStore;
  eventLog?: EventLog;
  controlPlaneMode: "memory" | "file";
  status?: RunStatus;
  sessionId?: string;
  runId?: string;
  limit?: number;
  format?: "summary" | "full";
}): RunQueryResult {
  const format = args.format ?? "summary";
  const loaded = args.runId ? [args.runStore.load(args.runId)].flatMap((run) => (run ? [run] : [])) : args.runStore.list({
    status: args.status,
    sessionId: args.sessionId,
  });
  const sorted = loaded.sort((a, b) => b.updatedAt - a.updatedAt);
  const limited = args.limit ? sorted.slice(0, args.limit) : sorted;
  const runs = format === "full" ? limited : limited.map((run) => summarizeRun(run, args.eventLog));

  return {
    format,
    controlPlaneMode: args.controlPlaneMode,
    runs,
    count: runs.length,
    eventCount: args.eventLog?.length,
  };
}
