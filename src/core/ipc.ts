import { z } from "zod";
import { PROVIDER_MODES } from "../providers/types.js";

/**
 * IPC Protocol Version.
 * (Wave 6: Semantic State & Knowledge Insights)
 * Phase D: optional multi-agent correlation (agentId, parentHandoffId); v6 documents that extension.
 */
export const TASK_PAYLOAD_SCHEMA_VERSION = 6;
export const TASK_RESULT_SCHEMA_VERSION = 6;

// --- Zod schemas for runtime validation ---
// TASK_PAYLOAD_FIELDS and TASK_RESULT_FIELDS are derived from the Zod schema shapes
// after they are defined below. Do not maintain them manually.

export const taskPayloadSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  mode: z.enum(PROVIDER_MODES),
  timestamp: z.string(),
  /** ISO time when the task was queued (segment latency; defaults to timestamp). */
  startedAt: z.string().optional(),
  system: z.string().optional(),
  staticContext: z.string().optional(),
  dynamicContext: z.string().optional(),
  workDir: z.string().optional(),
  sessionId: z.string().optional(),
  stepName: z.string().optional(),
  round: z.number().default(1),
  schemaVersion: z.number().int().positive(),
  knowledgeBase: z.record(z.string()).optional(),
  /** Optional logical agent identity for multi-agent / handoff tracing */
  agentId: z.string().optional(),
  /** Optional link to a prior handoff or parent task in a multi-agent chain */
  parentHandoffId: z.string().optional(),
  /**
   * When set, scripts/python/task_runner.py runs this argv with cwd=workDir, stdin=composed prompt,
   * stdout → result content (then agent modes collect git diff). Omitted → in-process stub (tests/CI).
   */
  delegateArgv: z.array(z.string()).min(1).optional(),
  /**
   * When true, task_runner.py allocates a pseudo-TTY for the delegate process.
   * Required for CLI tools that detect the absence of a TTY and refuse to run (e.g. Gemini CLI).
   */
  delegatePty: z.boolean().optional(),
  /**
   * When true, task_runner.py communicates with the delegate via ACP (Agent Client Protocol)
   * JSON-RPC over stdio instead of plain stdin/stdout. Requires Gemini CLI v0.45.0+.
   * task_runner.py validates the version at runtime and raises an error if too old.
   */
  delegateAcp: z.boolean().optional(),
  finalizeStrategy: z.enum(["auto", "defer"]).optional(),
  sharedLockKey: z.string().optional(),
});

export const taskResultSchema = z.object({
  id: z.string(),
  status: z.enum(["success", "error"]),
  content: z.string().optional().default(""),
  usage: z.object({
    promptTokens: z.number(),
    completionTokens: z.number(),
  }),
  error: z.string().optional(),
  model: z.string().optional().default("unknown"),
  summary: z.string().optional(),
  changes: z.string().optional(),
  filesModified: z.array(z.string()).optional().default([]),
  diffStat: z.string().optional(),
  workspacePath: z.string().optional(),
  workspaceRepoRoot: z.string().optional(),
  workspaceBaseRef: z.string().optional(),
  workspaceSharedLockKey: z.string().optional(),
  schemaVersion: z.number().int().positive(),
  insights: z.record(z.string()).optional(),
  nextSteps: z.array(z.object({
    name: z.string(),
    provider: z.string(),
    dependsOn: z.array(z.string()).optional()
  })).optional(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
});

export type TaskPayload = z.infer<typeof taskPayloadSchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;

// Derived from schema shapes — always in sync with Zod definitions above.
export const TASK_PAYLOAD_FIELDS: readonly string[] = Object.keys(taskPayloadSchema.shape);
export const TASK_RESULT_FIELDS: readonly string[] = Object.keys(taskResultSchema.shape);

// --- Helper functions ---

export function createTaskPayload(input: Omit<TaskPayload, "schemaVersion">): TaskPayload {
  return {
    ...input,
    schemaVersion: TASK_PAYLOAD_SCHEMA_VERSION,
  };
}

export function parseTaskPayload(data: unknown): TaskPayload {
  const result = taskPayloadSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid TaskPayload schema: ${result.error.message}`);
  }
  const payload = result.data;
  if (payload.schemaVersion > TASK_PAYLOAD_SCHEMA_VERSION) {
    throw new Error(`TaskPayload schema version ${payload.schemaVersion} is newer than supported ${TASK_PAYLOAD_SCHEMA_VERSION}`);
  }
  return payload;
}

export function createTaskResult(input: Partial<TaskResult> & { id: string; status: "success" | "error" }): TaskResult {
  return {
    content: "",
    usage: { promptTokens: 0, completionTokens: 0 },
    filesModified: [],
    model: "unknown",
    ...input,
    schemaVersion: TASK_RESULT_SCHEMA_VERSION,
  };
}

export function parseTaskResult(data: unknown): TaskResult {
  const result = taskResultSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Invalid TaskResult schema: ${result.error.message}`);
  }
  const res = result.data;
  if (res.schemaVersion > TASK_RESULT_SCHEMA_VERSION) {
    throw new Error(`TaskResult schema version ${res.schemaVersion} is newer than supported ${TASK_RESULT_SCHEMA_VERSION}`);
  }
  return res;
}
