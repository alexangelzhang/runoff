/**
 * Rubric-based judge for race candidates.
 *
 * Implements a simplified version of the Agentic Rubrics approach
 * (Scale AI, arXiv 2601.04171): generate a weighted checklist from
 * task description + diffs, then score each candidate patch against it.
 *
 * Two phases:
 *   1. generateRubric  — LLM produces rubric items across 4 axes
 *   2. scoreCandidate  — LLM scores one patch against the rubric (yes/no per item)
 */

import type { PipelineConfig } from "../core/config.js";
import { createProvider } from "../core/config.js";
import type { LLMProvider } from "../providers/types.js";
import { isTextResponse } from "../providers/types.js";

// --- Types ---

export type RubricAxis = "file_change" | "spec_alignment" | "integrity" | "runtime";
export type RubricWeight = 1 | 2 | 3; // 1=nice-to-have, 2=important, 3=must-have

export interface RubricItem {
  axis: RubricAxis;
  criterion: string;
  weight: RubricWeight;
}

export interface RubricScore {
  /** Weighted score in [0, 1]: Σ(weight × pass) / Σweights */
  score: number;
  items: Array<{
    criterion: string;
    axis: RubricAxis;
    weight: RubricWeight;
    pass: boolean;
    reasoning: string;
  }>;
}

export interface CandidateJudgement {
  providerName: string;
  score: number;
  rubricScore: RubricScore;
}

export interface RaceJudgeResult {
  rubric: RubricItem[];
  candidates: CandidateJudgement[];
  /** Sorted best-first by score */
  ranked: CandidateJudgement[];
  /** Index into the original candidates array for the winner */
  winnerIndex: number;
  judgeProvider: string;
}

// --- Prompt builders ---

function buildRubricGenPrompt(
  taskDescription: string,
  diffs: Array<{ provider: string; diff: string }>,
): string {
  const diffSummary = diffs
    .map((d) => `### ${d.provider}\n${d.diff.slice(0, 1500)}`)
    .join("\n\n");

  return `You are a code review expert generating evaluation criteria for competing patches.

## Task
${taskDescription}

## Candidate Diffs (for context only — generate criteria from task requirements, not by favouring a specific diff)
${diffSummary}

## Instructions
Generate a rubric checklist with 12–20 items across exactly these four axes:
- file_change (4–8 items): edits are minimal, local, and sufficient for the fix
- spec_alignment (3–6 items): patch satisfies the requirements in the task description
- integrity (3–6 items): no test weakening, no broad refactors, no unrelated dependency changes
- runtime (3–6 items): changes imply correct runtime behaviour, avoid obvious execution issues

Each item must be:
- Specific and binary (answerable yes/no by inspecting the diff)
- Grounded in the task description, not in a particular candidate's approach
- Assigned a weight: 1=nice-to-have, 2=important, 3=must-have

Output valid JSON only — no markdown, no explanation:
{
  "rubric": [
    { "axis": "file_change", "criterion": "...", "weight": 2 },
    ...
  ]
}`;
}

function buildScoringPrompt(
  taskDescription: string,
  rubric: RubricItem[],
  diff: string,
): string {
  const itemsJson = JSON.stringify(rubric, null, 2);
  return `You are a code review expert scoring a patch against a rubric checklist.

## Task
${taskDescription}

## Patch to evaluate
\`\`\`diff
${diff.slice(0, 8000)}
\`\`\`

## Rubric
${itemsJson}

## Instructions
For each rubric item, determine whether the patch satisfies it (pass: true/false).
Provide a one-sentence reasoning per item.

Output valid JSON only — no markdown, no explanation:
{
  "scores": [
    { "criterion": "...", "axis": "file_change", "weight": 2, "pass": true, "reasoning": "..." },
    ...
  ]
}`;
}

// --- Provider resolution ---

export function resolveJudgeProvider(
  config: PipelineConfig,
  excludeProviders: string[] = [],
): { provider: LLMProvider; name: string } | null {
  // Prefer a provider explicitly configured as judge (cast — field may be added in config)
  const judgeProviderName = (config.orchestration as Record<string, unknown> | undefined)
    ?.judgeProvider as string | undefined;
  if (judgeProviderName && config.providers[judgeProviderName]) {
    const pc = config.providers[judgeProviderName]!;
    if (!excludeProviders.includes(judgeProviderName) && pc.type !== "mock") {
      const p = createProvider(judgeProviderName, pc);
      if (p) return { provider: p, name: judgeProviderName };
    }
  }

  // Fall back: first text-mode provider not in exclusion list
  for (const [key, pc] of Object.entries(config.providers)) {
    if (excludeProviders.includes(key)) continue;
    if (pc.type === "mock") continue;
    const mode = (pc as { mode?: string }).mode ?? "text";
    if (mode !== "text") continue;
    const p = createProvider(key, pc);
    if (p) return { provider: p, name: key };
  }

  // Last resort: any non-excluded provider (including mock, for tests)
  for (const [key, pc] of Object.entries(config.providers)) {
    if (excludeProviders.includes(key)) continue;
    const p = createProvider(key, pc);
    if (p) return { provider: p, name: key };
  }

  return null;
}

// --- Core logic ---

export async function generateRubric(
  taskDescription: string,
  diffs: Array<{ provider: string; diff: string }>,
  provider: LLMProvider,
): Promise<RubricItem[]> {
  const prompt = buildRubricGenPrompt(taskDescription, diffs);
  const response = await provider.execute({ prompt });

  if (!isTextResponse(response) || response.failed) {
    throw new Error(`Rubric generation failed: ${response.error ?? "unknown error"}`);
  }

  const raw = extractJson(response.content);
  const parsed = JSON.parse(raw) as { rubric: RubricItem[] };
  if (!Array.isArray(parsed.rubric) || parsed.rubric.length === 0) {
    throw new Error("Rubric generation returned empty or invalid rubric array");
  }
  return parsed.rubric;
}

export async function scoreCandidate(
  taskDescription: string,
  rubric: RubricItem[],
  diff: string,
  provider: LLMProvider,
): Promise<RubricScore> {
  const prompt = buildScoringPrompt(taskDescription, rubric, diff);
  const response = await provider.execute({ prompt });

  if (!isTextResponse(response) || response.failed) {
    throw new Error(`Rubric scoring failed: ${response.error ?? "unknown error"}`);
  }

  const raw = extractJson(response.content);
  const parsed = JSON.parse(raw) as {
    scores: Array<{
      criterion: string;
      axis: RubricAxis;
      weight: RubricWeight;
      pass: boolean;
      reasoning: string;
    }>;
  };

  if (!Array.isArray(parsed.scores) || parsed.scores.length === 0) {
    throw new Error("Scoring returned empty or invalid scores array");
  }

  const totalWeight = parsed.scores.reduce((s, item) => s + item.weight, 0);
  const weightedPassed = parsed.scores.reduce(
    (s, item) => s + (item.pass ? item.weight : 0),
    0,
  );
  const score = totalWeight > 0 ? weightedPassed / totalWeight : 0;

  return { score, items: parsed.scores };
}

export async function judgeRaceCandidates(opts: {
  taskDescription: string;
  candidates: Array<{ providerName: string; diff: string }>;
  config: PipelineConfig;
  excludeProviders?: string[];
}): Promise<RaceJudgeResult> {
  const { taskDescription, candidates, config, excludeProviders = [] } = opts;

  const judgeResolved = resolveJudgeProvider(config, excludeProviders);
  if (!judgeResolved) {
    throw new Error(
      "No suitable judge provider found. Add a text-mode provider to pipeline.config.json, " +
      "or configure orchestration.judgeProvider.",
    );
  }
  const { provider: judgeProvider, name: judgeProviderName } = judgeResolved;

  // Phase 1: generate rubric from all diffs combined
  const diffs = candidates.map((c) => ({ provider: c.providerName, diff: c.diff }));
  const rubric = await generateRubric(taskDescription, diffs, judgeProvider);

  // Phase 2: score each candidate (sequential — same provider, same rubric)
  const judged: CandidateJudgement[] = [];
  for (const candidate of candidates) {
    const rubricScore = await scoreCandidate(
      taskDescription,
      rubric,
      candidate.diff,
      judgeProvider,
    );
    judged.push({
      providerName: candidate.providerName,
      score: rubricScore.score,
      rubricScore,
    });
  }

  const ranked = [...judged].sort((a, b) => b.score - a.score);
  const winner = ranked[0]!;
  const winnerIndex = candidates.findIndex((c) => c.providerName === winner.providerName);

  return {
    rubric,
    candidates: judged,
    ranked,
    winnerIndex,
    judgeProvider: judgeProviderName,
  };
}

// --- Helpers ---

/** Extract the first JSON object from an LLM response that may include prose. */
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON object found in response: ${text.slice(0, 200)}`);
  }
  return text.slice(start, end + 1);
}
