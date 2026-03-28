import { spawn, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createTaskPayload, parseTaskResult, type TaskResult } from "../ipc.js";
import { getTasksDir } from "../paths.js";
import { 
  LLMProvider, 
  LLMRequest, 
  LLMResponse, 
  ProviderMode, 
  parseCodeFromResponse
} from "./types.js";

/** 
 * Refactored to manage the task_runner process directly for active cancellation.
 * Integrated with Resilience Edition: Windows support and proper IPC alignment.
 */
async function executeTask(
  command: string, 
  args: string[], 
  taskFile: string, 
  resultFile: string, 
  timeoutMs: number,
  signal?: AbortSignal
): Promise<TaskResult> {
  return new Promise((resolve, reject) => {
    const scriptDir = dirname(new URL(import.meta.url).pathname);
    const defaultRunnerPath = join(scriptDir, "../../scripts/task_runner.py");

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
  private config: any;

  constructor(name: string, command: string, args: string[] = [], mode: ProviderMode = "text", config: any = {}) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.mode = mode;
    this.config = config;
  }

  async execute(req: LLMRequest): Promise<LLMResponse> {
    const tasksDir = getTasksDir();
    if (!existsSync(tasksDir)) mkdirSync(tasksDir, { recursive: true });

    const taskId = randomUUID().slice(0, 8);
    const taskFile = join(tasksDir, `${this.name}.${taskId}.task.json`);
    const resultFile = join(tasksDir, `${this.name}.${taskId}.result.json`);

    const payload = createTaskPayload({
      id: taskId,
      prompt: req.prompt,
      system: req.system,
      staticContext: req.staticContext,
      dynamicContext: req.dynamicContext,
      mode: this.mode as any,
      workDir: req.workDir,
      sessionId: req.sessionId,
      stepName: req.stepName,
      round: req.round ?? 1,
      timestamp: new Date().toISOString(),
    });

    writeFileSync(taskFile, JSON.stringify(payload));

    const timeoutOverride = this.config.timeoutMs;
    const timeoutMs = typeof timeoutOverride === "number" ? timeoutOverride : getResultTimeoutMs(this.mode);

    try {
      const result = await executeTask(this.command, this.args, taskFile, resultFile, timeoutMs, req.signal);
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
      return {
        kind: "text",
        model: `${this.name}-cli`,
        content: "",
        code: "",
        explanation: "",
        failed: true,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (existsSync(taskFile)) unlinkSync(taskFile);
      if (existsSync(resultFile)) unlinkSync(resultFile);
    }
  }
}
