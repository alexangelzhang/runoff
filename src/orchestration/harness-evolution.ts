/**
 * Harness evolution substrate.
 *
 * This is intentionally deterministic and local-first: it gives future
 * Self-Harness/RHO/HarnessX-style optimizers typed edit manifests, isolated
 * candidate variants, held-in/held-out regression gates, coreset selection,
 * pairwise self-preference ranking, and auditable accept/rollback records.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { LLMProvider, LLMResponse } from "../providers/types.js";
import { getHarnessEvolutionDir } from "../core/paths.js";
import type { PipelineTrace } from "../observability/trace.js";
import { loadTraceById, queryTraces } from "../observability/trace.js";
import { atomicWriteJson, readJsonFile, safePathSegment } from "./durable-io.js";
import { compareRegression, evaluatePipelineTrace, type RegressionTolerance } from "./harness.js";

export const HARNESS_EVOLUTION_SCHEMA = "runoff-harness-evolution-v1" as const;

export interface HarnessChangeManifest {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  candidateId: string;
  createdAt: string;
  summary: string;
  editableSurface: string[];
  expectedFixes: string[];
  possibleRegressions: string[];
  evidenceTraceIds: string[];
  author?: string;
}

export interface HarnessCandidateRecord {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  candidateId: string;
  createdAt: string;
  status: "proposed" | "accepted" | "rolled_back";
  manifest: HarnessChangeManifest;
  variant: {
    isolated: boolean;
    sourceDir?: string;
    variantDir: string;
  };
  proposal?: HarnessProposalResult;
  gate?: HarnessGateResult;
  ranking?: HarnessCandidateRank;
  decision?: HarnessDecisionRecord;
}

export interface HarnessEvalPair {
  baselineTraceId: string;
  candidateTraceId: string;
  split: "held-in" | "held-out";
}

export interface HarnessEvalInput {
  candidateId: string;
  pairs: HarnessEvalPair[];
  tolerance?: RegressionTolerance;
}

export interface HarnessSplitGate {
  split: "held-in" | "held-out";
  total: number;
  passed: number;
  regressions: Array<{ baselineTraceId: string; candidateTraceId: string; message: string }>;
  improvements: Array<{ baselineTraceId: string; candidateTraceId: string; reason: string }>;
}

export interface HarnessGateResult {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  candidateId: string;
  evaluatedAt: string;
  accepted: boolean;
  reason: string;
  heldIn: HarnessSplitGate;
  heldOut: HarnessSplitGate;
}

export interface HarnessCoresetItem {
  traceId: string;
  difficulty: number;
  diversityKey: string;
  finalStatus: PipelineTrace["finalStatus"];
  promptPreview: string;
}

export interface HarnessCandidateRank {
  candidateId: string;
  score: number;
  rank: number;
  preferenceWins: number;
  preferenceLosses: number;
  reasons: string[];
}

export interface HarnessDecisionRecord {
  candidateId: string;
  decision: "accept" | "rollback";
  decidedAt: string;
  reason: string;
  previousStatus: HarnessCandidateRecord["status"];
}

export interface HarnessProposalResult {
  schema: typeof HARNESS_EVOLUTION_SCHEMA;
  candidateId: string;
  proposedAt: string;
  provider: string;
  model: string;
  prompt: string;
  summary: string;
  filesModified: string[];
  diffStat?: string;
  failed?: boolean;
  error?: string;
  surfaceViolations: string[];
}

function evolutionDir(): string {
  return getHarnessEvolutionDir();
}

function candidatesDir(): string {
  return join(evolutionDir(), "candidates");
}

function candidateDir(candidateId: string): string {
  return join(candidatesDir(), safePathSegment(candidateId));
}

function candidatePath(candidateId: string): string {
  return join(candidateDir(candidateId), "candidate.json");
}

function gatePath(candidateId: string): string {
  return join(candidateDir(candidateId), "gate.json");
}

function rankingPath(candidateId: string): string {
  return join(candidateDir(candidateId), "ranking.json");
}

function decisionPath(candidateId: string): string {
  return join(candidateDir(candidateId), "decision.json");
}

function proposalPath(candidateId: string): string {
  return join(candidateDir(candidateId), "proposal.json");
}

function variantDir(candidateId: string): string {
  return join(candidateDir(candidateId), "variant");
}

function normalizeSurfacePath(path: string): string {
  return normalize(path).replace(/\\/g, "/").replace(/^\.\//, "");
}

function isAllowedByEditableSurface(file: string, surface: string[]): boolean {
  if (!surface.length) return true;
  const normalizedFile = normalizeSurfacePath(file);
  return surface.some((entry) => {
    const normalizedEntry = normalizeSurfacePath(entry);
    if (normalizedEntry.endsWith("/")) return normalizedFile.startsWith(normalizedEntry);
    return normalizedFile === normalizedEntry || normalizedFile.startsWith(`${normalizedEntry}/`);
  });
}

function summarizeProviderResponse(response: LLMResponse): {
  model: string;
  summary: string;
  filesModified: string[];
  diffStat?: string;
  failed?: boolean;
  error?: string;
} {
  if (response.kind === "agent") {
    return {
      model: response.model,
      summary: response.summary,
      filesModified: response.filesModified,
      diffStat: response.diffStat,
      failed: response.failed,
      error: response.error,
    };
  }
  return {
    model: response.model,
    summary: response.explanation || response.content.slice(0, 500),
    filesModified: [],
    failed: response.failed,
    error: response.error,
  };
}

export function createHarnessCandidate(input: {
  candidateId?: string;
  summary: string;
  editableSurface?: string[];
  expectedFixes?: string[];
  possibleRegressions?: string[];
  evidenceTraceIds?: string[];
  sourceDir?: string;
  author?: string;
}): HarnessCandidateRecord {
  const candidateId = input.candidateId?.trim() || `harness-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const dir = candidateDir(candidateId);
  const vDir = variantDir(candidateId);
  mkdirSync(dir, { recursive: true });
  mkdirSync(vDir, { recursive: true });

  const sourceDir = input.sourceDir ? resolve(input.sourceDir) : undefined;
  if (sourceDir && existsSync(sourceDir)) {
    cpSync(sourceDir, vDir, { recursive: true, force: true });
  }

  const manifest: HarnessChangeManifest = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    candidateId,
    createdAt: now,
    summary: input.summary,
    editableSurface: input.editableSurface ?? [],
    expectedFixes: input.expectedFixes ?? [],
    possibleRegressions: input.possibleRegressions ?? [],
    evidenceTraceIds: input.evidenceTraceIds ?? [],
    author: input.author,
  };

  const record: HarnessCandidateRecord = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    candidateId,
    createdAt: now,
    status: "proposed",
    manifest,
    variant: {
      isolated: true,
      sourceDir,
      variantDir: vDir,
    },
  };
  atomicWriteJson(candidatePath(candidateId), record);
  atomicWriteJson(join(dir, "manifest.json"), manifest);
  return record;
}

export function loadHarnessCandidate(candidateId: string): HarnessCandidateRecord | undefined {
  return readJsonFile<HarnessCandidateRecord>(candidatePath(candidateId));
}

export function listHarnessCandidates(): HarnessCandidateRecord[] {
  if (!existsSync(candidatesDir())) return [];
  return readdirSync(candidatesDir())
    .flatMap((name) => {
      const record = readJsonFile<HarnessCandidateRecord>(join(candidatesDir(), name, "candidate.json"));
      return record ? [record] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function buildProposalPrompt(record: HarnessCandidateRecord, extraInstructions?: string): string {
  return [
    "You are proposing a harness candidate for runoff.",
    "Edit only inside the current isolated variant directory.",
    "Do not mutate the source repository or files outside the current working directory.",
    "Keep changes limited to the editable surface declared below.",
    "",
    "Manifest:",
    JSON.stringify(record.manifest, null, 2),
    "",
    "Additional instructions:",
    extraInstructions?.trim() || "Make the smallest harness change that satisfies the manifest.",
  ].join("\n");
}

export async function proposeHarnessCandidate(input: {
  candidateId?: string;
  provider: LLMProvider;
  summary?: string;
  sourceDir?: string;
  editableSurface?: string[];
  expectedFixes?: string[];
  possibleRegressions?: string[];
  evidenceTraceIds?: string[];
  instructions?: string;
}): Promise<{ candidate: HarnessCandidateRecord; proposal: HarnessProposalResult }> {
  const existing = input.candidateId ? loadHarnessCandidate(input.candidateId) : undefined;
  const candidate = existing ?? createHarnessCandidate({
    candidateId: input.candidateId,
    summary: input.summary ?? "Harness proposer candidate",
    sourceDir: input.sourceDir,
    editableSurface: input.editableSurface,
    expectedFixes: input.expectedFixes,
    possibleRegressions: input.possibleRegressions,
    evidenceTraceIds: input.evidenceTraceIds,
    author: "harness-proposer",
  });

  const prompt = buildProposalPrompt(candidate, input.instructions);
  const response = await input.provider.execute({
    prompt,
    workDir: candidate.variant.variantDir,
    stepName: "harness-propose",
    round: 1,
  });
  const summary = summarizeProviderResponse(response);
  const surfaceViolations = summary.filesModified.filter(
    (file) => !isAllowedByEditableSurface(file, candidate.manifest.editableSurface),
  );
  const proposal: HarnessProposalResult = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    candidateId: candidate.candidateId,
    proposedAt: new Date().toISOString(),
    provider: input.provider.name,
    model: summary.model,
    prompt,
    summary: summary.summary,
    filesModified: summary.filesModified,
    diffStat: summary.diffStat,
    failed: summary.failed || surfaceViolations.length > 0,
    error: surfaceViolations.length
      ? `provider modified files outside editable surface: ${surfaceViolations.join(", ")}`
      : summary.error,
    surfaceViolations,
  };

  const next: HarnessCandidateRecord = { ...candidate, proposal };
  atomicWriteJson(candidatePath(candidate.candidateId), next);
  atomicWriteJson(proposalPath(candidate.candidateId), proposal);
  return { candidate: next, proposal };
}

function traceDifficulty(trace: PipelineTrace): number {
  let score = 0;
  if (trace.finalStatus === "failed" || trace.finalStatus === "max_rounds") score += 5;
  if (trace.finalStatus === "aborted") score += 3;
  score += Math.min(3, trace.totalRounds);
  score += Math.min(3, trace.steps.filter((s) => s.error).length);
  score += Math.min(3, Math.floor(trace.totalDurationMs / 60_000));
  return score;
}

function diversityKey(trace: PipelineTrace): string {
  const providers = [...new Set(trace.steps.map((s) => s.provider))].sort().join("+") || "none";
  const words = trace.prompt.toLowerCase().match(/[a-z0-9_-]{4,}/g) ?? [];
  return `${trace.finalStatus}:${providers}:${words.slice(0, 3).join("-")}`;
}

export function selectHarnessCoreset(input: {
  limit?: number;
  since?: string;
  traceIds?: string[];
} = {}): HarnessCoresetItem[] {
  const limit = Math.max(1, input.limit ?? 10);
  const traces = input.traceIds?.length
    ? input.traceIds.flatMap((id) => {
        const trace = loadTraceById(id);
        return trace ? [trace] : [];
      })
    : queryTraces({ since: input.since });

  const ranked = traces
    .map((trace) => ({
      trace,
      item: {
        traceId: trace.id,
        difficulty: traceDifficulty(trace),
        diversityKey: diversityKey(trace),
        finalStatus: trace.finalStatus,
        promptPreview: trace.prompt.slice(0, 160),
      } satisfies HarnessCoresetItem,
    }))
    .sort((a, b) => b.item.difficulty - a.item.difficulty || b.trace.timestamp.localeCompare(a.trace.timestamp));

  const selected: HarnessCoresetItem[] = [];
  const seenKeys = new Set<string>();
  for (const entry of ranked) {
    if (selected.length >= limit) break;
    if (seenKeys.has(entry.item.diversityKey) && selected.length < Math.ceil(limit / 2)) continue;
    selected.push(entry.item);
    seenKeys.add(entry.item.diversityKey);
  }
  for (const entry of ranked) {
    if (selected.length >= limit) break;
    if (!selected.some((item) => item.traceId === entry.item.traceId)) selected.push(entry.item);
  }
  return selected;
}

function improvementReason(candidate: PipelineTrace, baseline: PipelineTrace): string | undefined {
  const c = evaluatePipelineTrace(candidate);
  const b = evaluatePipelineTrace(baseline);
  if (c.success && !b.success) return "candidate succeeded where baseline failed";
  if (c.success === b.success && c.durationMs < b.durationMs) return "candidate reduced duration";
  if (c.success === b.success && c.roundCount < b.roundCount) return "candidate reduced rounds";
  return undefined;
}

function emptySplit(split: "held-in" | "held-out"): HarnessSplitGate {
  return { split, total: 0, passed: 0, regressions: [], improvements: [] };
}

export function evaluateHarnessCandidate(input: HarnessEvalInput): HarnessGateResult {
  const candidate = loadHarnessCandidate(input.candidateId);
  if (!candidate) throw new Error(`Harness candidate not found: ${input.candidateId}`);

  const bySplit: Record<"held-in" | "held-out", HarnessSplitGate> = {
    "held-in": emptySplit("held-in"),
    "held-out": emptySplit("held-out"),
  };

  for (const pair of input.pairs) {
    if (pair.split !== "held-in" && pair.split !== "held-out") {
      throw new Error(`Invalid harness eval split: ${String(pair.split)}`);
    }
    const baseline = loadTraceById(pair.baselineTraceId);
    const actual = loadTraceById(pair.candidateTraceId);
    if (!baseline || !actual) {
      bySplit[pair.split].regressions.push({
        baselineTraceId: pair.baselineTraceId,
        candidateTraceId: pair.candidateTraceId,
        message: !baseline ? "baseline trace missing" : "candidate trace missing",
      });
      bySplit[pair.split].total += 1;
      continue;
    }

    const split = bySplit[pair.split];
    split.total += 1;
    const reason = improvementReason(actual, baseline);
    if (reason) {
      split.passed += 1;
      split.improvements.push({ baselineTraceId: baseline.id, candidateTraceId: actual.id, reason });
      continue;
    }
    const regression = compareRegression(
      evaluatePipelineTrace(actual),
      evaluatePipelineTrace(baseline),
      input.tolerance,
    );
    if (regression.pass) {
      split.passed += 1;
    } else {
      split.regressions.push({
        baselineTraceId: baseline.id,
        candidateTraceId: actual.id,
        message: regression.message ?? "regression",
      });
    }
  }

  const heldIn = bySplit["held-in"];
  const heldOut = bySplit["held-out"];
  const regressionCount = heldIn.regressions.length + heldOut.regressions.length;
  const improvementCount = heldIn.improvements.length + heldOut.improvements.length;
  const hasBothSplits = heldIn.total > 0 && heldOut.total > 0;
  const accepted = hasBothSplits && regressionCount === 0 && improvementCount > 0;
  const reason = !hasBothSplits
    ? "held-in and held-out evidence are both required"
    : regressionCount > 0
      ? `${regressionCount} regression(s) detected`
      : improvementCount === 0
        ? "no measured improvement"
        : "passed held-in/held-out gate with measured improvement";

  const result: HarnessGateResult = {
    schema: HARNESS_EVOLUTION_SCHEMA,
    candidateId: input.candidateId,
    evaluatedAt: new Date().toISOString(),
    accepted,
    reason,
    heldIn,
    heldOut,
  };

  const next: HarnessCandidateRecord = { ...candidate, gate: result };
  atomicWriteJson(candidatePath(input.candidateId), next);
  atomicWriteJson(gatePath(input.candidateId), result);
  return result;
}

function rankScore(record: HarnessCandidateRecord): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const gate = record.gate;
  if (!gate) {
    reasons.push("no gate result");
    return { score, reasons };
  }
  if (gate.accepted) {
    score += 100;
    reasons.push("gate accepted");
  } else {
    reasons.push(`gate rejected: ${gate.reason}`);
  }
  const improvementCount = gate.heldIn.improvements.length + gate.heldOut.improvements.length;
  const regressionCount = gate.heldIn.regressions.length + gate.heldOut.regressions.length;
  score += improvementCount * 10;
  score -= regressionCount * 25;
  score += gate.heldOut.passed * 3 + gate.heldIn.passed;
  if (record.manifest.expectedFixes.length) score += Math.min(5, record.manifest.expectedFixes.length);
  reasons.push(`${improvementCount} improvement(s), ${regressionCount} regression(s)`);
  return { score, reasons };
}

export function rankHarnessCandidates(candidateIds?: string[]): HarnessCandidateRank[] {
  const records = (candidateIds?.length ? candidateIds.flatMap((id) => {
    const record = loadHarnessCandidate(id);
    return record ? [record] : [];
  }) : listHarnessCandidates());

  const scored = records.map((record) => ({ record, ...rankScore(record), wins: 0, losses: 0 }));
  for (let i = 0; i < scored.length; i++) {
    for (let j = i + 1; j < scored.length; j++) {
      const left = scored[i]!;
      const right = scored[j]!;
      if (left.score === right.score) continue;
      if (left.score > right.score) {
        left.wins += 1;
        right.losses += 1;
      } else {
        right.wins += 1;
        left.losses += 1;
      }
    }
  }
  const ranks = scored
    .sort((a, b) => b.score - a.score || b.wins - a.wins || a.record.createdAt.localeCompare(b.record.createdAt))
    .map((item, index) => ({
      candidateId: item.record.candidateId,
      score: item.score,
      rank: index + 1,
      preferenceWins: item.wins,
      preferenceLosses: item.losses,
      reasons: item.reasons,
    }));

  for (const rank of ranks) {
    const record = loadHarnessCandidate(rank.candidateId);
    if (!record) continue;
    atomicWriteJson(candidatePath(rank.candidateId), { ...record, ranking: rank });
    atomicWriteJson(rankingPath(rank.candidateId), rank);
  }
  return ranks;
}

export function decideHarnessCandidate(input: {
  candidateId: string;
  decision?: "accept" | "rollback";
  reason?: string;
}): HarnessDecisionRecord {
  const record = loadHarnessCandidate(input.candidateId);
  if (!record) throw new Error(`Harness candidate not found: ${input.candidateId}`);
  const autoDecision = record.gate?.accepted ? "accept" : "rollback";
  const decision = input.decision ?? autoDecision;
  const nextStatus = decision === "accept" ? "accepted" : "rolled_back";
  const decisionRecord: HarnessDecisionRecord = {
    candidateId: input.candidateId,
    decision,
    decidedAt: new Date().toISOString(),
    reason: input.reason ?? (decision === "accept" ? "accepted by regression gate" : record.gate?.reason ?? "rolled back without passing gate"),
    previousStatus: record.status,
  };
  atomicWriteJson(candidatePath(input.candidateId), {
    ...record,
    status: nextStatus,
    decision: decisionRecord,
  } satisfies HarnessCandidateRecord);
  atomicWriteJson(decisionPath(input.candidateId), decisionRecord);
  return decisionRecord;
}
