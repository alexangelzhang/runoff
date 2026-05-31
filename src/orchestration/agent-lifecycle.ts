/**
 * Agent registry lifecycle + durable event log (Gate 2.5).
 */

import type { EventLog } from "./event-log.js";
import { OrchestrationEventEmitter } from "./events.js";
import type { AgentRegistry } from "./registry.js";
import type { AgentId } from "./multi-agent-types.js";

export interface LifecycleSummary {
  registered: number;
  disposed: number;
  handoffs: number;
  stepStarted: number;
  stepFinished: number;
}

/** Emit agent_registered for every agent currently in the registry. */
export function emitRegistryRegistered(registry: AgentRegistry, eventLog: EventLog, runId: string): void {
  const emitter = new OrchestrationEventEmitter(eventLog, runId);
  for (const id of registry.ids()) {
    emitter.agentRegistered(id, registry.getOrThrow(id).role);
  }
}

/** Emit agent_disposed for each agent, then dispose and clear the registry. */
export function disposeRegistryTracked(registry: AgentRegistry, eventLog: EventLog, runId: string): void {
  const emitter = new OrchestrationEventEmitter(eventLog, runId);
  for (const id of [...registry.ids()]) {
    emitter.agentDisposed(id);
  }
  registry.disposeAll();
}

export function summarizeLifecycle(eventLog: EventLog, runId: string): LifecycleSummary {
  const entries = eventLog.replay(runId);
  let registered = 0;
  let disposed = 0;
  let handoffs = 0;
  let stepStarted = 0;
  let stepFinished = 0;
  for (const e of entries) {
    switch (e.event.type) {
      case "agent_registered":
        registered++;
        break;
      case "agent_disposed":
        disposed++;
        break;
      case "handoff":
        handoffs++;
        break;
      case "step_started":
        stepStarted++;
        break;
      case "step_finished":
        stepFinished++;
        break;
      default:
        break;
    }
  }
  return { registered, disposed, handoffs, stepStarted, stepFinished };
}

/** True when every registration has a matching disposal and registry is empty. */
export function lifecycleBalanced(summary: LifecycleSummary, registrySize: number): boolean {
  return summary.registered === summary.disposed && registrySize === 0;
}

export function emitStepHandoff(
  eventLog: EventLog,
  runId: string,
  from: AgentId,
  to: AgentId,
  reason?: string,
): void {
  new OrchestrationEventEmitter(eventLog, runId).handoff(from, to, reason);
}
