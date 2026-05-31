/**
 * C2 — Full pipeline.config.json editor (providers, retry, pipeline DAG).
 */

import { agentGraphFromConfig, serializeAgentGraph } from "../orchestration/agent-graph-io.js";
import type { PipelineConfig } from "../core/config.js";

export type PipelineConfigEditorOptions = {
  saveUrl: string;
  configPathLabel: string;
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const CLIENT_SCRIPT = `
(function () {
  let baseConfig = {};
  const statusEl = document.getElementById("status");
  const providerList = document.getElementById("providerList");
  const nodeTbody = document.querySelector("#nodes tbody");

  function setStatus(kind, text) {
    statusEl.dataset.kind = kind;
    statusEl.textContent = text;
  }

  function parseProviders(raw) {
    const t = String(raw ?? "").trim();
    if (!t) return "mock";
    if (t.includes("|")) return t.split("|").map((x) => x.trim()).filter(Boolean);
    return t;
  }

  function fmtProviders(p) {
    return Array.isArray(p) ? p.join("|") : String(p ?? "");
  }

  function pipelineFromNodes(nodes) {
    const pipeline = {};
    for (const n of nodes) {
      const p = n.providers;
      pipeline[n.id] = Array.isArray(p) ? [p, ...n.dependsOn] : [p, ...n.dependsOn];
    }
    return pipeline;
  }

  function readNodes() {
    const nodes = [];
    for (const tr of nodeTbody.querySelectorAll("tr")) {
      const id = tr.querySelector('[data-f="id"]').value.trim();
      if (!id) continue;
      const prov = parseProviders(tr.querySelector('[data-f="providers"]').value);
      const depRaw = tr.querySelector('[data-f="dependsOn"]').value;
      const dependsOn = depRaw.split(",").map((s) => s.trim()).filter(Boolean);
      nodes.push({ id, providers: prov, dependsOn });
    }
    return nodes;
  }

  function readProviders() {
    const providers = {};
    for (const row of providerList.querySelectorAll(".prov-row")) {
      const name = row.querySelector('[data-f="name"]').value.trim();
      if (!name) continue;
      const type = row.querySelector('[data-f="type"]').value;
      const entry = { type };
      const cmd = row.querySelector('[data-f="command"]').value.trim();
      const argsRaw = row.querySelector('[data-f="args"]').value.trim();
      const mode = row.querySelector('[data-f="mode"]').value.trim();
      const timeout = row.querySelector('[data-f="timeoutMs"]').value.trim();
      const model = row.querySelector('[data-f="model"]').value.trim();
      if (cmd) entry.command = cmd;
      if (argsRaw) entry.args = argsRaw.split(",").map((s) => s.trim()).filter(Boolean);
      if (mode) entry.mode = mode;
      if (timeout) entry.timeoutMs = Number(timeout);
      if (model) entry.model = model;
      providers[name] = entry;
    }
    return providers;
  }

  function collectConfig() {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.providers = readProviders();
    cfg.pipeline = pipelineFromNodes(readNodes());
    cfg.retry = {
      maxRounds: Number(document.getElementById("maxRounds").value) || 1,
      reviewStep: document.getElementById("reviewStep").value.trim() || undefined,
    };
    if (!cfg.retry.reviewStep) delete cfg.retry.reviewStep;
    if (!cfg.routing) cfg.routing = [];

    const orchMode = document.getElementById("orchMode").value;
    if (orchMode) {
      cfg.orchestration = cfg.orchestration || {};
      cfg.orchestration.mode = orchMode;
    }
    const costBudget = document.getElementById("costBudgetUSD").value.trim();
    const controlPlane = document.getElementById("controlPlane").value;
    const raceFinalize = document.getElementById("raceFinalize").value;
    const otelExport = document.getElementById("otelExport").checked;
    const govEnabled = document.getElementById("govEnabled").checked;
    cfg.runtime = cfg.runtime || {};
    if (costBudget) cfg.runtime.costBudgetUSD = Number(costBudget);
    else delete cfg.runtime.costBudgetUSD;
    if (controlPlane) cfg.runtime.controlPlane = controlPlane;
    else delete cfg.runtime.controlPlane;
    if (raceFinalize) cfg.runtime.raceFinalize = raceFinalize;
    else delete cfg.runtime.raceFinalize;
    if (otelExport) cfg.runtime.otelExport = true;
    else delete cfg.runtime.otelExport;
    if (govEnabled) {
      cfg.runtime.governance = { ...(cfg.runtime.governance || {}), enabled: true };
    } else if (cfg.runtime.governance) {
      delete cfg.runtime.governance.enabled;
      if (!Object.keys(cfg.runtime.governance).length) delete cfg.runtime.governance;
    }
    if (!Object.keys(cfg.runtime).length) delete cfg.runtime;

    return cfg;
  }

  function syncPreview() {
    document.getElementById("jsonPreview").value = JSON.stringify(collectConfig(), null, 2);
  }

  function mkLabel(text, field, input) {
    const lab = document.createElement("label");
    lab.textContent = text + " ";
    input.dataset.f = field;
    lab.appendChild(input);
    return lab;
  }

  function addProviderRow(name, pc) {
    const div = document.createElement("div");
    div.className = "prov-row";
    const nameInp = document.createElement("input");
    nameInp.type = "text";
    const typeSel = document.createElement("select");
    for (const t of ["mock", "cli", "openai"]) {
      const o = document.createElement("option");
      o.value = t;
      o.textContent = t;
      typeSel.appendChild(o);
    }
    const cmdInp = document.createElement("input");
    cmdInp.type = "text";
    const argsInp = document.createElement("input");
    argsInp.type = "text";
    const modeInp = document.createElement("input");
    modeInp.type = "text";
    const timeoutInp = document.createElement("input");
    timeoutInp.type = "text";
    const modelInp = document.createElement("input");
    modelInp.type = "text";
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "Remove";
    rm.addEventListener("click", () => { div.remove(); syncPreview(); });

    div.append(
      mkLabel("Name", "name", nameInp),
      mkLabel("Type", "type", typeSel),
      mkLabel("Command", "command", cmdInp),
      mkLabel("Args", "args", argsInp),
      mkLabel("Mode", "mode", modeInp),
      mkLabel("Timeout", "timeoutMs", timeoutInp),
      mkLabel("Model", "model", modelInp),
      rm,
    );

    nameInp.value = name || "";
    typeSel.value = pc?.type || "mock";
    cmdInp.value = pc?.command || "";
    argsInp.value = Array.isArray(pc?.args) ? pc.args.join(", ") : "";
    modeInp.value = pc?.mode || "";
    timeoutInp.value = pc?.timeoutMs != null ? String(pc.timeoutMs) : "";
    modelInp.value = pc?.model || "";
    for (const inp of div.querySelectorAll("input,select")) inp.addEventListener("change", syncPreview);
    providerList.appendChild(div);
  }

  function addNodeRow(n) {
    const tr = document.createElement("tr");
    const mk = (field) => {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.dataset.f = field;
      return inp;
    };
    const idInp = mk("id");
    const provInp = mk("providers");
    const depInp = mk("dependsOn");
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "×";
    rm.addEventListener("click", () => { tr.remove(); syncPreview(); });
    for (const cell of [idInp, provInp, depInp]) {
      const td = document.createElement("td");
      td.appendChild(cell);
      tr.appendChild(td);
      cell.addEventListener("change", syncPreview);
    }
    const tdAct = document.createElement("td");
    tdAct.appendChild(rm);
    tr.appendChild(tdAct);
    idInp.value = n?.id || "";
    provInp.value = fmtProviders(n?.providers);
    depInp.value = (n?.dependsOn || []).join(", ");
    nodeTbody.appendChild(tr);
  }

  window.__lpConfigEditorInit = function (cfg, snap) {
    baseConfig = cfg;
    providerList.replaceChildren();
    nodeTbody.replaceChildren();
    for (const [name, pc] of Object.entries(cfg.providers || {})) addProviderRow(name, pc);
    for (const n of snap.nodes || []) addNodeRow(n);
    document.getElementById("maxRounds").value = String(cfg.retry?.maxRounds ?? 3);
    document.getElementById("reviewStep").value = cfg.retry?.reviewStep || "review";
    document.getElementById("orchMode").value = cfg.orchestration?.mode || "dag";
    document.getElementById("costBudgetUSD").value =
      cfg.runtime?.costBudgetUSD != null ? String(cfg.runtime.costBudgetUSD) : "";
    document.getElementById("controlPlane").value = cfg.runtime?.controlPlane || "";
    document.getElementById("raceFinalize").value = cfg.runtime?.raceFinalize || "defer";
    document.getElementById("otelExport").checked = !!cfg.runtime?.otelExport;
    document.getElementById("govEnabled").checked = !!cfg.runtime?.governance?.enabled;
    for (const id of ["orchMode", "costBudgetUSD", "controlPlane", "raceFinalize", "otelExport", "govEnabled"]) {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", syncPreview);
    }
    syncPreview();
  };

  document.getElementById("addProvider").addEventListener("click", () => {
    addProviderRow("provider_" + providerList.children.length, { type: "mock" });
    syncPreview();
  });
  document.getElementById("addNode").addEventListener("click", () => {
    addNodeRow({ id: "step_" + nodeTbody.children.length, providers: "mock", dependsOn: [] });
    syncPreview();
  });

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.panel).classList.add("active");
    });
  });

  document.getElementById("saveToConfig").addEventListener("click", async () => {
    const saveBtn = document.getElementById("saveToConfig");
    saveBtn.disabled = true;
    setStatus("ok", "Saving…");
    try {
      const config = collectConfig();
      const res = await fetch(window.__lpSaveUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setStatus("error", data.error || ("HTTP " + res.status));
        return;
      }
      baseConfig = config;
      setStatus("ok", "Saved to " + (data.configPath || "config"));
    } catch (e) {
      setStatus("error", e.message || String(e));
    } finally {
      saveBtn.disabled = false;
    }
  });
})();
`;

export function pipelineConfigToEditorHtml(
  config: PipelineConfig,
  title: string,
  options: PipelineConfigEditorOptions,
): string {
  const snap = serializeAgentGraph(agentGraphFromConfig(config));
  const initialConfig = JSON.stringify(config).replace(/</g, "\\u003c");
  const initialSnap = JSON.stringify(snap).replace(/</g, "\\u003c");
  const saveUrl = JSON.stringify(options.saveUrl);
  const safeTitle = escapeHtml(title);
  const configLabel = escapeHtml(options.configPathLabel);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${safeTitle}</title>
  <style>
    :root { font-family: system-ui, sans-serif; color: #18181b; }
    body { margin: 0; }
    header { padding: 0.75rem 1rem; border-bottom: 1px solid #e4e4e7; background: #fafafa; }
    .tabs { display: flex; gap: 0.25rem; padding: 0.5rem 1rem; border-bottom: 1px solid #e4e4e7; }
    .tab { padding: 0.4rem 0.9rem; border: 1px solid #d4d4d8; border-radius: 6px; background: #fff; cursor: pointer; }
    .tab.active { background: #18181b; color: #fff; border-color: #18181b; }
    .panel { display: none; padding: 1rem; max-width: 1100px; }
    .panel.active { display: block; }
    .prov-row { display: grid; grid-template-columns: repeat(auto-fill,minmax(140px,1fr)); gap: 0.5rem; padding: 0.75rem; border: 1px solid #e4e4e7; border-radius: 8px; margin-bottom: 0.5rem; }
    .prov-row label { font-size: 0.75rem; display: flex; flex-direction: column; gap: 0.2rem; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #e4e4e7; padding: 0.35rem; }
    input, select { width: 100%; box-sizing: border-box; }
    button { cursor: pointer; padding: 0.4rem 0.75rem; border: 1px solid #d4d4d8; border-radius: 6px; background: #fff; }
    button.primary { background: #18181b; color: #fff; }
    #status[data-kind="error"] { color: #b91c1c; }
    #status[data-kind="ok"] { color: #15803d; }
    #jsonPreview { width: 100%; min-height: 12rem; font-family: ui-monospace, monospace; font-size: 0.8rem; }
    .hint { font-size: 0.85rem; color: #71717a; }
  </style>
</head>
<body>
  <header>
    <strong>${safeTitle}</strong>
    <span class="hint"> — ${configLabel}</span>
    <div id="status" data-kind="ok">Ready</div>
    <button type="button" id="saveToConfig" class="primary" style="margin-top:0.5rem">Save to config</button>
  </header>
  <nav class="tabs">
    <button type="button" class="tab active" data-panel="panelProviders">Providers</button>
    <button type="button" class="tab" data-panel="panelPipeline">Pipeline DAG</button>
    <button type="button" class="tab" data-panel="panelRetry">Retry</button>
    <button type="button" class="tab" data-panel="panelAdvanced">Runtime</button>
    <button type="button" class="tab" data-panel="panelJson">JSON preview</button>
  </nav>
  <section id="panelProviders" class="panel active">
    <button type="button" id="addProvider">Add provider</button>
    <div id="providerList"></div>
  </section>
  <section id="panelPipeline" class="panel">
    <button type="button" id="addNode">Add step</button>
    <table id="nodes"><thead><tr><th>step id</th><th>provider(s)</th><th>dependsOn</th><th></th></tr></thead><tbody></tbody></table>
    <p class="hint">Multi-provider race: use prov1|prov2 in provider column. Dependencies: comma-separated step ids.</p>
  </section>
  <section id="panelRetry" class="panel">
    <label>maxRounds <input id="maxRounds" type="number" min="1" /></label>
    <label>reviewStep <input id="reviewStep" type="text" placeholder="review" /></label>
  </section>
  <section id="panelAdvanced" class="panel">
    <p class="hint">Orchestration / runtime (A2A and Dream stay in JSON — see docs/advanced)</p>
    <label>orchestration.mode
      <select id="orchMode">
        <option value="dag">dag</option>
        <option value="llm-driven">llm-driven</option>
        <option value="workflow">workflow</option>
      </select>
    </label>
    <label>runtime.costBudgetUSD <input id="costBudgetUSD" type="text" placeholder="optional" /></label>
    <label>runtime.controlPlane
      <select id="controlPlane">
        <option value="">(default)</option>
        <option value="memory">memory</option>
        <option value="file">file</option>
      </select>
    </label>
    <label>runtime.raceFinalize
      <select id="raceFinalize">
        <option value="defer">defer (manual llm_race_apply)</option>
        <option value="auto-pick">auto-pick</option>
      </select>
    </label>
    <label><input id="otelExport" type="checkbox" /> runtime.otelExport</label>
    <label><input id="govEnabled" type="checkbox" /> runtime.governance.enabled</label>
  </section>
  <section id="panelJson" class="panel">
    <textarea id="jsonPreview" readonly></textarea>
  </section>
  <script>window.__lpSaveUrl = ${saveUrl};</script>
  <script>${CLIENT_SCRIPT}</script>
  <script>window.__lpConfigEditorInit(${initialConfig}, ${initialSnap});</script>
</body>
</html>`;
}
