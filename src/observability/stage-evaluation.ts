import type {
  StageEvaluationMetricResult,
  StageEvaluationResult,
  StageMetricStatus,
  StepObservation,
  StepResult,
} from "../core/state.js";

export type StageEvaluationKind = "analyze" | "implement" | "review" | "test" | "final_summary" | "other";

export interface StageEvaluationMetricHint {
  name: string;
  description: string;
  evidenceRefs: string[];
}

export interface StageEvaluationHint {
  stepName: string;
  kind: StageEvaluationKind;
  metrics: StageEvaluationMetricHint[];
  overallStatus?: StageMetricStatus;
}

export function normalizeStageKind(stepName: string): StageEvaluationKind {
  const normalized = stepName.trim().toLowerCase();
  if (normalized.includes("analy")) return "analyze";
  if (normalized.includes("test") || normalized.includes("verify")) return "test";
  if (normalized.includes("review")) return "review";
  if (normalized.includes("implement") || normalized.includes("refactor") || normalized.includes("write")) {
    return "implement";
  }
  if (normalized.includes("final") || normalized.includes("summary") || normalized.includes("report")) {
    return "final_summary";
  }
  return "other";
}

function metricsForKind(kind: StageEvaluationKind): StageEvaluationMetricHint[] {
  switch (kind) {
    case "analyze":
      return [
        {
          name: "scope_accuracy",
          description: "是否准确识别了要处理的文件、模块和风险边界。",
          evidenceRefs: ["step.observation.evidence", "step.observation.artifactRefs"],
        },
        {
          name: "risk_identification",
          description: "是否显式列出高风险点、测试目标或回归面。",
          evidenceRefs: ["step.observation.claims", "step.observation.coverageGaps"],
        },
        {
          name: "test_target_precision",
          description: "是否给出可执行且足够窄的验证目标。",
          evidenceRefs: ["step.observation.claims", "step.observation.contextContract"],
        },
      ];
    case "implement":
      return [
        {
          name: "diff_validity",
          description: "是否产生真实 diff，而不是只给出文字说明。",
          evidenceRefs: ["step.observation.artifactRefs", "step.observation.evidence"],
        },
        {
          name: "surface_compliance",
          description: "是否只修改了允许的 surface，没有越界改动。",
          evidenceRefs: ["step.observation.claims", "step.observation.coverageGaps"],
        },
        {
          name: "boundary_handling",
          description: "是否处理了空值、错误路径和边界条件。",
          evidenceRefs: ["step.observation.claims", "step.observation.artifactRefs"],
        },
      ];
    case "review":
      return [
        {
          name: "evidence_citation",
          description: "是否把问题说明回指到具体代码、artifact 或观察证据。",
          evidenceRefs: ["step.observation.claims", "step.observation.artifactRefs"],
        },
        {
          name: "blocker_separation",
          description: "是否区分 blocker 与非 blocker，而不是把所有问题一刀切。",
          evidenceRefs: ["step.observation.claims", "step.observation.coverageGaps"],
        },
        {
          name: "false_positive_control",
          description: "是否避免没有证据的泛化指控。",
          evidenceRefs: ["step.observation.evidence", "step.observation.coverageGaps"],
        },
      ];
    case "test":
      return [
        {
          name: "command_capture",
          description: "是否记录了实际执行的验证命令。",
          evidenceRefs: ["step.observation.evidence", "step.observation.contextContract"],
        },
        {
          name: "exit_status",
          description: "是否记录并解释了命令退出状态。",
          evidenceRefs: ["step.observation.evidence", "step.observation.claims"],
        },
        {
          name: "output_summary",
          description: "是否保留了关键输出，而不是只写 pass/fail。",
          evidenceRefs: ["step.observation.claims", "step.observation.artifactRefs"],
        },
      ];
    case "final_summary":
      return [
        {
          name: "claim_evidence_coverage",
          description: "每个完成声明是否都能指回 trace、artifact 或测试证据。",
          evidenceRefs: ["pipeline.observation.claims", "pipeline.observation.stepRefs"],
        },
        {
          name: "unverified_items_visible",
          description: "未验证项是否被显式列出，而不是混在已验证结论里。",
          evidenceRefs: ["pipeline.observation.coverageGaps", "pipeline.observation.claims"],
        },
        {
          name: "trace_ref_present",
          description: "最终摘要是否保留 trace 或 checkpoint 的回链。",
          evidenceRefs: ["pipeline.observation.traceRef", "pipeline.observation.checkpointRef"],
        },
      ];
    case "other":
      return [
        {
          name: "step_completion",
          description: "该 step 是否完成了预期职责。",
          evidenceRefs: ["step.observation.summary", "step.observation.claims"],
        },
        {
          name: "evidence_coverage",
          description: "该 step 的结论是否有足够证据支撑。",
          evidenceRefs: ["step.observation.claims", "step.observation.coverageGaps"],
        },
        {
          name: "followup_hint_clarity",
          description: "如果没有一次做完，下一步提示是否足够清楚。",
          evidenceRefs: ["step.observation.nextHint", "pipeline.observation.nextHint"],
        },
      ];
  }
}

function combineStatus(statuses: StageMetricStatus[]): StageMetricStatus {
  if (!statuses.length) return "unknown";
  if (statuses.every((status) => status === "pass")) return "pass";
  if (statuses.some((status) => status === "fail")) return "fail";
  if (statuses.some((status) => status === "partial")) return "partial";
  return "unknown";
}

function hasArtifactKinds(
  observation: StepObservation | undefined,
  kinds: string[],
): boolean {
  return Boolean(observation?.artifactRefs.some((ref) => kinds.includes(ref.kind)));
}

function evidenceMatches(observation: StepObservation | undefined, pattern: RegExp): boolean {
  return Boolean(observation?.evidence.some((entry) => pattern.test(entry)));
}

function claimsHaveEvidenceRefs(observation: StepObservation | undefined): boolean {
  return Boolean(
    observation?.claims?.some(
      (claim) => claim.evidenceRefs.length > 0 && !claim.evidenceRefs.every((ref) => ref.includes("error=")),
    ),
  );
}

function evaluateMetric(
  metric: StageEvaluationMetricHint,
  stepResult: StepResult,
  observation: StepObservation | undefined,
): StageEvaluationMetricResult {
  if (stepResult.status !== "success") {
    return {
      ...metric,
      status: "unknown",
      detail: `Step status is ${stepResult.status}; metric not evaluated.`,
    };
  }

  const typedGaps = observation?.typedCoverageGaps ?? [];
  const evidenceGaps = typedGaps.filter((gap) => gap.kind === "evidence");

  switch (metric.name) {
    case "scope_accuracy":
      return {
        ...metric,
        status:
          (observation?.artifactRefs.length ?? 0) > 0 || evidenceMatches(observation, /filesModified=|model=/)
            ? "pass"
            : "partial",
        detail:
          (observation?.artifactRefs.length ?? 0) > 0
            ? "Artifacts or file evidence present."
            : "No scoped artifact refs recorded.",
      };
    case "risk_identification":
      return {
        ...metric,
        status: claimsHaveEvidenceRefs(observation) || Boolean(observation?.summary?.length)
          ? "pass"
          : "partial",
      };
    case "test_target_precision":
      return {
        ...metric,
        status: Boolean(stepResult.contextContract?.requiredEvidence.length) ? "pass" : "partial",
      };
    case "diff_validity":
      return {
        ...metric,
        status:
          Boolean(stepResult.filesModified?.length || stepResult.diffStat) ||
          hasArtifactKinds(observation, ["diff", "patch"])
            ? "pass"
            : "fail",
        detail:
          stepResult.kind === "agent"
            ? "Agent step should report modified files or diff artifacts."
            : "Text step should include code or diff artifacts.",
      };
    case "surface_compliance":
      return {
        ...metric,
        status: evidenceGaps.some((gap) => gap.detail.includes("filesModified")) ? "partial" : "pass",
      };
    case "boundary_handling":
      return {
        ...metric,
        status: claimsHaveEvidenceRefs(observation) ? "pass" : "partial",
      };
    case "evidence_citation":
      return {
        ...metric,
        status:
          hasArtifactKinds(observation, ["review", "verdict"]) && claimsHaveEvidenceRefs(observation)
            ? "pass"
            : "partial",
      };
    case "blocker_separation":
      return {
        ...metric,
        status: hasArtifactKinds(observation, ["verdict", "review"]) ? "pass" : "partial",
      };
    case "false_positive_control":
      return {
        ...metric,
        status: evidenceGaps.length ? "partial" : "pass",
      };
    case "command_capture":
      return {
        ...metric,
        status: evidenceMatches(observation, /verify|command=|exit=/) ? "pass" : "fail",
        detail: "Expected verification command evidence on test/verify steps.",
      };
    case "exit_status":
      return {
        ...metric,
        status: evidenceMatches(observation, /exit=|status=|failed|passed/) ? "pass" : "partial",
      };
    case "output_summary":
      return {
        ...metric,
        status: Boolean(observation?.summary || observation?.claims?.length) ? "pass" : "fail",
      };
    case "step_completion":
      return {
        ...metric,
        status: stepResult.status === "success" ? "pass" : "fail",
      };
    case "evidence_coverage":
      return {
        ...metric,
        status: evidenceGaps.length ? "fail" : claimsHaveEvidenceRefs(observation) ? "pass" : "partial",
        detail: evidenceGaps.length
          ? `${evidenceGaps.length} evidence gap(s) recorded.`
          : "Claims are linked to evidence refs.",
      };
    case "followup_hint_clarity":
      return {
        ...metric,
        status: observation?.nextHint ? "pass" : "partial",
      };
    default:
      return {
        ...metric,
        status: evidenceGaps.length ? "partial" : "unknown",
      };
  }
}

export function evaluateStageForStep(
  stepName: string,
  stepResult: StepResult,
  observation?: StepObservation,
): StageEvaluationResult {
  const kind = normalizeStageKind(stepName);
  const metrics = metricsForKind(kind).map((metric) =>
    evaluateMetric(metric, stepResult, observation),
  );
  return {
    stepName,
    kind,
    metrics,
    overallStatus: combineStatus(metrics.map((metric) => metric.status)),
  };
}

export function buildStageEvaluationHints(stepNames: string[]): StageEvaluationHint[] {
  return stepNames.map((stepName) => ({
    stepName,
    kind: normalizeStageKind(stepName),
    metrics: metricsForKind(normalizeStageKind(stepName)),
  }));
}

export function buildStageEvaluationsFromStepResults(
  stepResults: Record<string, StepResult>,
): StageEvaluationResult[] {
  return Object.entries(stepResults).map(([stepName, stepResult]) =>
    evaluateStageForStep(stepName, stepResult, stepResult.observation),
  );
}

export function toStageEvaluationHints(results: StageEvaluationResult[]): StageEvaluationHint[] {
  return results.map((result) => ({
    stepName: result.stepName,
    kind: result.kind as StageEvaluationKind,
    metrics: result.metrics.map(({ name, description, evidenceRefs }) => ({
      name,
      description,
      evidenceRefs,
    })),
    overallStatus: result.overallStatus,
  }));
}
