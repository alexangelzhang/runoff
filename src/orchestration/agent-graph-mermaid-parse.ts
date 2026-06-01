/**
 * P6 — Parse runoff AgentGraph Mermaid (flowchart TD) back to snapshot.
 */

import { recomputeSnapshotWaves } from "./agent-graph-validate.js";
import type { AgentGraphGroupLink, AgentGraphSnapshot } from "./agent-graph-io.js";

const NODE_RE = /^\s*([A-Za-z0-9_]+)\["([^"]+)"\]\s*$/;
const EDGE_RE = /^\s*([A-Za-z0-9_]+)\s*-->\s*([A-Za-z0-9_]+)\s*$/;

function parseNodeLabel(label: string): { id: string; providers: string | string[] } {
  const parts = label.split(/<br\s*\/?>/i);
  const id = (parts[0] ?? "").trim();
  const provRaw = (parts[1] ?? "mock").trim() || "mock";
  const providers = provRaw.includes("|")
    ? provRaw.split("|").map((s) => s.trim()).filter(Boolean)
    : provRaw;
  return { id, providers };
}

/** Parse Mermaid from `agentGraphToMermaid`; waves recomputed from deps. */
export function parseAgentGraphFromMermaid(
  text: string,
  source: AgentGraphSnapshot["source"] = "config",
): AgentGraphSnapshot {
  const midToId = new Map<string, string>();
  const providersById = new Map<string, string | string[]>();
  const dependsOn = new Map<string, Set<string>>();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("flowchart") || trimmed.startsWith("subgraph") || trimmed === "end") {
      continue;
    }

    const nodeMatch = NODE_RE.exec(line);
    if (nodeMatch) {
      const mid = nodeMatch[1]!;
      const { id, providers } = parseNodeLabel(nodeMatch[2]!);
      if (!id) continue;
      midToId.set(mid, id);
      providersById.set(id, providers);
      if (!dependsOn.has(id)) dependsOn.set(id, new Set());
      continue;
    }

    const edgeMatch = EDGE_RE.exec(line);
    if (edgeMatch) {
      const fromMid = edgeMatch[1]!;
      const toMid = edgeMatch[2]!;
      const fromId = midToId.get(fromMid) ?? fromMid;
      const toId = midToId.get(toMid) ?? toMid;
      if (!dependsOn.has(toId)) dependsOn.set(toId, new Set());
      dependsOn.get(toId)!.add(fromId);
      if (!dependsOn.has(fromId)) dependsOn.set(fromId, new Set());
      if (!providersById.has(fromId)) providersById.set(fromId, "mock");
      if (!providersById.has(toId)) providersById.set(toId, "mock");
      midToId.set(fromMid, fromId);
      midToId.set(toMid, toId);
    }
  }

  const nodes = [...dependsOn.keys()].map((id) => ({
    id,
    providers: providersById.get(id) ?? "mock",
    dependsOn: [...(dependsOn.get(id) ?? [])],
  }));

  if (nodes.length === 0) {
    throw new Error("No nodes parsed from Mermaid (expected id[\"id<br/>provider\"] lines)");
  }

  const snap: AgentGraphSnapshot = { source, waves: [], nodes };
  snap.waves = recomputeSnapshotWaves(snap);
  return snap;
}

const GROUP_NODE_RE = /^\s*([A-Za-z0-9_]+)\["([^"]+)"\]\s*$/;
const GROUP_EDGE_RE = /^\s*([A-Za-z0-9_]+)\s*-->\s*([A-Za-z0-9_]+)\s*$/;

function midToGroupKey(mid: string, label?: string): string {
  if (label && label !== "(no groups)") return label;
  return mid.replace(/_/g, "/");
}

/** Parse group-link Mermaid from `agentGraphGroupLinksToMermaid` (P19). */
export function parseAgentGraphGroupLinksFromMermaid(text: string): AgentGraphGroupLink[] {
  const midToLabel = new Map<string, string>();
  const links: AgentGraphGroupLink[] = [];
  const seen = new Set<string>();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (
      !trimmed ||
      trimmed.startsWith("flowchart") ||
      trimmed.startsWith("subgraph") ||
      trimmed === "end"
    ) {
      continue;
    }

    const nodeMatch = GROUP_NODE_RE.exec(line);
    if (nodeMatch) {
      const label = nodeMatch[2]!.replace(/'/g, '"');
      if (label === "(no groups)") continue;
      midToLabel.set(nodeMatch[1]!, label);
      continue;
    }

    const edgeMatch = GROUP_EDGE_RE.exec(line);
    if (edgeMatch) {
      const from = midToGroupKey(edgeMatch[1]!, midToLabel.get(edgeMatch[1]!));
      const to = midToGroupKey(edgeMatch[2]!, midToLabel.get(edgeMatch[2]!));
      const key = `${from}\0${to}`;
      if (seen.has(key) || from === to) continue;
      seen.add(key);
      links.push({ from, to });
    }
  }

  return links;
}
