/**
 * Scaffold pipeline.config.json from example profiles.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getRepoRoot } from "../core/paths.js";
import type { PipelineConfig, ProviderConfig } from "../core/config.js";
import { commandExists } from "./pipeline-doctor.js";
import { writeLoopManifest } from "./loop-sync.js";

export type InitProfile =
  | "mock"
  | "feature"
  | "bugfix"
  | "refactor"
  | "cli-detected"
  | "pr-babysitter"
  | "race-pr-babysitter"
  | "ci-sweeper"
  | "daily-triage";

const PROFILE_FILES: Record<Exclude<InitProfile, "cli-detected">, string> = {
  mock: "quickstart.config.json",
  feature: "feature.config.json",
  bugfix: "bugfix.config.json",
  refactor: "refactor.config.json",
  "pr-babysitter": "pr-babysitter.config.json",
  "race-pr-babysitter": "race-pr-babysitter.config.json",
  "ci-sweeper": "ci-sweeper.config.json",
  "daily-triage": "daily-triage.config.json",
};

const LOOP_PROFILES = new Set<InitProfile>([
  "pr-babysitter",
  "race-pr-babysitter",
  "ci-sweeper",
  "daily-triage",
]);

export type InitResult = {
  configPath: string;
  profile: InitProfile;
  workDir: string;
  scaffoldedFiles: string[];
};

type LoopProfileGuide = {
  pattern: string;
  level: string;
  cadence: string;
  nonGoals: string[];
};

function examplesPath(filename: string): string {
  return join(getRepoRoot(), "examples", "configs", filename);
}

function loopProfileGuide(profile: InitProfile): LoopProfileGuide | null {
  switch (profile) {
    case "pr-babysitter":
      return {
        pattern: "PR Babysitter",
        level: "L2 assisted (triage → fix → verify → review)",
        cadence: "every 5–15 minutes during active review",
        nonGoals: [
          "Do not auto-merge without human approval",
          "Do not edit auth/payment paths without explicit approval",
          "Exit early when the PR watchlist is empty",
        ],
      };
    case "race-pr-babysitter":
      return {
        pattern: "PR Babysitter (provider race on fix)",
        level: "L2 + human judge — two fixers race, runoff_race_apply picks winner",
        cadence: "every 5–15 minutes during active review",
        nonGoals: [
          "Do not auto-pick race winner — use runoff_race_apply after human review",
          "Do not auto-merge without human approval",
          "Exit early when the PR watchlist is empty",
        ],
      };
    case "ci-sweeper":
      return {
        pattern: "CI Sweeper",
        level: "L2 cautious (triage → diagnose → fix → verify → review)",
        cadence: "every 5–15 minutes when CI is red; slower overnight",
        nonGoals: [
          "Do not auto-fix flaky tests without classification",
          "Do not modify .github/workflows without approval",
          "Escalate after 3 failed fix attempts on the same job",
        ],
      };
    case "daily-triage":
      return {
        pattern: "Daily Triage",
        level: "L1 report-only (triage step)",
        cadence: "every 1d–2h or each morning",
        nonGoals: [
          "Week 1: report only — no repo writes",
          "Do not invent multi-file refactors from triage output",
          "Flag ambiguous items for human review",
        ],
      };
    default:
      return null;
  }
}

function filterCliProviders(config: PipelineConfig): PipelineConfig {
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, pc] of Object.entries(config.providers)) {
    if (pc.type === "mock") {
      providers[name] = pc;
      continue;
    }
    if (pc.type === "cli" && pc.command && commandExists(pc.command)) {
      providers[name] = pc;
    }
  }
  if (!Object.keys(providers).length) {
    providers.reviewer = { type: "mock" };
    providers.implementer = { type: "mock" };
  }
  return { ...config, providers };
}

function writePipelineReadme(workDir: string, profile: InitProfile): string | null {
  const path = join(workDir, "PIPELINE.md");
  if (existsSync(path)) return null;
  const body = `# pipeline.config.json

Profile: **${profile}** (created by \`pipeline init\`).

- Edit graph: \`npm run pipeline:config:edit -- --config pipeline.config.json\` (from runoff checkout)
- Health check: \`npm run pipeline:doctor -- --config pipeline.config.json\`
- Loop hosting: [host-loop-cookbook.md](https://github.com/OWNER/REPO/blob/main/docs/guides/host-loop-cookbook.md)
`;
  writeFileSync(path, body, "utf-8");
  return path;
}

function writeAgentsMd(workDir: string, profile: InitProfile): string | null {
  const path = join(workDir, "AGENTS.md");
  if (existsSync(path)) return null;

  const guide = loopProfileGuide(profile);
  if (!guide) return null;

  const nonGoals = guide.nonGoals.map((line) => `- ${line}`).join("\n");
  const body = `# AGENTS.md — runoff loop (${profile})

## Loop profile

- **Pattern:** ${guide.pattern}
- **Level:** ${guide.level}
- **Cadence:** ${guide.cadence}
- **Host guide:** runoff \`docs/guides/host-loop-cookbook.md\`

## Build & verify

Fill in your project commands (loop agents read this every run):

- **Install:** \`npm install\` (or your stack)
- **Test:** \`npm test\`
- **Lint:** \`npm run lint\` (if applicable)

## Loop non-goals

${nonGoals}

## Harness checks

Before enabling unattended fixes:

\`\`\`bash
npm run pipeline:doctor -- --config pipeline.config.json
\`\`\`

Target **L1** report-only first, then **L2** with \`runtime.governance.enabled\`.

## Optional: MFS context refs

When using [MFS](https://github.com/zilliztech/mfs) for cross-source search, pass **excerpts + URI refs** into \`runoff_run_pipeline\` context — not raw \`mfs search\` JSON. runoff records \`contextRefs\` (\`file://\`, \`mfs://\`, \`path:line\`) in Observation for host re-\`mfs cat\`. See \`docs/guides/mfs-context-layer.md\`.
`;
  writeFileSync(path, body, "utf-8");
  return path;
}

function writeStateMd(workDir: string, profile: InitProfile): string | null {
  const path = join(workDir, "STATE.md");
  if (existsSync(path)) return null;

  const guide = loopProfileGuide(profile);
  if (!guide) return null;

  const body = `# Loop State — ${guide.pattern}

Last run: _(host updates ISO timestamp each tick)_

## High Priority

- _(none)_

## Watch List

- _(none)_

## Recent Noise (ignored this run)

- _(none)_

## Resolved (last 7d)

- _(none)_

---

_Update every loop tick. Prune merged/closed items. Record human overrides here._
`;
  writeFileSync(path, body, "utf-8");
  return path;
}

function writeLoopScaffold(workDir: string, profile: InitProfile): string[] {
  const created: string[] = [];
  for (const writer of [writeAgentsMd, writeStateMd]) {
    const path = writer(workDir, profile);
    if (path) created.push(path);
  }
  return created;
}

export function pipelineInit(workDir: string, profile: InitProfile): InitResult {
  const dir = resolve(workDir);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "pipeline.config.json");

  if (existsSync(configPath)) {
    throw new Error(`Already exists: ${configPath}\nRemove or pick another --work-dir.`);
  }

  let sourceFile: string;
  if (profile === "cli-detected") {
    sourceFile = examplesPath("cli.config.json");
    const raw = JSON.parse(readFileSync(sourceFile, "utf-8")) as PipelineConfig;
    const filtered = filterCliProviders(raw);
    writeFileSync(configPath, `${JSON.stringify(filtered, null, 2)}\n`, "utf-8");
  } else {
    sourceFile = examplesPath(PROFILE_FILES[profile]);
    if (!existsSync(sourceFile)) {
      throw new Error(`Example not found: ${sourceFile}`);
    }
    cpSync(sourceFile, configPath);
  }

  const scaffoldedFiles: string[] = [];
  const readme = writePipelineReadme(dir, profile);
  if (readme) scaffoldedFiles.push(readme);
  if (LOOP_PROFILES.has(profile)) {
    scaffoldedFiles.push(...writeLoopScaffold(dir, profile));
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as PipelineConfig;
    scaffoldedFiles.push(writeLoopManifest(dir, profile, config));
  }

  return { configPath, profile, workDir: dir, scaffoldedFiles };
}
