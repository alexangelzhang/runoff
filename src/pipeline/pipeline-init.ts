/**
 * Scaffold pipeline.config.json from example profiles.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getRepoRoot } from "../core/paths.js";
import type { PipelineConfig, ProviderConfig } from "../core/config.js";
import { commandExists } from "./pipeline-doctor.js";

export type InitProfile = "mock" | "feature" | "bugfix" | "refactor" | "cli-detected";

const PROFILE_FILES: Record<Exclude<InitProfile, "cli-detected">, string> = {
  mock: "quickstart.config.json",
  feature: "feature.config.json",
  bugfix: "bugfix.config.json",
  refactor: "refactor.config.json",
};

export type InitResult = {
  configPath: string;
  profile: InitProfile;
  workDir: string;
};

function examplesPath(filename: string): string {
  return join(getRepoRoot(), "examples", "configs", filename);
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

function writePipelineReadme(workDir: string, profile: InitProfile): void {
  const path = join(workDir, "PIPELINE.md");
  if (existsSync(path)) return;
  const body = `# pipeline.config.json

Profile: **${profile}** (created by \`pipeline init\`).

- Edit graph: \`npm run pipeline:config:edit -- --config pipeline.config.json\` (from llm-pipeline checkout)
- Health check: \`npm run pipeline:doctor -- --config pipeline.config.json\`
- Run: see [llm-pipeline getting started](https://github.com/OWNER/REPO/blob/main/docs/guides/getting-started-30min.md)
`;
  writeFileSync(path, body, "utf-8");
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

  writePipelineReadme(dir, profile);
  return { configPath, profile, workDir: dir };
}
