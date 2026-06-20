/**
 * CLI helpers for local harness evolution commands.
 */

import {
  createProvider,
  loadConfigFromPath,
} from "../core/config.js";
import {
  createHarnessCandidate,
  decideHarnessCandidate,
  evaluateHarnessCandidate,
  listHarnessCandidates,
  proposeHarnessCandidate,
  rankHarnessCandidates,
  selectHarnessCoreset,
  type HarnessEvalPair,
} from "../orchestration/harness-evolution.js";

export type HarnessEvolveListOptions = {
  limit?: number;
  json?: boolean;
};

export type HarnessEvolveCoresetOptions = {
  limit?: number;
  since?: string;
  json?: boolean;
};

export type HarnessEvolveCreateOptions = {
  candidateId?: string;
  summary: string;
  sourceDir?: string;
  editableSurface?: string[];
  expectedFixes?: string[];
  possibleRegressions?: string[];
  evidenceTraceIds?: string[];
  json?: boolean;
};

export type HarnessEvolveProposeOptions = HarnessEvolveCreateOptions & {
  configPath: string;
  provider?: string;
  instructions?: string;
};

export type HarnessEvolveEvaluateOptions = {
  candidateId: string;
  pairs: HarnessEvalPair[];
  json?: boolean;
};

export type HarnessEvolveRankOptions = {
  candidateIds?: string[];
  json?: boolean;
};

export type HarnessEvolveDecideOptions = {
  candidateId: string;
  decision?: "accept" | "rollback";
  reason?: string;
  json?: boolean;
};

export function harnessEvolveList(opts: HarnessEvolveListOptions = {}): void {
  const candidates = listHarnessCandidates().slice(0, opts.limit ?? 20);
  if (opts.json) {
    console.log(JSON.stringify({ candidates, count: candidates.length }, null, 2));
    return;
  }
  if (!candidates.length) {
    console.log("No harness candidates found.");
    return;
  }
  for (const c of candidates) {
    console.log(`${c.createdAt}  ${c.candidateId}  ${c.status}  gate=${c.gate?.accepted ?? "none"}  ${c.manifest.summary}`);
  }
}

export function harnessEvolveCoreset(opts: HarnessEvolveCoresetOptions = {}): void {
  const items = selectHarnessCoreset({ limit: opts.limit, since: opts.since });
  if (opts.json) {
    console.log(JSON.stringify({ items, count: items.length }, null, 2));
    return;
  }
  for (const item of items) {
    console.log(`${item.traceId}  difficulty=${item.difficulty}  key=${item.diversityKey}  status=${item.finalStatus}`);
  }
}

export function harnessEvolveCreate(opts: HarnessEvolveCreateOptions): void {
  const candidate = createHarnessCandidate({
    candidateId: opts.candidateId,
    summary: opts.summary,
    sourceDir: opts.sourceDir,
    editableSurface: opts.editableSurface,
    expectedFixes: opts.expectedFixes,
    possibleRegressions: opts.possibleRegressions,
    evidenceTraceIds: opts.evidenceTraceIds,
    author: "runoff CLI",
  });
  if (opts.json) {
    console.log(JSON.stringify({ candidate }, null, 2));
    return;
  }
  console.log(`Created ${candidate.candidateId}`);
  console.log(`  variant: ${candidate.variant.variantDir}`);
  console.log(`  manifest: ${candidate.manifest.summary}`);
}

export async function harnessEvolvePropose(opts: HarnessEvolveProposeOptions): Promise<void> {
  const config = loadConfigFromPath(opts.configPath);
  const providerName = opts.provider ?? config.orchestration?.plannerProvider ?? Object.keys(config.providers)[0];
  if (!providerName || !config.providers[providerName]) throw new Error("provider is required");
  const provider = createProvider(providerName, config.providers[providerName]!);
  if (!provider) throw new Error(`provider "${providerName}" cannot execute proposals`);
  const result = await proposeHarnessCandidate({
    candidateId: opts.candidateId,
    provider,
    summary: opts.summary,
    sourceDir: opts.sourceDir,
    editableSurface: opts.editableSurface,
    expectedFixes: opts.expectedFixes,
    possibleRegressions: opts.possibleRegressions,
    evidenceTraceIds: opts.evidenceTraceIds,
    instructions: opts.instructions,
  });
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.proposal.failed ? "FAILED" : "PROPOSED"} ${result.candidate.candidateId}`);
  console.log(`  provider: ${result.proposal.provider}`);
  console.log(`  variant:  ${result.candidate.variant.variantDir}`);
  console.log(`  files:    ${result.proposal.filesModified.join(", ") || "none reported"}`);
  console.log(`  observed: ${result.proposal.observedFilesModified.join(", ") || "none"}`);
  if (result.proposal.error) console.log(`  error:    ${result.proposal.error}`);
}

export function harnessEvolveEvaluate(opts: HarnessEvolveEvaluateOptions): void {
  const gate = evaluateHarnessCandidate({ candidateId: opts.candidateId, pairs: opts.pairs });
  if (opts.json) {
    console.log(JSON.stringify({ gate }, null, 2));
    return;
  }
  console.log(`${gate.accepted ? "ACCEPTABLE" : "REJECTED"} ${gate.candidateId}: ${gate.reason}`);
  console.log(`  held-in:  ${gate.heldIn.passed}/${gate.heldIn.total} passed, regressions=${gate.heldIn.regressions.length}`);
  console.log(`  held-out: ${gate.heldOut.passed}/${gate.heldOut.total} passed, regressions=${gate.heldOut.regressions.length}`);
}

export function harnessEvolveRank(opts: HarnessEvolveRankOptions = {}): void {
  const ranks = rankHarnessCandidates(opts.candidateIds);
  if (opts.json) {
    console.log(JSON.stringify({ ranks, count: ranks.length }, null, 2));
    return;
  }
  for (const rank of ranks) {
    console.log(`#${rank.rank} ${rank.candidateId} score=${rank.score} wins=${rank.preferenceWins} losses=${rank.preferenceLosses}`);
  }
}

export function harnessEvolveDecide(opts: HarnessEvolveDecideOptions): void {
  const decision = decideHarnessCandidate({ candidateId: opts.candidateId, decision: opts.decision, reason: opts.reason });
  if (opts.json) {
    console.log(JSON.stringify({ decision }, null, 2));
    return;
  }
  console.log(`${decision.decision.toUpperCase()} ${decision.candidateId}: ${decision.reason}`);
}
