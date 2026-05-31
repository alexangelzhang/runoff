/**
 * SharedContext + Conflict Resolution (Wave 7.4).
 *
 * Manages branching/merging of candidate state when multiple agents
 * work in parallel. Each branch is an isolated snapshot; merge strategies
 * resolve conflicts when branches rejoin.
 */

import type { AgentId } from "./multi-agent-types.js";
import type { Artifact } from "./artifacts.js";

// --- Branch ---

export interface ContextBranch {
  branchId: string;
  parentBranchId?: string;
  ownerId: AgentId;
  /** Artifacts produced on this branch. */
  artifacts: Artifact[];
  /** Files modified on this branch (for conflict detection). */
  filesModified: string[];
  createdAt: number;
  merged: boolean;
}

// --- Merge Strategy ---

export type MergeStrategy = "auto-merge" | "pick-winner" | "manual";

export interface MergeResult {
  success: boolean;
  strategy: MergeStrategy;
  /** Conflicting files (if any). */
  conflicts: string[];
  /** Merged artifacts. */
  mergedArtifacts: Artifact[];
}

// --- SharedContext ---

export class SharedContext {
  private branches = new Map<string, ContextBranch>();
  private mainArtifacts: Artifact[] = [];
  private nextBranchId = 1;

  /** Create a new branch for an agent to work on. */
  createBranch(ownerId: AgentId, parentBranchId?: string): ContextBranch {
    const branchId = `branch-${this.nextBranchId++}`;
    const branch: ContextBranch = {
      branchId,
      parentBranchId,
      ownerId,
      artifacts: [],
      filesModified: [],
      createdAt: Date.now(),
      merged: false,
    };
    this.branches.set(branchId, branch);
    return branch;
  }

  /** Get a branch by id. */
  getBranch(branchId: string): ContextBranch | undefined {
    return this.branches.get(branchId);
  }

  /** Add an artifact to a branch. */
  addArtifact(branchId: string, artifact: Artifact, filesModified?: string[]): void {
    const branch = this.branches.get(branchId);
    if (!branch) throw new Error(`Branch not found: ${branchId}`);
    if (branch.merged) throw new Error(`Branch ${branchId} is already merged`);

    branch.artifacts.push(artifact);
    if (filesModified) {
      for (const f of filesModified) {
        if (!branch.filesModified.includes(f)) {
          branch.filesModified.push(f);
        }
      }
    }
  }

  /** Detect file conflicts between two branches. */
  detectConflicts(branchA: string, branchB: string): string[] {
    const a = this.branches.get(branchA);
    const b = this.branches.get(branchB);
    if (!a || !b) return [];

    return a.filesModified.filter((f) => b.filesModified.includes(f));
  }

  /**
   * Merge a branch into main context.
   * - auto-merge: succeeds if no file conflicts with already-merged branches
   * - pick-winner: always succeeds, overwrites conflicts
   * - manual: fails on conflicts, requires external resolution
   */
  merge(branchId: string, strategy: MergeStrategy = "auto-merge"): MergeResult {
    const branch = this.branches.get(branchId);
    if (!branch) throw new Error(`Branch not found: ${branchId}`);
    if (branch.merged) throw new Error(`Branch ${branchId} is already merged`);

    // Check conflicts against all previously merged branches
    const conflicts: string[] = [];
    for (const [, other] of this.branches) {
      if (other.branchId === branchId || !other.merged) continue;
      const c = this.detectConflicts(branchId, other.branchId);
      for (const f of c) {
        if (!conflicts.includes(f)) conflicts.push(f);
      }
    }

    if (conflicts.length > 0 && strategy === "manual") {
      return { success: false, strategy, conflicts, mergedArtifacts: [] };
    }

    if (conflicts.length > 0 && strategy === "auto-merge") {
      return { success: false, strategy, conflicts, mergedArtifacts: [] };
    }

    // pick-winner or no conflicts: merge
    branch.merged = true;
    this.mainArtifacts.push(...branch.artifacts);

    return {
      success: true,
      strategy,
      conflicts,
      mergedArtifacts: [...branch.artifacts],
    };
  }

  /** Get all artifacts on the main (merged) context. */
  getMainArtifacts(): readonly Artifact[] {
    return this.mainArtifacts;
  }

  /** Get all active (unmerged) branches. */
  getActiveBranches(): ContextBranch[] {
    return [...this.branches.values()].filter((b) => !b.merged);
  }

  /** Get all branches for an agent. */
  getBranchesForAgent(agentId: AgentId): ContextBranch[] {
    return [...this.branches.values()].filter((b) => b.ownerId === agentId);
  }

  /** Total branch count. */
  get branchCount(): number {
    return this.branches.size;
  }

  /** Clear all branches and artifacts. */
  clear(): void {
    this.branches.clear();
    this.mainArtifacts = [];
    this.nextBranchId = 1;
  }

  /** Replace main-line artifacts (e.g. after LLM stage merge). */
  setMainArtifacts(artifacts: Artifact[]): void {
    this.mainArtifacts = [...artifacts];
  }
}
