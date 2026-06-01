#!/usr/bin/env npx tsx
/**
 * Zero-API-key quickstart: mock pipeline + PipelineHooks (trace + experiment).
 * Usage: npm run demo
 */

import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { clearConfigCache } from "../../../src/core/config.js";
import { executePipelineRun } from "../../../src/orchestration/pipeline-mcp-run.js";
import { getPipelineHomeDir } from "../../../src/core/paths.js";
import { queryExperiments } from "../../../src/observability/experiment-log.js";
import { buildExperimentEvalReport } from "../../../src/observability/observability-dataset.js";
import { loadTraceById } from "../../../src/observability/trace.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const CONFIG_SRC = join(ROOT, "examples", "configs", "quickstart.config.json");

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "runoff-demo-"));
  const runDir = mkdtempSync(join(tmpdir(), "runoff-demo-cwd-"));
  process.env.RUNOFF_HOME = home;
  cpSync(CONFIG_SRC, join(runDir, "pipeline.config.json"));
  process.chdir(runDir);
  clearConfigCache();

  console.log("runoff quickstart (mock providers, no API keys)\n");
  console.log(`  config:     ${CONFIG_SRC}`);
  console.log(`  data home:  ${getPipelineHomeDir()}\n`);

  const result = await executePipelineRun({
    prompt: "Quickstart: add a hello() function with unit tests",
    maxRounds: 2,
  });

  const trace = result.traceId ? loadTraceById(result.traceId) : null;
  const experiments = queryExperiments({ limit: 5 });
  const lastExp = experiments[experiments.length - 1];
  const evalReport =
    lastExp?.experimentId
      ? buildExperimentEvalReport(lastExp.experimentId)
      : null;

  console.log("Result:");
  console.log(`  finalStatus:      ${result.status}`);
  console.log(`  traceId:          ${result.traceId ?? "(none)"}`);
  console.log(`  trace steps:      ${trace?.steps.length ?? 0}`);
  console.log(`  experiment rows:  ${experiments.length}`);
  if (lastExp?.experimentId) {
    console.log(`  experimentId:     ${lastExp.experimentId}`);
  }
  if (evalReport && evalReport.totalRuns > 0) {
    console.log(`  eval winner:      ${evalReport.winnerVariant ?? "(none)"}`);
  }
  console.log(`\nTraces:      ${join(getPipelineHomeDir(), "traces")}`);
  console.log(`Experiments: ${join(getPipelineHomeDir(), "experiments.jsonl")}`);
  console.log("\nNext: npm run dev  → connect MCP  →  llm_run_pipeline / llm_query_traces");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
