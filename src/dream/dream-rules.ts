/**
 * Dream track B — rule-based memory evolution (no LLM).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getPipelineHomeDir } from "../core/paths.js";
import type { PipelineTrace } from "../observability/trace.js";
import { loadTraceById } from "../observability/trace.js";
import type { AgentMemory, MemoryScope } from "../orchestration/memory.js";
import { agentId } from "../orchestration/multi-agent-types.js";
import { PatternCache, extractPattern } from "../orchestration/pattern-cache.js";
import { feedbackRelevanceFromTrace } from "../orchestration/memory-relevance.js";
import { decayedRelevance } from "../orchestration/memory-decay.js";
import type { DreamBatchItem } from "./dream-structured.js";

export type DreamRuleAction =
  | "ADD"
  | "UPDATE"
  | "CONTRADICT"
  | "FORGET"
  | "FEEDBACK"
  | "LESSON"
  | "SKIP";

export interface DreamAuditEntry {
  timestamp: string;
  traceId: string;
  ruleId: string;
  action: DreamRuleAction;
  memoryId?: string;
  detail?: string;
}

export interface DreamRulesOptions {
  scope?: Partial<MemoryScope>;
  /** Relevance threshold (decayed) below which entries are forgotten. */
  forgetBelowRelevance?: number;
  dryRun?: boolean;
}

export interface DreamRulesResult {
  audits: DreamAuditEntry[];
  patternsAdded: number;
  patternsUpdated: number;
  lessonsStored: number;
  contradicted: number;
  relevanceUpdated: number;
  forgotten: number;
}

const DREAM_AGENT = agentId("dream-rules");
const FORGET_THRESHOLD = 0.05;

export function getDreamAuditPath(): string {
  return `${getPipelineHomeDir()}/dream-audit.jsonl`;
}

export function appendDreamAudit(entry: DreamAuditEntry): void {
  const path = getDreamAuditPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
}

function audit(
  audits: DreamAuditEntry[],
  traceId: string,
  ruleId: string,
  action: DreamRuleAction,
  detail?: string,
  memoryId?: string,
): DreamAuditEntry {
  const row: DreamAuditEntry = {
    timestamp: new Date().toISOString(),
    traceId,
    ruleId,
    action,
    detail,
    memoryId,
  };
  audits.push(row);
  return row;
}

export function applyDreamRules(
  memory: AgentMemory,
  items: DreamBatchItem[],
  options: DreamRulesOptions = {},
): DreamRulesResult {
  const scope = options.scope ?? { project: "default" };
  const forgetBelow = options.forgetBelowRelevance ?? FORGET_THRESHOLD;
  const dryRun = options.dryRun ?? false;
  const patternCache = new PatternCache(memory, scope);
  const audits: DreamAuditEntry[] = [];
  let patternsAdded = 0;
  let patternsUpdated = 0;
  let lessonsStored = 0;
  let contradicted = 0;
  let relevanceUpdated = 0;

  for (const item of items) {
    const trace = loadTraceById(item.traceId);
    if (!trace) {
      audit(audits, item.traceId, "B0-missing-trace", "SKIP", "trace file not found");
      continue;
    }

    if (!dryRun) {
      const n = feedbackRelevanceFromTrace(memory, trace, scope);
      if (n > 0) {
        relevanceUpdated += n;
        const row = audit(audits, item.traceId, "B4-feedback-relevance", "FEEDBACK", `updated=${n}`);
        appendDreamAudit(row);
      }
    } else {
      audit(audits, item.traceId, "B4-feedback-relevance", "FEEDBACK", "dry-run");
    }

    if (item.finalStatus === "approved") {
      const existing = memory.retrieve({
        category: "pattern",
        scope,
        textSearch: `promptHash:${item.promptHash}`,
        limit: 8,
      });
      const pattern = extractPattern(trace);
      if (pattern) {
        if (existing.length === 0) {
          if (!dryRun) patternCache.storeFromTrace(trace);
          patternsAdded++;
          const row = audit(audits, item.traceId, "B1-pattern-add", "ADD", item.promptHash);
          appendDreamAudit(row);
        } else {
          const best = existing[0]!;
          const meta = best.metadata as { totalTokens?: number } | undefined;
          const prevTokens = meta?.totalTokens ?? Number.MAX_SAFE_INTEGER;
          if (item.totalTokens < prevTokens) {
            if (!dryRun) {
              memory.patchMetadata(best.id, {
                totalTokens: item.totalTokens,
                totalDurationMs: item.durationMs,
                evidenceTraceId: item.traceId,
              });
              memory.updateRelevance(best.id, Math.min(1, (best.relevance ?? 0.5) + 0.05));
            }
            patternsUpdated++;
            const row = audit(
              audits,
              item.traceId,
              "B2-pattern-update",
              "UPDATE",
              `tokens ${prevTokens}→${item.totalTokens}`,
              best.id,
            );
            appendDreamAudit(row);
          }
        }
      }
    } else {
      const lessonContent = [
        `Run ${item.finalStatus}: ${item.prompt.slice(0, 120)}`,
        `Providers: ${item.providers.join(" → ") || "none"}`,
        item.steps.find((s) => s.error)?.error ?? "",
      ]
        .filter(Boolean)
        .join(" | ");

      if (!dryRun) {
        const stored = memory.store({
          agentId: DREAM_AGENT,
          scope,
          category: "lesson",
          content: lessonContent,
          relevance: 0.55,
          metadata: {
            evidenceTraceId: item.traceId,
            sourceAgent: "dream-rules",
            promptHash: item.promptHash,
            finalStatus: item.finalStatus,
          },
        });
        lessonsStored++;
        const row = audit(audits, item.traceId, "B3-lesson-store", "LESSON", undefined, stored.id);
        appendDreamAudit(row);
      } else {
        audit(audits, item.traceId, "B3-lesson-store", "LESSON", "dry-run");
      }

      const patterns = memory.retrieve({
        category: "pattern",
        scope,
        textSearch: `promptHash:${item.promptHash}`,
        limit: 8,
      });
      for (const p of patterns) {
        if (!dryRun) {
          memory.patchMetadata(p.id, {
            invalidated: true,
            invalidatedByTraceId: item.traceId,
            invalidatedAt: new Date().toISOString(),
          });
          memory.updateRelevance(p.id, Math.max(0, (p.relevance ?? 0.5) - 0.25));
        }
        contradicted++;
        const row = audit(audits, item.traceId, "B5-pattern-contradict", "CONTRADICT", item.promptHash, p.id);
        appendDreamAudit(row);
      }
    }
  }

  let forgotten = 0;
  const now = Date.now();
  const candidates = memory.retrieve({ scope, limit: 10_000, includeExpired: true });
  for (const e of candidates) {
    const expired = e.ttlMs !== undefined && now - e.createdAt >= e.ttlMs;
    const rel = decayedRelevance(e.relevance ?? 0.5, now - e.createdAt);
    if (!expired && rel >= forgetBelow) continue;
    if (!dryRun && memory.forget(e.id)) {
      forgotten++;
      const row = audit(
        audits,
        e.metadata?.evidenceTraceId as string | undefined ?? "batch",
        expired ? "B6-forget-ttl" : "B6-forget-decay",
        "FORGET",
        `rel=${rel.toFixed(3)}`,
        e.id,
      );
      appendDreamAudit(row);
    } else if (dryRun) {
      audit(audits, "batch", expired ? "B6-forget-ttl" : "B6-forget-decay", "FORGET", `dry-run ${e.id}`);
    }
  }

  return {
    audits,
    patternsAdded,
    patternsUpdated,
    lessonsStored,
    contradicted,
    relevanceUpdated,
    forgotten,
  };
}
