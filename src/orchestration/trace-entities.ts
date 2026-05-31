/**
 * Phase 8.1.6 — Trace entity relations (provider → file → verdict), Zep-style graph edges.
 */

import type { PipelineTrace, StepTrace } from "../observability/trace.js";
import type { PipelineStatus } from "../core/state.js";
import { hashPrompt } from "./pattern-cache.js";
import type { AgentMemory, MemoryEntry, MemoryScope } from "./memory.js";
import { agentId } from "./multi-agent-types.js";

export interface TraceEntityTriple {
  provider: string;
  file: string;
  verdict: string;
  traceId?: string;
  stepName?: string;
}

const ENTITY_AGENT_ID = agentId("trace-entities");
const ENTITY_CATEGORY = "entity_relation" as const;
const DEFAULT_SCOPE: MemoryScope = { project: "default" };

export function tripleKey(provider: string, file: string, verdict: string): string {
  return `${provider}|${file}|${verdict}`;
}

export function tripleContent(triple: TraceEntityTriple): string {
  return `triple:${tripleKey(triple.provider, triple.file, triple.verdict)}`;
}

function stepVerdict(step: StepTrace, trace: PipelineTrace): string {
  if (step.verdict) return step.verdict;
  if (step.error) return "failed";
  return trace.finalStatus;
}

function candidateVerdict(c: NonNullable<PipelineTrace["candidates"]>[number]): string {
  if (c.isWinner) return "approved";
  if (c.failed) return "failed";
  return "skipped";
}

/** Extract unique provider→file→verdict triples from a pipeline trace. */
export function extractEntityTriples(trace: PipelineTrace): TraceEntityTriple[] {
  const seen = new Set<string>();
  const out: TraceEntityTriple[] = [];

  const push = (triple: TraceEntityTriple) => {
    const key = tripleKey(triple.provider, triple.file, triple.verdict);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...triple, traceId: trace.id });
  };

  for (const step of trace.steps) {
    const verdict = stepVerdict(step, trace);
    for (const file of step.filesModified ?? []) {
      if (!file) continue;
      push({ provider: step.provider, file, verdict, stepName: step.name });
    }
  }

  for (const c of trace.candidates ?? []) {
    const verdict = candidateVerdict(c);
    for (const file of c.filesModified ?? []) {
      if (!file) continue;
      push({ provider: c.provider, file, verdict });
    }
  }

  return out;
}

function relevanceForVerdict(verdict: string): number {
  if (verdict === "approved") return 0.85;
  if (verdict === "needs_revision") return 0.55;
  if (verdict === "failed") return 0.35;
  return 0.45;
}

/**
 * Persist triples into AgentMemory (upsert by provider|file|verdict).
 * Returns count of entries created or updated.
 */
export function storeEntityTriplesFromTrace(
  memory: AgentMemory,
  trace: PipelineTrace,
  scope: MemoryScope = DEFAULT_SCOPE,
): number {
  const triples = extractEntityTriples(trace);
  if (triples.length === 0) return 0;

  const promptHash = hashPrompt(trace.prompt);
  let touched = 0;

  for (const triple of triples) {
    const content = tripleContent(triple);
    const existing = memory.retrieve({
      agentId: ENTITY_AGENT_ID,
      category: ENTITY_CATEGORY,
      scope,
      textSearch: content,
      limit: 1,
    })[0];

    const recordedAt = new Date().toISOString();
    const meta = {
      provider: triple.provider,
      file: triple.file,
      verdict: triple.verdict,
      promptHash,
      lastTraceId: trace.id,
      stepName: triple.stepName,
      hitCount: 1,
      /** M4: fact time (trace) vs ingestion time (Graphiti-style dual clock). */
      validAt: trace.timestamp,
      recordedAt,
    };

    if (existing) {
      const prevVerdict =
        typeof existing.metadata?.verdict === "string" ? existing.metadata.verdict : undefined;
      const prev = typeof existing.metadata?.hitCount === "number" ? existing.metadata.hitCount : 0;
      const patch: Record<string, unknown> = {
        ...existing.metadata,
        ...meta,
        hitCount: prev + 1,
        recordedAt,
      };
      if (prevVerdict && prevVerdict !== triple.verdict) {
        patch.invalidatedAt = recordedAt;
        patch.supersededByVerdict = triple.verdict;
      }
      memory.patchMetadata(existing.id, patch);
      const nextRel = Math.min(
        1,
        (existing.relevance ?? 0.5) + (trace.finalStatus === "approved" ? 0.05 : -0.03),
      );
      memory.updateRelevance(existing.id, nextRel);
      touched++;
      continue;
    }

    memory.store({
      agentId: ENTITY_AGENT_ID,
      scope,
      category: ENTITY_CATEGORY,
      content,
      metadata: meta,
      relevance: relevanceForVerdict(triple.verdict),
      ttlMs: 90 * 24 * 60 * 60 * 1000,
    });
    touched++;
  }

  return touched;
}

export interface EntityVerdictQuery {
  provider: string;
  file: string;
  scope?: MemoryScope;
}

/** Lookup stored verdict edges for a provider + file path. */
export function queryEntityVerdicts(
  memory: AgentMemory,
  query: EntityVerdictQuery,
): TraceEntityTriple[] {
  const scope = query.scope ?? DEFAULT_SCOPE;
  const entries = memory.retrieve({
    agentId: ENTITY_AGENT_ID,
    category: ENTITY_CATEGORY,
    scope,
    textSearch: query.provider,
    limit: 64,
  });

  return entries
    .map((e) => entryToTriple(e))
    .filter((t): t is TraceEntityTriple => t !== null && t.file === query.file && t.provider === query.provider);
}

function entryToTriple(entry: MemoryEntry): TraceEntityTriple | null {
  const m = entry.metadata;
  if (!m || typeof m.provider !== "string" || typeof m.file !== "string" || typeof m.verdict !== "string") {
    return null;
  }
  return {
    provider: m.provider,
    file: m.file,
    verdict: m.verdict,
    traceId: typeof m.lastTraceId === "string" ? m.lastTraceId : undefined,
    stepName: typeof m.stepName === "string" ? m.stepName : undefined,
  };
}

/** Prefer approved verdict when multiple edges exist for the same file. */
export function dominantVerdictForFile(
  memory: AgentMemory,
  query: EntityVerdictQuery,
): PipelineStatus | string | null {
  const edges = queryEntityVerdicts(memory, query);
  if (edges.length === 0) return null;
  const rank = (v: string) => (v === "approved" ? 3 : v === "needs_revision" ? 2 : v === "failed" ? 1 : 0);
  edges.sort((a, b) => rank(b.verdict) - rank(a.verdict));
  return edges[0]!.verdict;
}
