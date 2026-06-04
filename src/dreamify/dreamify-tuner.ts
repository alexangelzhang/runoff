/**
 * M3 Dreamify — grid search over retrieval hyperparameters.
 */

import type { AgentMemory } from "../orchestration/memory.js";
import { buildExperimentEvalReport, type ExperimentEvalReport } from "../observability/observability-dataset.js";
import {
  DEFAULT_DREAMIFY_RETRIEVAL,
  getDreamifyBestParamsPath,
  saveDreamifyBestParams,
  type DreamifyRetrievalParams,
} from "./dreamify-params.js";
import { scoreDreamifyParams, type DreamifyScoreBreakdown } from "./dreamify-scorer.js";

export interface DreamifyGridAxes {
  minSemanticSimilarity?: number[];
  patternLimit?: number[];
  decayHalfLifeDays?: number[];
  fileLinkMinOverlap?: number[];
  /** Fusion weights for the 4-strategy multi-retrieve. Single-element = fixed; multiple = tuned. */
  semanticWeight?: number[];
  bm25Weight?: number[];
  graphWeight?: number[];
  entityWeight?: number[];
}

export const DEFAULT_DREAMIFY_GRID: Required<DreamifyGridAxes> = {
  minSemanticSimilarity: [0.25, 0.35, 0.45],
  patternLimit: [2, 3, 5],
  decayHalfLifeDays: [3, 7, 14],
  fileLinkMinOverlap: [1, 2],
  // Single-element defaults keep grid size at 54 (3×3×3×2×1×1×1×1).
  // Widen these axes to enable data-driven weight tuning once enough race picks accumulate.
  semanticWeight: [0.45],
  bm25Weight: [0.3],
  graphWeight: [0.15],
  entityWeight: [0.1],
};

export interface DreamifyTuneOptions {
  experimentId: string;
  memory: AgentMemory;
  scope?: { project?: string };
  grid?: DreamifyGridAxes;
  dryRun?: boolean;
}

export interface DreamifyCandidate {
  params: DreamifyRetrievalParams;
  breakdown: DreamifyScoreBreakdown;
}

export interface DreamifyTuneReport {
  experimentId: string;
  dryRun: boolean;
  candidatesEvaluated: number;
  baseline: DreamifyCandidate;
  best: DreamifyCandidate;
  evalReport: ExperimentEvalReport;
  savedPath?: string;
  improved: boolean;
}

function daysToMs(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

function buildGrid(axes: DreamifyGridAxes): DreamifyRetrievalParams[] {
  const g = { ...DEFAULT_DREAMIFY_GRID, ...axes };
  const out: DreamifyRetrievalParams[] = [];
  for (const minSemanticSimilarity of g.minSemanticSimilarity) {
    for (const patternLimit of g.patternLimit) {
      for (const days of g.decayHalfLifeDays) {
        for (const fileLinkMinOverlap of g.fileLinkMinOverlap) {
          for (const semanticWeight of g.semanticWeight) {
            for (const bm25Weight of g.bm25Weight) {
              for (const graphWeight of g.graphWeight) {
                for (const entityWeight of g.entityWeight) {
                  out.push({
                    minSemanticSimilarity,
                    patternLimit,
                    decayHalfLifeMs: daysToMs(days),
                    fileLinkMinOverlap,
                    semanticWeight,
                    bm25Weight,
                    graphWeight,
                    entityWeight,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return out;
}

export function runDreamifyTune(options: DreamifyTuneOptions): DreamifyTuneReport {
  const scope = { project: options.scope?.project ?? "default" };
  const grid = buildGrid(options.grid ?? {});
  const evalReport = buildExperimentEvalReport(options.experimentId);

  const baselineParams = DEFAULT_DREAMIFY_RETRIEVAL;
  const baseline: DreamifyCandidate = {
    params: baselineParams,
    breakdown: scoreDreamifyParams(options.experimentId, baselineParams, options.memory, scope),
  };

  let best: DreamifyCandidate = baseline;
  for (const params of grid) {
    const breakdown = scoreDreamifyParams(options.experimentId, params, options.memory, scope);
    if (breakdown.score > best.breakdown.score) {
      best = { params, breakdown };
    }
  }

  const improved = best.breakdown.score > baseline.breakdown.score;
  let savedPath: string | undefined;
  if (!options.dryRun) {
    const winner = improved ? best : baseline;
    saveDreamifyBestParams(winner.params, {
      experimentId: options.experimentId,
      score: winner.breakdown.score,
    });
    savedPath = getDreamifyBestParamsPath();
  }

  return {
    experimentId: options.experimentId,
    dryRun: options.dryRun ?? false,
    candidatesEvaluated: grid.length,
    baseline,
    best,
    evalReport,
    savedPath: options.dryRun ? undefined : savedPath,
    improved,
  };
}
