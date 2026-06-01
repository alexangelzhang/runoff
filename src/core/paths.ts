import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Repository root (parent of `src/`). */
export function getRepoRoot(): string {
  return REPO_ROOT;
}

export function getScriptsDir(): string {
  return join(REPO_ROOT, "scripts");
}

export function getTaskRunnerScriptPath(): string {
  return join(getScriptsDir(), "python", "task_runner.py");
}

export function getWorkspaceManagerScriptPath(): string {
  return join(getScriptsDir(), "python", "workspace_manager.py");
}

export function getPipelineHomeDir(): string {
  return process.env.RUNOFF_HOME ?? join(homedir(), ".runoff");
}

export function getTasksDir(): string {
  return join(getPipelineHomeDir(), "tasks");
}

export function getSessionsDir(): string {
  return join(getPipelineHomeDir(), "sessions");
}

/** Managed git worktrees (Python workspace_manager). */
export function getManagedWorkspacesDir(): string {
  return join(getPipelineHomeDir(), "workspaces");
}

export function getTracesDir(): string {
  return join(getPipelineHomeDir(), "traces");
}

export function getRaceSessionsDir(): string {
  return join(getPipelineHomeDir(), "race-sessions");
}

export function getControlPlaneDir(): string {
  return join(getPipelineHomeDir(), "control-plane");
}

export function getCacheDir(): string {
  return join(getPipelineHomeDir(), "cache");
}

export function getPromptVersionsDir(): string {
  return join(getPipelineHomeDir(), "prompt-versions");
}

export function getA2AFederationDir(): string {
  return join(getPipelineHomeDir(), "a2a-federation");
}

/** P4: default path for AgentGraph browser editor HTML. */
export function getAgentGraphEditorPath(): string {
  return join(getPipelineHomeDir(), "agent-graph-editor.html");
}

/** P7: SVG DAG canvas editor HTML. */
export function getAgentGraphCanvasPath(): string {
  return join(getPipelineHomeDir(), "agent-graph-canvas.html");
}
