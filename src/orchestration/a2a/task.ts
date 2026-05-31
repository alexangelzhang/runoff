/**
 * A2A Task Protocol (Wave 7.9).
 *
 * Async task negotiation between agents: send / receive / status / cancel.
 * Reference: Google Agent2Agent Protocol — Task lifecycle.
 */

import type { AgentId } from "../multi-agent-types.js";
import type { A2AArtifact } from "./artifact.js";

// --- Task Status ---

export type A2ATaskStatus =
  | "pending"
  | "accepted"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

// --- Task ---

export interface A2ATask {
  id: string;
  /** Agent that created the task. */
  from: AgentId;
  /** Agent that should execute the task. */
  to: AgentId;
  /** What to do. */
  instruction: string;
  /** Input artifacts. */
  inputArtifacts?: A2AArtifact[];
  /** Current status. */
  status: A2ATaskStatus;
  /** Output artifacts (populated on completion). */
  outputArtifacts?: A2AArtifact[];
  /** Error message (if failed). */
  error?: string;
  /** Timestamps. */
  createdAt: number;
  updatedAt: number;
}

// --- Task Manager ---

/**
 * Manages A2A task lifecycle.
 * In production, this would be backed by a persistent store + transport.
 */
export class A2ATaskManager {
  private tasks = new Map<string, A2ATask>();
  private nextId = 1;
  private handlers = new Map<string, (task: A2ATask) => Promise<A2AArtifact[]>>();

  /** Register a handler for an agent (called when tasks are sent to it). */
  registerHandler(
    agentId: AgentId,
    handler: (task: A2ATask) => Promise<A2AArtifact[]>
  ): void {
    this.handlers.set(agentId, handler);
  }

  /** Send a task to another agent. Returns the task with initial status. */
  send(from: AgentId, to: AgentId, instruction: string, inputArtifacts?: A2AArtifact[]): A2ATask {
    const now = Date.now();
    const task: A2ATask = {
      id: `a2a-task-${this.nextId++}`,
      from,
      to,
      instruction,
      inputArtifacts,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  /** Execute a pending task (dispatches to registered handler). */
  async execute(taskId: string): Promise<A2ATask> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`A2A task not found: ${taskId}`);
    if (task.status !== "pending" && task.status !== "accepted") {
      throw new Error(`Cannot execute task in status: ${task.status}`);
    }

    const handler = this.handlers.get(task.to);
    if (!handler) {
      task.status = "failed";
      task.error = `No handler registered for agent: ${task.to}`;
      task.updatedAt = Date.now();
      return task;
    }

    task.status = "in_progress";
    task.updatedAt = Date.now();

    try {
      const outputs = await handler(task);
      task.outputArtifacts = outputs;
      task.status = "completed";
    } catch (err) {
      task.status = "failed";
      task.error = err instanceof Error ? err.message : String(err);
    }

    task.updatedAt = Date.now();
    return task;
  }

  /** Get task status. */
  getStatus(taskId: string): A2ATaskStatus | undefined {
    return this.tasks.get(taskId)?.status;
  }

  /** Get full task. */
  getTask(taskId: string): A2ATask | undefined {
    return this.tasks.get(taskId);
  }

  /** Cancel a task. */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === "completed" || task.status === "cancelled") return false;
    task.status = "cancelled";
    task.updatedAt = Date.now();
    return true;
  }

  /** List tasks filtered by agent. */
  listByAgent(agentId: AgentId, direction: "from" | "to" = "to"): A2ATask[] {
    return [...this.tasks.values()].filter((t) => t[direction] === agentId);
  }

  /** Total task count. */
  get size(): number {
    return this.tasks.size;
  }

  /** Clear all tasks. */
  clear(): void {
    this.tasks.clear();
    this.nextId = 1;
  }
}
