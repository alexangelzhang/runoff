/**
 * P9 — DAG wave layout for AgentGraph canvas (shared server + client logic).
 */

import type { AgentGraphNodeLayout, AgentGraphSnapshot } from "./agent-graph-io.js";
import { recomputeSnapshotWaves } from "./agent-graph-validate.js";

export type DagLayoutOptions = {
  width?: number;
  height?: number;
};

/** Layered layout by topological waves (same algorithm as canvas editor). */
export function computeDagWaveLayout(
  snapshot: AgentGraphSnapshot,
  options: DagLayoutOptions = {},
): Record<string, AgentGraphNodeLayout> {
  const W = options.width ?? 720;
  const H = options.height ?? 420;
  const waves =
    snapshot.waves.length > 0 ? snapshot.waves : recomputeSnapshotWaves(snapshot);
  const layout: Record<string, AgentGraphNodeLayout> = {};
  const layerH = H / Math.max(waves.length, 1);

  waves.forEach((wave, wi) => {
    const y = 40 + wi * layerH;
    wave.forEach((id, xi) => {
      const count = Math.max(wave.length, 1);
      const x = 60 + (xi + 0.5) * ((W - 120) / count);
      layout[id] = { x, y };
    });
  });

  for (const n of snapshot.nodes) {
    if (!layout[n.id]) layout[n.id] = { x: W / 2, y: H - 40 };
  }
  return layout;
}
