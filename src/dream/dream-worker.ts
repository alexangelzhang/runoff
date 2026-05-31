/**
 * Dream worker — orchestrates track A → B → (optional) C.
 */

import type { PipelineConfig } from "../core/config.js";
import { getPipelineLocalMemory } from "../memory/pipeline-memory.js";
import { touchDreamState, loadDreamState } from "../memory/dream-state.js";
import { exportDreamMemoryJsonl } from "./dream-export.js";
import { collectDreamBatch } from "./dream-structured.js";
import { applyDreamRules, getDreamAuditPath, type DreamRulesResult } from "./dream-rules.js";
import {
  applyDreamLlmProposals,
  enrichDreamBatchWithLlm,
  type DreamLlmProposal,
} from "./dream-llm.js";

export interface DreamRunOptions {
  config: PipelineConfig;
  sinceLastRun?: boolean;
  batchLimit?: number;
  llmEnabled?: boolean;
  dryRun?: boolean;
  project?: string;
}

export interface DreamRunReport {
  batchSize: number;
  since: string | null;
  rules: DreamRulesResult;
  llmProposals: DreamLlmProposal[];
  llmApplied: number;
  llmErrors: string[];
  auditsPath: string;
  exportPath?: string;
  exportRowCount?: number;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
}

export async function runDreamWorker(options: DreamRunOptions): Promise<DreamRunReport> {
  const startedAt = new Date().toISOString();
  const dreamCfg = options.config.orchestration?.dream;
  const enabled = dreamCfg?.enabled !== false;
  if (!enabled) {
    throw new Error("orchestration.dream.enabled is false");
  }

  const sinceLastRun = options.sinceLastRun ?? dreamCfg?.sinceLastRun ?? true;
  const batchLimit = options.batchLimit ?? dreamCfg?.batchLimit ?? 50;
  const llmEnabled = options.llmEnabled ?? dreamCfg?.llmEnabled ?? true;
  const dryRun = options.dryRun ?? false;
  const project = options.project ?? dreamCfg?.project ?? "default";
  const scope = { project };

  const prevState = loadDreamState();
  const since = sinceLastRun ? prevState.lastDreamAt : null;

  const batch = collectDreamBatch({ since, limit: batchLimit });
  const memory = getPipelineLocalMemory();

  const rules = applyDreamRules(memory, batch, { scope, dryRun });

  let llmProposals: DreamLlmProposal[] = [];
  let llmErrors: string[] = [];
  let llmApplied = 0;

  if (llmEnabled && batch.length > 0) {
    const llm = await enrichDreamBatchWithLlm(options.config, batch, {
      maxItems: Math.min(10, batch.length),
      providerName: dreamCfg?.provider,
    });
    llmProposals = llm.proposals;
    llmErrors = llm.errors;
    if (llm.proposals.length > 0) {
      llmApplied = applyDreamLlmProposals(memory, llm.proposals, { scope, dryRun });
    }
  }

  let exportPath: string | undefined;
  let exportRowCount: number | undefined;
  if (!dryRun) {
    touchDreamState();
    if (options.config.orchestration?.dreamify?.exportOnDreamRun) {
      const exported = exportDreamMemoryJsonl(memory, { scope });
      exportPath = exported.path;
      exportRowCount = exported.rowCount;
    }
  }

  return {
    batchSize: batch.length,
    since,
    rules,
    llmProposals,
    llmApplied,
    llmErrors,
    auditsPath: getDreamAuditPath(),
    exportPath,
    exportRowCount,
    dryRun,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
