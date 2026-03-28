// --- Request types ---

export interface LLMRequest {
  prompt: string;
  language?: string;
  context?: string;
  /** Agent mode: absolute path to project directory */
  workDir?: string;
  sessionId?: string;
  stepName?: string;
  round?: number;
  system?: string;
  staticContext?: string;
  dynamicContext?: string;
  /** Signal for active cancellation of long-running tasks */
  signal?: AbortSignal;
}

// --- Response types (discriminated union) ---

export interface TextResponse {
  kind: "text";
  content: string;
  code: string;
  explanation: string;
  model: string;
  usage?: { promptTokens: number; completionTokens: number };
  failed?: boolean;
  error?: string;
  insights?: Record<string, string>;
  nextSteps?: any[];
}

export interface AgentResponse {
  kind: "agent";
  summary: string;
  changes: string;           // git diff output
  filesModified: string[];
  diffStat: string;          // e.g. "3 files changed, 45 insertions(+), 12 deletions(-)"
  model: string;
  usage?: { promptTokens: number; completionTokens: number };
  failed?: boolean;
  error?: string;
  insights?: Record<string, string>;
  nextSteps?: any[];
}

export type LLMResponse = TextResponse | AgentResponse;

export type ProviderMode = "text" | "agent-write" | "agent-read";

export function isAgentMode(mode: ProviderMode): boolean {
  return mode !== "text";
}

export function modesAreCompatible(expected: ProviderMode, candidate: ProviderMode): boolean {
  return expected === candidate;
}

export interface LLMProvider {
  name: string;
  mode: ProviderMode;
  execute(req: LLMRequest): Promise<LLMResponse>;
}

// --- Helpers ---

export function parseCodeFromResponse(raw: string): { code: string; explanation: string } {
  const codeBlocks: string[] = [];
  const codeBlockRegex = /```[\w]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(raw)) !== null) {
    codeBlocks.push(match[1].trim());
  }
  const code = codeBlocks.length > 0 ? codeBlocks.join("\n\n") : raw;
  const explanation = raw.replace(/```[\w]*\n[\s\S]*?```/g, "").trim();
  return { code, explanation };
}

/** Type guard: is this a text response? */
export function isTextResponse(r: LLMResponse): r is TextResponse {
  return r.kind === "text";
}

/** Type guard: is this an agent response? */
export function isAgentResponse(r: LLMResponse): r is AgentResponse {
  return r.kind === "agent";
}
