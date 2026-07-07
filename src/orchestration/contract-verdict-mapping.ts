/**
 * Map review verdict text to per-assertion pass/fail coverage.
 */

import type {
  CompletionContract,
  ContractAssertion,
  ContractAssertionCoverage,
  ContractAssertionMapping,
  ContractAssertionVerdictStatus,
} from "../core/state.js";

const FAIL_PATTERN =
  /\b(fail(?:ed|ure|s)?|missing|not met|unmet|violate[ds]?|incorrect|broken|absent|without)\b/i;
const PASS_PATTERN = /\b(pass(?:ed|es)?|met|satisf(?:ied|ies)|correct|complete|verified|ok)\b/i;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((token) => token.length > 2);
}

function assertionMentioned(assertion: ContractAssertion, text: string): boolean {
  if (text.includes(assertion.id)) return true;
  const assertionTokens = new Set(tokenize(assertion.assertion));
  const textTokens = new Set(tokenize(text));
  let overlap = 0;
  for (const token of assertionTokens) {
    if (textTokens.has(token)) overlap += 1;
  }
  const threshold = Math.max(2, Math.ceil(assertionTokens.size * 0.35));
  return overlap >= threshold;
}

function snippetAroundAssertion(assertion: ContractAssertion, text: string): string {
  const idIndex = text.indexOf(assertion.id);
  if (idIndex >= 0) {
    return text.slice(Math.max(0, idIndex - 120), Math.min(text.length, idIndex + 200));
  }
  const firstToken = tokenize(assertion.assertion).find((token) => text.toLowerCase().includes(token));
  if (!firstToken) return text.slice(0, 240);
  const index = text.toLowerCase().indexOf(firstToken);
  return text.slice(Math.max(0, index - 80), Math.min(text.length, index + 180));
}

function mapAssertionStatus(
  assertion: ContractAssertion,
  reviewText: string,
  verdictApproved: boolean,
  stepName: string,
): ContractAssertionMapping {
  const mentioned = assertionMentioned(assertion, reviewText);
  const snippet = snippetAroundAssertion(assertion, reviewText);
  const evidenceRefs = [`stepResults.${stepName}.observation.contractAssertionCoverage`];

  if (!mentioned) {
    const status: ContractAssertionVerdictStatus = verdictApproved ? "pass" : "unknown";
    return {
      assertionId: assertion.id,
      assertion: assertion.assertion,
      status,
      evidenceRefs,
      detail: mentioned ? undefined : verdictApproved
        ? "Not cited explicitly; overall verdict approved."
        : "Not cited in review feedback.",
    };
  }

  if (FAIL_PATTERN.test(snippet)) {
    return {
      assertionId: assertion.id,
      assertion: assertion.assertion,
      status: "fail",
      evidenceRefs,
      detail: "Review text cites a failure signal for this assertion.",
    };
  }

  if (PASS_PATTERN.test(snippet)) {
    return {
      assertionId: assertion.id,
      assertion: assertion.assertion,
      status: "pass",
      evidenceRefs,
      detail: "Review text cites satisfaction for this assertion.",
    };
  }

  return {
    assertionId: assertion.id,
    assertion: assertion.assertion,
    status: verdictApproved ? "partial" : "fail",
    evidenceRefs,
    detail: verdictApproved
      ? "Mentioned without explicit pass/fail wording."
      : "Mentioned while overall verdict needs revision.",
  };
}

function countStatus(mappings: ContractAssertionMapping[], status: ContractAssertionVerdictStatus): number {
  return mappings.filter((row) => row.status === status).length;
}

export function mapVerdictToContractAssertions(input: {
  contract: CompletionContract;
  stepName: string;
  round: number;
  reviewText: string;
  verdictApproved: boolean;
}): ContractAssertionCoverage {
  const mappings = input.contract.assertions.map((assertion) =>
    mapAssertionStatus(assertion, input.reviewText, input.verdictApproved, input.stepName),
  );
  return {
    schemaVersion: 1,
    stepName: input.stepName,
    round: input.round,
    verdictApproved: input.verdictApproved,
    mappings,
    passCount: countStatus(mappings, "pass"),
    failCount: countStatus(mappings, "fail"),
    partialCount: countStatus(mappings, "partial"),
    unknownCount: countStatus(mappings, "unknown"),
  };
}

export function formatAssertionCoverageSummary(coverage: ContractAssertionCoverage): string {
  const failed = coverage.mappings.filter((row) => row.status === "fail" || row.status === "partial");
  if (!failed.length) {
    return `All ${coverage.passCount} mapped assertion(s) pass or are implicitly approved.`;
  }
  return failed
    .map((row) => `[${row.assertionId}] ${row.status}: ${row.detail ?? row.assertion}`)
    .join("\n");
}
