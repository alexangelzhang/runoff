/**
 * CLI helpers for `pipeline traces` commands.
 */

import { watch } from "node:fs";
import { getTracesDir } from "../core/paths.js";
import {
  queryTraces,
  loadTraceById,
  type TraceQuery,
} from "../observability/trace.js";
import { buildTracePostmortem } from "../observability/trace-postmortem.js";

export type TracesListOptions = TraceQuery & { json?: boolean };

export function tracesList(opts: TracesListOptions): void {
  const traces = queryTraces(opts);
  if (opts.json) {
    console.log(JSON.stringify(traces, null, 2));
    return;
  }
  if (traces.length === 0) {
    console.log("No traces found.");
    return;
  }
  for (const t of traces) {
    console.log(
      `${t.timestamp}  ${t.id}  ${t.finalStatus.padEnd(14)}  session=${t.sessionId ?? "—"}  steps=${t.steps.length}  ${t.totalDurationMs}ms`,
    );
  }
  console.log(`\n${traces.length} trace(s)`);
}

export function tracesShow(traceId: string, opts: { postmortem?: boolean; json?: boolean }): void {
  const trace = loadTraceById(traceId);
  if (!trace) {
    throw new Error(`Trace not found: ${traceId}`);
  }
  if (opts.postmortem) {
    const pm = buildTracePostmortem(trace);
    console.log(opts.json ? JSON.stringify(pm, null, 2) : formatPostmortemText(pm));
    return;
  }
  console.log(opts.json ? JSON.stringify(trace, null, 2) : JSON.stringify(trace, null, 2));
}

function formatPostmortemText(pm: ReturnType<typeof buildTracePostmortem>): string {
  const lines = [
    pm.headline,
    `trace=${pm.traceId} session=${pm.sessionId ?? "—"} status=${pm.finalStatus}`,
  ];
  if (pm.failedSteps.length) {
    lines.push("\nFailed / revision steps:");
    for (const s of pm.failedSteps) {
      lines.push(`  - ${s.name} (${s.provider}, round ${s.round}): ${s.error ?? s.errorDetail?.message ?? "—"}`);
    }
  }
  if (pm.hints.length) {
    lines.push("\nHints:");
    for (const h of pm.hints) lines.push(`  • ${h}`);
  }
  if (pm.driftAlerts.length) {
    lines.push("\nDrift alerts:");
    for (const a of pm.driftAlerts) lines.push(`  [${a.severity}] ${a.message}`);
  }
  if (pm.humanScores.length) {
    lines.push("\nScores:");
    for (const sc of pm.humanScores) {
      lines.push(`  ${sc.name}=${sc.value}${sc.comment ? ` (${sc.comment})` : ""}`);
    }
  }
  return lines.join("\n");
}

export function tracesTail(opts: { intervalMs?: number; once?: boolean }): void {
  const dir = getTracesDir();
  const seen = new Set<string>();
  const poll = () => {
    const traces = queryTraces({ limit: 5 });
    for (const t of traces) {
      const key = `${t.id}:${t.finalStatus}:${t.steps.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`[trace] ${t.timestamp} ${t.id} ${t.finalStatus} (${t.steps.length} steps)`);
    }
  };
  poll();
  if (opts.once) return;

  const interval = opts.intervalMs ?? 2000;
  try {
    watch(dir, { recursive: false }, () => poll());
  } catch {
    setInterval(poll, interval);
  }
  console.log(`Watching ${dir} (Ctrl+C to stop)…`);
}
