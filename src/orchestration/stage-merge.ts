/**
 * P2 — Parallel DAG stage merge (auto-merge / llm-merge / pick-winner).
 */

import { createProvider, type PipelineConfig } from "../core/config.js";
import type { Candidate } from "../core/candidate.js";
import { createCodeArtifact, createDiffArtifact, type Artifact } from "./artifacts.js";
import {
  candidateFromArtifacts,
  mergeParallelStageBranches,
  type StageMergeOutcome,
} from "./context-integration.js";
import { autoMergeCandidates, mergeCandidatesWithLlm } from "./race-merge.js";
import type { LLMProvider } from "../providers/types.js";
import { SharedContext, type MergeStrategy } from "./shared-context.js";
import { logger } from "../core/logger.js";

export type StageMergeMode = "auto-merge" | "llm-merge" | "pick-winner";

export function resolveStageMergeMode(config: PipelineConfig): StageMergeMode {
  const mode = config.orchestration?.conflictResolution;
  if (mode === "pick-winner") return "pick-winner";
  if (mode === "llm-merge") return "llm-merge";
  return "auto-merge";
}

function candidatesFromBranches(
  shared: SharedContext,
  branchByStep: Map<string, string>,
): { stepName: string; candidate: Candidate }[] {
  const out: { stepName: string; candidate: Candidate }[] = [];
  for (const [stepName, branchId] of branchByStep) {
    const branch = shared.getBranch(branchId);
    if (!branch?.artifacts.length) continue;
    out.push({ stepName, candidate: candidateFromArtifacts(branch.artifacts) });
  }
  return out;
}

function pickStageMergeProvider(config: PipelineConfig, stepNames: string[]): LLMProvider | undefined {
  for (const stepName of stepNames) {
    const tuple = config.pipeline[stepName];
    if (!tuple) continue;
    const providerRef = Array.isArray(tuple[0]) ? tuple[0][0] : tuple[0];
    const pc = config.providers[providerRef];
    if (pc) return createProvider(providerRef, pc);
  }
  const firstKey = Object.keys(config.providers)[0];
  if (!firstKey) return undefined;
  const pc = config.providers[firstKey];
  return pc ? createProvider(firstKey, pc) : undefined;
}

function candidateToMainArtifacts(candidate: Candidate): Artifact[] {
  const artifacts: Artifact[] = [];
  if (candidate.code) {
    artifacts.push(createCodeArtifact(candidate.code, candidate.summary ?? "merged"));
  }
  if (candidate.changes) {
    artifacts.push(
      createDiffArtifact(
        candidate.changes,
        candidate.summary ?? "merged",
        candidate.filesModified ?? [],
        candidate.diffStat ?? "",
      ),
    );
  }
  return artifacts;
}

function applyMergedToMain(shared: SharedContext, merged: Candidate): void {
  shared.clear();
  shared.setMainArtifacts(candidateToMainArtifacts(merged));
}

/**
 * Merge parallel stage branches; llm-merge runs when auto-merge hits file conflicts.
 */
export async function mergeParallelStageBranchesAsync(
  shared: SharedContext,
  branchByStep: Map<string, string>,
  mode: StageMergeMode,
  options: { prompt: string; config: PipelineConfig },
): Promise<StageMergeOutcome> {
  const sharedStrategy: MergeStrategy =
    mode === "pick-winner" ? "pick-winner" : "auto-merge";

  const syncOutcome = mergeParallelStageBranches(shared, branchByStep, sharedStrategy);
  if (syncOutcome.success || mode !== "llm-merge") {
    return { ...syncOutcome, strategy: mode === "llm-merge" ? "auto-merge" : syncOutcome.strategy };
  }

  const branchCandidates = candidatesFromBranches(shared, branchByStep);
  const candidates = branchCandidates.map((b) => b.candidate);
  const auto = autoMergeCandidates(candidates);
  if (auto.ok) {
    applyMergedToMain(shared, auto.merged);
    return {
      success: true,
      strategy: "auto-merge",
      conflicts: syncOutcome.conflicts,
      candidate: auto.merged,
    };
  }

  const stepNames = [...branchByStep.keys()].sort();
  const mergeProvider = pickStageMergeProvider(options.config, stepNames);
  if (!mergeProvider) {
    logger.warn("stage-merge", "llm-merge: no provider available, falling back to pick-winner");
    return mergeParallelStageBranches(shared, branchByStep, "pick-winner");
  }

  const stageLabel = stepNames.join("+");
  const llmMerged = await mergeCandidatesWithLlm(candidates, mergeProvider, {
    stepName: `stage:${stageLabel}`,
    prompt: options.prompt,
    labels: branchCandidates.map((b) => b.stepName),
  });

  if (llmMerged) {
    applyMergedToMain(shared, llmMerged);
    return {
      success: true,
      strategy: "pick-winner",
      conflicts: syncOutcome.conflicts,
      candidate: candidateFromArtifacts(shared.getMainArtifacts()),
    };
  }

  logger.warn(
    "stage-merge",
    `llm-merge failed for stage [${stageLabel}], falling back to pick-winner`,
  );
  return mergeParallelStageBranches(shared, branchByStep, "pick-winner");
}
