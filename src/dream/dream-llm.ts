/**
 * Dream track C — optional LLM enrichment (lessons, summaries, judge proposals).
 */

import type { PipelineConfig } from "../core/config.js";
import { createProvider } from "../core/config.js";
import type { LLMProvider } from "../providers/types.js";
import type { DreamBatchItem } from "./dream-structured.js";
import { loadTraceById } from "../observability/trace.js";
import type { AgentMemory, MemoryScope } from "../orchestration/memory.js";
import { agentId } from "../orchestration/multi-agent-types.js";
import { hashPrompt } from "../orchestration/pattern-cache.js";

export type DreamLlmAction = "ADD" | "UPDATE" | "CONTRADICT" | "IGNORE";

export interface DreamLlmProposal {
  action: DreamLlmAction;
  category: "lesson" | "trace_summary";
  content: string;
  evidenceTraceId: string;
}

export interface DreamLlmOptions {
  maxItems?: number;
  providerName?: string;
}

export interface DreamLlmResult {
  proposals: DreamLlmProposal[];
  errors: string[];
}

function resolveDreamProvider(config: PipelineConfig, name?: string): LLMProvider | null {
  if (name && config.providers[name]) {
    return createProvider(name, config.providers[name]!);
  }
  const configured = config.orchestration?.dream?.provider;
  if (configured && config.providers[configured]) {
    return createProvider(configured, config.providers[configured]!);
  }
  for (const [key, pc] of Object.entries(config.providers)) {
    if (pc.type === "mock") return createProvider(key, pc);
  }
  return null;
}

function buildDreamPrompt(items: DreamBatchItem[]): string {
  const payload = items.map((i) => ({
    traceId: i.traceId,
    status: i.finalStatus,
    prompt: i.prompt.slice(0, 200),
    providers: i.providers,
    tokens: i.totalTokens,
    errors: i.steps.filter((s) => s.error).map((s) => s.error),
  }));
  return [
    "Analyze these pipeline run summaries. Output JSON only:",
    '{"proposals":[{"action":"ADD|UPDATE|CONTRADICT|IGNORE","category":"lesson|trace_summary","content":"...","evidenceTraceId":"..."}]}',
    "Rules: approved runs → trace_summary; failed → lesson; max 3 proposals.",
    JSON.stringify(payload),
  ].join("\n");
}

function parseDreamLlmJson(text: string): DreamLlmProposal[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as {
      proposals?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(parsed.proposals)) return [];
    const out: DreamLlmProposal[] = [];
    for (const p of parsed.proposals) {
      const action = p.action as DreamLlmAction;
      const category = p.category as DreamLlmProposal["category"];
      const content = typeof p.content === "string" ? p.content : "";
      const evidenceTraceId = typeof p.evidenceTraceId === "string" ? p.evidenceTraceId : "";
      if (!content || !evidenceTraceId) continue;
      if (!["ADD", "UPDATE", "CONTRADICT", "IGNORE"].includes(action)) continue;
      if (category !== "lesson" && category !== "trace_summary") continue;
      out.push({ action, category, content, evidenceTraceId });
    }
    return out;
  } catch {
    return [];
  }
}

export async function enrichDreamBatchWithLlm(
  config: PipelineConfig,
  items: DreamBatchItem[],
  options: DreamLlmOptions = {},
): Promise<DreamLlmResult> {
  const maxItems = options.maxItems ?? 10;
  const slice = items.slice(0, maxItems);
  const provider = resolveDreamProvider(config, options.providerName);
  if (!provider) {
    return { proposals: [], errors: ["no LLM provider for dream (set orchestration.dream.provider)"] };
  }

  try {
    const res = await provider.execute({
      prompt: buildDreamPrompt(slice),
      stepName: "dream-enrich",
      round: 1,
    });
    const text = res.kind === "text" ? res.content : res.summary ?? "";
    const proposals = parseDreamLlmJson(text);
    const valid = proposals.filter((p) => slice.some((i) => i.traceId === p.evidenceTraceId));
    return { proposals: valid, errors: [] };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { proposals: [], errors: [message] };
  }
}

export interface ApplyDreamLlmOptions {
  scope?: { project?: string };
  dryRun?: boolean;
}

export function applyDreamLlmProposals(
  memory: AgentMemory,
  proposals: DreamLlmProposal[],
  options: ApplyDreamLlmOptions = {},
): number {
  const scope: Partial<MemoryScope> = { project: options.scope?.project ?? "default" };
  const dryRun = options.dryRun ?? false;
  let applied = 0;
  const DREAM_LLM_AGENT = agentId("dream-llm");

  for (const p of proposals) {
    if (p.action === "IGNORE") continue;
    const trace = loadTraceById(p.evidenceTraceId);
    if (!trace) continue;

    if (p.action === "CONTRADICT") {
      const patterns = memory.retrieve({
        category: "pattern",
        scope,
        textSearch: `promptHash:${hashPrompt(trace.prompt)}`,
        limit: 32,
      });
      for (const row of patterns) {
        if (dryRun) {
          applied++;
          continue;
        }
        memory.patchMetadata(row.id, {
          invalidated: true,
          invalidatedByTraceId: p.evidenceTraceId,
          dreamLlm: true,
        });
        applied++;
      }
      continue;
    }

    if (p.action === "ADD" || p.action === "UPDATE") {
      if (dryRun) {
        applied++;
        continue;
      }
      memory.store({
        agentId: DREAM_LLM_AGENT,
        scope,
        category: p.category,
        content: p.content,
        relevance: p.action === "ADD" ? 0.7 : 0.75,
        metadata: {
          evidenceTraceId: p.evidenceTraceId,
          sourceAgent: "dream-llm",
          dreamAction: p.action,
        },
      });
      applied++;
    }
  }
  return applied;
}
