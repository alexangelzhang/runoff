/**
 * Completion contract — disk-backed testable assertions (LOOPS.md contract negotiation).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getSessionsDir } from "../core/paths.js";
import type { CompletionContract, ContractAssertion } from "../core/state.js";

export const COMPLETION_CONTRACT_SCHEMA_VERSION = 1 as const;

export function harnessDirForSession(sessionId: string): string {
  return join(getSessionsDir(), sessionId, "harness");
}

export function contractJsonPath(sessionId: string): string {
  return join(harnessDirForSession(sessionId), "contract.json");
}

export function contractMarkdownPath(sessionId: string): string {
  return join(harnessDirForSession(sessionId), "contract.md");
}

export function seedCompletionContract(input: {
  sessionId: string;
  spec: string;
  acceptanceCriteria?: string[];
}): CompletionContract {
  const assertions: ContractAssertion[] = [];

  for (let i = 0; i < (input.acceptanceCriteria?.length ?? 0); i++) {
    const text = input.acceptanceCriteria![i]!.trim();
    if (!text) continue;
    assertions.push({
      id: `ac-${i + 1}`,
      assertion: text,
      source: "acceptance_criteria",
      testable: true,
    });
  }

  const spec = input.spec.trim();
  if (spec) {
    assertions.push({
      id: "spec-boundary",
      assertion: `Deliverable satisfies the pipeline spec (${spec.length} chars).`,
      source: "spec",
      testable: true,
    });
  }

  return {
    schemaVersion: COMPLETION_CONTRACT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    specSummary: spec.slice(0, 500),
    assertions,
    assertionCount: assertions.length,
    negotiatedAt: new Date().toISOString(),
    diskRef: contractMarkdownPath(input.sessionId),
    debateRef: join(harnessDirForSession(input.sessionId), "contract-debate.md"),
    negotiationStatus: "draft",
    negotiationRound: 0,
  };
}

export function formatContractMarkdown(contract: CompletionContract): string {
  const lines = [
    "# Completion Contract",
    "",
    `session: ${contract.sessionId}`,
    `assertions: ${contract.assertionCount}`,
    `negotiatedAt: ${contract.negotiatedAt ?? "n/a"}`,
    "",
    "## Spec boundary",
    contract.specSummary || "(empty)",
    "",
    "## Testable assertions",
  ];
  for (const item of contract.assertions) {
    lines.push(`- [${item.id}] (${item.source}) ${item.assertion}`);
  }
  lines.push("", "## Notes", "- Generator proposes implementation against this list.", "- Evaluator must refute with evidence when an assertion is not met.");
  return lines.join("\n");
}

export async function readCompletionContract(sessionId: string): Promise<CompletionContract | null> {
  try {
    const raw = await readFile(contractJsonPath(sessionId), "utf-8");
    const parsed = JSON.parse(raw) as CompletionContract;
    if (parsed.schemaVersion !== COMPLETION_CONTRACT_SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeCompletionContract(
  sessionId: string,
  contract: CompletionContract,
): Promise<void> {
  const dir = harnessDirForSession(sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(contractJsonPath(sessionId), `${JSON.stringify(contract, null, 2)}\n`, "utf-8");
  await writeFile(contractMarkdownPath(sessionId), `${formatContractMarkdown(contract)}\n`, "utf-8");
}

export async function ensureCompletionContract(input: {
  sessionId: string;
  spec: string;
  acceptanceCriteria?: string[];
}): Promise<CompletionContract> {
  const existing = await readCompletionContract(input.sessionId);
  if (existing) return existing;
  const contract = seedCompletionContract(input);
  await writeCompletionContract(input.sessionId, contract);
  return contract;
}

export function contractAssertionLines(contract: CompletionContract | undefined): string[] {
  if (!contract?.assertions.length) return [];
  return contract.assertions.map((item, index) => `${index + 1}. [${item.id}] ${item.assertion}`);
}

export function summarizeCompletionContract(contract: CompletionContract | undefined): string | undefined {
  if (!contract) return undefined;
  return `${contract.assertionCount} assertion(s); disk=${contract.diskRef ?? contractMarkdownPath(contract.sessionId)}`;
}
