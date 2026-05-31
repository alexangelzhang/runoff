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
import type { DreamBatchItem } from "./dream-structured.js";
import {
  applyMemoryForgetPass,
  DEFAULT_FORGET_BELOW_RELEVANCE,
} from "../memory/memory-forget-pass.js";

/** Metadata keys for Dream B7 globalKnowledge → lesson promotion. */
const EVIDENCE_TRACE_META = "evidenceTraceId";
const GLOBAL_KNOWLEDGE_KEY_META = "globalKnowledgeKey";

function globalKnowledgeKeyFromLessonMeta(
  meta: Record<string, unknown> | undefined,
  traceId: string,
): string | undefined {
  if (!meta || meta[EVIDENCE_TRACE_META] !== traceId) return undefined;
  const key = meta[GLOBAL_KNOWLEDGE_KEY_META];
  return typeof key === "string" ? key : undefined;
}

function buildPromotedGkLessonMetadata(traceId: string, key: string): Record<string, unknown> {
  return {
    [EVIDENCE_TRACE_META]: traceId,
    sourceAgent: "dream-rules",
    [GLOBAL_KNOWLEDGE_KEY_META]: key,
    promotedFrom: "globalKnowledge",
  };
}

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
  /** Promote approved-run globalKnowledge to lesson entries. */
  promoteGlobalKnowledge?: boolean;
  /** Skip insight values shorter than this (default 24). */
  globalKnowledgeMinLength?: number;
}

export interface DreamRulesResult {
  audits: DreamAuditEntry[];
  patternsAdded: number;
  patternsUpdated: number;
  lessonsStored: number;
  globalKnowledgePromoted: number;
  contradicted: number;
  relevanceUpdated: number;
  forgotten: number;
}

const DREAM_AGENT = agentId("dream-rules");
const FORGET_THRESHOLD = DEFAULT_FORGET_BELOW_RELEVANCE;
const DEFAULT_GK_MIN_LENGTH = 24;

function buildGkPromotedIndex(
  memory: AgentMemory,
  scope: Partial<MemoryScope>,
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const entry of memory.retrieve({ category: "lesson", scope })) {
    const traceId =
      typeof entry.metadata?.evidenceTraceId === "string" ? entry.metadata.evidenceTraceId : undefined;
    if (!traceId) continue;
    const key = globalKnowledgeKeyFromLessonMeta(entry.metadata, traceId);
    if (!key) continue;
    let keys = index.get(traceId);
    if (!keys) {
      keys = new Set();
      index.set(traceId, keys);
    }
    keys.add(key);
  }
  return index;
}

function safeAppendDreamAudit(
  audits: DreamAuditEntry[],
  traceId: string,
  row: DreamAuditEntry,
  failRuleId: string,
): void {
  try {
    appendDreamAudit(row);
  } catch (err: unknown) {
    audit(
      audits,
      traceId,
      failRuleId,
      "SKIP",
      err instanceof Error ? err.message : String(err),
    );
  }
}

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
  const promoteGk = options.promoteGlobalKnowledge === true;
  const gkMinLength = options.globalKnowledgeMinLength ?? DEFAULT_GK_MIN_LENGTH;
  const patternCache = new PatternCache(memory, scope);
  const audits: DreamAuditEntry[] = [];
  let patternsAdded = 0;
  let patternsUpdated = 0;
  let lessonsStored = 0;
  let globalKnowledgePromoted = 0;
  let contradicted = 0;
  let relevanceUpdated = 0;
  const gkPromotedByTrace = promoteGk ? buildGkPromotedIndex(memory, scope) : new Map<string, Set<string>>();

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
        safeAppendDreamAudit(audits, item.traceId, row, "B4-audit-fail");
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
          safeAppendDreamAudit(audits, item.traceId, row, "B1-audit-fail");
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
            safeAppendDreamAudit(audits, item.traceId, row, "B2-audit-fail");
          }
        }
      }

      if (promoteGk && item.globalKnowledge) {
        let alreadyPromoted = gkPromotedByTrace.get(item.traceId);
        if (!alreadyPromoted) {
          alreadyPromoted = new Set<string>();
          gkPromotedByTrace.set(item.traceId, alreadyPromoted);
        }
        for (const [key, value] of Object.entries(item.globalKnowledge)) {
          if (!key.trim() || key.startsWith("_")) continue;
          if (typeof value !== "string") {
            audit(audits, item.traceId, "B7-global-knowledge-skip", "SKIP", `non-string key=${key}`);
            continue;
          }
          const trimmed = value.trim();
          if (trimmed.length < gkMinLength) continue;
          if (alreadyPromoted.has(key)) {
            audit(audits, item.traceId, "B7-global-knowledge-skip", "SKIP", `duplicate key=${key}`);
            continue;
          }
          const content = `${key}: ${trimmed}`;
          if (!dryRun) {
            const stored = memory.store({
              agentId: DREAM_AGENT,
              scope,
              category: "lesson",
              content,
              relevance: 0.65,
              metadata: buildPromotedGkLessonMetadata(item.traceId, key),
            });
            const row = audit(
              audits,
              item.traceId,
              "B7-global-knowledge-promote",
              "LESSON",
              key,
              stored.id,
            );
            safeAppendDreamAudit(audits, item.traceId, row, "B7-global-knowledge-audit-fail");
            globalKnowledgePromoted++;
          } else {
            globalKnowledgePromoted++;
            audit(audits, item.traceId, "B7-global-knowledge-promote", "LESSON", `dry-run key=${key}`);
          }
          alreadyPromoted.add(key);
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
        safeAppendDreamAudit(audits, item.traceId, row, "B3-audit-fail");
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
        safeAppendDreamAudit(audits, item.traceId, row, "B5-audit-fail");
      }
    }
  }

  let forgotten = 0;
  const forgetPass = applyMemoryForgetPass(memory, {
    scope,
    forgetBelowRelevance: forgetBelow,
    dryRun,
    onCandidate: (info) => {
      const row = audit(
        audits,
        info.evidenceTraceId,
        info.reason === "ttl" ? "B6-forget-ttl" : "B6-forget-decay",
        "FORGET",
        dryRun ? `dry-run ${info.memoryId}` : `rel=${info.relevance.toFixed(3)}`,
        info.memoryId,
      );
      if (!dryRun) {
        safeAppendDreamAudit(audits, row.traceId, row, "B6-audit-fail");
      }
    },
  });
  forgotten = dryRun ? forgetPass.candidateCount : forgetPass.forgotten;

  return {
    audits,
    patternsAdded,
    patternsUpdated,
    lessonsStored,
    globalKnowledgePromoted,
    contradicted,
    relevanceUpdated,
    forgotten,
  };
}
