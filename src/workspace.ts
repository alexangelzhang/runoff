/**
 * Session-level workspace isolation using Python Workspace Manager backend.
 * Manages a git worktree that persists across all rounds of a pipeline run,
 * with repo-level locking managed exclusively by Python side.
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = join(__dirname, "../scripts/workspace_manager.py");

// --- Git helpers ---

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf-8" });
  return stdout.trim();
}

export async function resolveRepoRoot(dir: string): Promise<string | null> {
  try {
    return await git(["rev-parse", "--show-toplevel"], dir);
  } catch {
    return null;
  }
}

export async function isInsideWorktree(dir: string): Promise<boolean> {
  try {
    const gitDir = await git(["rev-parse", "--git-dir"], dir);
    return gitDir.includes("/worktrees/") || gitDir.includes(".git/worktrees");
  } catch {
    return false;
  }
}

// --- SessionWorkspace ---

export interface SessionWorkspaceOptions {
  repoRoot: string;
  baseRef?: string;
  sessionId?: string;
  sharedLockKey?: string;
}

export interface PatchResult {
  patch: Buffer;
  filesModified: string[];
  diffStat: string;
}

export const activeWorkspaces = new Set<SessionWorkspace>();

export class SessionWorkspace {
  readonly repoRoot: string;
  readonly baseRef: string;
  readonly worktreePath: string;
  readonly sessionId: string;
  readonly sharedLockKey?: string;
  private destroyed = false;

  private constructor(repoRoot: string, baseRef: string, worktreePath: string, sessionId: string, sharedLockKey?: string) {
    this.repoRoot = repoRoot;
    this.baseRef = baseRef;
    this.worktreePath = worktreePath;
    this.sessionId = sessionId;
    this.sharedLockKey = sharedLockKey;
  }

  private static async runPython(cmd: string, args: Record<string, string | number>): Promise<any> {
    const cliArgs = [SCRIPT_PATH, cmd];
    for (const [k, v] of Object.entries(args)) {
      if (v !== undefined && v !== "") {
        cliArgs.push(`--${k}`, String(v));
      }
    }
    
    let stdout = "";
    try {
      const result = await execFileAsync("python3", cliArgs, { maxBuffer: 10 * 1024 * 1024 });
      stdout = result.stdout;
    } catch (e: any) {
      stdout = e.stdout || "";
      if (!stdout) {
        throw new Error(`Workspace Python crashed: ${e.stderr || e.message}`);
      }
    }

    const text = stdout.trim();
    if (!text) throw new Error(`Empty response from python workspace_${cmd}`);

    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const result = JSON.parse(lines[i]);
        if (result && typeof result === "object") {
          if (result.error) throw new Error(result.error);
          return result;
        }
      } catch (err) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
    }

    throw new Error(`Failed to parse Python response: ${text.slice(-500)}`);
  }

  static async create(opts: SessionWorkspaceOptions): Promise<SessionWorkspace> {
    const sessionId = opts.sessionId ?? randomUUID().slice(0, 8);
    const args: Record<string, string | number> = {
      repo: opts.repoRoot,
      session: sessionId,
      "owner-pid": process.pid,
    };
    if (opts.baseRef) args["base-ref"] = opts.baseRef;
    if (opts.sharedLockKey) args["shared-lock-key"] = opts.sharedLockKey;

    const result = await SessionWorkspace.runPython("create", args);
    const ws = new SessionWorkspace(opts.repoRoot, result.baseRef, result.worktreePath, sessionId, opts.sharedLockKey);
    activeWorkspaces.add(ws);
    return ws;
  }

  static async resume(worktreePath: string, repoRoot: string, baseRef: string, sessionId: string, sharedLockKey?: string): Promise<SessionWorkspace> {
    if (!existsSync(worktreePath)) {
      throw new Error(`Session workspace not found: ${worktreePath}`);
    }
    if (!(await isInsideWorktree(worktreePath))) {
      throw new Error(`Path is not a git worktree: ${worktreePath}`);
    }

    const ws = new SessionWorkspace(repoRoot, baseRef, worktreePath, sessionId, sharedLockKey);
    const lockArgs: Record<string, string | number> = {
      repo: repoRoot,
      "owner-pid": process.pid,
    };
    if (sharedLockKey) lockArgs["shared-lock-key"] = sharedLockKey;
    await SessionWorkspace.runPython("lock", lockArgs);

    activeWorkspaces.add(ws);
    return ws;
  }

  async resolveWorkDir(originalWorkDir?: string): Promise<string> {
    if (!originalWorkDir) return this.worktreePath;
    
    const { resolve, relative, isAbsolute } = await import("node:path");
    const { mkdir } = await import("node:fs/promises");
    const absWorkDir = resolve(originalWorkDir);
    const absRepoRoot = resolve(this.repoRoot);
    
    const rel = relative(absRepoRoot, absWorkDir);
    if (!rel.startsWith("..") && !isAbsolute(rel)) {
      const resolved = rel ? join(this.worktreePath, rel) : this.worktreePath;
      await mkdir(resolved, { recursive: true });
      return resolved;
    }

    return this.worktreePath;
  }

  async collectPatch(): Promise<PatchResult> {
    const result = await SessionWorkspace.runPython("collect", {
      worktree: this.worktreePath,
      "base-ref": this.baseRef
    });
    return {
      patch: result.patch ? Buffer.from(result.patch, "base64") : Buffer.alloc(0),
      filesModified: result.filesModified || [],
      diffStat: result.diffStat || ""
    };
  }

  async applyToSource(patch?: Buffer): Promise<void> {
    const patchData = patch ?? (await this.collectPatch()).patch;
    if (!patchData || patchData.length === 0) return;

    const { writeFile, unlink } = await import("node:fs/promises");
    const { getPipelineHomeDir } = await import("./paths.js");
    const tmpPatchPath = join(getPipelineHomeDir(), `patch-${randomUUID()}.patch`);
    await writeFile(tmpPatchPath, patchData);

    try {
      const args: Record<string, string | number> = {
        repo: this.repoRoot,
        "patch-file": tmpPatchPath,
        "owner-pid": process.pid,
      };
      if (this.sharedLockKey) args["shared-lock-key"] = this.sharedLockKey;
      await SessionWorkspace.runPython("apply", args);
    } finally {
      await unlink(tmpPatchPath).catch(() => {});
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    try {
      const args: Record<string, string | number> = {
        repo: this.repoRoot,
        worktree: this.worktreePath,
        "owner-pid": process.pid,
      };
      if (this.sharedLockKey) args["shared-lock-key"] = this.sharedLockKey;
      await SessionWorkspace.runPython("destroy", args);
    } catch (e: any) {
      console.error(`workspace destroy failed: ${e.message}`);
    }

    activeWorkspaces.delete(this);
  }

  async releaseLock(): Promise<void> {
    const args: Record<string, string | number> = {
        repo: this.repoRoot,
        "owner-pid": process.pid,
    };
    if (this.sharedLockKey) args["shared-lock-key"] = this.sharedLockKey;
    try { await SessionWorkspace.runPython("release", args); } catch {}
  }

  destroySync(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      const args = [
        SCRIPT_PATH,
        "destroy",
        "--repo", this.repoRoot,
        "--worktree", this.worktreePath,
        "--owner-pid", String(process.pid),
      ];
      if (this.sharedLockKey) {
        args.push("--shared-lock-key", this.sharedLockKey);
      }
      execFileSync("python3", args, { stdio: "ignore" });
    } catch { /* ignore */ }
    activeWorkspaces.delete(this);
  }
}
