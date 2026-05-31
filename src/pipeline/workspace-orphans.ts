/**
 * Detect / clean managed worktree dirs not tracked in activeWorkspaces.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { getManagedWorkspacesDir } from "../core/paths.js";
import { activeWorkspaces } from "../runtime/workspace.js";

export type OrphanWorkspace = {
  path: string;
  name: string;
  ageMs: number;
};

export function scanOrphanWorkspaces(options?: { homeDir?: string }): OrphanWorkspace[] {
  const base = options?.homeDir ? join(options.homeDir, "workspaces") : getManagedWorkspacesDir();
  if (!existsSync(base)) return [];

  const activePaths = new Set(
    [...activeWorkspaces].map((ws) => ws.worktreePath).filter((p) => existsSync(p)),
  );

  const orphans: OrphanWorkspace[] = [];
  const now = Date.now();
  for (const name of readdirSync(base)) {
    if (!name.startsWith("session-")) continue;
    const path = join(base, name);
    try {
      const st = statSync(path);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    if (activePaths.has(path)) continue;
    orphans.push({
      path,
      name,
      ageMs: Math.max(0, now - statSync(path).mtimeMs),
    });
  }
  return orphans.sort((a, b) => b.ageMs - a.ageMs);
}

export function cleanupOrphanWorkspaces(
  orphans: OrphanWorkspace[],
): { removed: number; errors: string[] } {
  let removed = 0;
  const errors: string[] = [];
  for (const o of orphans) {
    try {
      rmSync(o.path, { recursive: true, force: true });
      removed += 1;
    } catch (err: unknown) {
      errors.push(`${o.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { removed, errors };
}
