/**
 * P5 — AgentGraph snapshot validation (cycle detection, wave recompute).
 */

import { computePipelineStages } from "./dag.js";
import type { PipelineConfig } from "../core/config.js";
import type { AgentGraphNodeLayout, AgentGraphNodeMeta, AgentGraphSnapshot } from "./agent-graph-io.js";

export function snapshotToPipeline(snapshot: AgentGraphSnapshot): PipelineConfig["pipeline"] {
  const pipeline: PipelineConfig["pipeline"] = {};
  for (const node of snapshot.nodes) {
    const providers = node.providers;
    pipeline[node.id] = Array.isArray(providers)
      ? [providers, ...node.dependsOn]
      : [providers, ...node.dependsOn];
  }
  return pipeline;
}

/** Return a cycle path (first node repeated at end) or null if acyclic. */
export function findPipelineCycle(
  pipeline: PipelineConfig["pipeline"],
): string[] | null {
  const steps = Object.keys(pipeline);
  const adj = new Map<string, string[]>();
  for (const [step, tuple] of Object.entries(pipeline)) {
    adj.set(step, tuple.slice(1) as string[]);
  }

  const state = new Map<string, 0 | 1 | 2>();
  const parent = new Map<string, string>();
  let cycle: string[] | null = null;

  function dfs(u: string): void {
    if (cycle) return;
    state.set(u, 1);
    for (const v of adj.get(u) ?? []) {
      if (!steps.includes(v)) continue;
      const sv = state.get(v) ?? 0;
      if (sv === 0) {
        parent.set(v, u);
        dfs(v);
      } else if (sv === 1) {
        const path = [v];
        let cur = u;
        while (cur !== v && path.length <= steps.length + 1) {
          path.unshift(cur);
          cur = parent.get(cur) ?? v;
        }
        path.push(v);
        cycle = path;
        return;
      }
    }
    state.set(u, 2);
  }

  for (const step of steps) {
    if ((state.get(step) ?? 0) === 0) dfs(step);
    if (cycle) break;
  }
  return cycle;
}

export function findMissingDeps(snapshot: AgentGraphSnapshot): string[] {
  const ids = new Set(snapshot.nodes.map((n) => n.id));
  const missing: string[] = [];
  for (const node of snapshot.nodes) {
    for (const dep of node.dependsOn) {
      if (!ids.has(dep)) missing.push(`${node.id}→${dep}`);
    }
  }
  return missing;
}

export function recomputeSnapshotWaves(snapshot: AgentGraphSnapshot): string[][] {
  return computePipelineStages(snapshotToPipeline(snapshot));
}

/** P20: group keys referenced in groupLinks but with no node in nodeMeta. */
export function findDanglingGroupKeys(snapshot: AgentGraphSnapshot): string[] {
  const known = new Set<string>();
  for (const n of snapshot.nodes) {
    const meta = snapshot.nodeMeta?.[n.id];
    if (!meta?.group) continue;
    const gk = meta.parentGroup ? `${meta.parentGroup}/${meta.group}` : meta.group;
    known.add(gk);
  }
  const dangling = new Set<string>();
  for (const link of snapshot.groupLinks ?? []) {
    if (!known.has(link.from)) dangling.add(link.from);
    if (!known.has(link.to)) dangling.add(link.to);
  }
  return [...dangling].sort();
}

export type DanglingGroupRepairMode = "remove-links" | "placeholder-nodes";

function parseGroupKey(groupKey: string): { parentGroup?: string; group: string } {
  const slash = groupKey.indexOf("/");
  if (slash < 0) return { group: groupKey };
  return { parentGroup: groupKey.slice(0, slash), group: groupKey.slice(slash + 1) };
}

export function placeholderNodeIdForGroupKey(groupKey: string): string {
  return `__grp__${groupKey.replace(/[^a-zA-Z0-9]+/g, "_")}`;
}

/** P22: placeholder nodes created for dangling group repair. */
export function isPlaceholderGraphNode(
  nodeId: string,
  meta?: AgentGraphNodeMeta,
): boolean {
  return !!meta?.placeholder || nodeId.startsWith("__grp__");
}

/** P21: fix dangling group link endpoints (remove links or add placeholder nodes). */
export function repairDanglingGroupLinks(
  snapshot: AgentGraphSnapshot,
  mode: DanglingGroupRepairMode,
): AgentGraphSnapshot {
  const dangling = findDanglingGroupKeys(snapshot);
  if (!dangling.length) return snapshot;

  const snap: AgentGraphSnapshot = JSON.parse(JSON.stringify(snapshot));
  const danglingSet = new Set(dangling);

  if (mode === "remove-links") {
    snap.groupLinks = (snap.groupLinks ?? []).filter(
      (l) => !danglingSet.has(l.from) && !danglingSet.has(l.to),
    );
    return snap;
  }

  if (!snap.nodeMeta) snap.nodeMeta = {};
  for (const gk of dangling) {
    const id = placeholderNodeIdForGroupKey(gk);
    if (!snap.nodes.some((n) => n.id === id)) {
      snap.nodes.push({ id, providers: "mock", dependsOn: [] });
    }
    const { parentGroup, group } = parseGroupKey(gk);
    snap.nodeMeta[id] = parentGroup
      ? { group, parentGroup, placeholder: true }
      : { group, placeholder: true };
  }
  return snap;
}

/** P23: remove auto-created placeholder nodes and scrub deps/layout/meta. */
export function removePlaceholderGraphNodes(snapshot: AgentGraphSnapshot): AgentGraphSnapshot {
  const snap: AgentGraphSnapshot = JSON.parse(JSON.stringify(snapshot));
  const removeIds = new Set(
    snap.nodes
      .filter((n) => isPlaceholderGraphNode(n.id, snap.nodeMeta?.[n.id]))
      .map((n) => n.id),
  );
  if (!removeIds.size) return snap;
  snap.nodes = snap.nodes.filter((n) => !removeIds.has(n.id));
  if (snap.nodeMeta) {
    for (const id of removeIds) delete snap.nodeMeta[id];
  }
  if (snap.layout) {
    for (const id of removeIds) delete snap.layout[id];
  }
  for (const n of snap.nodes) {
    n.dependsOn = n.dependsOn.filter((d) => !removeIds.has(d));
  }
  try {
    snap.waves = recomputeSnapshotWaves(snap);
    const W = 720;
    const H = 420;
    const layout: Record<string, AgentGraphNodeLayout> = {};
    const layerH = H / Math.max(snap.waves.length, 1);
    snap.waves.forEach((wave, wi) => {
      const y = 40 + wi * layerH;
      wave.forEach((id, xi) => {
        const count = Math.max(wave.length, 1);
        const x = 60 + (xi + 0.5) * ((W - 120) / count);
        layout[id] = { x, y };
      });
    });
    for (const n of snap.nodes) {
      if (!layout[n.id]) layout[n.id] = { x: W / 2, y: H - 40 };
    }
    snap.layout = layout;
  } catch {
    if (snap.waves?.length) {
      snap.waves = snap.waves
        .map((w) => w.filter((id) => !removeIds.has(id)))
        .filter((w) => w.length > 0);
    }
  }
  return snap;
}

export type AgentGraphValidation = {
  valid: boolean;
  cycle?: string[];
  missingDeps?: string[];
  /** P20: group link endpoints with no member nodes */
  danglingGroups?: string[];
};

export function validateAgentGraphSnapshot(snapshot: AgentGraphSnapshot): AgentGraphValidation {
  const missingDeps = findMissingDeps(snapshot);
  if (missingDeps.length > 0) return { valid: false, missingDeps };

  const cycle = findPipelineCycle(snapshotToPipeline(snapshot));
  if (cycle) return { valid: false, cycle };

  const danglingGroups = findDanglingGroupKeys(snapshot);
  if (danglingGroups.length > 0) return { valid: false, danglingGroups };

  return { valid: true };
}
