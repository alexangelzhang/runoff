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
} from "./ast_utils.js";

// --- Token Budget Defaults ---

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4": 8_192,
  "gpt-3.5-turbo": 16_384,
  "o1": 200_000,
  "o1-mini": 128_000,
  "o3-mini": 200_000,
  "claude-3-opus": 200_000,
  "claude-3.5-sonnet": 200_000,
  "claude-4-sonnet": 200_000,
  "gemini-2.0-flash": 1_000_000,
  "gemini-2.5-pro": 1_000_000,
  "default": 128_000,
};

export function getModelContextWindow(model: string): number {
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

export function getLineDiff(oldContent: string, newContent: string): string {
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
}

export function buildReviewPrompt(input: ReviewPromptInput): StructuredPrompt {
  const system = `You are a senior code reviewer. Review the candidate output against the specification and provide a structured verdict.`;

  const staticParts: string[] = [];
  staticParts.push(`## Spec\n${input.spec}`);
  if (input.acceptanceCriteria?.length) {
    staticParts.push(`## Acceptance Criteria\n` + input.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n"));
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
}

export function buildGeneratePrompt(input: GeneratePromptInput): StructuredPrompt {
  const system = `You are an expert software engineer. Follow the spec and provide high-quality code.`;

  const staticParts: string[] = [`## Spec\n${input.spec}`];
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

export function renderPromptTemplate(prompt: StructuredPrompt): string {
  return renderPrompt(prompt);
}

export function getPromptStats(prompt: StructuredPrompt) {
  const systemTokens = estimateTokens(prompt.system);
  const staticTokens = estimateTokens(prompt.staticContext);
  const dynamicTokens = estimateTokens(prompt.dynamicContext);
  const totalTokens = systemTokens + staticTokens + dynamicTokens;
  const cacheableRatio = totalTokens > 0 ? (systemTokens + staticTokens) / totalTokens : 0;
  return { systemTokens, staticTokens, dynamicTokens, totalTokens, cacheableRatio };
}
