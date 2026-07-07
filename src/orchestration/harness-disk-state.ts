/**
 * LOOPS.md disk state — append-only log.md and rolling progress.md under session harness dir.
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CompletionContract,
  ContractNegotiationStatus,
  StepResult,
  StepStatus,
} from "../core/state.js";
import { harnessDirForSession } from "./completion-contract.js";

export function progressMarkdownPath(sessionId: string): string {
  return join(harnessDirForSession(sessionId), "progress.md");
}

export function logMarkdownPath(sessionId: string): string {
  return join(harnessDirForSession(sessionId), "log.md");
}

export function contractDebateMarkdownPath(sessionId: string): string {
  return join(harnessDirForSession(sessionId), "contract-debate.md");
}

export async function appendHarnessLog(
  sessionId: string,
  op: string,
  title: string,
  detail?: string,
): Promise<void> {
  const dir = harnessDirForSession(sessionId);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString();
  const lines = [`## [${stamp}] ${op} | ${title}`];
  if (detail?.trim()) lines.push(detail.trim());
  lines.push("");
  await appendFile(logMarkdownPath(sessionId), `${lines.join("\n")}\n`, "utf-8");
}

export async function writeHarnessProgress(input: {
  sessionId: string;
  round: number;
  stepResults: Record<string, StepResult>;
  contract?: CompletionContract;
  latestStep?: string;
}): Promise<void> {
  const dir = harnessDirForSession(input.sessionId);
  await mkdir(dir, { recursive: true });

  const stepLines = Object.entries(input.stepResults)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([stepName, step]) => {
      const verdict =
        step.contractAssertionCoverage && stepName === input.latestStep
          ? `; assertions pass=${step.contractAssertionCoverage.passCount} fail=${step.contractAssertionCoverage.failCount}`
          : "";
      return `- ${stepName}: ${step.status} (round ${step.round ?? input.round})${verdict}`;
    });

  const coverage = input.contract?.latestAssertionCoverage;
  const assertionLines = coverage?.mappings.map(
    (row) => `- ${row.assertionId}: ${row.status}${row.detail ? ` — ${row.detail}` : ""}`,
  );

  const body = [
    "# Harness Progress",
    "",
    `session: ${input.sessionId}`,
    `round: ${input.round}`,
    `contractStatus: ${input.contract?.negotiationStatus ?? "draft"}`,
    `negotiationRound: ${input.contract?.negotiationRound ?? 0}`,
    `latestStep: ${input.latestStep ?? "n/a"}`,
    `updatedAt: ${new Date().toISOString()}`,
    "",
    "## Step status",
    ...(stepLines.length ? stepLines : ["- (no steps yet)"]),
    "",
    "## Contract assertion summary",
    ...(assertionLines?.length ? assertionLines : ["- (no assertion mapping yet)"]),
    "",
  ].join("\n");

  await writeFile(progressMarkdownPath(input.sessionId), `${body}\n`, "utf-8");
}

export async function appendContractDebateSection(
  sessionId: string,
  section: string,
): Promise<void> {
  const dir = harnessDirForSession(sessionId);
  await mkdir(dir, { recursive: true });
  const path = contractDebateMarkdownPath(sessionId);
  const header = `# Contract Debate\n\nsession: ${sessionId}\n\n`;
  try {
    await appendFile(path, `${section}\n`, "utf-8");
  } catch {
    await writeFile(path, `${header}${section}\n`, "utf-8");
  }
}

export function formatDebateSection(input: {
  round: number;
  role: "generator" | "evaluator";
  stepName: string;
  message: string;
  assertionIds?: string[];
}): string {
  const stamp = new Date().toISOString();
  const ids = input.assertionIds?.length ? `\nassertions: ${input.assertionIds.join(", ")}` : "";
  return [
    `## Round ${input.round} — ${input.role} @ ${input.stepName} (${stamp})`,
    "",
    input.message.trim(),
    ids,
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export async function readContractDebateSummary(sessionId: string, maxChars = 4000): Promise<string | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(contractDebateMarkdownPath(sessionId), "utf-8");
    if (raw.length <= maxChars) return raw.trim() || undefined;
    return `...[debate truncated]...\n${raw.slice(-maxChars)}`.trim();
  } catch {
    return undefined;
  }
}

export function negotiationStatusLabel(status: ContractNegotiationStatus | undefined): string {
  return status ?? "draft";
}

export function stepStatusForLog(status: StepStatus): string {
  return status;
}
