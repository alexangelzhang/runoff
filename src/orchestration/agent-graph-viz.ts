/**
 * P3 — AgentGraph visualization (Mermaid + standalone HTML).
 */

import type { AgentGraphNodeMeta, AgentGraphSnapshot } from "./agent-graph-io.js";

function escapeMermaidId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, "_");
}

function providerLabel(providers: string | string[]): string {
  return Array.isArray(providers) ? providers.join("|") : providers;
}

/** Mermaid flowchart (render in GitHub, Obsidian, or llm_show_agent_graph format=mermaid). */
export function agentGraphToMermaid(snapshot: AgentGraphSnapshot): string {
  const lines: string[] = ["flowchart TD"];
  const nodeIds = new Map<string, string>();

  for (const node of snapshot.nodes) {
    const mid = escapeMermaidId(node.id);
    nodeIds.set(node.id, mid);
    const label = `${node.id}<br/>${providerLabel(node.providers)}`;
    lines.push(`  ${mid}["${label}"]`);
  }

  for (const node of snapshot.nodes) {
    const to = nodeIds.get(node.id)!;
    for (const dep of node.dependsOn) {
      const from = nodeIds.get(dep);
      if (from) lines.push(`  ${from} --> ${to}`);
    }
  }

  snapshot.waves.forEach((wave, i) => {
    if (wave.length <= 1) return;
    lines.push(`  subgraph wave${i}["wave ${i + 1}"]`);
    for (const step of wave) {
      const id = nodeIds.get(step);
      if (id) lines.push(`    ${id}`);
    }
    lines.push("  end");
  });

  return lines.join("\n");
}

function groupKeyFromMeta(meta?: AgentGraphNodeMeta): string | undefined {
  if (!meta?.group) return undefined;
  return meta.parentGroup ? `${meta.parentGroup}/${meta.group}` : meta.group;
}

/** Collect group keys from nodeMeta and groupLinks (P18). */
export function collectAgentGraphGroupKeys(snapshot: AgentGraphSnapshot): string[] {
  const keys = new Set<string>();
  for (const n of snapshot.nodes) {
    const gk = groupKeyFromMeta(snapshot.nodeMeta?.[n.id]);
    if (gk) keys.add(gk);
  }
  for (const link of snapshot.groupLinks ?? []) {
    keys.add(link.from);
    keys.add(link.to);
  }
  return [...keys].sort();
}

/** Mermaid flowchart for inter-group links only (P18). */
export function agentGraphGroupLinksToMermaid(snapshot: AgentGraphSnapshot): string {
  const keys = collectAgentGraphGroupKeys(snapshot);
  const links = snapshot.groupLinks ?? [];
  if (!keys.length && !links.length) {
    return "flowchart LR\n  empty[\"(no groups)\"]";
  }
  const lines: string[] = ["flowchart LR"];
  const idMap = new Map<string, string>();
  for (const g of keys) {
    const mid = escapeMermaidId(g.replace(/\//g, "_"));
    idMap.set(g, mid);
    lines.push(`  ${mid}["${g.replace(/"/g, "'")}"]`);
  }
  for (const link of links) {
    const from = idMap.get(link.from);
    const to = idMap.get(link.to);
    if (from && to) lines.push(`  ${from} --> ${to}`);
  }
  return lines.join("\n");
}

/** Self-contained HTML preview (opens in browser; uses Mermaid CDN). */
export function agentGraphToHtml(snapshot: AgentGraphSnapshot, title = "AgentGraph"): string {
  const mermaid = agentGraphToMermaid(snapshot);
  const safeTitle = title.replace(/</g, "&lt;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
    mermaid.initialize({ startOnLoad: true, theme: "neutral" });
  </script>
  <style>
    body { font-family: system-ui, sans-serif; margin: 1.5rem; }
    h1 { font-size: 1.25rem; }
    pre { background: #f4f4f5; padding: 1rem; overflow: auto; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>${safeTitle}</h1>
  <p>Source: <code>${snapshot.source}</code> · Waves: ${snapshot.waves.length} · Nodes: ${snapshot.nodes.length}</p>
  <pre class="mermaid">${mermaid.replace(/</g, "&lt;")}</pre>
  <h2>JSON snapshot</h2>
  <pre>${JSON.stringify(snapshot, null, 2).replace(/</g, "&lt;")}</pre>
</body>
</html>`;
}
