/**
 * Provider-level race merge strategies (P1): auto-merge / llm-merge / pick-winner.
 */

import type { Candidate } from "../core/candidate.js";
import { getCandidateContent } from "../core/candidate.js";
import { isSyntaxValid } from "../infra/ast_utils.js";
import { parseVerdict } from "../core/verdict.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../providers/types.js";
import { isAgentResponse, isTextResponse } from "../providers/types.js";
import { logger } from "../core/logger.js";

export type ProviderRaceResolution = "auto-merge" | "llm-merge" | "pick-winner";

export interface ProviderRaceEntry {
  provider: LLMProvider;
  providerName: string;
  resp: LLMResponse;
}

export interface ProviderRacePick {
  entry: ProviderRaceEntry;
  /** True when multiple provider outputs were combined. */
  merged: boolean;
  conflictFiles?: string[];
  mergeStrategy: ProviderRaceResolution;
}

function candidateFromResponse(resp: LLMResponse): Candidate | undefined {
  if (resp.failed) return undefined;
  if (isTextResponse(resp)) {
    return { code: resp.code, summary: resp.explanation, isAgent: false };
  }
  if (isAgentResponse(resp)) {
    return {
      changes: resp.changes,
      summary: resp.summary,
      filesModified: resp.filesModified ? [...resp.filesModified] : undefined,
      diffStat: resp.diffStat,
      isAgent: true,
    };
  }
  return undefined;
}

function detectFileConflicts(candidates: Candidate[]): string[] {
  const seen = new Set<string>();
  const conflicts: string[] = [];
  for (const c of candidates) {
    for (const f of c.filesModified ?? []) {
      if (seen.has(f) && !conflicts.includes(f)) conflicts.push(f);
      seen.add(f);
    }
  }
  return conflicts;
}

/** Merge disjoint file sets; fails when any file appears in more than one branch. */
export function autoMergeCandidates(candidates: Candidate[]): {
  ok: true;
  merged: Candidate;
} | {
  ok: false;
  conflicts: string[];
} {
  if (candidates.length === 0) {
    return { ok: false, conflicts: [] };
  }
  const conflicts = detectFileConflicts(candidates);
  if (conflicts.length > 0) return { ok: false, conflicts };

  const filesModified = new Set<string>();
  const parts: string[] = [];
  let isAgent = false;
  let summary: string | undefined;

  for (const c of candidates) {
    if (c.isAgent) isAgent = true;
    for (const f of c.filesModified ?? []) filesModified.add(f);
    const content = getCandidateContent(c);
    if (content) parts.push(content);
    if (c.summary && !summary) summary = c.summary;
  }

  const uniqueParts = [...new Set(parts.filter((p) => p.length > 0))];
  if (uniqueParts.length > 1 && filesModified.size === 0) {
    return { ok: false, conflicts: ["<content>"] };
  }

  const mergedContent = uniqueParts.join("\n\n");
  if (isAgent) {
    return {
      ok: true,
      merged: {
        changes: mergedContent,
        filesModified: [...filesModified],
        summary,
        isAgent: true,
      },
    };
  }
  return {
    ok: true,
    merged: {
      code: mergedContent,
      summary,
      isAgent: false,
    },
  };
}

function pickWinnerBySyntax(entries: ProviderRaceEntry[]): ProviderRaceEntry {
  const winners = entries.filter((e) => !e.resp.failed);
  const sorted = (winners.length > 0 ? winners : entries).sort((a, b) => {
    const aSyntax =
      isTextResponse(a.resp) && a.resp.code ? isSyntaxValid(a.resp.code) : true;
    const bSyntax =
      isTextResponse(b.resp) && b.resp.code ? isSyntaxValid(b.resp.code) : true;
    if (aSyntax && !bSyntax) return -1;
    if (!aSyntax && bSyntax) return 1;
    return 0;
  });
  return sorted[0]!;
}

function buildSyntheticTextResponse(merged: Candidate, model: string): LLMResponse {
  const code = merged.code ?? "";
  return {
    kind: "text",
    model,
    content: code,
    code,
    explanation: merged.summary ?? "Merged race outputs",
    failed: false,
  };
}

function buildSyntheticAgentResponse(
  merged: Candidate,
  template: LLMResponse,
): LLMResponse {
  if (!isAgentResponse(template)) {
    return buildSyntheticTextResponse(merged, "race-merge");
  }
  return {
    ...template,
    kind: "agent",
    failed: false,
    changes: merged.changes ?? template.changes,
    summary: merged.summary ?? template.summary,
    filesModified: merged.filesModified ?? template.filesModified,
    diffStat: merged.diffStat ?? template.diffStat,
  };
}

/** LLM merge for parallel branches or provider races (shared implementation). */
export async function mergeCandidatesWithLlm(
  candidates: Candidate[],
  provider: LLMProvider,
  options: { stepName: string; prompt: string; labels?: string[] },
): Promise<Candidate | undefined> {
  if (candidates.length === 0) return undefined;

  const blocks = candidates
    .map((c, i) => {
      const label = options.labels?.[i] ?? `candidate-${i + 1}`;
      const body = getCandidateContent(c);
      return `### ${label}\n${body || "(empty)"}`;
    })
    .join("\n\n");

  const req: LLMRequest = {
    prompt: [
      "Merge the following parallel outputs into one coherent implementation.",
      "Preserve all non-overlapping file changes. If two candidates edit the same file, prefer the more complete version.",
      "Return only the merged code or unified diff in a fenced code block.",
      "",
      `Task: ${options.prompt}`,
      "",
      blocks,
    ].join("\n"),
    stepName: `${options.stepName}:race-merge`,
    round: 1,
  };

  const resp = await provider.execute(req);
  return candidateFromResponse(resp);
}

async function llmMergeCandidates(
  entries: ProviderRaceEntry[],
  stepName: string,
  spec: string,
): Promise<Candidate | undefined> {
  const mergeProvider = entries.find((e) => !e.resp.failed)?.provider ?? entries[0]?.provider;
  if (!mergeProvider) return undefined;
  const candidates = entries
    .map((e) => candidateFromResponse(e.resp))
    .filter((c): c is Candidate => !!c);
  return mergeCandidatesWithLlm(candidates, mergeProvider, {
    stepName,
    prompt: spec,
    labels: entries.map((e) => e.providerName),
  });
}

/**
 * Select or merge parallel provider race outputs.
 */
export async function resolveProviderRaceWinner(
  entries: ProviderRaceEntry[],
  strategy: ProviderRaceResolution,
  options: { stepName: string; prompt: string },
): Promise<ProviderRacePick> {
  if (entries.length === 0) {
    throw new Error("resolveProviderRaceWinner: no race entries");
  }
  if (entries.length === 1 || strategy === "pick-winner") {
    return {
      entry: pickWinnerBySyntax(entries),
      merged: false,
      mergeStrategy: "pick-winner",
    };
  }

  const candidates = entries
    .map((e) => candidateFromResponse(e.resp))
    .filter((c): c is Candidate => !!c);

  if (strategy === "llm-merge") {
    const llmMerged = await llmMergeCandidates(entries, options.stepName, options.prompt);
    if (llmMerged) {
      const template = entries.find((e) => isAgentResponse(e.resp))?.resp ?? entries[0]!.resp;
      const mergedResp = isAgentResponse(template)
        ? buildSyntheticAgentResponse(llmMerged, template)
        : buildSyntheticTextResponse(llmMerged, "race-llm-merge");
      return {
        entry: { provider: entries[0]!.provider, providerName: entries[0]!.providerName, resp: mergedResp },
        merged: true,
        mergeStrategy: "llm-merge",
      };
    }
    logger.warn("race-merge", `llm-merge failed for ${options.stepName}, falling back to pick-winner`);
  }

  const auto = autoMergeCandidates(candidates);
  if (auto.ok) {
    const template = entries.find((e) => isAgentResponse(e.resp))?.resp ?? entries[0]!.resp;
    const mergedResp = isAgentResponse(template)
      ? buildSyntheticAgentResponse(auto.merged, template)
      : buildSyntheticTextResponse(auto.merged, "race-auto-merge");
    const host = entries[0]!;
    return {
      entry: { provider: host.provider, providerName: host.providerName, resp: mergedResp },
      merged: true,
      mergeStrategy: "auto-merge",
    };
  }

  logger.warn(
    "race-merge",
    `auto-merge conflicts for ${options.stepName}: ${auto.conflicts.join(", ")} — pick-winner`,
  );
  return {
    entry: pickWinnerBySyntax(entries),
    merged: false,
    conflictFiles: auto.conflicts,
    mergeStrategy: "pick-winner",
  };
}

/** Parse verdict from a race entry (for downstream step outcome). */
export function verdictFromRaceEntry(entry: ProviderRaceEntry): ReturnType<typeof parseVerdict> {
  const text = isTextResponse(entry.resp)
    ? entry.resp.content || ""
    : isAgentResponse(entry.resp)
      ? entry.resp.summary || ""
      : "";
  return parseVerdict(text);
}
