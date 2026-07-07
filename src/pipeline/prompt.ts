/**
 * Structured Prompt System.
 *
 * Replaces ad-hoc string concatenation with a 3-layer architecture:
 *   1. System  — role instructions (cacheable prefix, rarely changes)
 *   2. Static  — spec + acceptance criteria (cacheable, same across retry rounds)
 *   3. Dynamic — review feedback, previous code, verify results (changes every round)
 */

import {
  extractRelevantNodes
} from "../infra/ast_utils.js";
import { GENERATE_SYSTEM_PROMPT, REVIEW_SYSTEM_PROMPT } from "../prompts/index.js";

// --- Token Budget Defaults ---

/**
 * Model context window sizes (tokens).
 * IMPORTANT: Keep in sync with PRICING_TABLE in pricing.ts — both tables must cover the same model keys.
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "o1": 200_000,
  "o1-mini": 128_000,
  "o3-mini": 200_000,
  // Anthropic
  "claude-3.5-sonnet": 200_000,
  "claude-3-opus": 200_000,
  "claude-4-sonnet": 200_000,
  // Google
  "gemini-2.0-flash": 1_000_000,
  "gemini-2.5-pro": 1_000_000,
  // Fallback
  "default": 128_000,
};

function getModelContextWindow(model: string): number {
  const normalized = model.toLowerCase();
  for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (normalized.includes(key)) return value;
  }
  return MODEL_CONTEXT_WINDOWS["default"];
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.2);
}

// --- Incremental Context Engine (Optimization: Wave 4-1) ---

function getLineDiff(oldContent: string, newContent: string): string {
  if (!oldContent) return newContent;
  if (oldContent === newContent) return "(No changes detected)";

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const diff: string[] = [];

  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++; j++;
    } else {
      while (i < oldLines.length && (j >= newLines.length || oldLines[i] !== newLines[j])) {
        diff.push("- " + oldLines[i]);
        i++;
      }
      while (j < newLines.length && (i >= oldLines.length || newLines[j] !== oldLines[i])) {
        diff.push("+ " + newLines[j]);
        j++;
      }
    }
  }

  if (diff.length > newLines.length * 0.7) return newContent;
  return diff.join("\n");
}

// --- Structured Prompt ---

export interface StructuredPrompt {
  system: string;
  staticContext: string;
  dynamicContext: string;
}

export interface PromptBudgetOptions {
  model?: string;
  maxTokens?: number;
  reserveForOutput?: number;
}

export function renderPrompt(prompt: StructuredPrompt, options?: PromptBudgetOptions): string {
  const contextWindow = options?.maxTokens ?? getModelContextWindow(options?.model ?? "default");
  const reserveForOutput = options?.reserveForOutput ?? 8192;
  const budget = contextWindow - reserveForOutput;

  const systemTokens = estimateTokens(prompt.system);
  const staticTokens = estimateTokens(prompt.staticContext);
  const dynamicTokens = estimateTokens(prompt.dynamicContext);
  const totalTokens = systemTokens + staticTokens + dynamicTokens;

  let dynamicContent = prompt.dynamicContext;

  if (totalTokens > budget) {
    const availableForDynamic = Math.max(0, budget - systemTokens - staticTokens);
    const availableChars = Math.floor(availableForDynamic * 3.2);
    if (availableChars < dynamicContent.length) {
      const keepChars = Math.max(availableChars - 100, 0);
      dynamicContent =
        dynamicContent.substring(0, keepChars) +
        "\n\n...[TRUNCATED: context trimmed to fit model context window]...";
    }
  }

  const parts = [prompt.system, prompt.staticContext, dynamicContent].filter(Boolean);
  return parts.join("\n\n");
}

// --- Review Prompt Builder ---

export interface ReviewPromptInput {
  spec: string;
  acceptanceCriteria?: string[];
  verifyResults?: string;
  candidateContent: string;
  candidateLabel: string;
  targets?: string[];
  knowledge?: Record<string, string>;
  contractAssertions?: string[];
  contractDebateSummary?: string;
  harnessRole?: "evaluator";
}

export function buildReviewPrompt(input: ReviewPromptInput): StructuredPrompt {
  const system =
    input.harnessRole === "evaluator"
      ? `${REVIEW_SYSTEM_PROMPT()}\n\nAssume the candidate output contains defects until evidence proves otherwise. Evaluate only against the completion contract and spec; cite concrete evidence for every issue.`
      : REVIEW_SYSTEM_PROMPT();

  const staticParts: string[] = [];
  staticParts.push(`## Spec\n${input.spec}`);
  if (input.acceptanceCriteria?.length) {
    staticParts.push(`## Acceptance Criteria\n` + input.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n"));
  }
  if (input.contractAssertions?.length) {
    staticParts.push(`## Completion Contract\n` + input.contractAssertions.join("\n"));
  }
  if (input.contractDebateSummary) {
    staticParts.push(`## Contract Debate (latest)\n${input.contractDebateSummary}`);
  }

  if (input.knowledge && Object.keys(input.knowledge).length > 0) {
    staticParts.push(`## Shared Knowledge\n` + Object.entries(input.knowledge).map(([k, v]) => `- **${k}**: ${v}`).join("\n"));
  }

  staticParts.push(
    `## Instructions\n` +
    `Review the ${input.candidateLabel.toLowerCase()} and respond with your analysis.\n` +
    `Then on a separate line, give the overall verdict:\n` +
    `VERDICT: APPROVED\n` +
    `VERDICT: NEEDS_REVISION: <specific issues to fix>`
  );

  const staticContext = staticParts.join("\n\n");

  const dynamicParts: string[] = [];
  if (input.verifyResults) {
    dynamicParts.push(`## External Verification Results\n\`\`\`\n${input.verifyResults}\n\`\`\``);
  }

  let content = input.candidateContent;
  const isCode = input.candidateLabel.toLowerCase().includes("code") || input.candidateLabel.toLowerCase().includes("typescript");

  if (isCode && input.targets?.length && content.length > 2048) {
    const pruned = extractRelevantNodes(content, input.targets);
    if (pruned.length < content.length * 0.9) {
      content = pruned + "\n\n...[Semantically pruned: non-relevant nodes hidden]...";
    }
  }

  dynamicParts.push(`## ${input.candidateLabel}\n\`\`\`\n${content}\n\`\`\``);
  const dynamicContext = dynamicParts.join("\n\n");

  return { system, staticContext, dynamicContext };
}

// --- Generate Prompt Builder ---

export interface GeneratePromptInput {
  spec: string;
  round: number;
  lastReviewFeedback?: string;
  previousContent?: string;
  previousContentLabel?: string;
  context?: string;
  targets?: string[];
  knowledge?: Record<string, string>;
  contractAssertions?: string[];
  contractDebateSummary?: string;
  harnessRole?: "planner" | "generator" | "evaluator";
  harnessRoleNote?: string;
}

export function buildGeneratePrompt(input: GeneratePromptInput): StructuredPrompt {
  const system = input.harnessRoleNote
    ? `${GENERATE_SYSTEM_PROMPT()}\n\n${input.harnessRoleNote}`
    : GENERATE_SYSTEM_PROMPT();

  const staticParts: string[] = [`## Spec\n${input.spec}`];
  if (input.contractAssertions?.length) {
    staticParts.push(`## Completion Contract\n` + input.contractAssertions.join("\n"));
  }
  if (input.contractDebateSummary) {
    staticParts.push(`## Contract Debate (latest)\n${input.contractDebateSummary}`);
  }
  if (input.knowledge && Object.keys(input.knowledge).length > 0) {
    staticParts.push(`## Shared Knowledge\n` + Object.entries(input.knowledge).map(([k, v]) => `- **${k}**: ${v}`).join("\n"));
  }
  const staticContext = staticParts.join("\n\n");

  const dynamicParts: string[] = [];
  if (input.round > 1 && input.lastReviewFeedback) {
    dynamicParts.push(`## Previous Review Feedback (round ${input.round - 1})\n${input.lastReviewFeedback}`);
  }
  
  const label = input.previousContentLabel ?? "Previous Content";
  let content = input.previousContent || input.context || "";
  const baseContext = input.context || "";
  
  if (input.targets?.length && content.length > 2048) {
    // Priority 1: AST-aware semantic pruning
    const pruned = extractRelevantNodes(content, input.targets);
    if (pruned.length < content.length * 0.9) {
      content = pruned + "\n\n...[Semantically pruned: non-relevant nodes hidden]...";
    }
  } else if (input.round > 1 && baseContext && content && content.length > 2048) {
    // Priority 2: Line-based incremental diffs (Wave 4-1 Fallback)
    const diff = getLineDiff(baseContext, content);
    if (diff.length < content.length) {
      content = diff;
      dynamicParts.push(`## ${label} (Incremental Diffs)\n\`\`\`diff\n${content}\n\`\`\``);
      // We already pushed the block, return early to avoid double push
      const dynamicContext = dynamicParts.join("\n\n");
      return { system, staticContext, dynamicContext };
    }
  }

  if (content) {
    dynamicParts.push(`## ${label}\n\`\`\`\n${content}\n\`\`\``);
  }

  const dynamicContext = dynamicParts.join("\n\n");

  return { system, staticContext, dynamicContext };
}

