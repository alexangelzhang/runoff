/**
 * P4/P5/P6 — AgentGraph editor: nodes, waves, cycle check, drag-sort, Mermaid sync.
 */

import type { AgentGraphSnapshot } from "./agent-graph-io.js";
import { agentGraphToMermaid } from "./agent-graph-viz.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const CLIENT_SCRIPT = `
(function () {
  const tbody = document.querySelector("#nodes tbody");
  const wavesEl = document.getElementById("waves");
  const statusEl = document.getElementById("status");
  const jsonEl = document.getElementById("json");
  const mermaidEl = document.getElementById("mermaidSrc");
  const mermaidPreview = document.getElementById("mermaidPreview");
  let initial = {};
  let dragRow = null;

  function fmtProviders(p) {
    return Array.isArray(p) ? p.join("|") : String(p ?? "");
  }

  function parseProviders(raw) {
    const t = raw.trim();
    if (!t) return "mock";
    if (t.includes("|")) return t.split("|").map((x) => x.trim()).filter(Boolean);
    return t;
  }

  function mkInput(value, field) {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.dataset.f = field;
    inp.value = value;
    inp.addEventListener("change", syncJson);
    return inp;
  }

  function rowTemplate(n) {
    const tr = document.createElement("tr");
    tr.draggable = true;
    const tdGrip = document.createElement("td");
    tdGrip.textContent = "⋮⋮";
    tdGrip.style.cursor = "grab";
    tdGrip.title = "Drag to reorder";
    const tdId = document.createElement("td");
    tdId.appendChild(mkInput(n.id, "id"));
    const tdProv = document.createElement("td");
    tdProv.appendChild(mkInput(fmtProviders(n.providers), "providers"));
    const tdDep = document.createElement("td");
    tdDep.appendChild(mkInput((n.dependsOn || []).join(", "), "dependsOn"));
    const tdAct = document.createElement("td");
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "×";
    del.addEventListener("click", () => { tr.remove(); syncJson(); });
    tdAct.appendChild(del);
    tr.append(tdGrip, tdId, tdProv, tdDep, tdAct);
    return tr;
  }

  function snapToMermaid(snap) {
    const lines = ["flowchart TD"];
    const mids = new Map();
    const mid = (id) => id.replace(/[^a-zA-Z0-9_]/g, "_");
    for (const n of snap.nodes) {
      const m = mid(n.id);
      mids.set(n.id, m);
      const prov = Array.isArray(n.providers) ? n.providers.join("|") : n.providers;
      lines.push("  " + m + '["' + n.id + "<br/>" + prov + '"]');
    }
    for (const n of snap.nodes) {
      const to = mids.get(n.id);
      for (const d of n.dependsOn) {
        const from = mids.get(d);
        if (from) lines.push("  " + from + " --> " + to);
      }
    }
    return lines.join("\\n");
  }

  function parseMermaid(text) {
    const NODE_RE = /^\\s*([A-Za-z0-9_]+)\\["([^"]+)"\\]\\s*$/;
    const EDGE_RE = /^\\s*([A-Za-z0-9_]+)\\s*-->\\s*([A-Za-z0-9_]+)\\s*$/;
    const midToId = new Map();
    const providersById = new Map();
    const depMap = new Map();
    for (const line of text.split("\\n")) {
      const t = line.trim();
      if (!t || t.startsWith("flowchart") || t.startsWith("subgraph") || t === "end") continue;
      const nm = NODE_RE.exec(line);
      if (nm) {
        const label = nm[2];
        const parts = label.split(/<br\\s*\\/?>/i);
        const id = (parts[0] || "").trim();
        const prov = (parts[1] || "mock").trim() || "mock";
        const providers = prov.includes("|") ? prov.split("|").map((s) => s.trim()).filter(Boolean) : prov;
        midToId.set(nm[1], id);
        providersById.set(id, providers);
        if (!depMap.has(id)) depMap.set(id, new Set());
        continue;
      }
      const em = EDGE_RE.exec(line);
      if (em) {
        const fromId = midToId.get(em[1]) || em[1];
        const toId = midToId.get(em[2]) || em[2];
        if (!depMap.has(toId)) depMap.set(toId, new Set());
        depMap.get(toId).add(fromId);
        if (!depMap.has(fromId)) depMap.set(fromId, new Set());
        if (!providersById.has(fromId)) providersById.set(fromId, "mock");
        if (!providersById.has(toId)) providersById.set(toId, "mock");
      }
    }
    const nodes = [...depMap.keys()].map((id) => ({
      id,
      providers: providersById.get(id) || "mock",
      dependsOn: [...(depMap.get(id) || [])],
    }));
    if (!nodes.length) throw new Error("No nodes parsed from Mermaid");
    return { source: initial.source || "config", waves: [], nodes };
  }

  async function refreshMermaidPreview() {
    const src = mermaidEl.value;
    mermaidPreview.textContent = src;
    if (window.mermaid) {
      try {
        await window.mermaid.run({ nodes: [mermaidPreview] });
      } catch (_) { /* ignore while editing */ }
    }
  }

  function readWaves() {
    const lines = wavesEl.value.split("\\n").map((l) => l.trim()).filter(Boolean);
    return lines.map((line) => line.split(",").map((s) => s.trim()).filter(Boolean));
  }

  function writeWaves(waves) {
    wavesEl.value = (waves || []).map((w) => w.join(", ")).join("\\n");
  }

  function findCycle(nodes) {
    const ids = new Set(nodes.map((n) => n.id));
    const adj = new Map(nodes.map((n) => [n.id, n.dependsOn.filter((d) => ids.has(d))]));
    const state = new Map();
    const parent = new Map();
    let cycle = null;
    function dfs(u) {
      if (cycle) return;
      state.set(u, 1);
      for (const v of adj.get(u) || []) {
        const sv = state.get(v) || 0;
        if (sv === 0) { parent.set(v, u); dfs(v); }
        else if (sv === 1) {
          const path = [v];
          let cur = u;
          while (cur !== v && path.length < ids.size + 2) {
            path.unshift(cur);
            cur = parent.get(cur) || v;
          }
          path.push(v);
          cycle = path;
          return;
        }
      }
      state.set(u, 2);
    }
    for (const id of ids) {
      if ((state.get(id) || 0) === 0) dfs(id);
      if (cycle) break;
    }
    return cycle;
  }

  function recomputeWaves(nodes) {
    const pipeline = {};
    for (const n of nodes) {
      pipeline[n.id] = [n.providers, ...n.dependsOn];
    }
    const stages = [];
    const visited = new Set();
    const all = Object.keys(pipeline);
    while (visited.size < all.length) {
      const stage = [];
      for (const step of all) {
        if (visited.has(step)) continue;
        const deps = pipeline[step].slice(1);
        if (deps.every((d) => visited.has(d))) stage.push(step);
      }
      if (!stage.length) return null;
      for (const s of stage) visited.add(s);
      stages.push(stage);
    }
    return stages;
  }

  function readSnapshot() {
    const nodes = [];
    tbody.querySelectorAll("tr").forEach((tr) => {
      const id = tr.querySelector('[data-f="id"]').value.trim();
      if (!id) return;
      const providers = parseProviders(tr.querySelector('[data-f="providers"]').value);
      const dependsOn = tr.querySelector('[data-f="dependsOn"]').value
        .split(",").map((s) => s.trim()).filter(Boolean);
      nodes.push({ id, providers, dependsOn });
    });
    return { source: initial.source || "config", waves: readWaves(), nodes };
  }

  function updateStatus() {
    const snap = readSnapshot();
    const cycle = findCycle(snap.nodes);
    if (cycle) {
      statusEl.textContent = "Cycle: " + cycle.join(" → ");
      statusEl.dataset.kind = "error";
      return;
    }
    const recomputed = recomputeWaves(snap.nodes);
    if (recomputed === null) {
      statusEl.textContent = "Cannot compute waves (cycle in deps)";
      statusEl.dataset.kind = "error";
      return;
    }
    statusEl.textContent = "OK · " + snap.nodes.length + " nodes · " + recomputed.length + " waves";
    statusEl.dataset.kind = "ok";
  }

  function syncJson() {
    const snap = readSnapshot();
    jsonEl.value = JSON.stringify(snap, null, 2);
    mermaidEl.value = snapToMermaid(snap);
    refreshMermaidPreview();
    updateStatus();
  }

  function renderTable(snap) {
    tbody.replaceChildren();
    (snap.nodes || []).forEach((n) => tbody.appendChild(rowTemplate(n)));
    writeWaves(snap.waves || []);
    syncJson();
  }

  tbody.addEventListener("dragstart", (e) => {
    const tr = e.target.closest("tr");
    if (!tr) return;
    dragRow = tr;
    e.dataTransfer.effectAllowed = "move";
  });
  tbody.addEventListener("dragover", (e) => {
    e.preventDefault();
    const tr = e.target.closest("tr");
    if (!tr || !dragRow || tr === dragRow) return;
    const after = e.clientY > tr.getBoundingClientRect().top + tr.offsetHeight / 2;
    tbody.insertBefore(dragRow, after ? tr.nextSibling : tr);
  });
  tbody.addEventListener("dragend", () => {
    dragRow = null;
    syncJson();
  });

  window.__agentGraphEditorInit = function (snap, mermaidText) {
    initial = snap;
    renderTable(snap);
    if (mermaidText) {
      mermaidEl.value = mermaidText;
      refreshMermaidPreview();
    }
  };

  document.getElementById("recomputeWaves").addEventListener("click", () => {
    const snap = readSnapshot();
    const waves = recomputeWaves(snap.nodes);
    if (!waves) {
      alert("Cycle detected — fix dependsOn first");
      return;
    }
    writeWaves(waves);
    syncJson();
  });

  document.getElementById("addNode").addEventListener("click", () => {
    tbody.appendChild(rowTemplate({
      id: "step_" + tbody.children.length,
      providers: "mock",
      dependsOn: [],
    }));
    syncJson();
  });
  document.getElementById("syncJson").addEventListener("click", syncJson);
  document.getElementById("loadJson").addEventListener("click", () => {
    try {
      const snap = JSON.parse(jsonEl.value);
      if (!Array.isArray(snap.nodes)) throw new Error("nodes array required");
      renderTable(snap);
    } catch (e) {
      alert(e.message || String(e));
    }
  });
  document.getElementById("copyJson").addEventListener("click", async () => {
    syncJson();
    await navigator.clipboard.writeText(jsonEl.value);
  });
  wavesEl.addEventListener("input", syncJson);
  document.getElementById("toMermaid").addEventListener("click", syncJson);
  document.getElementById("fromMermaid").addEventListener("click", () => {
    try {
      const snap = parseMermaid(mermaidEl.value);
      const waves = recomputeWaves(snap.nodes);
      if (!waves) throw new Error("Cycle in Mermaid deps");
      snap.waves = waves;
      renderTable(snap);
    } catch (e) {
      alert(e.message || String(e));
    }
  });
  mermaidEl.addEventListener("input", refreshMermaidPreview);
})();
`;

/** Interactive editor HTML (no build step; opens locally or via llm_show_agent_graph format=editor). */
export function agentGraphToEditorHtml(
  snapshot: AgentGraphSnapshot,
  title = "AgentGraph Editor",
): string {
  const initial = JSON.stringify(snapshot).replace(/</g, "\\u003c");
  const initialMermaid = JSON.stringify(agentGraphToMermaid(snapshot));
  const safeTitle = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
    mermaid.initialize({ startOnLoad: false, theme: "neutral" });
    window.mermaid = mermaid;
  </script>
  <style>
    :root { font-family: system-ui, sans-serif; color: #18181b; }
    body { margin: 0; display: grid; grid-template-columns: 1fr 18rem 20rem; min-height: 100vh; }
    header { grid-column: 1 / -1; padding: 0.75rem 1rem; border-bottom: 1px solid #e4e4e7; background: #fafafa; }
    main { padding: 1rem; overflow: auto; }
    #mermaidPane { padding: 1rem; border-left: 1px solid #e4e4e7; display: flex; flex-direction: column; gap: 0.5rem; }
    aside { padding: 1rem; border-left: 1px solid #e4e4e7; background: #f4f4f5; display: flex; flex-direction: column; gap: 0.5rem; }
    #mermaidSrc { min-height: 8rem; font-family: ui-monospace, monospace; font-size: 0.75rem; }
    #mermaidPreview { min-height: 8rem; padding: 0.5rem; border: 1px solid #e4e4e7; background: #fff; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th, td { border: 1px solid #e4e4e7; padding: 0.35rem 0.5rem; text-align: left; }
    th { background: #f4f4f5; }
    input[type=text] { width: 100%; box-sizing: border-box; }
    button { cursor: pointer; padding: 0.4rem 0.75rem; border: 1px solid #d4d4d8; border-radius: 6px; background: #fff; }
    button.primary { background: #18181b; color: #fff; border-color: #18181b; }
    textarea { flex: 1; min-height: 12rem; font-family: ui-monospace, monospace; font-size: 0.75rem; }
    .hint { font-size: 0.8rem; color: #71717a; }
    .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    #status { font-size: 0.85rem; padding: 0.35rem 0.5rem; border-radius: 4px; }
    #status[data-kind="error"] { background: #fef2f2; color: #b91c1c; }
    #status[data-kind="ok"] { background: #f0fdf4; color: #15803d; }
    #waves { width: 100%; min-height: 5rem; font-family: ui-monospace, monospace; font-size: 0.8rem; }
  </style>
</head>
<body>
  <header>
    <strong>${safeTitle}</strong>
    <span class="hint"> — edit nodes & waves; cycle check; apply via MCP</span>
    <div id="status" data-kind="ok">—</div>
  </header>
  <main>
    <div class="actions">
      <button type="button" id="addNode">Add node</button>
      <button type="button" id="recomputeWaves">Recompute waves from deps</button>
      <button type="button" id="syncJson" class="primary">Sync → JSON</button>
    </div>
    <table id="nodes">
      <thead><tr><th></th><th>id</th><th>providers</th><th>dependsOn (comma)</th><th></th></tr></thead>
      <tbody></tbody>
    </table>
    <h3 style="font-size:0.95rem;margin:1rem 0 0.35rem">Waves (one line per stage, comma-separated step ids)</h3>
    <textarea id="waves" spellcheck="false"></textarea>
  </main>
  <section id="mermaidPane">
    <div class="hint">Mermaid ↔ table</div>
    <button type="button" id="toMermaid">Table → Mermaid</button>
    <button type="button" id="fromMermaid">Mermaid → table</button>
    <textarea id="mermaidSrc" spellcheck="false"></textarea>
    <div id="mermaidPreview" class="mermaid"></div>
  </section>
  <aside>
    <div class="hint">AgentGraphSnapshot (apply via MCP)</div>
    <textarea id="json" spellcheck="false"></textarea>
    <button type="button" id="copyJson" class="primary">Copy JSON</button>
    <button type="button" id="loadJson">Load JSON → table</button>
  </aside>
  <script>${CLIENT_SCRIPT}</script>
  <script>window.__agentGraphEditorInit(${initial}, ${initialMermaid});</script>
</body>
</html>`;
}
