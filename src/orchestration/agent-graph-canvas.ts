/**
 * P7 — SVG DAG canvas editor (visual graph, non-table).
 */

import type { AgentGraphSnapshot } from "./agent-graph-io.js";
import { computeDagWaveLayout } from "./agent-graph-layout.js";
import { recomputeSnapshotWaves } from "./agent-graph-validate.js";
import { AGENT_GRAPH_CANVAS_SCRIPT } from "./agent-graph-canvas-script.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}


/** Standalone SVG DAG canvas (format=canvas). */
export function agentGraphToCanvasHtml(
  snapshot: AgentGraphSnapshot,
  title = "AgentGraph Canvas",
): string {
  const waves =
    snapshot.waves.length > 0
      ? snapshot.waves
      : (() => {
          try {
            return recomputeSnapshotWaves(snapshot);
          } catch {
            return snapshot.nodes.map((n) => [n.id]);
          }
        })();
  const snap = { ...snapshot, waves };
  if (!snap.layout || Object.keys(snap.layout).length === 0) {
    snap.layout = computeDagWaveLayout(snap);
  }
  const initial = JSON.stringify(snap).replace(/</g, "\\u003c");
  const safeTitle = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <style>
    :root { font-family: system-ui, sans-serif; color: #18181b; }
    body { margin: 0; display: grid; grid-template-columns: 1fr 16rem; min-height: 100vh; }
    header { grid-column: 1 / -1; padding: 0.75rem 1rem; border-bottom: 1px solid #e4e4e7; background: #fafafa; }
    main { padding: 1rem; }
    aside { padding: 1rem; border-left: 1px solid #e4e4e7; background: #f4f4f5; display: flex; flex-direction: column; gap: 0.5rem; }
    #dagWrap { overflow: hidden; max-width: 760px; border: 1px solid #e4e4e7; background: #fafafa; }
    #dagSvg { width: 100%; height: 440px; display: block; cursor: grab; }
    input, textarea { width: 100%; box-sizing: border-box; font-size: 0.85rem; }
    button { cursor: pointer; padding: 0.35rem 0.6rem; border: 1px solid #d4d4d8; border-radius: 6px; background: #fff; }
    .hint { font-size: 0.8rem; color: #71717a; }
    #status[data-kind="error"] { color: #b91c1c; }
    #status[data-kind="warn"] { color: #b45309; cursor: pointer; }
    footer { grid-column: 1 / -1; padding: 0.5rem 1rem; border-top: 1px solid #e4e4e7; background: #fafafa; font-size: 0.8rem; color: #71717a; }
    footer.undo-stack-full { background: #fffbeb; border-top-color: #fcd34d; }
    footer.undo-stack-full #undoFooterHint { color: #b45309; font-weight: 600; }
    #json { flex: 1; min-height: 8rem; font-family: ui-monospace, monospace; font-size: 0.75rem; }
  </style>
</head>
<body>
  <header>
    <strong>${safeTitle}</strong>
    <span class="hint"> — drag box to select; Shift+click toggle; align buttons; Undo ⌘Z</span>
    <div id="status" data-kind="ok">—</div>
  </header>
  <main>
    <div id="dagWrap">
      <svg id="dagSvg" viewBox="0 0 720 420" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="#a1a1aa" />
          </marker>
        </defs>
        <g id="viewport"></g>
        <rect id="selectionRect" visibility="hidden" fill="rgba(37,99,235,0.08)" stroke="#2563eb" stroke-width="1" stroke-dasharray="4 3" pointer-events="none" />
      </svg>
    </div>
    <div style="margin-top:0.5rem;display:flex;gap:0.5rem;flex-wrap:wrap">
      <button type="button" id="addNode">Add node</button>
      <button type="button" id="recomputeWaves">Recompute waves</button>
      <button type="button" id="autoLayout">Auto layout</button>
      <button type="button" id="exportPng">Export PNG</button>
      <button type="button" id="alignLeft">Align L</button>
      <button type="button" id="alignCenter">Align C</button>
      <button type="button" id="alignRight">Align R</button>
      <button type="button" id="alignTop">Align T</button>
      <button type="button" id="alignMiddle">Align M</button>
      <button type="button" id="alignBottom">Align B</button>
      <button type="button" id="distributeH">Distribute H</button>
      <button type="button" id="distributeV">Distribute V</button>
      <button type="button" id="toggleGroupCollapse">Collapse group</button>
      <button type="button" id="lockGroup">Lock group</button>
      <button type="button" id="copyGroupMermaid">Copy grp Mermaid</button>
      <button type="button" id="fromGroupMermaid">Import grp Mermaid</button>
      <button type="button" id="fixDanglingRemove">Fix dangling (del links)</button>
      <button type="button" id="fixDanglingPlaceholder">Fix dangling (placeholder)</button>
      <button type="button" id="removePlaceholders">Remove placeholders</button>
      <button type="button" id="addGroupLink">Link groups</button>
      <button type="button" id="removeGroupLink">Remove grp link</button>
      <button type="button" id="toggleParentCollapse">Collapse parent</button>
      <button type="button" id="alignGroupLeft">Grp L</button>
      <button type="button" id="alignGroupCenter">Grp C</button>
      <button type="button" id="alignGroupRight">Grp R</button>
      <button type="button" id="alignGroupTop">Grp T</button>
      <button type="button" id="alignGroupMiddle">Grp M</button>
      <button type="button" id="alignGroupBottom">Grp B</button>
    </div>
    <label class="hint">Selected node</label>
    <input id="selId" type="text" placeholder="id" />
    <input id="selProv" type="text" placeholder="providers" />
    <input id="selDeps" type="text" placeholder="dependsOn comma-separated" />
    <input id="selGroup" type="text" placeholder="group name" />
    <input id="selParentGroup" type="text" placeholder="parent group (nested)" />
    <input id="selGroupLinkFrom" type="text" placeholder="group link from" />
    <input id="selGroupLinkTo" type="text" placeholder="group link to" />
    <button type="button" id="applyGroupLink">Apply group link</button>
    <label class="hint"><input id="selLocked" type="checkbox" /> Lock node (no drag)</label>
    <input id="selEdge" type="text" placeholder="selected edge" readonly />
    <button type="button" id="applySel">Apply selection</button>
    <button type="button" id="removeEdge">Remove edge</button>
    <button type="button" id="undo">Undo</button>
    <button type="button" id="redo">Redo</button>
  </main>
  <aside>
    <div class="hint">Group links Mermaid (P18)</div>
    <textarea id="groupMermaid" spellcheck="false" style="min-height:5rem;font-family:ui-monospace,monospace;font-size:0.75rem"></textarea>
    <div class="hint">JSON for MCP apply</div>
    <textarea id="json" spellcheck="false"></textarea>
    <button type="button" id="copyJson">Copy JSON</button>
    <button type="button" id="loadJson">Load JSON</button>
  </aside>
  <footer id="canvasFooter"><span id="undoFooterHint">Undo ⌘Z · Redo ⇧⌘Z — undo: 0/40 · redo: 0</span></footer>
  <script>${AGENT_GRAPH_CANVAS_SCRIPT}</script>
  <script>window.__agentGraphCanvasInit(${initial});</script>
</body>
</html>`;
}
