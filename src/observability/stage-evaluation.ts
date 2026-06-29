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
}

function normalizeStageKind(stepName: string): StageEvaluationKind {
  const normalized = stepName.trim().toLowerCase();
  if (normalized.includes("analy")) return "analyze";
  if (normalized.includes("test") || normalized.includes("verify")) return "test";
  if (normalized.includes("review")) return "review";
  if (normalized.includes("implement") || normalized.includes("refactor") || normalized.includes("write")) return "implement";
  if (normalized.includes("final") || normalized.includes("summary") || normalized.includes("report")) return "final_summary";
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

export function buildStageEvaluationHints(stepNames: string[]): StageEvaluationHint[] {
  return stepNames.map((stepName) => ({
    stepName,
    kind: normalizeStageKind(stepName),
    metrics: metricsForKind(normalizeStageKind(stepName)),
  }));
}
