/**
 * Step context contracts — unified taxonomy, evidence checks, and bounded context composition.
 */

import type {
  ContextCompositionReport,
  ContextEvidenceRef,
  StepContextContract,
  StepContextKind,
  StepResult,
} from "../core/state.js";
import { emptyCandidate } from "../core/candidate.js";
import type { Artifact } from "./artifacts.js";
import type { Candidate } from "../core/candidate.js";
import { resolveStepKind, type StepKind } from "./step-strategy.js";

export const DEFAULT_BOUNDED_CONTEXT_CHARS = 16_000;

export type StepPromptBuildInput = {
  stepName: string;
  reviewStepName: string;
  spec: string;
  round: number;
  globalKnowledge: Record<string, string>;
  candidate: Candidate;
  acceptanceCriteria?: string[];
  verifyResults?: string;
  lastReviewFeedback?: string;
  context?: string;
  outputKind?: "text" | "agent" | "mixed";
};

const URI_SCHEME_RE = /\b(?:file|mfs):\/\/[^\s\]>"']+/g;
const HTTP_URI_RE = /\bhttps?:\/\/[^\s\]>"']+/g;
const RELATIVE_PATH_RE =
  /\b(?:[\w.-]+\/)+[\w.-]+\.(?:tsx?|jsx?|md|py|json|yaml|yml|toml|sh)(?::\d+(?:-\d+)?)?\b/g;

const SEARCH_HIT_KEYS = ["uri", "href", "path", "id", "file", "source"] as const;

export function parseContextRef(raw: string, label?: string): ContextEvidenceRef {
  if (raw.startsWith("file://")) return { ref: raw, scheme: "file", label };
  if (raw.startsWith("mfs://")) return { ref: raw, scheme: "mfs", label };
  if (raw.startsWith("https://")) return { ref: raw, scheme: "https", label };
  if (raw.startsWith("http://")) return { ref: raw, scheme: "http", label };
  return { ref: raw, scheme: "relative", label };
}

export function extractContextRefs(text: string): ContextEvidenceRef[] {
  const uriRefs: ContextEvidenceRef[] = [];
  for (const re of [URI_SCHEME_RE, HTTP_URI_RE]) {
    for (const match of text.matchAll(re)) {
      uriRefs.push(parseContextRef(match[0]));
    }
  }
  const refs = dedupeContextRefs(uriRefs);
  const uriStrings = refs.map((entry) => entry.ref);
  for (const match of text.matchAll(RELATIVE_PATH_RE)) {
    const raw = match[0];
    if (uriStrings.some((uri) => uri.includes(raw))) continue;
    refs.push(parseContextRef(raw));
  }
  return dedupeContextRefs(refs);
}

export function looksLikeSearchHitList(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null) {
      return SEARCH_HIT_KEYS.some((key) => key in (parsed[0] as Record<string, unknown>));
    }
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      if (Array.isArray(record.hits) || Array.isArray(record.results)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function compactSearchHitList(
  text: string,
): { summary: string; refs: ContextEvidenceRef[] } | null {
  const trimmed = text.trim();
  if (!looksLikeSearchHitList(trimmed)) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const hits = Array.isArray(parsed)
      ? parsed
      : ((parsed as Record<string, unknown>).hits ??
        (parsed as Record<string, unknown>).results ??
        []);
    if (!Array.isArray(hits)) return null;
    const refs: ContextEvidenceRef[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      if (!hit || typeof hit !== "object") continue;
      const record = hit as Record<string, unknown>;
      const uri = record.uri ?? record.href ?? record.path ?? record.id ?? record.file ?? record.source;
      if (typeof uri === "string" && !seen.has(uri)) {
        seen.add(uri);
        refs.push(parseContextRef(uri));
      }
    }
    return {
      summary: `[${hits.length} search hit(s) omitted per context contract; use contextRefs with mfs cat — not inlined JSON.]`,
      refs,
    };
  } catch {
    return null;
  }
}

export function dedupeContextRefs(refs: ContextEvidenceRef[]): ContextEvidenceRef[] {
  const seen = new Set<string>();
  return refs.filter((entry) => {
    if (seen.has(entry.ref)) return false;
    seen.add(entry.ref);
    return true;
  });
}

export function resolveStepContextKind(stepName: string, reviewStepName: string): StepContextKind {
  if (resolveStepKind(stepName, reviewStepName) === "review") return "review";
  const normalized = stepName.trim().toLowerCase();
  if (normalized.includes("triage") || normalized.includes("diagnos")) return "analyze";
  if (normalized.includes("analy")) return "analyze";
  if (normalized.includes("test") || normalized.includes("verify")) return "test";
  if (normalized.includes("final") || normalized.includes("summary") || normalized.includes("report")) {
    return "final_summary";
  }
  if (
    normalized.includes("implement") ||
    normalized.includes("refactor") ||
    normalized.includes("write") ||
    normalized.includes("fix")
  ) {
    return "implement";
  }
  return "generate";
}

function requiredEvidenceForKind(
  kind: StepContextKind,
  outputKind: StepPromptBuildInput["outputKind"],
): string[] {
  if (kind === "review") {
    return ["verdict", "artifactRefs", "review_feedback"];
  }
  if (kind === "analyze") {
    const base = ["contextRefs", "review_feedback"];
    if (outputKind === "agent" || outputKind === "mixed") base.push("artifacts");
    return base;
  }
  if (kind === "test") {
    return ["artifacts", "verificationCommand"];
  }
  if (kind === "final_summary") {
    return ["artifactRefs", "claims"];
  }
  if (outputKind === "text") return ["code", "artifacts"];
  if (outputKind === "mixed") return ["artifacts"];
  return ["filesModified", "diffStat", "artifacts"];
}

function inputsForKind(kind: StepContextKind): string[] {
  switch (kind) {
    case "review":
      return ["spec", "acceptanceCriteria", "verifyResults", "candidateContent", "knowledge"];
    case "analyze":
      return ["spec", "context", "knowledge", "acceptanceCriteria"];
    case "test":
      return ["spec", "verifyResults", "candidateContent", "context"];
    case "final_summary":
      return ["spec", "stepResults", "traceRef", "coverageGaps"];
    case "implement":
      return ["spec", "lastReviewFeedback", "previousContent", "context", "knowledge"];
    default:
      return ["spec", "lastReviewFeedback", "previousContent", "context", "knowledge"];
  }
}

function scopeNotesForKind(kind: StepContextKind): string[] {
  switch (kind) {
    case "analyze":
      return [
        "Identify editable surface, risk boundaries, and verification targets before implementation.",
        "Prefer stable contextRefs (file://, mfs://, path:line) over inlined search hit JSON.",
      ];
    case "implement":
      return ["Prefer the smallest edit surface that satisfies the spec and review feedback."];
    case "review":
      return ["Focus on the supplied candidate and explicit verification results."];
    case "test":
      return ["Capture the verification command, exit status, and key output — not just pass/fail."];
    case "final_summary":
      return ["Every completion claim must point back to trace, artifact, or verification evidence."];
    default:
      return ["Prefer the smallest edit surface that satisfies the spec and review feedback."];
  }
}

const FORBIDDEN_DEFAULT = [
  "full_trace_history",
  "unrelated_artifacts",
  "unbounded_repo_context",
  "raw_provider_payloads",
  "inline_tool_json",
  "raw_api_response_dumps",
] as const;

export function buildStepContextContract(
  input: StepPromptBuildInput,
  options?: { roleOmittedInputs?: string[]; harnessRole?: import("./harness-role.js").LoopHarnessRole },
): StepContextContract {
  const kind = resolveStepContextKind(input.stepName, input.reviewStepName);
  return {
    kind,
    harnessRole: options?.harnessRole,
    roleOmittedInputs: options?.roleOmittedInputs,
    inputs: inputsForKind(kind),
    forbidden: [...FORBIDDEN_DEFAULT],
    requiredEvidence: requiredEvidenceForKind(kind, input.outputKind),
    scopeNotes: scopeNotesForKind(kind),
  };
}

export function buildFallbackStepContextContract(
  stepName: string,
  stepResult: StepResult,
): StepContextContract {
  if (stepResult.contextContract) return stepResult.contextContract;
  const isReview = stepName.toLowerCase().includes("review");
  return buildStepContextContract({
    stepName,
    reviewStepName: isReview ? stepName : "review",
    spec: "",
    round: stepResult.round ?? 1,
    globalKnowledge: {},
    candidate: emptyCandidate(),
    outputKind: stepResult.kind === "text" ? "text" : "agent",
  });
}

export function requiredEvidenceRef(stepName: string, requirement: string): string {
  switch (requirement) {
    case "artifactRefs":
    case "artifacts":
      return `stepResults.${stepName}.artifacts`;
    case "diffStat":
      return `stepResults.${stepName}.diffStat`;
    case "filesModified":
      return `stepResults.${stepName}.filesModified`;
    case "code":
      return `stepResults.${stepName}.code`;
    case "review_feedback":
    case "verdict":
      return `stepResults.${stepName}.artifacts`;
    case "claims":
      return `stepResults.${stepName}.observation.claims`;
    case "contextRefs":
      return `stepResults.${stepName}.contextComposition.contextRefs`;
    case "verificationCommand":
      return `stepResults.${stepName}.observation.evidence`;
    default:
      return `stepResults.${stepName}`;
  }
}

export function hasRequiredEvidence(
  requirement: string,
  stepResult: StepResult,
  artifacts: Artifact[],
): boolean {
  switch (requirement) {
    case "artifactRefs":
    case "artifacts":
      return artifacts.length > 0;
    case "diffStat":
      return Boolean(
        stepResult.diffStat ||
          artifacts.some((artifact) => (artifact.kind === "diff" || artifact.kind === "patch") && artifact.diffStat),
      );
    case "filesModified":
      return Boolean(
        stepResult.filesModified?.length ||
          artifacts.some(
            (artifact) => (artifact.kind === "diff" || artifact.kind === "patch") && artifact.filesModified.length,
          ),
      );
    case "code":
      return Boolean(
        stepResult.code || artifacts.some((artifact) => artifact.kind === "code" && artifact.code),
      );
    case "review_feedback":
      return Boolean(
        stepResult.reason ||
          stepResult.summary ||
          stepResult.explanation ||
          artifacts.some((artifact) => {
            if (artifact.kind === "review") {
              return Boolean(artifact.reviewText || artifact.issues?.length || artifact.suggestions?.length);
            }
            if (artifact.kind === "verdict") {
              return Boolean(artifact.feedback || artifact.sourceReview);
            }
            return false;
          }),
      );
    case "verdict":
      return artifacts.some((artifact) => artifact.kind === "verdict");
    case "claims":
      return Boolean(stepResult.observation?.claims?.length);
    case "verificationCommand":
      return (stepResult.observation?.evidence ?? []).some(
        (entry) =>
          entry.toLowerCase().includes("verify") ||
          entry.toLowerCase().includes("command=") ||
          entry.toLowerCase().includes("exit="),
      );
    case "contextRefs": {
      if (!stepResult.contextComposition?.suppliedInputs.includes("context")) return true;
      if (stepResult.contextComposition.contextRefs?.length) return true;
      return (stepResult.observation?.evidence ?? []).some((entry) => entry.startsWith("contextRef="));
    }
    default:
      return Boolean((stepResult as unknown as Record<string, unknown>)[requirement]);
  }
}

export function buildRequiredEvidenceGaps(
  stepName: string,
  stepResult: StepResult,
  contextContract: StepContextContract,
  artifactCount: number,
): import("../core/state.js").ObservationCoverageGap[] {
  if (stepResult.status !== "success") return [];
  const artifacts = stepResult.artifacts ?? [];
  return contextContract.requiredEvidence
    .filter((requirement) => {
      if ((requirement === "artifactRefs" || requirement === "artifacts") && artifactCount > 0) {
        return !hasRequiredEvidence(requirement, stepResult, artifacts);
      }
      return !hasRequiredEvidence(requirement, stepResult, artifacts);
    })
    .map((requirement) => ({
      kind: "evidence" as const,
      detail: `Missing required evidence ${JSON.stringify(requirement)} from step context contract.`,
      evidenceRefs: [requiredEvidenceRef(stepName, requirement)],
    }));
}

function truncateContext(context: string, maxChars: number): { text: string; truncated: boolean } {
  if (context.length <= maxChars) return { text: context, truncated: false };
  return {
    text: `${context.slice(0, maxChars)}\n\n[context truncated to ${maxChars} chars per context contract]`,
    truncated: true,
  };
}

export function composeBoundedStepContext(
  context: string | undefined,
  contract: StepContextContract,
  options?: { maxChars?: number },
): { effectiveContext?: string; report: ContextCompositionReport } {
  const maxChars = options?.maxChars ?? DEFAULT_BOUNDED_CONTEXT_CHARS;
  const suppliedInputs: string[] = [];
  const omittedForbidden: string[] = [];
  const warnings: string[] = [];

  if (context) suppliedInputs.push("context");
  if (contract.forbidden.includes("full_trace_history")) {
    omittedForbidden.push("full_trace_history");
  }
  if (contract.forbidden.includes("unrelated_artifacts")) {
    omittedForbidden.push("unrelated_artifacts");
  }
  if (contract.forbidden.includes("raw_provider_payloads")) {
    omittedForbidden.push("raw_provider_payloads");
  }
  if (contract.forbidden.includes("inline_tool_json")) {
    omittedForbidden.push("inline_tool_json");
  }
  if (contract.forbidden.includes("raw_api_response_dumps")) {
    omittedForbidden.push("raw_api_response_dumps");
  }

  if (!context) {
    return {
      effectiveContext: undefined,
      report: {
        schemaVersion: 1,
        suppliedInputs,
        omittedForbidden,
        warnings,
      },
    };
  }

  let effectiveContext = context;
  const originalContextChars = context.length;
  let extractedRefs: ContextEvidenceRef[] = [];

  const compacted = compactSearchHitList(context);
  if (compacted) {
    effectiveContext = compacted.summary;
    extractedRefs = compacted.refs;
    omittedForbidden.push("inline_tool_json");
    warnings.push(
      `Replaced inline search hit list with bounded summary (${compacted.refs.length} contextRef(s) extracted).`,
    );
  }

  extractedRefs = dedupeContextRefs([...extractedRefs, ...extractContextRefs(effectiveContext)]);

  if (effectiveContext.length > maxChars) {
    if (contract.forbidden.includes("unbounded_repo_context")) {
      omittedForbidden.push("unbounded_repo_context");
    }
    const bounded = truncateContext(effectiveContext, maxChars);
    effectiveContext = bounded.text;
    if (bounded.truncated) {
      warnings.push(
        `Context truncated from ${originalContextChars} to ${maxChars} chars per context contract (large payloads stay in artifacts).`,
      );
    }
  }

  return {
    effectiveContext,
    report: {
      schemaVersion: 1,
      suppliedInputs,
      omittedForbidden,
      warnings,
      originalContextChars,
      boundedContextChars: effectiveContext.length,
      contextRefs: extractedRefs.length ? extractedRefs : undefined,
    },
  };
}

export function detectSuppliedPromptInputs(input: StepPromptBuildInput): string[] {
  const supplied: string[] = ["spec"];
  if (input.acceptanceCriteria?.length) supplied.push("acceptanceCriteria");
  if (input.verifyResults) supplied.push("verifyResults");
  if (input.lastReviewFeedback) supplied.push("lastReviewFeedback");
  if (input.context) supplied.push("context");
  if (Object.keys(input.globalKnowledge).length) supplied.push("knowledge");
  if (input.candidate.code || input.candidate.changes || input.candidate.summary) {
    supplied.push("candidateContent");
  }
  if (input.candidate.code || input.candidate.changes) supplied.push("previousContent");
  return supplied;
}

export function buildContextCompositionReport(
  input: StepPromptBuildInput,
  contract: StepContextContract,
  bounded?: ContextCompositionReport,
): ContextCompositionReport {
  const suppliedInputs = detectSuppliedPromptInputs(input);
  const missingInputs = contract.inputs.filter((name) => !suppliedInputs.includes(name));
  const warnings = [...(bounded?.warnings ?? [])];
  for (const missing of missingInputs) {
    if (missing === "stepResults" || missing === "traceRef") continue;
    warnings.push(`Expected input ${JSON.stringify(missing)} was not supplied to this step.`);
  }
  return {
    schemaVersion: 1,
    suppliedInputs,
    omittedForbidden: bounded?.omittedForbidden ?? [],
    warnings,
    originalContextChars: bounded?.originalContextChars,
    boundedContextChars: bounded?.boundedContextChars,
  };
}
