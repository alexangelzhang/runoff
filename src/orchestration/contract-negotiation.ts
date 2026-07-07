/**
 * Generator ↔ Evaluator contract negotiation on disk (contract-debate.md).
 */

import type {
  CompletionContract,
  ContractAssertionCoverage,
  ContractNegotiationStatus,
  StepResult,
} from "../core/state.js";
import { resolveLoopHarnessRole } from "./harness-role.js";
import { resolveStepContextKind } from "./context-contract.js";
import {
  appendContractDebateSection,
  appendHarnessLog,
  contractDebateMarkdownPath,
  formatDebateSection,
  writeHarnessProgress,
} from "./harness-disk-state.js";
import {
  formatAssertionCoverageSummary,
  mapVerdictToContractAssertions,
} from "./contract-verdict-mapping.js";
import { writeCompletionContract } from "./completion-contract.js";

const CONTRACT_ADD_PATTERN = /^CONTRACT_(?:ADD|ASSERTION):\s*(.+)$/gim;

export function parseGeneratorContractProposals(text: string): string[] {
  const proposals: string[] = [];
  for (const match of text.matchAll(CONTRACT_ADD_PATTERN)) {
    const value = match[1]?.trim();
    if (value) proposals.push(value);
  }
  return proposals;
}

function collectStepText(stepResult: StepResult): string {
  return [stepResult.summary, stepResult.explanation, stepResult.reason, stepResult.code]
    .filter(Boolean)
    .join("\n");
}

function mergeNegotiatedAssertions(
  contract: CompletionContract,
  proposals: string[],
): CompletionContract {
  if (!proposals.length) return contract;
  const existing = new Set(contract.assertions.map((row) => row.assertion.trim().toLowerCase()));
  const negotiated = [...contract.assertions];
  let added = 0;
  for (const proposal of proposals) {
    const normalized = proposal.trim().toLowerCase();
    if (!normalized || existing.has(normalized)) continue;
    existing.add(normalized);
    added += 1;
    negotiated.push({
      id: `negotiated-${negotiated.filter((row) => row.source === "negotiated").length + 1}`,
      assertion: proposal.trim(),
      source: "negotiated",
      testable: true,
    });
  }
  if (!added) return contract;
  return {
    ...contract,
    assertions: negotiated,
    assertionCount: negotiated.length,
    negotiationStatus: "proposed",
    negotiationRound: (contract.negotiationRound ?? 0) + 1,
    lastDebateAt: new Date().toISOString(),
    debateRef: contract.debateRef ?? contractDebateMarkdownPath(contract.sessionId),
  };
}

function reviewFeedbackText(stepResult: StepResult, verdict?: { approved: boolean; feedback: string }): string {
  const verdictArtifact = stepResult.artifacts?.find((artifact) => artifact.kind === "verdict");
  const reviewArtifact = stepResult.artifacts?.find((artifact) => artifact.kind === "review");
  const parts = [
    verdict?.feedback,
    stepResult.reason,
    stepResult.summary,
    stepResult.explanation,
    verdictArtifact && verdictArtifact.kind === "verdict" ? verdictArtifact.feedback : undefined,
    reviewArtifact && reviewArtifact.kind === "review" ? reviewArtifact.reviewText : undefined,
  ];
  return parts.filter(Boolean).join("\n\n");
}

function resolveNegotiationStatus(
  coverage: ContractAssertionCoverage,
  verdictApproved: boolean,
): ContractNegotiationStatus {
  if (verdictApproved && coverage.failCount === 0 && coverage.partialCount === 0) return "agreed";
  if (coverage.failCount > 0 || coverage.partialCount > 0 || !verdictApproved) return "challenged";
  return "proposed";
}

export async function updateHarnessStateAfterStep(input: {
  sessionId: string;
  stepName: string;
  round: number;
  reviewStepName: string;
  stepResult: StepResult;
  contract: CompletionContract;
  stepResults: Record<string, StepResult>;
  verdict?: { approved: boolean; feedback: string };
}): Promise<{
  contract: CompletionContract;
  assertionCoverage?: ContractAssertionCoverage;
}> {
  const kind = resolveStepContextKind(input.stepName, input.reviewStepName);
  const role = resolveLoopHarnessRole(kind);
  let contract = { ...input.contract, assertions: [...input.contract.assertions] };
  let assertionCoverage: ContractAssertionCoverage | undefined;

  await appendHarnessLog(
    input.sessionId,
    input.stepName,
    `step ${input.stepResult.status}`,
    `round=${input.round} role=${role}`,
  );

  if (role === "generator" && input.stepResult.status === "success") {
    const proposals = parseGeneratorContractProposals(collectStepText(input.stepResult));
    contract = mergeNegotiatedAssertions(contract, proposals);
    const message =
      proposals.length > 0
        ? `Generator proposed ${proposals.length} new contract assertion(s):\n${proposals.map((p) => `- ${p}`).join("\n")}`
        : `Generator completed ${input.stepName}; working against ${contract.assertionCount} contract assertion(s).`;
    await appendContractDebateSection(
      input.sessionId,
      formatDebateSection({
        round: input.round,
        role: "generator",
        stepName: input.stepName,
        message,
        assertionIds: contract.assertions.map((row) => row.id),
      }),
    );
    if (!proposals.length && contract.negotiationStatus !== "challenged") {
      contract = { ...contract, negotiationStatus: "proposed" };
    }
  }

  if (role === "evaluator" && input.stepResult.status === "success") {
    const reviewText = reviewFeedbackText(input.stepResult, input.verdict);
    const verdictApproved = input.verdict?.approved ?? false;
    assertionCoverage = mapVerdictToContractAssertions({
      contract,
      stepName: input.stepName,
      round: input.round,
      reviewText,
      verdictApproved,
    });
    const negotiationStatus = resolveNegotiationStatus(assertionCoverage, verdictApproved);
    contract = {
      ...contract,
      negotiationStatus,
      negotiationRound: (contract.negotiationRound ?? 0) + 1,
      lastDebateAt: new Date().toISOString(),
      debateRef: contract.debateRef ?? contractDebateMarkdownPath(input.sessionId),
      latestAssertionCoverage: assertionCoverage,
    };
    const challengedIds = assertionCoverage.mappings
      .filter((row) => row.status === "fail" || row.status === "partial")
      .map((row) => row.assertionId);
    await appendContractDebateSection(
      input.sessionId,
      formatDebateSection({
        round: input.round,
        role: "evaluator",
        stepName: input.stepName,
        message: [
          `Verdict: ${verdictApproved ? "APPROVED" : "NEEDS_REVISION"}`,
          formatAssertionCoverageSummary(assertionCoverage),
        ].join("\n\n"),
        assertionIds: challengedIds.length ? challengedIds : assertionCoverage.mappings.map((row) => row.assertionId),
      }),
    );
    await appendHarnessLog(
      input.sessionId,
      "contract",
      negotiationStatus,
      `pass=${assertionCoverage.passCount} fail=${assertionCoverage.failCount} partial=${assertionCoverage.partialCount}`,
    );
  }

  await writeCompletionContract(input.sessionId, contract);
  await writeHarnessProgress({
    sessionId: input.sessionId,
    round: input.round,
    stepResults: input.stepResults,
    contract,
    latestStep: input.stepName,
  });

  return { contract, assertionCoverage };
}
