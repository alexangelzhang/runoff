import { spawn, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTaskPayload, parseTaskResult, type TaskResult } from "../core/ipc.js";
import { normalizeDelegateArgv, injectDirFlag } from "./delegate-argv.js";
import { getTaskRunnerScriptPath, getTasksDir } from "../core/paths.js";
import {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ProviderMode,
  parseCodeFromResponse,
} from "./types.js";
/** Subset of provider JSON needed at runtime (avoid importing config.ts → circular). */
export type CLIProviderRuntimeOptions = {
  timeoutMs?: number;
  /** Allocate a pseudo-TTY for the delegate process (for TTY-requiring CLIs like Gemini). */
  pty?: boolean;
};

function atomicWriteJsonFile(filePath: string, data: unknown): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), "utf-8");
  renameSync(tmp, filePath);
}

/** 
 * Refactored to manage the task_runner process directly for active cancellation.
 * Integrated with Resilience Edition: Windows support and proper IPC alignment.
 */
/** Exported for failure-path / abort contract tests (issue 6.11 / 6.18). */
export async function executeCliRunnerTask(
  command: string, 
  args: string[], 
  taskFile: string, 
  resultFile: string, 
  timeoutMs: number,
  signal?: AbortSignal
): Promise<TaskResult> {
  return new Promise((resolve, reject) => {
    const defaultRunnerPath = getTaskRunnerScriptPath();

    const useCommand = command || "python3";
    const useArgs = args.length > 0 ? [...args, taskFile, resultFile] : [defaultRunnerPath, taskFile, resultFile];

    // Use detached for group kill support on POSIX
    const proc = spawn(useCommand, useArgs, {
      detached: platform() !== "win32", 
      stdio: "inherit" 
    });

    let resolved = false;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      if (proc.pid) {
        try {
          if (platform() === "win32") {
            execSync(`taskkill /F /T /PID ${proc.pid}`);
          } else {
            process.kill(-proc.pid, "SIGKILL"); 
          }
        } catch (e) { /* ignore */ }
      }
    };

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(new Error("Task aborted"));
        return;
      }
      signal.addEventListener("abort", () => {
        cleanup();
        reject(new Error("Task aborted by pipeline controller"));
      }, { once: true });
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Task execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on("exit", (code) => {
      if (resolved) return;
      clearTimeout(timer);
      resolved = true;

      if (existsSync(resultFile)) {
        try {
          const content = readFileSync(resultFile, "utf-8");
          resolve(parseTaskResult(JSON.parse(content)));
        } catch (err) {
          reject(new Error(`Failed to parse task result: ${err}`));
        }
      } else {
        reject(new Error(`Task runner exited with code ${code} but produced no result file`));
      }
    });

    proc.on("error", (err) => {
      if (resolved) return;
      cleanup();
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function getResultTimeoutMs(mode: ProviderMode): number {
  return mode === "text" ? 330_000 : 900_000; 
}

export class CLIProvider implements LLMProvider {
  name: string;
  mode: ProviderMode;
  private command: string;
  private args: string[];
  private runtimeOptions: CLIProviderRuntimeOptions;

  constructor(
    name: string,
    command: string,
    args: string[] = [],
    mode: ProviderMode = "text",
    runtimeOptions: CLIProviderRuntimeOptions = {},
  ) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.mode = mode;
    this.runtimeOptions = runtimeOptions;
  }

  async execute(req: LLMRequest): Promise<LLMResponse> {
    const tasksDir = getTasksDir();
    if (!existsSync(tasksDir)) mkdirSync(tasksDir, { recursive: true });

    const taskId = randomUUID().slice(0, 8);
    const taskFile = join(tasksDir, `${this.name}.${taskId}.task.json`);
    const resultFile = join(tasksDir, `${this.name}.${taskId}.result.json`);

    const trimmedCmd = this.command.trim();
    const rawArgv = trimmedCmd !== "" ? [trimmedCmd, ...this.args] : undefined;
    const delegateArgv = rawArgv
      ? injectDirFlag(normalizeDelegateArgv(rawArgv), req.workDir)
      : undefined;
    const deferFinalize = req.finalizeStrategy === "defer";
    const sharedLockKey = deferFinalize ? (req.sharedLockKey ?? req.sessionId) : req.sharedLockKey;
    const startedAt = new Date().toISOString();
    const payload = createTaskPayload({
      id: taskId,
      prompt: req.prompt,
      system: req.system,
      staticContext: req.staticContext,
      dynamicContext: req.dynamicContext,
      mode: this.mode,
      workDir: req.workDir,
      sessionId: deferFinalize ? `${req.sessionId ?? "session"}-${this.name}-${taskId}` : req.sessionId,
      stepName: req.stepName,
      round: req.round ?? 1,
      timestamp: startedAt,
      startedAt,
      ...(delegateArgv ? { delegateArgv } : {}),
      ...(this.runtimeOptions.pty ? { delegatePty: true } : {}),
      ...(req.finalizeStrategy ? { finalizeStrategy: req.finalizeStrategy } : {}),
      ...(sharedLockKey ? { sharedLockKey } : {}),
    });

    atomicWriteJsonFile(taskFile, payload);

    const timeoutOverride = this.runtimeOptions.timeoutMs;
    const timeoutMs = typeof timeoutOverride === "number" ? timeoutOverride : getResultTimeoutMs(this.mode);

    try {
      const result = await executeCliRunnerTask("python3", [], taskFile, resultFile, timeoutMs, req.signal);
      const failed = result.status === "error";
      
      const usage = result.usage || {
        promptTokens: Math.ceil((req.prompt?.length || 0) / 4),
        completionTokens: Math.ceil((result.content?.length || 0) / 4)
      };

      if (this.mode === "agent-write" || this.mode === "agent-read") {
        return {
          kind: "agent",
          model: `${this.name}-cli`,
          changes: result.changes || "",
          summary: result.content || result.summary || "",
          filesModified: result.filesModified || [],
          diffStat: result.diffStat || "",
          workspace: result.workspacePath
            ? {
                workspacePath: result.workspacePath,
                workspaceRepoRoot: result.workspaceRepoRoot || req.workDir || "",
                workspaceBaseRef: result.workspaceBaseRef || "",
                workspaceSharedLockKey: result.workspaceSharedLockKey,
              }
            : undefined,
          failed,
          error: result.error,
          usage,
        };
      } else {
        const raw = result.content || result.summary || "";
        const { code, explanation } = parseCodeFromResponse(raw);
        return {
          kind: "text",
          model: `${this.name}-cli`,
          content: raw,
          code,
          explanation,
          failed,
          error: result.error,
          usage,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const usage = {
        promptTokens: Math.ceil((req.prompt?.length || 0) / 4),
        completionTokens: 0,
      };
      if (this.mode === "agent-write" || this.mode === "agent-read") {
        return {
          kind: "agent",
          model: `${this.name}-cli`,
          changes: "",
          summary: "",
          filesModified: [],
          diffStat: "",
          workspace: undefined,
          failed: true,
          error: message,
          usage,
        };
      }
      return {
        kind: "text",
        model: `${this.name}-cli`,
        content: "",
        code: "",
        explanation: "",
        failed: true,
        error: message,
        usage,
      };
    } finally {
      if (existsSync(taskFile)) unlinkSync(taskFile);
      if (existsSync(resultFile)) unlinkSync(resultFile);
    }
  }
}
