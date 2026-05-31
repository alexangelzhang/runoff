/**
 * Per-agent state management (Wave 7.1).
 *
 * Each agent maintains its own knowledge, execution history, and candidate reference.
 * State is mutable during a pipeline run and can be serialized for checkpoint/resume.
 */

import type { AgentId } from "./multi-agent-types.js";

export interface AgentStateSnapshot {
  id: AgentId;
  knowledge: Record<string, string>;
  candidateRef?: string;
  executionHistory: AgentExecutionRecord[];
}

export interface AgentExecutionRecord {
  stepName: string;
  round: number;
  durationMs: number;
  success: boolean;
  timestamp: number;
}

export class AgentState {
  readonly id: AgentId;
  private knowledge: Record<string, string>;
  private candidateRef: string | undefined;
  private executionHistory: AgentExecutionRecord[];

  constructor(id: AgentId) {
    this.id = id;
    this.knowledge = {};
    this.candidateRef = undefined;
    this.executionHistory = [];
  }

  /** Merge new knowledge entries (later values win). */
  mergeKnowledge(entries: Record<string, string>): void {
    Object.assign(this.knowledge, entries);
  }

  getKnowledge(): Readonly<Record<string, string>> {
    return this.knowledge;
  }

  getKnowledgeValue(key: string): string | undefined {
    return this.knowledge[key];
  }

  setCandidateRef(ref: string | undefined): void {
    this.candidateRef = ref;
  }

  getCandidateRef(): string | undefined {
    return this.candidateRef;
  }

  recordExecution(record: AgentExecutionRecord): void {
    this.executionHistory.push(record);
  }

  getExecutionHistory(): readonly AgentExecutionRecord[] {
    return this.executionHistory;
  }

  getLastExecution(): AgentExecutionRecord | undefined {
    return this.executionHistory[this.executionHistory.length - 1];
  }

  /** Serialize for checkpoint persistence. */
  snapshot(): AgentStateSnapshot {
    return {
      id: this.id,
      knowledge: { ...this.knowledge },
      candidateRef: this.candidateRef,
      executionHistory: [...this.executionHistory],
    };
  }

  /** Restore from a checkpoint snapshot. */
  static fromSnapshot(snap: AgentStateSnapshot): AgentState {
    const state = new AgentState(snap.id);
    state.knowledge = { ...snap.knowledge };
    state.candidateRef = snap.candidateRef;
    state.executionHistory = [...snap.executionHistory];
    return state;
  }

  /** Reset state for a new run (keeps id). */
  reset(): void {
    this.knowledge = {};
    this.candidateRef = undefined;
    this.executionHistory = [];
  }
}
