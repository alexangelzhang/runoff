import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getSessionsDir } from "./paths.js";
import { StepTrace } from "../observability/trace.js";
import type { Candidate } from "./candidate.js";
import type { PipelineConfig } from "./config.js";
import { calculateConfigHash } from "./config.js";
import { logger } from "./logger.js";
import type { RaceCandidateSnapshot } from "../runtime/race-registry.js";

export const CHECKPOINT_SCHEMA_VERSION = 4;
/** Oldest schema version that can be safely loaded without migration. v3→v4 only added optional fields. */
const OLDEST_COMPATIBLE_SCHEMA_VERSION = 3;

export type StepStatus = "queued" | "running" | "success" | "failed" | "skipped" | "cancelled";
export type PipelineStatus =
  | "queued"
  | "running"
  | "approved"
  | "failed"
  | "aborted"
  | "max_rounds"
  | "awaiting_judge"
  | "awaiting_approval"
  | "awaiting_plan_approval";

/** Shared MCP/query filter list for pipeline terminal and in-flight statuses. */
export const PIPELINE_STATUS_FILTERS = [
  "approved",
  "failed",
  "max_rounds",
  "running",
  "queued",
  "aborted",
  "awaiting_judge",
  "awaiting_approval",
  "awaiting_plan_approval",
] as const satisfies readonly PipelineStatus[];

/** Terminal failure statuses — MCP isError and query filters. */
export const PIPELINE_TERMINAL_FAILURE_STATUSES = [
  "failed",
  "aborted",
  "max_rounds",
] as const satisfies readonly PipelineStatus[];

const STEP_TRANSITIONS: Record<StepStatus, StepStatus[]> = {
  queued: ["running", "skipped", "cancelled"],
  running: ["success", "failed", "skipped", "cancelled"],
  success: [],
  failed: ["running"],
  skipped: [],
  cancelled: [],
};

const PIPELINE_TRANSITIONS: Record<PipelineStatus, PipelineStatus[]> = {
  queued: ["running"],
  running: ["approved", "failed", "aborted", "max_rounds", "awaiting_judge", "awaiting_approval", "awaiting_plan_approval"],
  approved: [],
  failed: ["running"],
  aborted: [],
  max_rounds: ["running"],
  awaiting_judge: ["approved", "failed", "aborted"],
  awaiting_approval: ["running", "failed", "aborted"],
  awaiting_plan_approval: ["running", "failed", "aborted"],
};

export function assertStepTransition(from: StepStatus, to: StepStatus, stepName?: string): void {
  const allowed = STEP_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    const label = stepName ? ` for step "${stepName}"` : "";
    throw new Error(`Invalid step status transition${label}: "${from}" → "${to}"`);
  }
}

export function assertPipelineTransition(from: PipelineStatus, to: PipelineStatus, sessionId?: string): void {
  const allowed = PIPELINE_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    const label = sessionId ? ` for session "${sessionId}"` : "";
    throw new Error(`Invalid pipeline status transition${label}: "${from}" → "${to}"`);
  }
}

export interface StepResult {
  status: StepStatus;
  provider?: string;
  routedFrom?: string;
  round?: number;
  kind?: "text" | "agent";
  model?: string;
  code?: string;
  explanation?: string;
  summary?: string;
  changes?: string;
  filesModified?: string[];
  diffStat?: string;
  reason?: string;
  error?: string;
  usage?: { promptTokens: number; completionTokens: number };
  candidateSnapshot?: Partial<Candidate>;
  durationMs?: number;
  /** Typed artifacts for this step (Wave 7.5 / Gate 2.7). */
  artifacts?: import("../orchestration/artifacts.js").Artifact[];
}

export interface ResumeMetadata {
  mode: "pipeline";
  language?: string;
  workDir?: string;
  promptHash: string;
  contextHash: string;
  acceptanceCriteriaHash: string;
  verifyResultsHash: string;
  configHash: string;
}

export interface ResumeRequest {
  mode: "pipeline";
  prompt: string;
  language?: string;
  context?: string;
  workDir?: string;
  acceptanceCriteria?: string[];
  verifyResults?: string;
  configHash: string;
}

export interface PipelineState {
  schemaVersion?: number;
  sessionId: string;
  prompt: string;
  round: number;
  maxRounds: number;
  lastCode: string;
  lastReviewFeedback: string;
  approved: boolean;
  stepResults: Record<string, StepResult>;
  stepTraces: StepTrace[];
  dynamicPipeline?: PipelineConfig["pipeline"];
  traceId: string;
  globalKnowledge: Record<string, string>;
  timestamp: string;
  status: PipelineStatus;
  resume: ResumeMetadata;
  workspacePath?: string;
  workspaceRepoRoot?: string;
  workspaceBaseRef?: string;
  pendingRaceTraceId?: string;
  raceCandidates?: RaceCandidateSnapshot[];
  /** Experiment metadata carried through checkpoint/resume. */
  experimentId?: string;
  experimentVariant?: string;
  /** Plan awaiting operator approval (Phase 7.8 A). */
  pendingExecutionPlan?: { steps: Array<string | string[]>; maxRounds?: number };
}

function getCheckpointFile(sessionId: string): string {
  return join(getSessionsDir(), `${sessionId}.checkpoint.json`);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);

  return `{${entries.join(",")}}`;
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function assertCheckpointSchemaVersion(state: Partial<PipelineState>): number {
  const schemaVersion = state.schemaVersion;
  if (schemaVersion === undefined) {
    throw new Error("Checkpoint was created by an older pipeline version and cannot be safely resumed");
  }
  if (!Number.isInteger(schemaVersion) || Number(schemaVersion) < 1) {
    throw new Error("Checkpoint schemaVersion must be a positive integer");
  }
  if (schemaVersion < OLDEST_COMPATIBLE_SCHEMA_VERSION) {
    throw new Error("Checkpoint was created by an older pipeline version and cannot be safely resumed");
  }
  if (schemaVersion > CHECKPOINT_SCHEMA_VERSION) {
    throw new Error("Checkpoint was created by a newer pipeline version and cannot be safely resumed");
  }
  return Number(schemaVersion);
}

function parseCheckpoint(raw: string): PipelineState {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Checkpoint payload must be an object");
  }
  const obj = parsed as Record<string, unknown>;
  assertCheckpointSchemaVersion(obj as Partial<PipelineState>);

  // Validate critical fields
  if (typeof obj.sessionId !== "string") throw new Error("Checkpoint missing sessionId");
  if (typeof obj.prompt !== "string") throw new Error("Checkpoint missing prompt");
  if (typeof obj.round !== "number") throw new Error("Checkpoint missing round");
  if (typeof obj.status !== "string") throw new Error("Checkpoint missing status");

  // Validate dynamicPipeline shape if present
  if (obj.dynamicPipeline !== undefined) {
    if (typeof obj.dynamicPipeline !== "object" || obj.dynamicPipeline === null || Array.isArray(obj.dynamicPipeline)) {
      throw new Error("Checkpoint dynamicPipeline must be a Record<string, [...]>");
    }
    for (const [step, val] of Object.entries(obj.dynamicPipeline as Record<string, unknown>)) {
      if (!Array.isArray(val)) {
        throw new Error(`Checkpoint dynamicPipeline["${step}"] must be an array`);
      }
    }
  }

  return {
    ...(obj as unknown as PipelineState),
    schemaVersion: assertCheckpointSchemaVersion(obj as Partial<PipelineState>),
  };
}

/** @deprecated Use {@link calculateConfigHash} from config.ts instead. */
export const createConfigHash = calculateConfigHash;

export function buildResumeMetadata(input: ResumeRequest): ResumeMetadata {
  return {
    mode: input.mode,
    language: input.language,
    workDir: input.workDir,
    promptHash: hashValue(input.prompt),
    contextHash: hashValue(input.context ?? ""),
    acceptanceCriteriaHash: hashValue(input.acceptanceCriteria ?? []),
    verifyResultsHash: hashValue(input.verifyResults ?? ""),
    configHash: input.configHash,
  };
}

export function assertResumeCompatible(state: PipelineState, request: ResumeRequest): void {
  assertCheckpointSchemaVersion(state);

  if (!state.resume || !state.status) {
    throw new Error("Checkpoint was created by an older pipeline version and cannot be safely resumed");
  }

  if (state.status === "approved") {
    throw new Error(`Checkpoint ${state.sessionId} is already approved and cannot be resumed`);
  }

  if (state.status === "awaiting_judge") {
    throw new Error(`Checkpoint ${state.sessionId} is awaiting judge; use llm_race_apply or llm_race_abort instead of resume`);
  }

  if (state.status === "awaiting_approval" || state.status === "awaiting_plan_approval") {
    throw new Error(`Checkpoint ${state.sessionId} is awaiting operator approval; approve or abort before resuming`);
  }

  const expected = buildResumeMetadata(request);
  const mismatches: string[] = [];

  if (state.resume.mode !== expected.mode) mismatches.push("mode");
  if ((state.resume.language ?? "") !== (expected.language ?? "")) mismatches.push("language");
  if ((state.resume.workDir ?? "") !== (expected.workDir ?? "")) mismatches.push("workDir");
  if (state.resume.promptHash !== expected.promptHash) mismatches.push("prompt");
  if (state.resume.contextHash !== expected.contextHash) mismatches.push("context");
  if (state.resume.acceptanceCriteriaHash !== expected.acceptanceCriteriaHash) mismatches.push("acceptanceCriteria");
  if (state.resume.verifyResultsHash !== expected.verifyResultsHash) mismatches.push("verifyResults");
  if (state.resume.configHash !== expected.configHash) mismatches.push("pipelineConfig");

  if (mismatches.length > 0) {
    throw new Error(`Checkpoint resume context mismatch for session ${state.sessionId}: ${mismatches.join(", ")}`);
  }
}

export async function saveCheckpoint(sessionId: string, state: PipelineState): Promise<boolean> {
  try {
    const sessionsDir = getSessionsDir();
    if (!existsSync(sessionsDir)) await mkdir(sessionsDir, { recursive: true });

    const file = getCheckpointFile(sessionId);
    const tmpFile = `${file}.${process.pid}.tmp`;
    const payload: PipelineState = {
      ...state,
      globalKnowledge: state.globalKnowledge || {},
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    };
    await writeFile(tmpFile, JSON.stringify(payload, null, 2));
    await rename(tmpFile, file);
    return true;
  } catch (err) {
    logger.error("state", `Failed to save checkpoint for session ${sessionId}`, { err });
    return false;
  }
}

export async function loadCheckpoint(sessionId: string): Promise<PipelineState | null> {
  try {
    const file = getCheckpointFile(sessionId);
    if (!existsSync(file)) return null;
    const raw = await readFile(file, "utf-8");
    return parseCheckpoint(raw);
  } catch (err) {
    logger.error("state", `Failed to load checkpoint for session ${sessionId}`, { err });
    return null;
  }
}

export async function deleteCheckpoint(sessionId: string): Promise<void> {
  try {
    const file = getCheckpointFile(sessionId);
    if (existsSync(file)) await unlink(file);
  } catch (err) {
    logger.error("state", `Failed to delete checkpoint for session ${sessionId}`, { err });
  }
}
