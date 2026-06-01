/**
 * Approval gate adapters — auto (dev/CI), defer (pause run), callback (CLI/MCP).
 */

import type { ApprovalGate, ApprovalRequest, ApprovalResponse, RiskLevel } from "./approval.js";
import { AutoApprovalGate, CallbackApprovalGate } from "./approval.js";
import type { PipelineRuntimeConfig } from "../core/config.js";

export class DeferredApprovalGate implements ApprovalGate {
  readonly pendingRequest: ApprovalRequest;

  constructor(private readonly request: ApprovalRequest) {
    this.pendingRequest = request;
  }

  shouldApprove(): boolean {
    return true;
  }

  async requestApproval(): Promise<ApprovalResponse> {
    throw new ApprovalDeferredError(this.request);
  }
}

export class ApprovalDeferredError extends Error {
  readonly request: ApprovalRequest;

  constructor(request: ApprovalRequest) {
    super(`Approval deferred for action: ${request.action}`);
    this.name = "ApprovalDeferredError";
    this.request = request;
  }
}

/** Factory used by execution governance and tests. */
export function createApprovalGate(
  runtime?: PipelineRuntimeConfig,
  callback?: (request: ApprovalRequest) => Promise<ApprovalResponse>,
): ApprovalGate {
  const mode = runtime?.governance?.approvalMode ?? process.env.RUNOFF_APPROVAL_MODE ?? "auto";

  if (mode === "callback" && callback) {
    return new CallbackApprovalGate(
      callback,
      runtime?.governance?.approvalRiskThreshold ?? "medium",
    );
  }

  if (mode === "defer") {
    return {
      shouldApprove: () => true,
      requestApproval: async (request) => {
        throw new ApprovalDeferredError(request);
      },
    };
  }

  const threshold = runtime?.governance?.approvalRiskThreshold ?? "medium";
  const autoBelow = process.env.RUNOFF_AUTO_APPROVE === "1" ? "low" : threshold;
  return new AutoApprovalGate(autoBelow as RiskLevel);
}
