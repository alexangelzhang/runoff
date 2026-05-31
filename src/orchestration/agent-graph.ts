/**
 * Backlog B7 — AgentGraph as a first-class runtime topology model.
 * Config `pipeline` remains the declaration SoT; the graph is compiled and updated on dynamic inject.
 */

import type { PipelineConfig } from "../core/config.js";
import { computePipelineStages } from "./dag.js";
import type { ExecutionPlan } from "./orchestrator.js";
import { executionPlanToStages } from "./plan-scheduler.js";

export type AgentGraphNode = {
  id: string;
  providers: string | string[];
  dependsOn: string[];
};

export type AgentGraphSource = "config" | "dynamic";

export type AgentGraph = {
  nodes: Map<string, AgentGraphNode>;
  /** Topological waves (each inner array = parallel stage). */
  waves: string[][];
  source: AgentGraphSource;
};

/** Compile runtime graph from pipeline config tuple (providers + deps). */
export function compileAgentGraphFromPipeline(
  pipeline: PipelineConfig["pipeline"],
  source: AgentGraphSource = "config",
): AgentGraph {
  const nodes = new Map<string, AgentGraphNode>();
  for (const [stepName, tuple] of Object.entries(pipeline)) {
    const [providers, ...dependsOn] = tuple;
    nodes.set(stepName, { id: stepName, providers, dependsOn });
  }
  return {
    nodes,
    waves: computePipelineStages(pipeline),
    source,
  };
}

export function agentGraphToStages(graph: AgentGraph): string[][] {
  return graph.waves.map((wave) => [...wave]);
}

/** Project graph waves to orchestrator ExecutionPlan (nested array = parallel). */
export function agentGraphToExecutionPlan(
  graph: AgentGraph,
  maxRounds?: number,
): ExecutionPlan {
  const steps = graph.waves.map((stage) =>
    stage.length === 1 ? stage[0]! : [...stage],
  );
  return {
    steps,
    maxRounds: maxRounds ?? Math.max(graph.waves.length * 2, 1),
  };
}

/** Recompute waves after pipeline config or nodes change (e.g. dynamic inject). */
export function refreshAgentGraphWaves(
  graph: AgentGraph,
  pipeline: PipelineConfig["pipeline"],
): void {
  graph.waves = computePipelineStages(pipeline);
}

export function appendNodeToAgentGraph(
  graph: AgentGraph,
  stepName: string,
  node: Pick<AgentGraphNode, "providers" | "dependsOn">,
  pipeline: PipelineConfig["pipeline"],
): void {
  graph.nodes.set(stepName, { id: stepName, ...node });
  graph.source = "dynamic";
  refreshAgentGraphWaves(graph, pipeline);
}

/** B6: apply orchestrator / LLM planner waves onto the runtime graph. */
export function applyExecutionPlanToAgentGraph(
  graph: AgentGraph,
  plan: ExecutionPlan,
): void {
  graph.waves = executionPlanToStages(plan);
  graph.source = "dynamic";
}

/** Keep an active ExecutionPlan in sync with graph waves (B3 + B7). */
export function syncExecutionPlanFromAgentGraph(
  plan: ExecutionPlan,
  graph: AgentGraph,
): void {
  plan.steps = graph.waves.map((stage) =>
    stage.length === 1 ? stage[0]! : [...stage],
  );
}
