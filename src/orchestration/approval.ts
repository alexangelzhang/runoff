/**
 * Human-in-the-Loop Approval Gate (Wave 7.8).
 *
 * Inserts a human approval step before high-risk operations.
 * Works with PolicyEngine: policy decides allow/deny/require-approval,
 * then ApprovalGate handles the require-approval case.
 *
 * Reference: Microsoft Agent Framework Approval Gate, LangGraph interrupt_before.
 */

import type { AgentId } from "./multi-agent-types.js";

// --- Risk Level ---

export type RiskLevel = "low" | "medium" | "high";

// --- Pending Action ---

export interface PendingAction {
  agentId: AgentId;
  action: string;
  targetPath?: string;
  risk: RiskLevel;
  metadata?: Record<string, unknown>;
}

// --- Approval Request / Response ---

export interface ApprovalRequest {
  id: string;
  agentId: AgentId;
  action: string;
  description: string;
  risk: RiskLevel;
  context?: unknown;
  requestedAt: number;
}

export type ApprovalResponse =
  | { decision: "approve" }
  | { decision: "reject"; reason: string }
  | { decision: "modify"; modifications: unknown };

// --- Approval Record (for audit) ---

export interface ApprovalRecord {
  request: ApprovalRequest;
  response: ApprovalResponse;
  respondedAt: number;
  respondedBy?: string;
}

// --- Approval Gate Interface ---

export interface ApprovalGate {
  /** Determine if this action needs human approval. */
  shouldApprove(action: PendingAction): boolean;
  /** Request approval, resolves when human responds. */
  requestApproval(request: ApprovalRequest): Promise<ApprovalResponse>;
}

// --- Auto Approval Gate ---

/**
 * Default gate that auto-approves low-risk actions and requires
 * approval for medium/high risk. Useful for testing and as a base.
 */
export class AutoApprovalGate implements ApprovalGate {
  private approveBelow: RiskLevel;

  /**
   * @param approveBelow Auto-approve actions with risk strictly below this level.
   *   "medium" means low is auto-approved, medium and high need approval.
   *   "high" means low and medium are auto-approved.
   *   "low" means everything needs approval.
   */
  constructor(approveBelow: RiskLevel = "medium") {
    this.approveBelow = approveBelow;
  }

  shouldApprove(action: PendingAction): boolean {
    const levels: RiskLevel[] = ["low", "medium", "high"];
    const actionLevel = levels.indexOf(action.risk);
    const threshold = levels.indexOf(this.approveBelow);
    return actionLevel >= threshold;
  }

  async requestApproval(_request: ApprovalRequest): Promise<ApprovalResponse> {
    // Auto-approve everything that reaches here (for testing).
    return { decision: "approve" };
  }
}

// --- Callback Approval Gate ---

/**
 * Gate that delegates approval to a callback function.
 * Useful for CLI prompts, webhook integrations, MCP callbacks.
 */
export class CallbackApprovalGate implements ApprovalGate {
  private riskThreshold: RiskLevel;
  private callback: (request: ApprovalRequest) => Promise<ApprovalResponse>;

  constructor(
    callback: (request: ApprovalRequest) => Promise<ApprovalResponse>,
    riskThreshold: RiskLevel = "medium"
  ) {
    this.callback = callback;
    this.riskThreshold = riskThreshold;
  }

  shouldApprove(action: PendingAction): boolean {
    const levels: RiskLevel[] = ["low", "medium", "high"];
    return levels.indexOf(action.risk) >= levels.indexOf(this.riskThreshold);
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    return this.callback(request);
  }
}

// --- Approval Manager ---

/**
 * Coordinates policy decisions with approval gates.
 * Maintains an audit log of all approval decisions.
 */
export class ApprovalManager {
  private gate: ApprovalGate;
  private records: ApprovalRecord[] = [];
  private nextId = 1;
  private readonly onRequested?: (request: ApprovalRequest) => void;
  private readonly onRecord?: (record: ApprovalRecord) => void;

  constructor(
    gate: ApprovalGate,
    options?: {
      onRequested?: (request: ApprovalRequest) => void;
      onRecord?: (record: ApprovalRecord) => void;
    },
  ) {
    this.gate = gate;
    this.onRequested = options?.onRequested;
    this.onRecord = options?.onRecord;
  }

  /** Check if an action needs approval. */
  needsApproval(action: PendingAction): boolean {
    return this.gate.shouldApprove(action);
  }

  /** Request approval for an action. Returns the response and records it. */
  async requestApproval(
    action: PendingAction,
    description: string,
    context?: unknown,
    respondedBy?: string,
  ): Promise<ApprovalResponse> {
    const request: ApprovalRequest = {
      id: `approval-${this.nextId++}`,
      agentId: action.agentId,
      action: action.action,
      description,
      risk: action.risk,
      context,
      requestedAt: Date.now(),
    };

    this.onRequested?.(request);

    const response = await this.gate.requestApproval(request);

    const record: ApprovalRecord = {
      request,
      response,
      respondedAt: Date.now(),
      respondedBy,
    };
    this.records.push(record);
    this.onRecord?.(record);

    return response;
  }

  /** Get all approval records (audit log). */
  getRecords(): readonly ApprovalRecord[] {
    return this.records;
  }

  /** Get records filtered by agent. */
  getRecordsForAgent(agentId: AgentId): ApprovalRecord[] {
    return this.records.filter((r) => r.request.agentId === agentId);
  }

  /** Clear audit log. */
  clearRecords(): void {
    this.records = [];
  }
}
