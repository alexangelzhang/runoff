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
  /** Agent finalize semantics: auto finalize (default) or defer to llm_race_apply / abort. */
  finalizeStrategy?: "auto" | "defer";
  /** Shared repo lock key for intentional concurrent workspaces (e.g. race candidates). */
  sharedLockKey?: string;
  /** Signal for active cancellation of long-running tasks */
  signal?: AbortSignal;
}

export interface AgentWorkspaceArtifact {
  workspacePath: string;
  workspaceRepoRoot: string;
  workspaceBaseRef: string;
  workspaceSharedLockKey?: string;
}

// --- Response types (discriminated union) ---

export interface NextStep {
  name: string;
  provider: string;
  dependsOn?: string[];
}

/** Normalize runtime-parsed nextSteps (e.g. from model JSON) to the IPC/TaskResult shape. */
export function filterValidNextSteps(raw: unknown): NextStep[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: NextStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const n = item as Record<string, unknown>;
    if (typeof n.name !== "string" || typeof n.provider !== "string") continue;
    const step: NextStep = { name: n.name, provider: n.provider };
    if (Array.isArray(n.dependsOn) && n.dependsOn.every((d) => typeof d === "string")) {
      step.dependsOn = n.dependsOn as string[];
    }
    out.push(step);
  }
  return out.length > 0 ? out : undefined;
}

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
  nextSteps?: NextStep[];
}

export interface AgentResponse {
  kind: "agent";
  summary: string;
  changes: string;           // git diff output
  filesModified: string[];
  diffStat: string;          // e.g. "3 files changed, 45 insertions(+), 12 deletions(-)"
  model: string;
  workspace?: AgentWorkspaceArtifact;
  usage?: { promptTokens: number; completionTokens: number };
  failed?: boolean;
  error?: string;
  insights?: Record<string, string>;
  nextSteps?: NextStep[];
}

export type LLMResponse = TextResponse | AgentResponse;

export const PROVIDER_MODES = ["text", "agent-read", "agent-write"] as const;
export type ProviderMode = (typeof PROVIDER_MODES)[number];

export function isAgentMode(mode: ProviderMode): boolean {
  return mode !== "text";
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
