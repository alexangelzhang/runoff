import { homedir } from "node:os";
import { join } from "node:path";

export function getPipelineHomeDir(): string {
  return process.env.LLM_PIPELINE_HOME ?? join(homedir(), ".llm-pipeline");
}

export function getTasksDir(): string {
  return join(getPipelineHomeDir(), "tasks");
}

export function getSessionsDir(): string {
  return join(getPipelineHomeDir(), "sessions");
}

export function getTracesDir(): string {
  return join(getPipelineHomeDir(), "traces");
}
