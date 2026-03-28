import { z } from "zod";

/**
 * IPC Protocol Version.
 * (Wave 6: Semantic State & Knowledge Insights)
 * Phase D: optional multi-agent correlation (agentId, parentHandoffId); v6 documents that extension.
 */
export const TASK_PAYLOAD_SCHEMA_VERSION = 6;
export const TASK_RESULT_SCHEMA_VERSION = 5;

export const TASK_PAYLOAD_FIELDS = [
  "id", "prompt", "mode", "timestamp", "system",
  "staticContext", "dynamicContext", "workDir",
  "sessionId", "stepName", "round", "schemaVersion",
  "knowledgeBase",
  "agentId", "parentHandoffId",
];

export const TASK_RESULT_FIELDS = [
  "id", "status", "content", "usage", "error",
  "model", "summary", "changes", "filesModified",
  "diffStat", "schemaVersion", "insights", "nextSteps"
];

// --- Zod schemas for runtime validation ---

export const taskPayloadSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  mode: z.enum(["text", "agent-read", "agent-write"]),
  timestamp: z.string(),
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
  schemaVersion: z.number().int().positive(),
  insights: z.record(z.string()).optional(),
  nextSteps: z.array(z.object({
    name: z.string(),
    provider: z.string(),
    dependsOn: z.array(z.string()).optional()
  })).optional(),
});

export type TaskPayload = z.infer<typeof taskPayloadSchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;

// --- Helper functions ---

export function createTaskPayload(input: Omit<TaskPayload, "schemaVersion">): TaskPayload {
  return {
    ...input,
    schemaVersion: TASK_PAYLOAD_SCHEMA_VERSION,
  };
}

export function parseTaskPayload(data: any): TaskPayload {
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

export function parseTaskResult(data: any): TaskResult {
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
