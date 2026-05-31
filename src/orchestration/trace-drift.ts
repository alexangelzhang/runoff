/**
 * Phase 8.3.8 — Time-bucket metrics and drift detection (Arize-style).
 */

import type { PipelineTrace } from "../observability/trace.js";

export interface TraceBucketMetrics {
  bucketStart: number;
  bucketEnd: number;
  count: number;
  approvalRate: number;
  avgDurationMs: number;
  avgTokens: number;
}

export type DriftSeverity = "info" | "warning" | "critical";

export interface DriftAlert {
  metric: "approvalRate" | "avgDurationMs" | "avgTokens";
  severity: DriftSeverity;
  message: string;
  baseline: number;
  recent: number;
  relativeDelta: number;
}

export interface DriftDetectionOptions {
  /** Relative change threshold (e.g. 0.25 = 25%). */
  threshold?: number;
  minBucketCount?: number;
}

const DEFAULT_THRESHOLD = 0.25;

function traceTokens(trace: PipelineTrace): number {
  if (trace.totalUsage) {
    return trace.totalUsage.promptTokens + trace.totalUsage.completionTokens;
  }
  return trace.steps.reduce((sum, s) => {
    if (!s.usage) return sum;
    return sum + s.usage.promptTokens + s.usage.completionTokens;
  }, 0);
}

/** Bucket traces by fixed time window (ms). */
export function bucketTracesByTime(
  traces: PipelineTrace[],
  bucketSizeMs: number,
): TraceBucketMetrics[] {
  if (traces.length === 0 || bucketSizeMs <= 0) return [];

  const sorted = [...traces].sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
  const start = Date.parse(sorted[0]!.timestamp);
  const end = Date.parse(sorted[sorted.length - 1]!.timestamp);
  const buckets: TraceBucketMetrics[] = [];

  for (let t = start; t <= end; t += bucketSizeMs) {
    const bucketEnd = t + bucketSizeMs;
    const inBucket = sorted.filter((tr) => {
      const ts = Date.parse(tr.timestamp);
      return ts >= t && ts < bucketEnd;
    });
    if (inBucket.length === 0) continue;

    const approved = inBucket.filter((tr) => tr.finalStatus === "approved").length;
    const totalDuration = inBucket.reduce((s, tr) => s + tr.totalDurationMs, 0);
    const totalTokens = inBucket.reduce((s, tr) => s + traceTokens(tr), 0);

    buckets.push({
      bucketStart: t,
      bucketEnd,
      count: inBucket.length,
      approvalRate: approved / inBucket.length,
      avgDurationMs: totalDuration / inBucket.length,
      avgTokens: totalTokens / inBucket.length,
    });
  }

  return buckets;
}

/**
 * Compare recent buckets vs earlier baseline buckets for drift.
 */
export function detectTraceDrift(
  buckets: TraceBucketMetrics[],
  options: DriftDetectionOptions = {},
): DriftAlert[] {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const minCount = options.minBucketCount ?? 2;
  if (buckets.length < minCount * 2) return [];

  const mid = Math.floor(buckets.length / 2);
  const baseline = buckets.slice(0, mid);
  const recent = buckets.slice(mid);
  if (baseline.length === 0 || recent.length === 0) return [];

  const avg = (arr: TraceBucketMetrics[], pick: (b: TraceBucketMetrics) => number) => {
    const weights = arr.map((b) => b.count);
    const total = weights.reduce((a, b) => a + b, 0);
    if (total === 0) return 0;
    return arr.reduce((s, b, i) => s + pick(b) * weights[i]!, 0) / total;
  };

  const pairs: Array<{
    metric: DriftAlert["metric"];
    baseline: number;
    recent: number;
    higherIsBad?: boolean;
  }> = [
    { metric: "approvalRate", baseline: avg(baseline, (b) => b.approvalRate), recent: avg(recent, (b) => b.approvalRate), higherIsBad: false },
    { metric: "avgDurationMs", baseline: avg(baseline, (b) => b.avgDurationMs), recent: avg(recent, (b) => b.avgDurationMs), higherIsBad: true },
    { metric: "avgTokens", baseline: avg(baseline, (b) => b.avgTokens), recent: avg(recent, (b) => b.avgTokens), higherIsBad: true },
  ];

  const alerts: DriftAlert[] = [];
  for (const p of pairs) {
    if (p.baseline === 0 && p.recent === 0) continue;
    const denom = Math.max(Math.abs(p.baseline), 1e-6);
    const relativeDelta = (p.recent - p.baseline) / denom;
    const worsened = p.higherIsBad ? relativeDelta > threshold : relativeDelta < -threshold;
    if (!worsened) continue;

    const severity: DriftSeverity =
      Math.abs(relativeDelta) > threshold * 2 ? "critical" : "warning";

    alerts.push({
      metric: p.metric,
      severity,
      message: `${p.metric} drift: baseline=${p.baseline.toFixed(3)} recent=${p.recent.toFixed(3)} (${(relativeDelta * 100).toFixed(1)}%)`,
      baseline: p.baseline,
      recent: p.recent,
      relativeDelta,
    });
  }

  return alerts;
}
