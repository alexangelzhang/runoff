/**
 * Dreamify status snapshot for MCP / diagnostics.
 */

import type { PipelineConfig } from "../core/config.js";
import {
  getDreamifyBestParamsPath,
  getDreamifyDir,
  loadDreamifyParamsFile,
  resolveDreamifyRetrieval,
  type DreamifyParamsFile,
  type ResolvedDreamifyRetrieval,
} from "./dreamify-params.js";

export interface DreamifyStatusSnapshot {
  active: ResolvedDreamifyRetrieval;
  persisted: DreamifyParamsFile | null;
  paths: {
    dreamifyDir: string;
    bestParams: string;
  };
  config: {
    experimentId?: string;
    project?: string;
    multiStrategy?: boolean;
  };
  decayHalfLifeDays: number;
}

export function describeDreamifyStatus(config: PipelineConfig): DreamifyStatusSnapshot {
  const active = resolveDreamifyRetrieval(config);
  const persisted = loadDreamifyParamsFile();
  const dreamify = config.orchestration?.dreamify;
  return {
    active,
    persisted,
    paths: {
      dreamifyDir: getDreamifyDir(),
      bestParams: getDreamifyBestParamsPath(),
    },
    config: {
      experimentId: dreamify?.experimentId,
      project: dreamify?.project,
      multiStrategy: dreamify?.multiStrategy,
    },
    decayHalfLifeDays: active.decayHalfLifeMs / (24 * 60 * 60 * 1000),
  };
}
