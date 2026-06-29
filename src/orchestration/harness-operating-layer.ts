/**
 * Harness operating layer.
 *
 * This module owns rule registry, feedback compilation, harness GC, autonomy
 * decisions, and context routing. It intentionally works on durable
 * control-plane artifacts only; it does not mutate user repositories.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { PipelineTrace } from "../observability/trace.js";
import { loadTraceById, queryTraces } from "../observability/trace.js";
import {
  autonomyDecisionPath,
  autonomyPolicyPath,
  autonomyDir,
  candidatePath,
  contextRoutePath,
  contextTopologyDir,
  contextTopologyPath,
  feedbackDir,
  feedbackPath,
  gcReportsDir,
  gcReportPath,
  isHarnessSurfaceAllowed,
  normalizeHarnessSurfacePath,
  rejectedBufferDir,
  rejectedEntryPath,
  rulePath,
  rulesDir,
  signaturesDir,
  signaturePath,
  taskSetEvaluationPath,
  taskSetPath,
  taskSetsDir,
} from "./harness-artifact-store.js";
import {
  atomicWriteJson,
  readJsonFile,
  safePathSegment,
} from "./durable-io.js";

export const HARNESS_OPERATING_LAYER_SCHEMA =
  "runoff-harness-evolution-v1" as const;

export type HarnessRuleKind =
  | "coding_standard"
  | "qa_plan"
  | "review_rubric"
  | "lint_guidance"
  | "architecture_boundary"
  | "workflow";

export interface HarnessRule {
  schema: typeof HARNESS_OPERATING_LAYER_SCHEMA;
  ruleId: string;
  createdAt: string;
  updatedAt: string;
  kind: HarnessRuleKind;
  summary: string;
  guidance: string;
  appliesTo: string[];
  triggers: string[];
  severity: "info" | "warn" | "blocker";
  skillRef?: string;
  verifierIds: string[];
  enabled: boolean;
}

export interface HarnessCompiledFeedback {
  schema: typeof HARNESS_OPERATING_LAYER_SCHEMA;
  feedbackId: string;
  createdAt: string;
  traceId?: string;
  candidateId?: string;
  taskSetId?: string;
  source: "trace" | "taskset_evaluation" | "manual";
  sourceRefs: string[];
  ruleIds: string[];
  messages: Array<{
    level: "info" | "warn" | "blocker";
    title: string;
    prompt: string;
    evidence: string[];
    nextAction: string;
  }>;
  compiledPrompt: string;
}

export interface HarnessGcDebtItem {
  itemId: string;
  kind:
    | "failure_signature"
    | "rejected_candidate"
    | "feedback_blocker"
    | "approval_friction";
  severity: number;
  summary: string;
  evidenceRefs: string[];
  recommendedAction:
    | "create_rule"
    | "patch_skill"
    | "add_verifier"
    | "add_taskset"
    | "adjust_autonomy"
    | "manual_review";
}

export interface HarnessGcReport {
  schema: typeof HARNESS_OPERATING_LAYER_SCHEMA;
  reportId: string;
  createdAt: string;
  window: {
    since?: string;
    limit: number;
  };
  items: HarnessGcDebtItem[];
  nextAction:
    | "patch_harness"
    | "add_evaluation"
    | "manual_review"
    | "no_action";
  rulePatchSuggestions: Array<{
    ruleId?: string;
    summary: string;
    guidance: string;
    evidenceRefs: string[];
  }>;
}

export interface HarnessAutonomyPolicy {
  schema: typeof HARNESS_OPERATING_LAYER_SCHEMA;
  policyId: string;
  createdAt: string;
  summary: string;
  defaultDecision: "auto_continue" | "ask_approval" | "report_only";
  rules: Array<{
    action: string;
    maxRisk: number;
    minConfidence: number;
    decision: "auto_continue" | "ask_approval" | "rollback" | "report_only";
    reason: string;
  }>;
}

export interface HarnessAutonomyDecision {
  schema: typeof HARNESS_OPERATING_LAYER_SCHEMA;
  decisionId: string;
  createdAt: string;
  policyId: string;
  action: string;
  risk: number;
  confidence: number;
  candidateId?: string;
  runId?: string;
  decision: "auto_continue" | "ask_approval" | "rollback" | "report_only";
  reason: string;
  evidenceRefs: string[];
  nextHint: string;
}

export interface HarnessContextNode {
  nodeId: string;
  kind: "file" | "directory" | "rule" | "skill" | "verifier" | "taskset";
  ref: string;
  summary: string;
  tags: string[];
  priority: number;
}

export interface HarnessContextTopology {
  schema: typeof HARNESS_OPERATING_LAYER_SCHEMA;
  topologyId: string;
  createdAt: string;
  summary: string;
  nodes: HarnessContextNode[];
  edges: Array<{
    from: string;
    to: string;
    relation: "depends_on" | "governed_by" | "verifies" | "routes_to";
  }>;
}

export interface HarnessContextRoute {
  schema: typeof HARNESS_OPERATING_LAYER_SCHEMA;
  routeId: string;
  createdAt: string;
  topologyId?: string;
  taskId?: string;
  candidateId?: string;
  changedFiles: string[];
  selectedRefs: Array<{
    ref: string;
    kind: HarnessContextNode["kind"];
    reason: string;
    priority: number;
  }>;
  omittedRefs: Array<{
    ref: string;
    reason: string;
  }>;
}

type HarnessCandidateProjection = {
  candidateId: string;
  proposal?: {
    observedFilesModified?: string[];
  };
};

type HarnessTaskSetProjection = {
  taskSetId: string;
  createdAt: string;
  name: string;
};

type HarnessTaskSetEvaluationProjection = {
  results: Array<{
    verifier: {
      reason: string;
    };
  }>;
};

type HarnessRejectedBufferProjection = {
  rejectedId: string;
  createdAt: string;
  candidateId: string;
  regressionFailures: string[];
  rejectionReason: string;
};

type HarnessFailureSignatureProjection = {
  signatureId: string;
  title: string;
  severity: number;
  evidenceTraceIds: string[];
};

const normalizeSurfacePath = normalizeHarnessSurfacePath;
const isAllowedBySurface = isHarnessSurfaceAllowed;

function loadHarnessCandidateProjection(
  candidateId: string,
): HarnessCandidateProjection | undefined {
  if (!candidateId) return undefined;
  return readJsonFile<HarnessCandidateProjection>(candidatePath(candidateId));
}

function loadHarnessTaskSetEvaluationProjection(
  taskSetId: string,
  candidateId: string,
): HarnessTaskSetEvaluationProjection | undefined {
  return readJsonFile<HarnessTaskSetEvaluationProjection>(
    taskSetEvaluationPath(taskSetId, candidateId),
  );
}

function listHarnessTaskSetProjections(): HarnessTaskSetProjection[] {
  if (!existsSync(taskSetsDir())) return [];
  return readdirSync(taskSetsDir())
    .flatMap((name) => {
      const taskSet = readJsonFile<HarnessTaskSetProjection>(
        join(taskSetsDir(), name),
      );
      return taskSet ? [taskSet] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function listHarnessRejectedBufferProjections(
  limit = 20,
): HarnessRejectedBufferProjection[] {
  if (!existsSync(rejectedBufferDir())) return [];
  return readdirSync(rejectedBufferDir())
    .flatMap((name) => {
      const entry = readJsonFile<HarnessRejectedBufferProjection>(
        rejectedEntryPath(name.replace(/\.json$/, "")),
      );
      return entry ? [entry] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, limit));
}

function traceDifficulty(trace: PipelineTrace): number {
  const failedSteps = trace.steps.filter(
    (step) => step.error || step.verdict === "needs_revision",
  );
  return (
    (trace.finalStatus === "approved" ? 0 : 3) +
    failedSteps.length * 2 +
    trace.totalRounds
  );
}

function failureCategory(trace: PipelineTrace): string | undefined {
  if (trace.finalStatus === "approved") return undefined;
  const failedStep = firstFailureStep(trace);
  const text = [
    trace.prompt,
    failedStep?.error,
    failedStep?.observation?.summary,
    ...(failedStep?.observation?.coverageGaps ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (text.includes("timeout") || text.includes("abort")) return "runtime";
  if (text.includes("leak") || text.includes("secret")) return "policy";
  if (text.includes("diff") || text.includes("patch")) return "proposal";
  if (text.includes("boundary") || text.includes("unknown")) return "boundary";
  return "quality";
}

function buildFailureSignature(
  category: string,
  traces: PipelineTrace[],
): HarnessFailureSignatureProjection {
  const first = traces[0]!;
  const step = firstFailureStep(first);
  const surface = [
    ...new Set(
      traces.flatMap((trace) =>
        trace.steps.flatMap((traceStep) => traceStep.filesModified ?? []),
      ),
    ),
  ].sort();
  const signatureId = `sig-${safePathSegment(category)}-${safePathSegment(step?.name ?? first.mode)}`;
  const title = [
    `${category} failure`,
    `mode=${first.mode}`,
    `rounds=${first.totalRounds}`,
    `step=${step?.name ?? "unknown"}`,
    surface.length ? `files=${surface.slice(0, 3).join(",")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  return {
    signatureId,
    title,
    severity: Math.min(
      10,
      Math.max(...traces.map(traceDifficulty)) + traces.length,
    ),
    evidenceTraceIds: traces.map((trace) => trace.id),
  };
}

function mineHarnessFailureSignaturesForGc(input: {
  limit: number;
  since?: string;
}): HarnessFailureSignatureProjection[] {
  const traces = queryTraces({ since: input.since });
  const grouped = new Map<string, PipelineTrace[]>();
  for (const trace of traces) {
    const category = failureCategory(trace);
    if (!category) continue;
    const stepName = firstFailureStep(trace)?.name ?? trace.mode;
    const key = `${category}:${stepName}`;
    const list = grouped.get(key) ?? [];
    list.push(trace);
    grouped.set(key, list);
  }
  const signatures = [...grouped.entries()]
    .map(([, group]) =>
      buildFailureSignature(failureCategory(group[0]!)!, group),
    )
    .sort((a, b) => b.severity - a.severity)
    .slice(0, input.limit);
  mkdirSync(signaturesDir(), { recursive: true });
  for (const signature of signatures)
    atomicWriteJson(signaturePath(signature.signatureId), signature);
  return signatures;
}

function firstFailureStep(trace: PipelineTrace) {
  return (
    trace.steps.find(
      (step) => step.error || step.verdict === "needs_revision",
    ) ?? trace.steps.at(-1)
  );
}

export function registerHarnessRule(input: {
  ruleId?: string;
  kind: HarnessRuleKind;
  summary: string;
  guidance: string;
  appliesTo?: string[];
  triggers?: string[];
  severity?: HarnessRule["severity"];
  skillRef?: string;
  verifierIds?: string[];
  enabled?: boolean;
}): HarnessRule {
  const ruleId =
    input.ruleId?.trim() || `rule-${input.kind}-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const existing = readJsonFile<HarnessRule>(rulePath(ruleId));
  const rule: HarnessRule = {
    schema: HARNESS_OPERATING_LAYER_SCHEMA,
    ruleId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    kind: input.kind,
    summary: input.summary,
    guidance: input.guidance,
    appliesTo: [...new Set(input.appliesTo ?? [])].sort(),
    triggers: [...new Set(input.triggers ?? [])].sort(),
    severity: input.severity ?? "warn",
    skillRef: input.skillRef,
    verifierIds: [...new Set(input.verifierIds ?? [])].sort(),
    enabled: input.enabled ?? true,
  };
  mkdirSync(rulesDir(), { recursive: true });
  atomicWriteJson(rulePath(ruleId), rule);
  return rule;
}

export function loadHarnessRule(ruleId: string): HarnessRule | undefined {
  return readJsonFile<HarnessRule>(rulePath(ruleId));
}

export function listHarnessRules(limit = 50): HarnessRule[] {
  if (!existsSync(rulesDir())) return [];
  return readdirSync(rulesDir())
    .flatMap((name) => {
      const rule = readJsonFile<HarnessRule>(join(rulesDir(), name));
      return rule ? [rule] : [];
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(1, limit));
}

function matchesRule(rule: HarnessRule, texts: string[], files: string[]) {
  if (!rule.enabled) return false;
  const lowerTexts = texts.map((text) => text.toLowerCase());
  const triggerMatch =
    !rule.triggers.length ||
    rule.triggers.some((trigger) =>
      lowerTexts.some((text) => text.includes(trigger.toLowerCase())),
    );
  const surfaceMatch =
    !rule.appliesTo.length ||
    rule.appliesTo.some((surface) =>
      files.some((file) => isAllowedBySurface(file, [surface])),
    );
  return triggerMatch && surfaceMatch;
}

function feedbackMessageForRule(
  rule: HarnessRule,
  evidence: string[],
): HarnessCompiledFeedback["messages"][number] {
  return {
    level: rule.severity,
    title: rule.summary,
    prompt: [
      `Apply harness rule ${rule.ruleId}: ${rule.summary}.`,
      rule.guidance,
      rule.skillRef ? `Skill reference: ${rule.skillRef}.` : "",
      rule.verifierIds.length
        ? `Verifier refs: ${rule.verifierIds.join(", ")}.`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    evidence,
    nextAction:
      rule.severity === "blocker"
        ? "fix before continuing"
        : "incorporate into next agent prompt",
  };
}

export function compileHarnessFeedback(input: {
  feedbackId?: string;
  traceId?: string;
  candidateId?: string;
  taskSetId?: string;
  manualText?: string;
  ruleIds?: string[];
}): HarnessCompiledFeedback {
  const feedbackId =
    input.feedbackId?.trim() || `feedback-${randomUUID().slice(0, 8)}`;
  const trace = input.traceId ? loadTraceById(input.traceId) : null;
  const taskSetEvaluation =
    input.taskSetId && input.candidateId
      ? loadHarnessTaskSetEvaluationProjection(
          input.taskSetId,
          input.candidateId,
        )
      : undefined;
  const texts = [
    input.manualText ?? "",
    trace?.prompt ?? "",
    ...(trace?.steps.flatMap((step) => [
      step.error ?? "",
      step.observation?.summary ?? "",
      ...(step.observation?.coverageGaps ?? []),
    ]) ?? []),
    ...(taskSetEvaluation?.results.map((result) => result.verifier.reason) ??
      []),
  ].filter(Boolean);
  const files = [
    ...(trace?.steps.flatMap((step) => step.filesModified ?? []) ?? []),
    ...(loadHarnessCandidateProjection(input.candidateId ?? "")?.proposal
      ?.observedFilesModified ?? []),
  ];
  const availableRules = input.ruleIds?.length
    ? input.ruleIds.flatMap((id) => {
        const rule = loadHarnessRule(id);
        return rule ? [rule] : [];
      })
    : listHarnessRules(100);
  const matchedRules = availableRules.filter((rule) =>
    matchesRule(rule, texts, files),
  );
  const source: HarnessCompiledFeedback["source"] = input.traceId
    ? "trace"
    : taskSetEvaluation
      ? "taskset_evaluation"
      : "manual";
  const sourceRefs = [
    ...(input.traceId ? [input.traceId] : []),
    ...(input.taskSetId && input.candidateId
      ? [`${input.taskSetId}/${input.candidateId}`]
      : []),
  ];
  const evidence = [...sourceRefs, ...files].filter(Boolean);
  const messages =
    matchedRules.length > 0
      ? matchedRules.map((rule) => feedbackMessageForRule(rule, evidence))
      : [
          {
            level: "info" as const,
            title: "No matching harness rule",
            prompt:
              texts.join("\n").slice(0, 1200) ||
              "No source text was available for feedback compilation.",
            evidence,
            nextAction: "review manually or add a harness rule",
          },
        ];
  const compiledPrompt = messages
    .map((message) =>
      [
        `[${message.level.toUpperCase()}] ${message.title}`,
        message.prompt,
        message.evidence.length
          ? `Evidence: ${message.evidence.join(", ")}`
          : "",
        `Next: ${message.nextAction}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  const feedback: HarnessCompiledFeedback = {
    schema: HARNESS_OPERATING_LAYER_SCHEMA,
    feedbackId,
    createdAt: new Date().toISOString(),
    traceId: input.traceId,
    candidateId: input.candidateId,
    taskSetId: input.taskSetId,
    source,
    sourceRefs,
    ruleIds: matchedRules.map((rule) => rule.ruleId),
    messages,
    compiledPrompt,
  };
  mkdirSync(feedbackDir(), { recursive: true });
  atomicWriteJson(feedbackPath(feedbackId), feedback);
  return feedback;
}

export function listHarnessFeedback(limit = 50): HarnessCompiledFeedback[] {
  if (!existsSync(feedbackDir())) return [];
  return readdirSync(feedbackDir())
    .flatMap((name) => {
      const feedback = readJsonFile<HarnessCompiledFeedback>(
        join(feedbackDir(), name),
      );
      return feedback ? [feedback] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, limit));
}

export function runHarnessGcLoop(
  input: { reportId?: string; since?: string; limit?: number } = {},
): HarnessGcReport {
  const limit = Math.max(1, input.limit ?? 20);
  const signatures = mineHarnessFailureSignaturesForGc({
    limit,
    since: input.since,
  });
  const rejected = listHarnessRejectedBufferProjections(limit);
  const feedback = listHarnessFeedback(limit);
  const items: HarnessGcDebtItem[] = [
    ...signatures.map((signature) => ({
      itemId: `gc-${signature.signatureId}`,
      kind: "failure_signature" as const,
      severity: signature.severity,
      summary: signature.title,
      evidenceRefs: signature.evidenceTraceIds,
      recommendedAction: "create_rule" as const,
    })),
    ...rejected.map((entry) => ({
      itemId: `gc-${entry.rejectedId}`,
      kind: "rejected_candidate" as const,
      severity: entry.regressionFailures.length ? 4 : 2,
      summary: entry.rejectionReason,
      evidenceRefs: [entry.rejectedId, entry.candidateId],
      recommendedAction: "patch_skill" as const,
    })),
    ...feedback.flatMap((entry) =>
      entry.messages
        .filter((message) => message.level === "blocker")
        .map((message) => ({
          itemId: `gc-${entry.feedbackId}-${safePathSegment(message.title)}`,
          kind: "feedback_blocker" as const,
          severity: 4,
          summary: message.title,
          evidenceRefs: [entry.feedbackId, ...entry.sourceRefs],
          recommendedAction: "add_verifier" as const,
        })),
    ),
  ]
    .sort((a, b) => b.severity - a.severity)
    .slice(0, limit);
  const reportId = input.reportId?.trim() || `gc-${randomUUID().slice(0, 8)}`;
  const rulePatchSuggestions = items
    .filter((item) => item.recommendedAction === "create_rule")
    .slice(0, 5)
    .map((item) => ({
      summary: item.summary,
      guidance: `Convert recurring harness debt into an explicit rule. Evidence: ${item.evidenceRefs.join(", ")}`,
      evidenceRefs: item.evidenceRefs,
    }));
  const report: HarnessGcReport = {
    schema: HARNESS_OPERATING_LAYER_SCHEMA,
    reportId,
    createdAt: new Date().toISOString(),
    window: { since: input.since, limit },
    items,
    nextAction: !items.length
      ? "no_action"
      : rulePatchSuggestions.length
        ? "patch_harness"
        : "manual_review",
    rulePatchSuggestions,
  };
  mkdirSync(gcReportsDir(), { recursive: true });
  atomicWriteJson(gcReportPath(reportId), report);
  return report;
}

export function listHarnessGcReports(limit = 20): HarnessGcReport[] {
  if (!existsSync(gcReportsDir())) return [];
  return readdirSync(gcReportsDir())
    .flatMap((name) => {
      const report = readJsonFile<HarnessGcReport>(join(gcReportsDir(), name));
      return report ? [report] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, limit));
}

export function registerHarnessAutonomyPolicy(input: {
  policyId?: string;
  summary: string;
  defaultDecision?: HarnessAutonomyPolicy["defaultDecision"];
  rules?: HarnessAutonomyPolicy["rules"];
}): HarnessAutonomyPolicy {
  const policyId =
    input.policyId?.trim() || `autonomy-${randomUUID().slice(0, 8)}`;
  const policy: HarnessAutonomyPolicy = {
    schema: HARNESS_OPERATING_LAYER_SCHEMA,
    policyId,
    createdAt: new Date().toISOString(),
    summary: input.summary,
    defaultDecision: input.defaultDecision ?? "ask_approval",
    rules: input.rules ?? [],
  };
  mkdirSync(dirname(autonomyPolicyPath(policyId)), { recursive: true });
  atomicWriteJson(autonomyPolicyPath(policyId), policy);
  return policy;
}

export function loadHarnessAutonomyPolicy(
  policyId: string,
): HarnessAutonomyPolicy | undefined {
  return readJsonFile<HarnessAutonomyPolicy>(autonomyPolicyPath(policyId));
}

export function listHarnessAutonomyPolicies(
  limit = 20,
): HarnessAutonomyPolicy[] {
  const dir = join(autonomyDir(), "policies");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name) => {
      const policy = readJsonFile<HarnessAutonomyPolicy>(join(dir, name));
      return policy ? [policy] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, limit));
}

export function decideHarnessAutonomy(input: {
  decisionId?: string;
  policyId?: string;
  action: string;
  risk?: number;
  confidence?: number;
  candidateId?: string;
  runId?: string;
  evidenceRefs?: string[];
}): HarnessAutonomyDecision {
  const policy =
    (input.policyId ? loadHarnessAutonomyPolicy(input.policyId) : undefined) ??
    registerHarnessAutonomyPolicy({
      policyId: "default",
      summary: "Default harness autonomy policy",
      defaultDecision: "ask_approval",
      rules: [
        {
          action: "report",
          maxRisk: 1,
          minConfidence: 0,
          decision: "report_only",
          reason: "report-only actions do not mutate repo state",
        },
        {
          action: "continue",
          maxRisk: 2,
          minConfidence: 0.8,
          decision: "auto_continue",
          reason: "low-risk high-confidence continuation",
        },
      ],
    });
  const risk = Math.max(0, Math.min(5, input.risk ?? 3));
  const confidence = Math.max(0, Math.min(1, input.confidence ?? 0.5));
  const matched = policy.rules.find(
    (rule) =>
      rule.action === input.action &&
      risk <= rule.maxRisk &&
      confidence >= rule.minConfidence,
  );
  const decision = matched?.decision ?? policy.defaultDecision;
  const decisionId =
    input.decisionId?.trim() || `autonomy-decision-${randomUUID().slice(0, 8)}`;
  const record: HarnessAutonomyDecision = {
    schema: HARNESS_OPERATING_LAYER_SCHEMA,
    decisionId,
    createdAt: new Date().toISOString(),
    policyId: policy.policyId,
    action: input.action,
    risk,
    confidence,
    candidateId: input.candidateId,
    runId: input.runId,
    decision,
    reason: matched?.reason ?? `default policy decision: ${decision}`,
    evidenceRefs: input.evidenceRefs ?? [],
    nextHint:
      decision === "auto_continue"
        ? "continue without human approval"
        : decision === "rollback"
          ? "rollback candidate before continuing"
          : decision === "report_only"
            ? "emit report and do not mutate source"
            : "ask human approval before continuing",
  };
  mkdirSync(dirname(autonomyDecisionPath(decisionId)), { recursive: true });
  atomicWriteJson(autonomyDecisionPath(decisionId), record);
  return record;
}

export function listHarnessAutonomyDecisions(
  limit = 20,
): HarnessAutonomyDecision[] {
  const dir = join(autonomyDir(), "decisions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name) => {
      const decision = readJsonFile<HarnessAutonomyDecision>(join(dir, name));
      return decision ? [decision] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, limit));
}

export function createHarnessContextTopology(input: {
  topologyId?: string;
  summary: string;
  nodes?: HarnessContextNode[];
  edges?: HarnessContextTopology["edges"];
  includeRules?: boolean;
  includeTaskSets?: boolean;
}): HarnessContextTopology {
  const topologyId =
    input.topologyId?.trim() || `context-${randomUUID().slice(0, 8)}`;
  const ruleNodes = input.includeRules
    ? listHarnessRules(100).map((rule) => ({
        nodeId: `rule:${rule.ruleId}`,
        kind: "rule" as const,
        ref: rule.ruleId,
        summary: rule.summary,
        tags: [rule.kind, rule.severity],
        priority: rule.severity === "blocker" ? 100 : 60,
      }))
    : [];
  const taskSetNodes = input.includeTaskSets
    ? listHarnessTaskSetProjections().map((taskSet) => ({
        nodeId: `taskset:${taskSet.taskSetId}`,
        kind: "taskset" as const,
        ref: taskSet.taskSetId,
        summary: taskSet.name,
        tags: ["taskset"],
        priority: 50,
      }))
    : [];
  const topology: HarnessContextTopology = {
    schema: HARNESS_OPERATING_LAYER_SCHEMA,
    topologyId,
    createdAt: new Date().toISOString(),
    summary: input.summary,
    nodes: [...(input.nodes ?? []), ...ruleNodes, ...taskSetNodes],
    edges: input.edges ?? [],
  };
  mkdirSync(dirname(contextTopologyPath(topologyId)), { recursive: true });
  atomicWriteJson(contextTopologyPath(topologyId), topology);
  return topology;
}

export function loadHarnessContextTopology(
  topologyId: string,
): HarnessContextTopology | undefined {
  return readJsonFile<HarnessContextTopology>(contextTopologyPath(topologyId));
}

export function listHarnessContextTopologies(
  limit = 20,
): HarnessContextTopology[] {
  const dir = join(contextTopologyDir(), "topologies");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name) => {
      const topology = readJsonFile<HarnessContextTopology>(join(dir, name));
      return topology ? [topology] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, limit));
}

export function routeHarnessContext(input: {
  routeId?: string;
  topologyId?: string;
  taskId?: string;
  candidateId?: string;
  changedFiles?: string[];
  limit?: number;
}): HarnessContextRoute {
  const topology = input.topologyId
    ? loadHarnessContextTopology(input.topologyId)
    : listHarnessContextTopologies(1)[0];
  const candidate = input.candidateId
    ? loadHarnessCandidateProjection(input.candidateId)
    : undefined;
  const changedFiles = [
    ...(input.changedFiles ?? []),
    ...(candidate?.proposal?.observedFilesModified ?? []),
  ].map(normalizeSurfacePath);
  const limit = Math.max(1, input.limit ?? 20);
  const nodes = topology?.nodes ?? [];
  const scored = nodes
    .map((node) => {
      const fileMatch = changedFiles.some(
        (file) =>
          file === normalizeSurfacePath(node.ref) ||
          file.startsWith(`${normalizeSurfacePath(node.ref)}/`) ||
          node.tags.some((tag) => file.includes(tag)),
      );
      const ruleMatch =
        node.kind === "rule" &&
        loadHarnessRule(node.ref)?.appliesTo.some((surface) =>
          changedFiles.some((file) => isAllowedBySurface(file, [surface])),
        );
      return {
        node,
        score: node.priority + (fileMatch ? 50 : 0) + (ruleMatch ? 40 : 0),
        reason: fileMatch
          ? "changed file matched context node"
          : ruleMatch
            ? "changed file matched rule surface"
            : "topology priority",
      };
    })
    .sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, limit);
  const omitted = scored.slice(limit);
  const routeId =
    input.routeId?.trim() || `context-route-${randomUUID().slice(0, 8)}`;
  const route: HarnessContextRoute = {
    schema: HARNESS_OPERATING_LAYER_SCHEMA,
    routeId,
    createdAt: new Date().toISOString(),
    topologyId: topology?.topologyId,
    taskId: input.taskId,
    candidateId: input.candidateId,
    changedFiles,
    selectedRefs: selected.map((item) => ({
      ref: item.node.ref,
      kind: item.node.kind,
      reason: item.reason,
      priority: item.score,
    })),
    omittedRefs: omitted.map((item) => ({
      ref: item.node.ref,
      reason: "outside context route limit",
    })),
  };
  mkdirSync(dirname(contextRoutePath(routeId)), { recursive: true });
  atomicWriteJson(contextRoutePath(routeId), route);
  return route;
}

export function listHarnessContextRoutes(limit = 20): HarnessContextRoute[] {
  const dir = join(contextTopologyDir(), "routes");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name) => {
      const route = readJsonFile<HarnessContextRoute>(join(dir, name));
      return route ? [route] : [];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(1, limit));
}
