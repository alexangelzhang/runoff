/**
 * Wire SharedContext into pipeline DAG execution (Phase 7.4).
 */

import type { Candidate } from "../core/candidate.js";
import type { PipelineConfig } from "../core/config.js";
import type { Artifact } from "./artifacts.js";
import {
  isCodeArtifact,
  isDiffArtifact,
  isVerdictArtifact,
} from "./artifacts.js";
import { agentId, type AgentId } from "./multi-agent-types.js";
import { SharedContext, type MergeStrategy } from "./shared-context.js";

export type { StageMergeMode } from "./stage-merge.js";
export { resolveStageMergeMode, mergeParallelStageBranchesAsync } from "./stage-merge.js";

/** Sync merge only — prefer {@link mergeParallelStageBranchesAsync} when llm-merge is enabled. */
export function resolveMergeStrategy(config: PipelineConfig): MergeStrategy {
  const mode = config.orchestration?.conflictResolution;
  if (mode === "pick-winner" || mode === "llm-merge") return "pick-winner";
  return "auto-merge";
}

export function artifactToCandidatePatch(artifact: Artifact): Partial<Candidate> {
  if (isCodeArtifact(artifact)) {
    return { code: artifact.code, summary: artifact.explanation, isAgent: false };
  }
  if (isDiffArtifact(artifact)) {
    return {
      changes: artifact.changes,
      summary: artifact.summary,
      filesModified: [...artifact.filesModified],
      diffStat: artifact.diffStat,
      isAgent: true,
    };
  }
  if (isVerdictArtifact(artifact)) {
    return {
      reviewVerdict: { approved: artifact.approved, feedback: artifact.feedback },
    };
  }
  return {};
}

export function candidateFromArtifacts(artifacts: readonly Artifact[]): Candidate {
  let candidate: Candidate = {};
  const filesModified = new Set<string>();
  for (const artifact of artifacts) {
    const patch = artifactToCandidatePatch(artifact);
    if (patch.filesModified) {
      for (const f of patch.filesModified) filesModified.add(f);
    }
    candidate = { ...candidate, ...patch };
  }
  if (filesModified.size > 0) {
    candidate.filesModified = [...filesModified];
  }
  return candidate;
}

export interface StageMergeOutcome {
  success: boolean;
  strategy: MergeStrategy;
  conflicts: string[];
  candidate: Candidate;
}

/**
 * Merge parallel stage branches into one candidate (ordered merge for determinism).
 */
export function mergeParallelStageBranches(
  shared: SharedContext,
  branchByStep: Map<string, string>,
  strategy: MergeStrategy,
): StageMergeOutcome {
  const stepNames = [...branchByStep.keys()].sort();
  const allConflicts: string[] = [];

  for (const stepName of stepNames) {
    const branchId = branchByStep.get(stepName);
    if (!branchId) continue;
    const result = shared.merge(branchId, strategy);
    for (const c of result.conflicts) {
      if (!allConflicts.includes(c)) allConflicts.push(c);
    }
    if (!result.success) {
      return {
        success: false,
        strategy,
        conflicts: allConflicts,
        candidate: candidateFromArtifacts(shared.getMainArtifacts()),
      };
    }
  }

  return {
    success: true,
    strategy,
    conflicts: allConflicts,
    candidate: candidateFromArtifacts(shared.getMainArtifacts()),
  };
}

export function recordOutcomeOnBranch(
  shared: SharedContext,
  branchId: string,
  artifacts: Artifact[] | undefined,
  filesModified?: string[],
): void {
  if (!artifacts?.length) return;
  for (const artifact of artifacts) {
    const files =
      filesModified ??
      (isDiffArtifact(artifact) ? artifact.filesModified : undefined);
    shared.addArtifact(branchId, artifact, files);
  }
}

export function createParallelBranches(
  shared: SharedContext,
  stepNames: string[],
): Map<string, { branchId: string; ownerId: AgentId }> {
  const out = new Map<string, { branchId: string; ownerId: AgentId }>();
  for (const stepName of stepNames) {
    const ownerId = agentId(stepName);
    const branch = shared.createBranch(ownerId);
    out.set(stepName, { branchId: branch.branchId, ownerId });
  }
  return out;
}
