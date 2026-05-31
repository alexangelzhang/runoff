/**
 * Workflow Agent Primitives (Wave 7.3).
 *
 * Three deterministic orchestration primitives (no LLM overhead):
 * - SequentialAgent: execute sub-agents in order, chaining outputs
 * - ParallelAgent: execute sub-agents concurrently, collect all results
 * - LoopAgent: repeat sub-agent until termination condition met
 *
 * Reference: Google ADK SequentialAgent / ParallelAgent / LoopAgent.
 */

import type { AgentId, AgentRole } from "./multi-agent-types.js";
import type {
  AgentInstance,
  AgentTask,
  AgentResult,
  AgentCapability,
} from "./agent.js";
import { AgentState } from "./agent-state.js";
import type { LLMProvider } from "../providers/types.js";

// --- Base Workflow Agent ---

abstract class WorkflowAgent implements AgentInstance {
  readonly id: AgentId;
  readonly role: AgentRole;
  readonly capabilities: readonly AgentCapability[];
  readonly state: AgentState;
  protected children: AgentInstance[];
  private disposed = false;

  /** Workflow agents don't use a provider directly. */
  get provider(): LLMProvider {
    throw new Error("WorkflowAgent does not have a direct provider");
  }

  constructor(id: AgentId, children: AgentInstance[], role: AgentRole = "orchestrator") {
    this.id = id;
    this.role = role;
    this.capabilities = ["delegate"];
    this.state = new AgentState(id);
    this.children = children;
  }

  abstract execute(task: AgentTask): Promise<AgentResult>;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const child of this.children) child.dispose();
  }

  protected ensureNotDisposed(): void {
    if (this.disposed) throw new Error(`WorkflowAgent ${this.id} is disposed`);
  }
}

// --- Sequential Agent ---

/**
 * Executes children in order. Each child receives the previous child's
 * output as reviewFeedback context (chaining pattern).
 */
export class SequentialAgent extends WorkflowAgent {
  async execute(task: AgentTask): Promise<AgentResult> {
    this.ensureNotDisposed();
    const start = Date.now();
    let lastResult: AgentResult | undefined;

    for (const child of this.children) {
      const childTask: AgentTask = {
        ...task,
        stepName: `${task.stepName}/${child.id}`,
        // Chain: pass previous output as review feedback
        reviewFeedback: lastResult?.response.kind === "text"
          ? lastResult.response.content
          : task.reviewFeedback,
      };
      lastResult = await child.execute(childTask);

      // Merge child insights into our knowledge
      if (lastResult.insights) {
        this.state.mergeKnowledge(lastResult.insights);
      }
    }

    // Return the last child's result, attributed to this agent
    return {
      agentId: this.id,
      stepName: task.stepName,
      response: lastResult?.response ?? {
        kind: "text" as const,
        content: "",
        code: "",
        explanation: "",
        model: "sequential-agent",
        failed: true,
        error: "No children to execute",
      },
      durationMs: Date.now() - start,
      insights: Object.fromEntries(
        Object.entries(this.state.getKnowledge())
      ),
    };
  }
}

// --- Parallel Agent ---

/**
 * Executes all children concurrently. Collects all results.
 * Returns a combined result with all insights merged.
 */
export class ParallelAgent extends WorkflowAgent {
  private mergeStrategy: "first-success" | "all";

  constructor(
    id: AgentId,
    children: AgentInstance[],
    mergeStrategy: "first-success" | "all" = "all"
  ) {
    super(id, children);
    this.mergeStrategy = mergeStrategy;
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    this.ensureNotDisposed();
    const start = Date.now();

    const promises = this.children.map((child) => {
      const childTask: AgentTask = {
        ...task,
        stepName: `${task.stepName}/${child.id}`,
      };
      return child.execute(childTask);
    });

    const results = await Promise.all(promises);

    // Merge all insights
    for (const r of results) {
      if (r.insights) this.state.mergeKnowledge(r.insights);
    }

    // Pick the result to return
    let chosen: AgentResult;
    if (this.mergeStrategy === "first-success") {
      chosen = results.find((r) => !r.response.failed) ?? results[0];
    } else {
      // "all" — return the last result but with merged insights
      chosen = results[results.length - 1];
    }

    return {
      agentId: this.id,
      stepName: task.stepName,
      response: chosen.response,
      durationMs: Date.now() - start,
      insights: Object.fromEntries(
        Object.entries(this.state.getKnowledge())
      ),
    };
  }

  /** Run every child and return all results (workflow stage integration). */
  async executeAll(task: AgentTask): Promise<AgentResult[]> {
    this.ensureNotDisposed();
    const start = Date.now();
    const results = await Promise.all(
      this.children.map((child) =>
        child.execute({
          ...task,
          stepName: `${task.stepName}/${child.id}`,
        }),
      ),
    );
    for (const r of results) {
      if (r.insights) this.state.mergeKnowledge(r.insights);
    }
    void start;
    return results;
  }
}

// --- Loop Agent ---

/**
 * Repeatedly executes a single child agent until a termination condition
 * is met or maxIterations is reached.
 *
 * Common use: generate → review loop until review approves.
 */
export class LoopAgent extends WorkflowAgent {
  private maxIterations: number;
  private shouldTerminate: (result: AgentResult, iteration: number) => boolean;

  constructor(
    id: AgentId,
    child: AgentInstance,
    shouldTerminate: (result: AgentResult, iteration: number) => boolean,
    maxIterations = 5
  ) {
    super(id, [child]);
    this.maxIterations = maxIterations;
    this.shouldTerminate = shouldTerminate;
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    this.ensureNotDisposed();
    const start = Date.now();
    const child = this.children[0];
    let lastResult: AgentResult | undefined;

    for (let i = 0; i < this.maxIterations; i++) {
      const childTask: AgentTask = {
        ...task,
        stepName: `${task.stepName}/${child.id}`,
        round: i + 1,
        reviewFeedback: lastResult?.response.kind === "text"
          ? lastResult.response.content
          : task.reviewFeedback,
      };

      lastResult = await child.execute(childTask);

      if (lastResult.insights) {
        this.state.mergeKnowledge(lastResult.insights);
      }

      if (this.shouldTerminate(lastResult, i + 1)) {
        break;
      }
    }

    return {
      agentId: this.id,
      stepName: task.stepName,
      response: lastResult?.response ?? {
        kind: "text" as const,
        content: "",
        code: "",
        explanation: "",
        model: "loop-agent",
        failed: true,
        error: "No iterations executed",
      },
      durationMs: Date.now() - start,
      insights: Object.fromEntries(
        Object.entries(this.state.getKnowledge())
      ),
    };
  }
}
