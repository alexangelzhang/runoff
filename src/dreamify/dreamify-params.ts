/**
 * M3 Dreamify — persisted retrieval hyperparameters (~/.runoff/dreamify/).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getPipelineHomeDir } from "../core/paths.js";
import { DEFAULT_MEMORY_HALF_LIFE_MS } from "../orchestration/memory-decay.js";
import type { PipelineConfig } from "../core/config.js";

export const DREAMIFY_PARAMS_VERSION = 1 as const;

export interface DreamifyRetrievalParams {
  minSemanticSimilarity: number;
  patternLimit: number;
  decayHalfLifeMs: number;
  fileLinkMinOverlap: number;
  /** M4: fuse semantic + BM25-lite + graph hop (also from orchestration.dreamify.multiStrategy). */
  multiStrategy?: boolean;
}

export interface ResolvedDreamifyRetrieval extends DreamifyRetrievalParams {
  multiStrategy: boolean;
}

export interface DreamifyParamsFile {
  version: typeof DREAMIFY_PARAMS_VERSION;
  generatedAt: string;
  experimentId?: string;
  score?: number;
  active: DreamifyRetrievalParams;
  previous?: DreamifyRetrievalParams & { score?: number; generatedAt?: string };
}

export const DEFAULT_DREAMIFY_RETRIEVAL: DreamifyRetrievalParams = {
  minSemanticSimilarity: 0.35,
  patternLimit: 3,
  decayHalfLifeMs: DEFAULT_MEMORY_HALF_LIFE_MS,
  fileLinkMinOverlap: 1,
};

let _runtimeOverride: DreamifyRetrievalParams | null = null;

export function getDreamifyDir(): string {
  return join(getPipelineHomeDir(), "dreamify");
}

export function getDreamifyBestParamsPath(): string {
  return join(getDreamifyDir(), "best-params.json");
}

export function loadDreamifyParamsFile(): DreamifyParamsFile | null {
  const path = getDreamifyBestParamsPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DreamifyParamsFile>;
    if (!raw.active) return null;
    return {
      version: DREAMIFY_PARAMS_VERSION,
      generatedAt: raw.generatedAt ?? new Date(0).toISOString(),
      experimentId: raw.experimentId,
      score: raw.score,
      active: normalizeRetrieval(raw.active),
      previous: raw.previous ? normalizeRetrieval(raw.previous) : undefined,
    };
  } catch {
    return null;
  }
}

function normalizeRetrieval(p: Partial<DreamifyRetrievalParams>): DreamifyRetrievalParams {
  return {
    minSemanticSimilarity:
      typeof p.minSemanticSimilarity === "number"
        ? p.minSemanticSimilarity
        : DEFAULT_DREAMIFY_RETRIEVAL.minSemanticSimilarity,
    patternLimit:
      typeof p.patternLimit === "number" ? p.patternLimit : DEFAULT_DREAMIFY_RETRIEVAL.patternLimit,
    decayHalfLifeMs:
      typeof p.decayHalfLifeMs === "number" ? p.decayHalfLifeMs : DEFAULT_DREAMIFY_RETRIEVAL.decayHalfLifeMs,
    fileLinkMinOverlap:
      typeof p.fileLinkMinOverlap === "number"
        ? p.fileLinkMinOverlap
        : DEFAULT_DREAMIFY_RETRIEVAL.fileLinkMinOverlap,
    multiStrategy: p.multiStrategy === true,
  };
}

export function resolveDreamifyRetrieval(config?: PipelineConfig): ResolvedDreamifyRetrieval {
  const base = _runtimeOverride ?? loadDreamifyParamsFile()?.active ?? DEFAULT_DREAMIFY_RETRIEVAL;
  const normalized = normalizeRetrieval(base);
  const fromConfig = config?.orchestration?.dreamify?.multiStrategy === true;
  return {
    ...normalized,
    multiStrategy: fromConfig || normalized.multiStrategy === true,
  };
}

export function setDreamifyRetrievalOverride(params: DreamifyRetrievalParams | null): void {
  _runtimeOverride = params;
}

export function saveDreamifyBestParams(
  active: DreamifyRetrievalParams,
  meta: { experimentId?: string; score?: number },
): DreamifyParamsFile {
  const prevFile = loadDreamifyParamsFile();
  const doc: DreamifyParamsFile = {
    version: DREAMIFY_PARAMS_VERSION,
    generatedAt: new Date().toISOString(),
    experimentId: meta.experimentId,
    score: meta.score,
    active,
    previous: prevFile
      ? { ...prevFile.active, score: prevFile.score, generatedAt: prevFile.generatedAt }
      : undefined,
  };
  const path = getDreamifyBestParamsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2), "utf8");

  const historyPath = join(getDreamifyDir(), "history", `${doc.generatedAt.replace(/[:.]/g, "-")}.json`);
  mkdirSync(dirname(historyPath), { recursive: true });
  writeFileSync(historyPath, JSON.stringify(doc, null, 2), "utf8");

  return doc;
}
