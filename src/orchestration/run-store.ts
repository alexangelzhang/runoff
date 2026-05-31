/**
 * Run Store (Wave 7.2).
 *
 * Persists execution state for pipeline runs, enabling pause/resume,
 * approval waits, and crash recovery. In-memory implementation for dev;
 * production must use a durable adapter.
 */

import type { AgentId } from "./multi-agent-types.js";

// --- Run State ---

export type RunStatus =
  | "running"
  | "paused"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunState {
  runId: string;
  status: RunStatus;
  /** Pipeline session / trace id. */
  sessionId: string;
  /** Current round number. */
  round: number;
  /** Agent states snapshot (serialized). */
  agentStates?: Record<string, unknown>;
  /** Message cursor: index of last processed message. */
  messageCursor: number;
  /** Pending approval request, if status is awaiting_approval. */
  pendingApproval?: {
    agentId: AgentId;
    action: string;
    description: string;
    requestedAt: number;
    requestId?: string;
    phase?: "plan" | "action";
  };
  /** Resume token for crash recovery. */
  resumeToken?: string;
  /** Arbitrary metadata. */
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

// --- Store Interface ---

export interface RunStore {
  /** Save or update a run. */
  save(run: RunState): void;

  /** Load a run by id. */
  load(runId: string): RunState | undefined;

  /** List runs, optionally filtered by status. */
  list(filter?: { status?: RunStatus; sessionId?: string }): RunState[];

  /** Delete a run. */
  delete(runId: string): boolean;

  /** Total stored runs. */
  readonly size: number;

  /** Clear all runs. */
  clear(): void;
}

// --- In-Memory Implementation ---

export class InMemoryRunStore implements RunStore {
  private runs = new Map<string, RunState>();

  save(run: RunState): void {
    run.updatedAt = Date.now();
    this.runs.set(run.runId, { ...run });
  }

  load(runId: string): RunState | undefined {
    const run = this.runs.get(runId);
    return run ? { ...run } : undefined;
  }

  list(filter?: { status?: RunStatus; sessionId?: string }): RunState[] {
    let results = [...this.runs.values()];
    if (filter?.status) results = results.filter((r) => r.status === filter.status);
    if (filter?.sessionId) results = results.filter((r) => r.sessionId === filter.sessionId);
    return results.map((r) => ({ ...r }));
  }

  delete(runId: string): boolean {
    return this.runs.delete(runId);
  }

  get size(): number {
    return this.runs.size;
  }

  clear(): void {
    this.runs.clear();
  }
}
