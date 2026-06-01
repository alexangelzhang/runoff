#!/usr/bin/env npx tsx
/**
 * Race mode demo: two mock providers compete on the implement step.
 * Shows the awaiting_judge pause and candidate comparison output.
 * Usage: npm run demo:race
 */

import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { clearConfigCache } from "../../../src/core/config.js";
import { executePipelineRun } from "../../../src/orchestration/pipeline-mcp-run.js";
import { loadCheckpoint } from "../../../src/core/state.js";
import { getPipelineHomeDir } from "../../../src/core/paths.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const CONFIG_SRC = join(ROOT, "examples", "configs", "race-demo.config.json");

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "runoff-race-demo-"));
  const runDir = mkdtempSync(join(tmpdir(), "runoff-race-demo-cwd-"));
  process.env.RUNOFF_HOME = home;
  cpSync(CONFIG_SRC, join(runDir, "pipeline.config.json"));
  process.chdir(runDir);
  clearConfigCache();

  console.log("runoff race mode demo (mock providers, no API keys)");
  console.log("Two providers compete on the implement step.\n");
  console.log(`  config:    ${CONFIG_SRC}`);
  console.log(`  data home: ${getPipelineHomeDir()}\n`);

  const result = await executePipelineRun({
    prompt: "Add a retry() helper that wraps any async function with exponential backoff",
    maxRounds: 2,
  });

  console.log(`status:    ${result.status}`);
  console.log(`traceId:   ${result.traceId}`);
  console.log(`session:   ${result.checkpointFile}\n`);

  if (result.status === "awaiting_judge") {
    const checkpoint = await loadCheckpoint(result.checkpointFile);
    const candidates = checkpoint?.raceCandidates ?? [];

    if (candidates.length > 0) {
      console.log("--- candidates ---\n");
      candidates.forEach((c, i) => {
        const lines = (c.patchText ?? c.diffStat ?? "(mock output)").split("\n").length;
        const files = c.filesModified?.join(", ") ?? "(mock)";
        console.log(`candidate ${i}  (${c.providerName})`);
        console.log(`  files:  ${files}`);
        console.log(`  size:   ${lines} lines`);
        if (c.diffStat) console.log(`  diff:   ${c.diffStat}`);
        console.log();
      });

      console.log("--- to finalize ---\n");
      console.log(`apply candidate 0:`);
      console.log(
        `  npm run pipeline:race:apply -- --session ${result.checkpointFile} --winner 0\n`,
      );
      console.log(`apply candidate 1:`);
      console.log(
        `  npm run pipeline:race:apply -- --session ${result.checkpointFile} --winner 1\n`,
      );
      console.log(`abort (discard all):`);
      console.log(`  npm run pipeline:race:abort -- --trace-id ${result.traceId}\n`);
    } else {
      // Mock providers don't produce real race candidates; show the shape anyway
      console.log("(mock providers — candidates not persisted in demo mode)");
      console.log("In a real run with Codex + Gemini, you would see:");
      console.log();
      console.log("  candidate 0  (codex)");
      console.log("    files: src/utils/retry.ts");
      console.log("    diff:  +34 -0");
      console.log();
      console.log("  candidate 1  (gemini)");
      console.log("    files: src/utils/retry.ts");
      console.log("    diff:  +18 -0   (used existing sleep() helper)");
      console.log();
      console.log(`  npm run pipeline:race:apply -- --session ${result.checkpointFile} --winner 1`);
      console.log();
    }
  } else {
    console.log("(pipeline completed without reaching awaiting_judge)");
    console.log("Note: mock providers use auto-pick; set raceFinalize=defer in config for manual pick.");
  }

  console.log(`\nTraces: ${join(getPipelineHomeDir(), "traces")}`);
  console.log("Full docs: docs/features/race-mode.md");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
