/**
 * Rubric-based judge for race candidates.
 *
 * Implements the Agentic Rubrics approach (Scale AI, arXiv 2601.04171):
 *   Phase 0 (optional): context agent explores the repo to gather codebase-specific context
 *   Phase 1: generate a weighted checklist from task description + repo context + diffs
 *   Phase 2: score each candidate patch against the rubric (yes/no per item)
 *
 * Without a context provider, falls back to single-shot rubric generation from diffs alone
 * (simplified mode — rubric items will be less codebase-specific).
 */

import type { PipelineConfig } from "../core/config.js";
import { createProvider } from "../core/config.js";
import type { LLMProvider } from "../providers/types.js";
import { isTextResponse, isAgentResponse } from "../providers/types.js";

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
  /** Whether agentic repo context was collected before rubric generation */
  agenticContext: boolean;
}

// --- Prompt builders ---

function buildContextCollectionPrompt(taskDescription: string): string {
  return `You are a senior engineer preparing to review candidate patches for a software fix.

## Task
${taskDescription}

## Your Goal
Explore the repository to understand:
1. Which files are relevant to this task (entry points, affected modules, test files)
2. Key functions, classes, or interfaces touched by this change
3. Existing patterns, constraints, or invariants the fix must respect
4. How similar past fixes were structured in this codebase

Use available file exploration tools (grep, find, view) to gather this context.
Do NOT attempt to write or modify any files.

When done, output a concise summary (under 600 words) covering:
- Relevant files and their roles
- Key code contracts or invariants to preserve
- Specific methods or types the fix must interact with
- Any edge cases implied by the existing code or tests`;
}

function buildRubricGenPrompt(
  taskDescription: string,
  diffs: Array<{ provider: string; diff: string }>,
  repoContext?: string,
): string {
  const diffSummary = diffs
    .map((d) => `### ${d.provider}\n${d.diff.slice(0, 1500)}`)
    .join("\n\n");

  const contextSection = repoContext
    ? `\n## Repository Context (from codebase exploration)\n${repoContext}\n`
    : "";

  return `You are a code review expert generating evaluation criteria for competing patches.

## Task
${taskDescription}
${contextSection}
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
- Grounded in the task description${repoContext ? " and repository context" : ""}, not in a particular candidate's approach
- Assigned a weight: 1=nice-to-have, 2=important, 3=must-have
${repoContext ? "\nUse the repository context to write codebase-specific criteria (e.g. naming specific methods, classes, or invariants found during exploration).\n" : ""}
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
  // Prefer a provider explicitly configured as judge
  const judgeProviderName = config.orchestration?.judgeProvider;
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

/** Resolve the agent-read provider for repo context collection. Returns null if none configured. */
function resolveContextProvider(
  config: PipelineConfig,
  excludeProviders: string[] = [],
): { provider: LLMProvider; name: string } | null {
  // Prefer explicitly configured context provider
  const contextProviderName = config.orchestration?.contextProvider;
  if (contextProviderName && config.providers[contextProviderName]) {
    const pc = config.providers[contextProviderName]!;
    if (!excludeProviders.includes(contextProviderName)) {
      const p = createProvider(contextProviderName, pc);
      if (p) return { provider: p, name: contextProviderName };
    }
  }

  // Fall back: first agent-read provider not in exclusion list
  for (const [key, pc] of Object.entries(config.providers)) {
    if (excludeProviders.includes(key)) continue;
    if (pc.type === "mock") continue;
    const mode = (pc as { mode?: string }).mode;
    if (mode !== "agent-read") continue;
    const p = createProvider(key, pc);
    if (p) return { provider: p, name: key };
  }

  return null;
}

// --- Core logic ---

/**
 * Phase 0 (optional): use an agent-read provider to explore the repo
 * and collect codebase-specific context for rubric generation.
 * Returns null if no suitable provider is available (graceful degradation).
 */
export async function collectRepoContext(
  taskDescription: string,
  repoPath: string,
  provider: LLMProvider,
): Promise<string | null> {
  try {
    const prompt = buildContextCollectionPrompt(taskDescription);
    const response = await provider.execute({ prompt, workDir: repoPath });

    if (response.failed) return null;

    // agent-read returns AgentResponse; the summary field holds the exploration output
    if (isAgentResponse(response)) {
      return response.summary?.trim() || null;
    }
    // text-mode fallback (e.g. mock in tests)
    if (isTextResponse(response)) {
      return response.content?.trim() || null;
    }
    return null;
  } catch {
    // Context collection is best-effort — never block rubric generation
    return null;
  }
}

export async function generateRubric(
  taskDescription: string,
  diffs: Array<{ provider: string; diff: string }>,
  provider: LLMProvider,
  repoContext?: string,
): Promise<RubricItem[]> {
  const prompt = buildRubricGenPrompt(taskDescription, diffs, repoContext);
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
  /** Absolute path to repo root — enables agentic context collection before rubric generation. */
  repoPath?: string;
}): Promise<RaceJudgeResult> {
  const { taskDescription, candidates, config, excludeProviders = [], repoPath } = opts;

  const judgeResolved = resolveJudgeProvider(config, excludeProviders);
  if (!judgeResolved) {
    throw new Error(
      "No suitable judge provider found. Add a text-mode provider to pipeline.config.json, " +
      "or configure orchestration.judgeProvider.",
    );
  }
  const { provider: judgeProvider, name: judgeProviderName } = judgeResolved;

  // Phase 0 (optional): collect repo context via agent-read provider
  let repoContext: string | undefined;
  let agenticContext = false;
  if (repoPath) {
    const contextResolved = resolveContextProvider(config, excludeProviders);
    if (contextResolved) {
      const ctx = await collectRepoContext(taskDescription, repoPath, contextResolved.provider);
      if (ctx) {
        repoContext = ctx;
        agenticContext = true;
      }
    }
  }

  // Phase 1: generate rubric from all diffs + optional repo context
  const diffs = candidates.map((c) => ({ provider: c.providerName, diff: c.diff }));
  const rubric = await generateRubric(taskDescription, diffs, judgeProvider, repoContext);

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
    agenticContext,
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
