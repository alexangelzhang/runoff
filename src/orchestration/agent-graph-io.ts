/**
 * P2 — AgentGraph JSON export/import for visualization and external editors.
 */

import type { PipelineConfig } from "../core/config.js";
import {
  compileAgentGraphFromPipeline,
  refreshAgentGraphWaves,
  type AgentGraph,
  type AgentGraphNode,
} from "./agent-graph.js";
import {
  recomputeSnapshotWaves,
  validateAgentGraphSnapshot,
  type AgentGraphValidation,
} from "./agent-graph-validate.js";

export type { AgentGraphValidation };
export { recomputeSnapshotWaves, validateAgentGraphSnapshot };
export {
  parseAgentGraphFromMermaid,
  parseAgentGraphGroupLinksFromMermaid,
} from "./agent-graph-mermaid-parse.js";

export type AgentGraphNodeLayout = { x: number; y: number };

export type AgentGraphViewState = {
  zoom: number;
  panX: number;
  panY: number;
};

/** P13: per-node canvas metadata (groups, lock). */
export type AgentGraphNodeMeta = {
  group?: string;
  /** P16: outer group for nesting (display key: parent/group). */
  parentGroup?: string;
  locked?: boolean;
  /** P22: auto-created group placeholder (canvas styling). */
  placeholder?: boolean;
};

/** P16: dependency between groups (keys = parent/child or group name). */
export type AgentGraphGroupLink = {
  from: string;
  to: string;
};

export type AgentGraphSnapshot = {
  source: AgentGraph["source"];
  waves: string[][];
  nodes: Array<{
    id: string;
    providers: string | string[];
    dependsOn: string[];
  }>;
  /** P8: persisted node coordinates for canvas editor. */
  layout?: Record<string, AgentGraphNodeLayout>;
  /** P8: canvas zoom/pan state. */
  view?: AgentGraphViewState;
  /** P13: node group + lock flags for canvas editor. */
  nodeMeta?: Record<string, AgentGraphNodeMeta>;
  /** P14: collapsed group keys (hide member nodes). */
  collapsedGroups?: Record<string, boolean>;
  /** P16: inter-group dependency edges (group key → group key). */
  groupLinks?: AgentGraphGroupLink[];
  /** P17: collapsed parent group names (hides all nested child groups). */
  collapsedParents?: Record<string, boolean>;
};

export function serializeAgentGraph(graph: AgentGraph): AgentGraphSnapshot {
  return {
    source: graph.source,
    waves: graph.waves.map((w) => [...w]),
    nodes: [...graph.nodes.values()].map((n) => ({
      id: n.id,
      providers: n.providers,
      dependsOn: [...n.dependsOn],
    })),
  };
}

export function parseAgentGraphSnapshot(snapshot: AgentGraphSnapshot): AgentGraph {
  const nodes = new Map<string, AgentGraphNode>();
  for (const n of snapshot.nodes) {
    nodes.set(n.id, {
      id: n.id,
      providers: n.providers,
      dependsOn: [...n.dependsOn],
    });
  }
  return {
    nodes,
    waves: snapshot.waves.map((w) => [...w]),
    source: snapshot.source ?? "config",
  };
}

/** Apply snapshot nodes onto a pipeline config object (declaration SoT). */
export function applyAgentGraphToPipeline(
  snapshot: AgentGraphSnapshot,
  pipeline: PipelineConfig["pipeline"],
  options?: { skipValidation?: boolean },
): void {
  if (!options?.skipValidation) {
    const check = validateAgentGraphSnapshot(snapshot);
    if (!check.valid) {
      if (check.cycle) {
        throw new Error(`AgentGraph cycle detected: ${check.cycle.join(" → ")}`);
      }
      if (check.missingDeps?.length) {
        throw new Error(`AgentGraph missing dependencies: ${check.missingDeps.join(", ")}`);
      }
    }
  }
  for (const key of Object.keys(pipeline)) {
    delete pipeline[key];
  }
  for (const node of snapshot.nodes) {
    const providers = node.providers;
    pipeline[node.id] = Array.isArray(providers)
      ? [providers, ...node.dependsOn]
      : [providers, ...node.dependsOn];
  }
}

export function compileAgentGraphFromSnapshot(
  snapshot: AgentGraphSnapshot,
  pipeline: PipelineConfig["pipeline"],
): AgentGraph {
  const graph = parseAgentGraphSnapshot(snapshot);
  refreshAgentGraphWaves(graph, pipeline);
  return graph;
}

export function agentGraphFromConfig(config: PipelineConfig): AgentGraph {
  return compileAgentGraphFromPipeline(config.pipeline);
}
