/**
 * Minimal local observability dashboard (traces + experiments).
 * Renders via DOM APIs only (no innerHTML).
 */

export function observabilityUiHtml(apiBase: string): string {
  const base = apiBase.replace(/\/$/, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>runoff observability</title>
  <style>
    :root { font-family: system-ui, sans-serif; color: #e8e8e8; background: #12141a; }
    body { margin: 0; padding: 1rem 1.25rem; }
    h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 1rem; }
    nav { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
    nav button { background: #2a2f3a; color: #e8e8e8; border: 1px solid #3d4555; padding: 0.4rem 0.75rem; border-radius: 6px; cursor: pointer; }
    nav button.active { background: #3b6eea; border-color: #3b6eea; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    th, td { text-align: left; padding: 0.45rem 0.5rem; border-bottom: 1px solid #2a2f3a; }
    th { color: #9aa3b5; font-weight: 500; }
    tbody tr:hover td { background: #1a1e28; cursor: pointer; }
    pre { background: #1a1e28; padding: 0.75rem; border-radius: 8px; overflow: auto; font-size: 0.8rem; max-height: 70vh; white-space: pre-wrap; }
    .approved { color: #5dd39e; }
    .bad { color: #f07178; }
    .muted { color: #9aa3b5; font-size: 0.8rem; }
    #detail-panel { margin-top: 1rem; }
    .resume-panel { background: #1a1e28; border: 1px solid #2a2f3a; border-radius: 8px; padding: 0.75rem 1rem; margin: 0.75rem 0; }
    .resume-panel h3 { margin: 0 0 0.5rem; font-size: 0.95rem; font-weight: 600; }
    .resume-summary { display: flex; gap: 1rem; flex-wrap: wrap; font-size: 0.85rem; margin-bottom: 0.5rem; }
    .resume-rerun { color: #f0c674; }
    .resume-skipped { color: #9aa3b5; }
    .resume-rerun-list { margin: 0.5rem 0 0; padding-left: 1.25rem; font-size: 0.85rem; }
    .resume-rerun-list li { margin: 0.25rem 0; }
    .resume-skipped-drawer { margin-top: 0.5rem; }
    .resume-skipped-drawer summary { cursor: pointer; color: #9aa3b5; font-size: 0.85rem; }
    .resume-skipped-list { margin: 0.35rem 0 0; padding-left: 1.25rem; font-size: 0.8rem; color: #9aa3b5; }
  </style>
</head>
<body>
  <h1>runoff observability</h1>
  <p class="muted" id="api-label"></p>
  <nav>
    <button type="button" id="tab-traces" class="active">Traces</button>
    <button type="button" id="tab-experiments">Experiments</button>
  </nav>
  <div id="list"></div>
  <div id="detail-panel" hidden>
    <h2 id="detail-title" style="font-size:1rem;margin:0.5rem 0"></h2>
    <div id="detail-resume"></div>
    <pre id="detail-body"></pre>
  </div>
  <script>
    const API = ${JSON.stringify(base)};
    document.getElementById("api-label").textContent = "API " + API;
    let view = "traces";

    async function fetchJson(path) {
      const r = await fetch(API + path);
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    }

    function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

    function mkTable(headers) {
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const hr = document.createElement("tr");
      headers.forEach(h => {
        const th = document.createElement("th");
        th.textContent = h;
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      table.appendChild(tbody);
      return { table, tbody };
    }

    function showDetail(title, obj) {
      document.getElementById("detail-panel").hidden = false;
      document.getElementById("detail-title").textContent = title;
      renderResumePlannerPanel(document.getElementById("detail-resume"), obj);
      document.getElementById("detail-body").textContent = JSON.stringify(obj, null, 2);
    }

    function renderResumePlannerPanel(container, payload) {
      clear(container);
      const trace = payload.trace || payload;
      const plan = trace.resumeReusePlan;
      if (!plan || !plan.entries || !plan.entries.length) return;

      const reruns = plan.entries.filter(e => e.decision === "rerun");
      const skipped = plan.entries.filter(e => e.decision === "skipped");
      const panel = document.createElement("section");
      panel.className = "resume-panel";

      const heading = document.createElement("h3");
      heading.textContent = "Resume Planner";
      panel.appendChild(heading);

      const summary = document.createElement("div");
      summary.className = "resume-summary";
      [["round", String(plan.round), ""], ["rerun", String(plan.summary?.rerun ?? reruns.length), "resume-rerun"],
       ["skipped", String(plan.summary?.skipped ?? skipped.length), "resume-skipped"],
       ["status", trace.finalStatus || "—", "muted"]].forEach(([label, value, cls]) => {
        const span = document.createElement("span");
        if (cls) span.className = cls;
        span.textContent = label + " " + value;
        summary.appendChild(span);
      });
      panel.appendChild(summary);

      if (reruns.length) {
        const list = document.createElement("ul");
        list.className = "resume-rerun-list";
        reruns.forEach(entry => {
          const li = document.createElement("li");
          const downstream = entry.downstreamOf ? " (downstreamOf=" + entry.downstreamOf + ")" : "";
          li.textContent = entry.stepName + ": " + entry.reason + downstream;
          list.appendChild(li);
        });
        panel.appendChild(list);
      }

      if (skipped.length) {
        const drawer = document.createElement("details");
        drawer.className = "resume-skipped-drawer";
        const summaryEl = document.createElement("summary");
        summaryEl.textContent = "Skipped audit (" + skipped.length + ") — collapsed by default";
        drawer.appendChild(summaryEl);
        const list = document.createElement("ul");
        list.className = "resume-skipped-list";
        skipped.forEach(entry => {
          const li = document.createElement("li");
          li.textContent = entry.stepName + ": " + entry.reason;
          list.appendChild(li);
        });
        drawer.appendChild(list);
        panel.appendChild(drawer);
      }

      container.appendChild(panel);
    }

    async function showTraces() {
      const data = await fetchJson("/api/traces?limit=50");
      const list = document.getElementById("list");
      clear(list);
      const { table, tbody } = mkTable(["id", "status", "session", "steps", "duration", "time"]);
      data.traces.forEach(t => {
        const tr = document.createElement("tr");
        [["id", t.id], ["status", t.finalStatus], ["session", t.sessionId || "—"],
         ["steps", String(t.stepCount)], ["dur", t.totalDurationMs + "ms"], ["time", t.timestamp]].forEach(([, v], i) => {
          const td = document.createElement("td");
          td.textContent = v;
          if (i === 1) td.className = t.finalStatus === "approved" ? "approved" : (t.finalStatus === "failed" ? "bad" : "");
          tr.appendChild(td);
        });
        tr.addEventListener("click", () => fetchJson("/api/traces/" + encodeURIComponent(t.id)).then(d => showDetail("Trace " + t.id, d)));
        tbody.appendChild(tr);
      });
      list.appendChild(table);
      document.getElementById("detail-panel").hidden = true;
    }

    async function showExperiments() {
      const data = await fetchJson("/api/experiments");
      const list = document.getElementById("list");
      clear(list);
      const { table, tbody } = mkTable(["experiment", "runs", "variants"]);
      (data.summaries || []).forEach(s => {
        const tr = document.createElement("tr");
        [s.experimentId, String(s.runCount), String(s.variantCount)].forEach(v => {
          const td = document.createElement("td");
          td.textContent = v;
          tr.appendChild(td);
        });
        tr.addEventListener("click", () =>
          fetchJson("/api/experiments/" + encodeURIComponent(s.experimentId) + "/eval-report")
            .then(r => showDetail("Experiment " + s.experimentId, r)));
        tbody.appendChild(tr);
      });
      list.appendChild(table);
      document.getElementById("detail-panel").hidden = true;
    }

    async function render() {
      document.getElementById("tab-traces").classList.toggle("active", view === "traces");
      document.getElementById("tab-experiments").classList.toggle("active", view === "experiments");
      if (view === "traces") await showTraces();
      else await showExperiments();
    }

    document.getElementById("tab-traces").addEventListener("click", () => { view = "traces"; render(); });
    document.getElementById("tab-experiments").addEventListener("click", () => { view = "experiments"; render(); });
    render().catch(e => { document.getElementById("list").textContent = String(e); });
  </script>
</body>
</html>`;
}
