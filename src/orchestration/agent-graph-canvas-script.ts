/**
 * Client-side script for AgentGraph SVG canvas (embedded in generated HTML).
 * Long-term: extract to a standalone .html/.js asset and inline at build time.
 */
export const AGENT_GRAPH_CANVAS_SCRIPT = `
(function () {
  const svg = document.getElementById("dagSvg");
  const jsonEl = document.getElementById("json");
  const statusEl = document.getElementById("status");
  const undoFooterEl = document.getElementById("undoFooterHint");
  const canvasFooterEl = document.getElementById("canvasFooter");
  const selId = document.getElementById("selId");
  const selProv = document.getElementById("selProv");
  const selDeps = document.getElementById("selDeps");
  const viewport = document.getElementById("viewport");
  let snap = { source: "config", waves: [], nodes: [], layout: {}, nodeMeta: {}, collapsedGroups: {}, collapsedParents: {}, groupLinks: [], view: { zoom: 1, panX: 0, panY: 0 } };
  let selected = null;
  const selectedIds = new Set();
  let selectedEdge = null;
  let selectedGroupLink = null;
  let linkFrom = null;
  const SNAP = 8;
  let guideLines = [];
  const nodePos = new Map();
  const undoStack = [];
  const redoStack = [];
  const MAX_HISTORY = 40;
  const STORAGE_KEY = "llm-pipeline-agent-graph-canvas";
  let dragging = null;
  let suppressClick = false;
  let panning = false;
  let panStart = null;
  let boxSelect = null;
  const selectionRect = document.getElementById("selectionRect");

  const W = 720;
  const H = 420;
  const NODE_W = 88;
  const NODE_H = 36;

  function applyViewTransform() {
    const v = snap.view || { zoom: 1, panX: 0, panY: 0 };
    viewport.setAttribute("transform", "translate(" + v.panX + "," + v.panY + ") scale(" + v.zoom + ")");
  }

  function persistLayout() {
    const layout = {};
    for (const [id, p] of nodePos.entries()) layout[id] = { x: p.x, y: p.y };
    snap.layout = layout;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ layout: snap.layout, view: snap.view }));
    } catch (_) { /* ignore */ }
  }

  function fmtProviders(p) {
    return Array.isArray(p) ? p.join("|") : String(p ?? "");
  }

  function parseProviders(raw) {
    const t = raw.trim();
    if (!t) return "mock";
    if (t.includes("|")) return t.split("|").map((x) => x.trim()).filter(Boolean);
    return t;
  }

  function isNodeSelected(id) {
    return selectedIds.has(id);
  }

  function ensureNodeMeta() {
    if (!snap.nodeMeta) snap.nodeMeta = {};
  }

  function getNodeMeta(id) {
    return (snap.nodeMeta || {})[id] || {};
  }

  function isLocked(id) {
    return !!getNodeMeta(id).locked;
  }

  function ensureCollapsedGroups() {
    if (!snap.collapsedGroups) snap.collapsedGroups = {};
  }

  function ensureCollapsedParents() {
    if (!snap.collapsedParents) snap.collapsedParents = {};
  }

  function isParentCollapsed(parentName) {
    return !!(parentName && snap.collapsedParents && snap.collapsedParents[parentName]);
  }

  function groupKeyFromMeta(meta) {
    if (!meta.group) return null;
    return meta.parentGroup ? meta.parentGroup + "/" + meta.group : meta.group;
  }

  function groupKeyForNode(id) {
    return groupKeyFromMeta(getNodeMeta(id));
  }

  function isGroupCollapsed(groupKey) {
    return !!(groupKey && snap.collapsedGroups && snap.collapsedGroups[groupKey]);
  }

  function isNodeHidden(id) {
    const meta = getNodeMeta(id);
    if (meta.parentGroup && isParentCollapsed(meta.parentGroup)) return true;
    const gk = groupKeyForNode(id);
    return !!gk && isGroupCollapsed(gk);
  }

  function getActiveParentGroup() {
    if (selectedIds.size) {
      for (const id of selectedIds) {
        const p = getNodeMeta(id).parentGroup;
        if (p) return p;
      }
    }
    if (selected) return getNodeMeta(selected).parentGroup || "";
    return "";
  }

  function toggleParentCollapse(parentName) {
    if (!parentName) return;
    pushHistory();
    ensureCollapsedParents();
    if (snap.collapsedParents[parentName]) delete snap.collapsedParents[parentName];
    else snap.collapsedParents[parentName] = true;
    syncJson();
  }

  function getActiveGroupKey() {
    if (selectedIds.size) {
      for (const id of selectedIds) {
        const gk = groupKeyForNode(id);
        if (gk) return gk;
      }
    }
    if (selected) return groupKeyForNode(selected) || "";
    return "";
  }

  function toggleGroupCollapse(groupKey) {
    if (!groupKey) return;
    pushHistory();
    ensureCollapsedGroups();
    if (snap.collapsedGroups[groupKey]) delete snap.collapsedGroups[groupKey];
    else snap.collapsedGroups[groupKey] = true;
    syncJson();
  }

  function nodeIdsInGroupKey(groupKey) {
    return snap.nodes.filter((n) => groupKeyForNode(n.id) === groupKey).map((n) => n.id);
  }

  function nodeIdsInParentGroup(parentName) {
    if (!parentName) return [];
    return snap.nodes
      .filter((n) => getNodeMeta(n.id).parentGroup === parentName)
      .map((n) => n.id)
      .filter((id) => !isLocked(id));
  }

  function startParentGroupDrag(parentName, e) {
    e.stopPropagation();
    if (e.button !== 0) return;
    const ids = nodeIdsInParentGroup(parentName);
    if (!ids.length) return;
    const origins = new Map();
    for (const id of ids) {
      const p = nodePos.get(id);
      if (p) origins.set(id, { x: p.x, y: p.y });
    }
    dragging = { id: ids[0], startX: e.clientX, startY: e.clientY, origins };
  }

  function dragIdsForNode(id) {
    const gk = groupKeyForNode(id);
    if (gk && !isGroupCollapsed(gk)) {
      return nodeIdsInGroupKey(gk).filter((nid) => !isLocked(nid));
    }
    if (isNodeSelected(id) && selectedIds.size > 1) {
      return [...selectedIds].filter((nid) => !isLocked(nid));
    }
    return isLocked(id) ? [] : [id];
  }

  function selectGroupMembers(groupKey) {
    selectedIds.clear();
    for (const nid of nodeIdsInGroupKey(groupKey)) selectedIds.add(nid);
    selected = selectedIds.size ? [...selectedIds][0] : null;
  }

  function alignActiveGroup(mode) {
    const gk = getActiveGroupKey();
    if (!gk) return;
    pushHistory();
    selectGroupMembers(gk);
    alignSelected(mode);
    fillSelection();
  }

  function lockAllInGroup(groupKey) {
    if (!groupKey) return;
    pushHistory();
    ensureNodeMeta();
    for (const n of snap.nodes) {
      if (groupKeyForNode(n.id) === groupKey) {
        snap.nodeMeta[n.id] = { ...getNodeMeta(n.id), locked: true };
      }
    }
    syncJson();
  }

  function collectGroupKeysFromSelection() {
    const keys = new Set();
    const ids = selectedIds.size ? [...selectedIds] : (selected ? [selected] : []);
    for (const id of ids) {
      const gk = groupKeyForNode(id);
      if (gk) keys.add(gk);
    }
    return [...keys];
  }

  function removeSelectedGroupLink() {
    if (!selectedGroupLink || !snap.groupLinks) return;
    pushHistory();
    snap.groupLinks = snap.groupLinks.filter(
      (l) => !(l.from === selectedGroupLink.from && l.to === selectedGroupLink.to),
    );
    selectedGroupLink = null;
    syncJson();
  }

  function applyGroupLinkEdit() {
    if (!selectedGroupLink || !snap.groupLinks) return;
    const fromEl = document.getElementById("selGroupLinkFrom");
    const toEl = document.getElementById("selGroupLinkTo");
    const from = fromEl ? fromEl.value.trim() : "";
    const to = toEl ? toEl.value.trim() : "";
    if (!from || !to) return;
    pushHistory();
    const idx = snap.groupLinks.findIndex(
      (l) => l.from === selectedGroupLink.from && l.to === selectedGroupLink.to,
    );
    if (idx >= 0) {
      snap.groupLinks[idx] = { from, to };
      selectedGroupLink = { from, to };
    }
    syncJson();
  }

  function addGroupLinkFromSelection() {
    const keys = collectGroupKeysFromSelection();
    if (keys.length < 2) {
      alert("Select nodes from at least two groups");
      return;
    }
    pushHistory();
    if (!snap.groupLinks) snap.groupLinks = [];
    const from = keys[0];
    const to = keys[1];
    if (!snap.groupLinks.some((l) => l.from === from && l.to === to)) {
      snap.groupLinks.push({ from, to });
    }
    syncJson();
  }

  function setSingleSelection(id) {
    selectedIds.clear();
    if (id) selectedIds.add(id);
    selected = id;
  }

  function clientToGraph(cx, cy) {
    const v = snap.view || { zoom: 1, panX: 0, panY: 0 };
    const rect = svg.getBoundingClientRect();
    const sx = ((cx - rect.left) / rect.width) * W;
    const sy = ((cy - rect.top) / rect.height) * H;
    return { x: (sx - v.panX) / v.zoom, y: (sy - v.panY) / v.zoom };
  }

  function updateSelectionRect() {
    if (!boxSelect || !selectionRect) return;
    const x = Math.min(boxSelect.x0, boxSelect.x1);
    const y = Math.min(boxSelect.y0, boxSelect.y1);
    const w = Math.abs(boxSelect.x1 - boxSelect.x0);
    const h = Math.abs(boxSelect.y1 - boxSelect.y0);
    selectionRect.setAttribute("x", String(x));
    selectionRect.setAttribute("y", String(y));
    selectionRect.setAttribute("width", String(w));
    selectionRect.setAttribute("height", String(h));
    selectionRect.setAttribute("visibility", w > 2 || h > 2 ? "visible" : "hidden");
  }

  function finishBoxSelect() {
    if (!boxSelect) return;
    const x0 = Math.min(boxSelect.x0, boxSelect.x1);
    const x1 = Math.max(boxSelect.x0, boxSelect.x1);
    const y0 = Math.min(boxSelect.y0, boxSelect.y1);
    const y1 = Math.max(boxSelect.y0, boxSelect.y1);
    if (Math.abs(x1 - x0) > 4 && Math.abs(y1 - y0) > 4) {
      selectedIds.clear();
      for (const n of snap.nodes) {
        const p = nodePos.get(n.id);
        if (p && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) {
          selectedIds.add(n.id);
        }
      }
      selected = selectedIds.size ? [...selectedIds][0] : null;
      fillSelection();
    }
    boxSelect = null;
    updateSelectionRect();
    render();
  }

  function alignSelected(mode) {
    const ids = [...selectedIds];
    if (ids.length < 2) return;
    pushHistory();
    const pts = ids.map((id) => ({ id, p: nodePos.get(id) })).filter((x) => x.p);
    if (pts.length < 2) return;
    const xs = pts.map((x) => x.p.x);
    const ys = pts.map((x) => x.p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    if (mode === "left") pts.forEach((x) => { x.p.x = minX; });
    else if (mode === "right") pts.forEach((x) => { x.p.x = maxX; });
    else if (mode === "center") pts.forEach((x) => { x.p.x = midX; });
    else if (mode === "top") pts.forEach((x) => { x.p.y = minY; });
    else if (mode === "bottom") pts.forEach((x) => { x.p.y = maxY; });
    else if (mode === "middle") pts.forEach((x) => { x.p.y = midY; });
    else if (mode === "distributeH" && pts.length > 2) {
      pts.sort((a, b) => a.p.x - b.p.x);
      const step = (maxX - minX) / (pts.length - 1);
      pts.forEach((x, i) => { x.p.x = minX + step * i; });
    } else if (mode === "distributeV" && pts.length > 2) {
      pts.sort((a, b) => a.p.y - b.p.y);
      const step = (maxY - minY) / (pts.length - 1);
      pts.forEach((x, i) => { x.p.y = minY + step * i; });
    }
    for (const x of pts) nodePos.set(x.id, { x: x.p.x, y: x.p.y });
    syncJson();
  }

  function layoutNodes() {
    const saved = snap.layout || {};
    let usedSaved = false;
    for (const n of snap.nodes) {
      if (saved[n.id]) {
        nodePos.set(n.id, { x: saved[n.id].x, y: saved[n.id].y });
        usedSaved = true;
      }
    }
    if (usedSaved) return;
    const waves = snap.waves.length ? snap.waves : [snap.nodes.map((n) => n.id)];
    const layerH = H / Math.max(waves.length, 1);
    waves.forEach((wave, wi) => {
      const y = 40 + wi * layerH;
      wave.forEach((id, xi) => {
        const count = Math.max(wave.length, 1);
        const x = 60 + (xi + 0.5) * ((W - 120) / count);
        nodePos.set(id, { x, y });
      });
    });
    for (const n of snap.nodes) {
      if (!nodePos.has(n.id)) nodePos.set(n.id, { x: W / 2, y: H - 40 });
    }
  }

  function findCycle(nodes) {
    const ids = new Set(nodes.map((n) => n.id));
    const adj = new Map(nodes.map((n) => [n.id, n.dependsOn.filter((d) => ids.has(d))]));
    const state = new Map();
    let cycle = null;
    function dfs(u, parent) {
      if (cycle) return;
      state.set(u, 1);
      for (const v of adj.get(u) || []) {
        if ((state.get(v) || 0) === 1) { cycle = [v, u]; return; }
        if ((state.get(v) || 0) === 0) dfs(v, u);
      }
      state.set(u, 2);
    }
    for (const id of ids) {
      if ((state.get(id) || 0) === 0) dfs(id, null);
      if (cycle) break;
    }
    return cycle;
  }

  function cloneSnap() {
    return JSON.parse(JSON.stringify(snap));
  }

  function updateUndoFooter() {
    if (!undoFooterEl) return;
    undoFooterEl.textContent =
      "Undo ⌘Z · Redo ⇧⌘Z — undo: " +
      undoStack.length +
      "/" +
      MAX_HISTORY +
      " · redo: " +
      redoStack.length;
    if (canvasFooterEl) {
      canvasFooterEl.classList.toggle("undo-stack-full", undoStack.length >= MAX_HISTORY);
    }
  }

  function pushHistory() {
    undoStack.push(cloneSnap());
    const droppedOldest = undoStack.length > MAX_HISTORY;
    if (droppedOldest) undoStack.shift();
    redoStack.length = 0;
    updateUndoFooter();
    if (droppedOldest && statusEl) {
      statusEl.textContent =
        "Undo stack full — oldest change dropped (max " +
        MAX_HISTORY +
        ") — click to dismiss";
      statusEl.dataset.kind = "warn";
    } else {
      updateGraphStatus();
    }
  }

  function updateGraphStatus() {
    if (!statusEl) return;
    const cycle = findCycle(snap.nodes);
    const dangling = findDanglingGroupKeys();
    if (cycle) {
      statusEl.textContent = "Cycle: " + cycle.join(" → ");
      statusEl.dataset.kind = "error";
    } else if (dangling.length) {
      statusEl.textContent = "Dangling groups: " + dangling.join(", ");
      statusEl.dataset.kind = "error";
    } else {
      const edgeHint = selectedEdge
        ? " · edge " + selectedEdge.from + " → " + selectedEdge.to
        : "";
      statusEl.textContent =
        snap.nodes.length + " nodes · click A then B to add dep" + edgeHint;
      statusEl.dataset.kind = "ok";
    }
  }

  function groupLinksToMermaid() {
    const keys = new Set();
    for (const n of snap.nodes) {
      const gk = groupKeyForNode(n.id);
      if (gk) keys.add(gk);
    }
    for (const l of snap.groupLinks || []) {
      keys.add(l.from);
      keys.add(l.to);
    }
    const sorted = [...keys].sort();
    if (!sorted.length && !(snap.groupLinks || []).length) {
      return "flowchart LR\\n  empty[\\"(no groups)\\"]";
    }
    const idMap = new Map();
    const lines = ["flowchart LR"];
    for (const g of sorted) {
      const mid = g.replace(/[^a-zA-Z0-9_]/g, "_");
      idMap.set(g, mid);
      lines.push("  " + mid + "[\\"" + g.replace(/"/g, "'") + "\\"]");
    }
    for (const link of snap.groupLinks || []) {
      const f = idMap.get(link.from);
      const t = idMap.get(link.to);
      if (f && t) lines.push("  " + f + " --> " + t);
    }
    return lines.join("\\n");
  }

  function updateGroupMermaid() {
    const el = document.getElementById("groupMermaid");
    if (el) el.value = groupLinksToMermaid();
  }

  function parseGroupLinksFromMermaid(text) {
    const midToLabel = new Map();
    const links = [];
    const seen = new Set();
    const nodeLine = /^\\s*([A-Za-z0-9_]+)\\["([^"]+)"\\]\\s*$/;
    const edgeLine = /^\\s*([A-Za-z0-9_]+)\\s*-->\\s*([A-Za-z0-9_]+)\\s*$/;
    for (const line of text.split("\\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("flowchart") || trimmed.startsWith("subgraph") || trimmed === "end") continue;
      const nodeM = trimmed.match(nodeLine);
      if (nodeM) {
        const label = nodeM[2].replace(/'/g, '"');
        if (label !== "(no groups)") midToLabel.set(nodeM[1], label);
        continue;
      }
      const edgeM = trimmed.match(edgeLine);
      if (edgeM) {
        const from = midToLabel.get(edgeM[1]) || edgeM[1].replace(/_/g, "/");
        const to = midToLabel.get(edgeM[2]) || edgeM[2].replace(/_/g, "/");
        const key = from + "\\0" + to;
        if (!seen.has(key) && from !== to) {
          seen.add(key);
          links.push({ from, to });
        }
      }
    }
    return links;
  }

  function importGroupLinksFromMermaid() {
    const el = document.getElementById("groupMermaid");
    if (!el) return;
    const imported = parseGroupLinksFromMermaid(el.value);
    if (!imported.length) {
      alert("No group links parsed from Mermaid");
      return;
    }
    pushHistory();
    if (!snap.groupLinks) snap.groupLinks = [];
    for (const l of imported) {
      if (!snap.groupLinks.some((x) => x.from === l.from && x.to === l.to)) {
        snap.groupLinks.push(l);
      }
    }
    syncJson();
  }

  function isPlaceholderNode(id) {
    const meta = getNodeMeta(id);
    return !!meta.placeholder || id.startsWith("__grp__");
  }

  function findDanglingGroupKeys() {
    const known = new Set();
    for (const n of snap.nodes) {
      const gk = groupKeyForNode(n.id);
      if (gk) known.add(gk);
    }
    const dangling = new Set();
    for (const l of snap.groupLinks || []) {
      if (!known.has(l.from)) dangling.add(l.from);
      if (!known.has(l.to)) dangling.add(l.to);
    }
    return [...dangling];
  }

  function parseGroupKeyForRepair(gk) {
    const slash = gk.indexOf("/");
    if (slash < 0) return { group: gk };
    return { parentGroup: gk.slice(0, slash), group: gk.slice(slash + 1) };
  }

  function repairDanglingGroupLinks(mode) {
    const dangling = findDanglingGroupKeys();
    if (!dangling.length) return;
    pushHistory();
    const danglingSet = new Set(dangling);
    if (mode === "remove-links") {
      snap.groupLinks = (snap.groupLinks || []).filter(
        (l) => !danglingSet.has(l.from) && !danglingSet.has(l.to),
      );
    } else {
      ensureNodeMeta();
      for (const gk of dangling) {
        const id = "__grp__" + gk.replace(/[^a-zA-Z0-9]+/g, "_");
        if (!snap.nodes.some((n) => n.id === id)) {
          snap.nodes.push({ id, providers: "mock", dependsOn: [] });
        }
        const parsed = parseGroupKeyForRepair(gk);
        snap.nodeMeta[id] = parsed.parentGroup
          ? { group: parsed.group, parentGroup: parsed.parentGroup, placeholder: true }
          : { group: parsed.group, placeholder: true };
      }
    }
    syncJson();
  }

  function removeAllPlaceholderNodes() {
    const ids = snap.nodes.filter((n) => isPlaceholderNode(n.id)).map((n) => n.id);
    if (!ids.length) return;
    pushHistory();
    const removeSet = new Set(ids);
    snap.nodes = snap.nodes.filter((n) => !removeSet.has(n.id));
    ensureNodeMeta();
    for (const id of ids) {
      delete snap.nodeMeta[id];
      if (snap.layout) delete snap.layout[id];
    }
    for (const n of snap.nodes) {
      n.dependsOn = n.dependsOn.filter((d) => !removeSet.has(d));
    }
    try {
      snap.waves = recomputeWavesClient(snap.nodes);
    } catch (_) {
      if (snap.waves) {
        snap.waves = snap.waves
          .map((w) => w.filter((id) => !removeSet.has(id)))
          .filter((w) => w.length);
      }
    }
    snap.layout = {};
    nodePos.clear();
    layoutNodes();
    selectedIds = selectedIds.filter((id) => !removeSet.has(id));
    if (selectedIds.length === 0) selectedEdge = null;
    syncJson();
    statusEl.textContent = "Removed " + ids.length + " placeholder(s)";
    statusEl.dataset.kind = "ok";
    updateUndoFooter();
  }

  function syncJson() {
    persistLayout();
    if (!snap.view) snap.view = { zoom: 1, panX: 0, panY: 0 };
    jsonEl.value = JSON.stringify(snap, null, 2);
    updateGroupMermaid();
    updateGraphStatus();
    render();
  }

  function render() {
    layoutNodes();
    applyViewTransform();
    while (viewport.lastChild) viewport.removeChild(viewport.lastChild);

    const ns = "http://www.w3.org/2000/svg";
    for (const g of guideLines) {
      const line = document.createElementNS(ns, "line");
      if (g.vertical) {
        line.setAttribute("x1", String(g.x));
        line.setAttribute("x2", String(g.x));
        line.setAttribute("y1", String(g.y1));
        line.setAttribute("y2", String(g.y2));
      } else {
        line.setAttribute("x1", String(g.x1));
        line.setAttribute("x2", String(g.x2));
        line.setAttribute("y1", String(g.y));
        line.setAttribute("y2", String(g.y));
      }
      line.setAttribute("stroke", "#93c5fd");
      line.setAttribute("stroke-width", "1");
      line.setAttribute("stroke-dasharray", "4 3");
      viewport.appendChild(line);
    }
    const groupBounds = new Map();
    const parentBounds = new Map();
    for (const n of snap.nodes) {
      const meta = getNodeMeta(n.id);
      const gk = groupKeyFromMeta(meta);
      if (!gk) continue;
      const p = nodePos.get(n.id);
      if (!p) continue;
      const b = groupBounds.get(gk) || { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      b.minX = Math.min(b.minX, p.x - NODE_W / 2 - 6);
      b.maxX = Math.max(b.maxX, p.x + NODE_W / 2 + 6);
      b.minY = Math.min(b.minY, p.y - NODE_H / 2 - 6);
      b.maxY = Math.max(b.maxY, p.y + NODE_H / 2 + 6);
      groupBounds.set(gk, b);
    }
    for (const n of snap.nodes) {
      const meta = getNodeMeta(n.id);
      if (!meta.parentGroup || !meta.group) continue;
      const gk = groupKeyFromMeta(meta);
      const b = groupBounds.get(gk);
      if (!b) continue;
      const pb = parentBounds.get(meta.parentGroup) || { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      pb.minX = Math.min(pb.minX, b.minX - 10);
      pb.maxX = Math.max(pb.maxX, b.maxX + 10);
      pb.minY = Math.min(pb.minY, b.minY - 10);
      pb.maxY = Math.max(pb.maxY, b.maxY + 10);
      parentBounds.set(meta.parentGroup, pb);
    }
    for (const [parent, b] of parentBounds.entries()) {
      const outer = document.createElementNS(ns, "rect");
      outer.setAttribute("x", String(b.minX));
      outer.setAttribute("y", String(b.minY));
      outer.setAttribute("width", String(b.maxX - b.minX));
      outer.setAttribute("height", String(b.maxY - b.minY));
      outer.setAttribute("rx", "10");
      outer.setAttribute("fill", "none");
      outer.setAttribute("stroke", "#a1a1aa");
      outer.setAttribute("stroke-width", "2");
      outer.style.cursor = "move";
      outer.dataset.parentGroup = parent;
      outer.addEventListener("mousedown", (e) => startParentGroupDrag(parent, e));
      const pl = document.createElementNS(ns, "text");
      pl.setAttribute("x", String(b.minX + 8));
      pl.setAttribute("y", String(b.minY + 14));
      pl.setAttribute("fill", "#52525b");
      pl.setAttribute("font-size", "11");
      pl.setAttribute("font-weight", "bold");
      pl.textContent = parent;
      pl.style.cursor = "move";
      pl.addEventListener("mousedown", (e) => startParentGroupDrag(parent, e));
      viewport.appendChild(outer);
      viewport.appendChild(pl);
    }
    const groupCenters = new Map();
    for (const [g, b] of groupBounds.entries()) {
      const sampleNode = snap.nodes.find((n) => groupKeyForNode(n.id) === g);
      if (sampleNode && isParentCollapsed(getNodeMeta(sampleNode.id).parentGroup)) continue;
      groupCenters.set(g, { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
      const collapsed = isGroupCollapsed(g);
      const bg = document.createElementNS(ns, "rect");
      bg.setAttribute("x", String(b.minX));
      bg.setAttribute("y", String(b.minY));
      bg.setAttribute("width", String(b.maxX - b.minX));
      bg.setAttribute("height", String(b.maxY - b.minY));
      bg.setAttribute("rx", "8");
      bg.setAttribute("fill", collapsed ? "rgba(228,228,231,0.55)" : "rgba(228,228,231,0.35)");
      bg.setAttribute("stroke", "#d4d4d8");
      bg.setAttribute("stroke-dasharray", collapsed ? "2 2" : "6 4");
      const label = document.createElementNS(ns, "text");
      label.setAttribute("x", String(b.minX + 6));
      label.setAttribute("y", String(b.minY + 12));
      label.setAttribute("fill", "#71717a");
      label.setAttribute("font-size", "10");
      label.style.cursor = "pointer";
      label.textContent = (collapsed ? "▸ " : "▾ ") + g;
      label.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleGroupCollapse(g);
      });
      viewport.appendChild(bg);
      viewport.appendChild(label);
      if (collapsed) {
        const cx = (b.minX + b.maxX) / 2;
        const cy = (b.minY + b.maxY) / 2;
        const pill = document.createElementNS(ns, "g");
        pill.setAttribute("transform", "translate(" + (cx - 36) + "," + (cy - 14) + ")");
        const pr = document.createElementNS(ns, "rect");
        pr.setAttribute("width", "72");
        pr.setAttribute("height", "28");
        pr.setAttribute("rx", "6");
        pr.setAttribute("fill", "#fff");
        pr.setAttribute("stroke", "#a1a1aa");
        const pt = document.createElementNS(ns, "text");
        pt.setAttribute("x", "36");
        pt.setAttribute("y", "18");
        pt.setAttribute("text-anchor", "middle");
        pt.setAttribute("font-size", "10");
        pt.setAttribute("fill", "#52525b");
        const count = snap.nodes.filter((n) => groupKeyForNode(n.id) === g).length;
        pt.textContent = count + " nodes";
        pill.appendChild(pr);
        pill.appendChild(pt);
        pill.style.cursor = "pointer";
        pill.addEventListener("click", (e) => {
          e.stopPropagation();
          toggleGroupCollapse(g);
        });
        viewport.appendChild(pill);
      }
    }
    for (const link of snap.groupLinks || []) {
      const a = groupCenters.get(link.from);
      const b = groupCenters.get(link.to);
      if (!a || !b) continue;
      const isSel =
        selectedGroupLink &&
        selectedGroupLink.from === link.from &&
        selectedGroupLink.to === link.to;
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", String(a.x));
      line.setAttribute("y1", String(a.y));
      line.setAttribute("x2", String(b.x));
      line.setAttribute("y2", String(b.y));
      line.setAttribute("stroke", isSel ? "#5b21b6" : "#7c3aed");
      line.setAttribute("stroke-width", isSel ? "3" : "2");
      line.setAttribute("stroke-dasharray", "8 4");
      line.setAttribute("marker-end", "url(#arrow)");
      line.style.cursor = "pointer";
      line.addEventListener("click", (e) => {
        e.stopPropagation();
        selectedGroupLink = { from: link.from, to: link.to };
        selectedEdge = null;
        selected = null;
        selectedIds.clear();
        linkFrom = null;
        fillSelection();
        render();
      });
      viewport.appendChild(line);
    }

    for (const n of snap.nodes) {
      for (const d of n.dependsOn) {
        if (isNodeHidden(n.id) || isNodeHidden(d)) continue;
        const a = nodePos.get(d);
        const b = nodePos.get(n.id);
        if (!a || !b) continue;
        const line = document.createElementNS(ns, "line");
        line.setAttribute("x1", String(a.x));
        line.setAttribute("y1", String(a.y + NODE_H / 2));
        line.setAttribute("x2", String(b.x));
        line.setAttribute("y2", String(b.y - NODE_H / 2));
        const isSel = selectedEdge && selectedEdge.from === d && selectedEdge.to === n.id;
        line.setAttribute("stroke", isSel ? "#2563eb" : "#a1a1aa");
        line.setAttribute("stroke-width", isSel ? "2.5" : "1.5");
        line.setAttribute("marker-end", "url(#arrow)");
        line.style.cursor = "pointer";
        line.dataset.from = d;
        line.dataset.to = n.id;
        line.addEventListener("click", (e) => {
          e.stopPropagation();
          selectedEdge = { from: d, to: n.id };
          selectedGroupLink = null;
          selected = null;
          selectedIds.clear();
          linkFrom = null;
          fillSelection();
          render();
        });
        viewport.appendChild(line);
      }
    }

    for (const n of snap.nodes) {
      if (isNodeHidden(n.id)) continue;
      const p = nodePos.get(n.id);
      if (!p) continue;
      const g = document.createElementNS(ns, "g");
      g.setAttribute("transform", "translate(" + (p.x - NODE_W / 2) + "," + (p.y - NODE_H / 2) + ")");
      g.style.cursor = "pointer";
      g.dataset.nodeId = n.id;

      const rect = document.createElementNS(ns, "rect");
      rect.setAttribute("width", String(NODE_W));
      rect.setAttribute("height", String(NODE_H));
      rect.setAttribute("rx", "6");
      const sel = isNodeSelected(n.id);
      const ph = isPlaceholderNode(n.id);
      if (ph) {
        rect.setAttribute("fill", sel ? "#ca8a04" : "#fef9c3");
        rect.setAttribute("stroke", "#ca8a04");
        rect.setAttribute("stroke-dasharray", "5 3");
      } else {
        rect.setAttribute("fill", sel ? "#18181b" : "#fff");
        rect.setAttribute("stroke", sel ? "#18181b" : "#d4d4d8");
        if (isLocked(n.id)) rect.setAttribute("stroke-dasharray", "4 2");
      }
      if (n.id === linkFrom) rect.setAttribute("stroke", "#2563eb");
      if (sel && selectedIds.size > 1) rect.setAttribute("stroke", "#2563eb");

      const text = document.createElementNS(ns, "text");
      text.setAttribute("x", String(NODE_W / 2));
      text.setAttribute("y", String(NODE_H / 2 + 4));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("fill", sel && !ph ? "#fff" : ph ? "#92400e" : "#18181b");
      text.setAttribute("font-size", "11");
      text.textContent = n.id.length > 10 ? n.id.slice(0, 9) + "…" : n.id;

      g.appendChild(rect);
      g.appendChild(text);
      g.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        if (e.button !== 0) return;
        const origins = new Map();
        const dragIds = dragIdsForNode(n.id);
        if (!dragIds.length) return;
        for (const id of dragIds) {
          const p = nodePos.get(id);
          if (p) origins.set(id, { x: p.x, y: p.y });
        }
        dragging = { id: n.id, startX: e.clientX, startY: e.clientY, origins };
      });
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        if (suppressClick) { suppressClick = false; return; }
        onNodeClick(n.id, e.shiftKey);
      });
      viewport.appendChild(g);
    }
  }

  function snapDragPosition(id, x, y, dragIds) {
    guideLines = [];
    let sx = x;
    let sy = y;
    for (const n of snap.nodes) {
      if (dragIds.includes(n.id)) continue;
      const p = nodePos.get(n.id);
      if (!p) continue;
      if (Math.abs(p.x - x) <= SNAP) {
        sx = p.x;
        guideLines.push({ vertical: true, x: p.x, y1: 0, y2: H });
      }
      if (Math.abs(p.y - y) <= SNAP) {
        sy = p.y;
        guideLines.push({ vertical: false, y: p.y, x1: 0, x2: W });
      }
    }
    return { x: sx, y: sy };
  }

  function onNodeClick(id, shiftKey) {
    selectedEdge = null;
    selectedGroupLink = null;
    if (shiftKey) {
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
      selected = id;
      fillSelection();
      render();
      return;
    }
    setSingleSelection(id);
    if (linkFrom && linkFrom !== id) {
      const target = snap.nodes.find((n) => n.id === id);
      if (target && !target.dependsOn.includes(linkFrom)) {
        pushHistory();
        target.dependsOn.push(linkFrom);
      }
      linkFrom = null;
      fillSelection();
      syncJson();
      return;
    }
    linkFrom = id;
    fillSelection();
    render();
  }

  function removeSelectedEdge() {
    if (!selectedEdge) return;
    pushHistory();
    const target = snap.nodes.find((n) => n.id === selectedEdge.to);
    if (target) {
      target.dependsOn = target.dependsOn.filter((d) => d !== selectedEdge.from);
    }
    selectedEdge = null;
    try {
      snap.waves = recomputeWavesClient(snap.nodes);
    } catch (_) { /* cycle */ }
    syncJson();
  }

  function fillSelection() {
    const edgeEl = document.getElementById("selEdge");
    const glFrom = document.getElementById("selGroupLinkFrom");
    const glTo = document.getElementById("selGroupLinkTo");
    if (selectedGroupLink) {
      selId.value = "";
      selProv.value = "";
      selDeps.value = "";
      if (edgeEl) edgeEl.value = "";
      if (glFrom) glFrom.value = selectedGroupLink.from;
      if (glTo) glTo.value = selectedGroupLink.to;
      return;
    }
    if (glFrom) glFrom.value = "";
    if (glTo) glTo.value = "";
    if (selectedEdge) {
      selId.value = "";
      selProv.value = "";
      selDeps.value = "";
      if (edgeEl) edgeEl.value = selectedEdge.from + " → " + selectedEdge.to;
      return;
    }
    if (edgeEl) edgeEl.value = "";
    const n = snap.nodes.find((x) => x.id === selected);
    if (!n) return;
    selId.value = n.id;
    selProv.value = fmtProviders(n.providers);
    selDeps.value = n.dependsOn.join(", ");
    const selGroup = document.getElementById("selGroup");
    const selParentGroup = document.getElementById("selParentGroup");
    const selLocked = document.getElementById("selLocked");
    const meta = getNodeMeta(n.id);
    if (selGroup) selGroup.value = meta.group || "";
    if (selParentGroup) selParentGroup.value = meta.parentGroup || "";
    if (selLocked) selLocked.checked = !!meta.locked;
  }

  function applySelection() {
    if (selectedEdge || selectedGroupLink) return;
    pushHistory();
    const n = snap.nodes.find((x) => x.id === selected);
    if (!n) return;
    const newId = selId.value.trim();
    if (newId && newId !== n.id) {
      n.id = newId;
      selected = newId;
    }
    n.providers = parseProviders(selProv.value);
    n.dependsOn = selDeps.value.split(",").map((s) => s.trim()).filter(Boolean);
    ensureNodeMeta();
    const selGroup = document.getElementById("selGroup");
    const selParentGroup = document.getElementById("selParentGroup");
    const selLocked = document.getElementById("selLocked");
    const groupVal = selGroup ? selGroup.value.trim() : "";
    const parentVal = selParentGroup ? selParentGroup.value.trim() : "";
    const lockedVal = selLocked ? selLocked.checked : false;
    const metaIds = selectedIds.size ? [...selectedIds] : (selected ? [selected] : []);
    for (const id of metaIds) {
      const prev = snap.nodeMeta[id] || {};
      const next = { ...prev };
      if (groupVal) next.group = groupVal;
      else delete next.group;
      if (parentVal) next.parentGroup = parentVal;
      else delete next.parentGroup;
      next.locked = lockedVal;
      if (!next.group && !next.locked && !next.parentGroup) delete snap.nodeMeta[id];
      else snap.nodeMeta[id] = next;
    }
    try {
      snap.waves = recomputeWavesClient(snap.nodes);
    } catch (_) { /* cycle */ }
    syncJson();
  }

  function recomputeWavesClient(nodes) {
    const pipeline = {};
    for (const n of nodes) pipeline[n.id] = [n.providers, ...n.dependsOn];
    const stages = [];
    const visited = new Set();
    const all = Object.keys(pipeline);
    while (visited.size < all.length) {
      const stage = [];
      for (const step of all) {
        if (visited.has(step)) continue;
        if (pipeline[step].slice(1).every((d) => visited.has(d))) stage.push(step);
      }
      if (!stage.length) throw new Error("cycle");
      for (const s of stage) visited.add(s);
      stages.push(stage);
    }
    return stages;
  }

  window.addEventListener("mousemove", (e) => {
    if (dragging) {
      const v = snap.view || { zoom: 1, panX: 0, panY: 0 };
      const dx = (e.clientX - dragging.startX) / v.zoom;
      const dy = (e.clientY - dragging.startY) / v.zoom;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) suppressClick = true;
      const dragIds = [...dragging.origins.keys()];
      const anchor = dragging.origins.get(dragging.id);
      if (anchor) {
        const snapped = snapDragPosition(dragging.id, anchor.x + dx, anchor.y + dy, dragIds);
        const sdx = snapped.x - anchor.x;
        const sdy = snapped.y - anchor.y;
        for (const [id, orig] of dragging.origins.entries()) {
          nodePos.set(id, { x: orig.x + sdx, y: orig.y + sdy });
        }
      }
      render();
      return;
    }
    if (boxSelect) {
      const p = clientToGraph(e.clientX, e.clientY);
      boxSelect.x1 = p.x;
      boxSelect.y1 = p.y;
      updateSelectionRect();
      return;
    }
    guideLines = [];
    if (panning && panStart) {
      snap.view.panX = panStart.panX + (e.clientX - panStart.x);
      snap.view.panY = panStart.panY + (e.clientY - panStart.y);
      applyViewTransform();
    }
  });
  window.addEventListener("mouseup", () => {
    if (dragging) { dragging = null; syncJson(); }
    if (boxSelect) finishBoxSelect();
    panning = false;
    panStart = null;
  });
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (!snap.view) snap.view = { zoom: 1, panX: 0, panY: 0 };
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    snap.view.zoom = Math.min(2.5, Math.max(0.4, snap.view.zoom * factor));
    applyViewTransform();
    syncJson();
  }, { passive: false });
  svg.addEventListener("mousedown", (e) => {
    if (e.target === svg || e.target === selectionRect) {
      if (e.shiftKey) {
        if (!snap.view) snap.view = { zoom: 1, panX: 0, panY: 0 };
        panning = true;
        panStart = { x: e.clientX, y: e.clientY, panX: snap.view.panX, panY: snap.view.panY };
      } else {
        const p = clientToGraph(e.clientX, e.clientY);
        boxSelect = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        updateSelectionRect();
      }
    }
  });

  window.__agentGraphCanvasInit = function (initial) {
    snap = initial;
    if (!snap.layout) snap.layout = {};
    if (!snap.nodeMeta) snap.nodeMeta = {};
    if (!snap.collapsedGroups) snap.collapsedGroups = {};
    if (!snap.collapsedParents) snap.collapsedParents = {};
    if (!snap.groupLinks) snap.groupLinks = [];
    if (!snap.view) snap.view = { zoom: 1, panX: 0, panY: 0 };
    try {
      const cached = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      if (cached.layout) snap.layout = { ...snap.layout, ...cached.layout };
      if (cached.view) snap.view = { ...snap.view, ...cached.view };
    } catch (_) { /* ignore */ }
    syncJson();
    updateUndoFooter();
  };

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(cloneSnap());
    snap = undoStack.pop();
    selected = null;
    selectedIds.clear();
    selectedEdge = null;
    selectedGroupLink = null;
    linkFrom = null;
    syncJson();
    updateUndoFooter();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(cloneSnap());
    snap = redoStack.pop();
    selected = null;
    selectedIds.clear();
    selectedEdge = null;
    selectedGroupLink = null;
    linkFrom = null;
    syncJson();
    updateUndoFooter();
  }

  if (statusEl) {
    statusEl.addEventListener("click", () => {
      if (statusEl.dataset.kind === "warn") updateGraphStatus();
    });
  }
  document.getElementById("applySel").addEventListener("click", applySelection);
  document.getElementById("removeEdge").addEventListener("click", removeSelectedEdge);
  document.getElementById("undo").addEventListener("click", undo);
  document.getElementById("redo").addEventListener("click", redo);
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
      e.preventDefault();
      redo();
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      if (selectedGroupLink) {
        e.preventDefault();
        removeSelectedGroupLink();
      } else if (selectedEdge) {
        e.preventDefault();
        removeSelectedEdge();
      }
    }
  });
  document.getElementById("addNode").addEventListener("click", () => {
    pushHistory();
    const id = "step_" + snap.nodes.length;
    snap.nodes.push({ id, providers: "mock", dependsOn: [] });
    setSingleSelection(id);
    syncJson();
  });
  document.getElementById("recomputeWaves").addEventListener("click", () => {
    pushHistory();
    try {
      snap.waves = recomputeWavesClient(snap.nodes);
      syncJson();
    } catch (e) {
      alert(e.message || String(e));
    }
  });
  document.getElementById("copyJson").addEventListener("click", async () => {
    syncJson();
    await navigator.clipboard.writeText(jsonEl.value);
  });
  document.getElementById("loadJson").addEventListener("click", () => {
    try {
      pushHistory();
      snap = JSON.parse(jsonEl.value);
      if (!Array.isArray(snap.nodes)) throw new Error("nodes required");
      syncJson();
    } catch (e) {
      alert(e.message || String(e));
    }
  });
  document.getElementById("autoLayout").addEventListener("click", () => {
    pushHistory();
    snap.layout = {};
    nodePos.clear();
    layoutNodes();
    syncJson();
  });
  document.getElementById("alignLeft").addEventListener("click", () => alignSelected("left"));
  document.getElementById("alignCenter").addEventListener("click", () => alignSelected("center"));
  document.getElementById("alignRight").addEventListener("click", () => alignSelected("right"));
  document.getElementById("alignTop").addEventListener("click", () => alignSelected("top"));
  document.getElementById("alignMiddle").addEventListener("click", () => alignSelected("middle"));
  document.getElementById("alignBottom").addEventListener("click", () => alignSelected("bottom"));
  document.getElementById("distributeH").addEventListener("click", () => alignSelected("distributeH"));
  document.getElementById("distributeV").addEventListener("click", () => alignSelected("distributeV"));
  document.getElementById("toggleGroupCollapse").addEventListener("click", () => {
    toggleGroupCollapse(getActiveGroupKey());
  });
  document.getElementById("lockGroup").addEventListener("click", () => {
    lockAllInGroup(getActiveGroupKey());
  });
  document.getElementById("addGroupLink").addEventListener("click", addGroupLinkFromSelection);
  document.getElementById("removeGroupLink").addEventListener("click", removeSelectedGroupLink);
  document.getElementById("applyGroupLink").addEventListener("click", applyGroupLinkEdit);
  document.getElementById("toggleParentCollapse").addEventListener("click", () => {
    toggleParentCollapse(getActiveParentGroup());
  });
  document.getElementById("alignGroupLeft").addEventListener("click", () => alignActiveGroup("left"));
  document.getElementById("alignGroupCenter").addEventListener("click", () => alignActiveGroup("center"));
  document.getElementById("alignGroupRight").addEventListener("click", () => alignActiveGroup("right"));
  document.getElementById("alignGroupTop").addEventListener("click", () => alignActiveGroup("top"));
  document.getElementById("alignGroupMiddle").addEventListener("click", () => alignActiveGroup("middle"));
  document.getElementById("alignGroupBottom").addEventListener("click", () => alignActiveGroup("bottom"));
  document.getElementById("fromGroupMermaid").addEventListener("click", importGroupLinksFromMermaid);
  document.getElementById("fixDanglingRemove").addEventListener("click", () => {
    repairDanglingGroupLinks("remove-links");
  });
  document.getElementById("fixDanglingPlaceholder").addEventListener("click", () => {
    repairDanglingGroupLinks("placeholder-nodes");
  });
  document.getElementById("removePlaceholders").addEventListener("click", removeAllPlaceholderNodes);
  document.getElementById("copyGroupMermaid").addEventListener("click", async () => {
    updateGroupMermaid();
    const text = groupLinksToMermaid();
    try {
      await navigator.clipboard.writeText(text);
      statusEl.textContent = "Group Mermaid copied";
      statusEl.dataset.kind = "ok";
    } catch (_) {
      const el = document.getElementById("groupMermaid");
      if (el) { el.select(); document.execCommand("copy"); }
    }
  });
  document.getElementById("exportPng").addEventListener("click", () => {
    syncJson();
    const svgEl = document.getElementById("dagSvg");
    const clone = svgEl.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const svgData = new XMLSerializer().serializeToString(clone);
    const canvas = document.createElement("canvas");
    canvas.width = 1440;
    canvas.height = 840;
    const ctx = canvas.getContext("2d");
    const img = new Image();
    const blob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      ctx.fillStyle = "#fafafa";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((pngBlob) => {
        if (!pngBlob) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(pngBlob);
        a.download = "agent-graph.png";
        a.click();
        URL.revokeObjectURL(a.href);
      }, "image/png");
    };
    img.src = url;
  });
})();
`;
