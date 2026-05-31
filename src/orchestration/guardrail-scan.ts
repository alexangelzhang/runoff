/**
 * Shared content scanners for guardrails and memory redaction.
 */

import type { AgentResult, AgentTask } from "./agent.js";
import { isAgentResponse, isTextResponse } from "../providers/types.js";

export type ContentFinding = {
  category: "secret" | "pii" | "prompt_injection" | "forbidden_path";
  label: string;
};

/** Patterns for API keys, tokens, and credentials (aligned with memory redaction). */
export const SECRET_SCAN_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "OpenAI API key", pattern: /\bsk-[a-zA-Z0-9]{20,}\b/ },
  { label: "GitHub token", pattern: /\bghp_[a-zA-Z0-9]{20,}\b/ },
  { label: "Slack token", pattern: /\bxox[baprs]-[a-zA-Z0-9-]{10,}\b/ },
  { label: "Bearer token", pattern: /\bBearer\s+[A-Za-z0-9._-]{8,}\b/i },
  {
    label: "credential assignment",
    pattern: /\b(api[_-]?key|token|password|secret)\s*[=:]\s*["']?[\w-]{8,}/i,
  },
];

export const PII_SCAN_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "email address", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { label: "US SSN", pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  {
    label: "credit card number",
    pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/,
  },
  { label: "CN mobile number", pattern: /\b1[3-9]\d{9}\b/ },
  {
    label: "phone number",
    pattern: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/,
  },
];

export const PROMPT_INJECTION_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "ignore prior instructions", pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i },
  { label: "disregard instructions", pattern: /disregard\s+(your\s+)?(system\s+)?instructions/i },
  { label: "role override", pattern: /\byou\s+are\s+now\s+(a|an|the)\b/i },
  { label: "system prompt leak", pattern: /\b(system\s+prompt|developer\s+message|hidden\s+instructions)\b/i },
  { label: "jailbreak keyword", pattern: /\b(jailbreak|DAN\s+mode|do\s+anything\s+now)\b/i },
  { label: "XML system injection", pattern: /<\s*\/?\s*system\s*>/i },
  { label: "markdown system fence", pattern: /```\s*system\b/i },
];

export const FORBIDDEN_PATH_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "path traversal", pattern: /\.\.(\/|\\)/ },
  { label: "sensitive unix path", pattern: /\/etc\/(passwd|shadow)\b/i },
  { label: "env file reference", pattern: /\b\.env(?:\.[a-z0-9]+)?\b/i },
  { label: "private key file", pattern: /\bid_rsa\b/i },
  { label: "credentials file", pattern: /\bcredentials\.json\b/i },
];

function firstMatch(
  text: string,
  patterns: Array<{ label: string; pattern: RegExp }>,
  category: ContentFinding["category"],
): ContentFinding | undefined {
  for (const { label, pattern } of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      return { category, label };
    }
  }
  return undefined;
}

export function scanForSecrets(text: string): ContentFinding | undefined {
  return firstMatch(text, SECRET_SCAN_PATTERNS, "secret");
}

export function scanForPii(text: string): ContentFinding | undefined {
  return firstMatch(text, PII_SCAN_PATTERNS, "pii");
}

export function scanForPromptInjection(text: string): ContentFinding | undefined {
  return firstMatch(text, PROMPT_INJECTION_PATTERNS, "prompt_injection");
}

export function scanForForbiddenPaths(text: string): ContentFinding | undefined {
  return firstMatch(text, FORBIDDEN_PATH_PATTERNS, "forbidden_path");
}

/** Collect all user-controlled text from an agent task. */
export function collectTaskText(task: AgentTask): string {
  const parts = [
    task.prompt,
    task.context,
    task.reviewFeedback,
    task.workDir,
    ...Object.values(task.sharedKnowledge ?? {}),
  ];
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n");
}

/** Collect model output text from an agent result. */
export function collectResultText(result: AgentResult): string {
  const { response } = result;
  if (isTextResponse(response)) {
    return [response.content, response.code, response.explanation]
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .join("\n");
  }
  if (isAgentResponse(response)) {
    return [response.summary, response.changes]
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .join("\n");
  }
  return "";
}

/** Redact secrets using the same patterns as guardrail scans. */
export function redactSecretsInText(text: string): string {
  let out = text;
  for (const { pattern } of SECRET_SCAN_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}
