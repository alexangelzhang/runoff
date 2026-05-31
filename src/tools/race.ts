/**
 * llm_race_apply + llm_race_abort — Race session finalization tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadCheckpoint, saveCheckpoint, type PipelineState } from "../core/state.js";
import { updateTrace } from "../observability/trace.js";
import {
  deleteRaceSession,
  getRaceSession,
  type RaceCandidateSnapshot,
  type RaceSession,
} from "../runtime/race-registry.js";
import { SessionWorkspace } from "../runtime/workspace.js";

function applyPatchText(applyTargetPath: string, patchText: string): void {
  if (!patchText.trim()) {
    throw new Error("Winning candidate did not include a patch diff to apply.");
  }

  const tempDir = mkdtempSync(join(tmpdir(), "llm-race-"));
  const patchPath = join(tempDir, "winner.patch");
  writeFileSync(patchPath, patchText, "utf-8");

  try {
    execFileSync("git", ["apply", "--3way", "--binary", patchPath], {
      cwd: applyTargetPath,
      stdio: "pipe",
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function hasWorkspaceArtifact(candidate: RaceCandidateSnapshot): boolean {
  return Boolean(candidate.workspacePath && candidate.workspaceRepoRoot && candidate.workspaceBaseRef);
}

function sameWorkspacePath(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    if (!existsSync(a) || !existsSync(b)) return false;
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

async function resumeCandidateWorkspace(candidate: RaceCandidateSnapshot): Promise<SessionWorkspace> {
  if (!hasWorkspaceArtifact(candidate)) {
    throw new Error(`Candidate ${candidate.providerName} does not have workspace metadata.`);
  }
  return SessionWorkspace.resume(
    candidate.workspacePath!,
    candidate.workspaceRepoRoot!,
    candidate.workspaceBaseRef!,
    candidate.providerName,
    candidate.workspaceSharedLockKey,
    { registerActive: false },
  );
}

/** Apply global session worktree (standalone agent-write steps) before race winner patch. */
async function applyCheckpointSessionWorkspace(session: RaceSession): Promise<number> {
  if (!session.sessionId) return 0;
  const checkpoint = await loadCheckpoint(session.sessionId);
  if (!checkpoint?.workspacePath || !checkpoint.workspaceRepoRoot || !checkpoint.workspaceBaseRef) {
    return 0;
  }
  const sharedWithRace = session.candidates.some((candidate) =>
    sameWorkspacePath(candidate.workspacePath, checkpoint.workspacePath),
  );
  if (sharedWithRace) {
    return 0;
  }
  // Standalone draft lives in the global session worktree; race winner worktrees
  // already include those changes via parent_patch. Only release the global lock here.
  const workspace = await SessionWorkspace.resume(
    checkpoint.workspacePath,
    checkpoint.workspaceRepoRoot,
    checkpoint.workspaceBaseRef,
    checkpoint.traceId ?? session.sessionId,
    undefined,
    { registerActive: false },
  );
  await workspace.releaseLock();
  return 1; // standalone draft session present; winner worktree carries merged changes
}

async function cleanupCandidateWorkspace(candidate: RaceCandidateSnapshot): Promise<boolean> {
  if (!hasWorkspaceArtifact(candidate)) return false;
  const workspace = await resumeCandidateWorkspace(candidate);
  await workspace.destroy();
  return true;
}

async function updateCheckpointAfterRaceDecision(
  session: RaceSession,
  status: "approved" | "aborted",
): Promise<string[]> {
  const warnings: string[] = [];
  if (!session.sessionId) return warnings;

  const checkpoint = await loadCheckpoint(session.sessionId);
  if (!checkpoint) {
    warnings.push(`checkpoint not found for session ${session.sessionId}`);
    return warnings;
  }

  let workspaceCleared = false;
  if (checkpoint.workspacePath && checkpoint.workspaceRepoRoot && checkpoint.workspaceBaseRef) {
    try {
      const workspace = await SessionWorkspace.resume(
        checkpoint.workspacePath,
        checkpoint.workspaceRepoRoot,
        checkpoint.workspaceBaseRef,
        checkpoint.traceId,
        undefined,
        { registerActive: false },
      );
      await workspace.destroy();
      workspaceCleared = true;
    } catch (err: unknown) {
      warnings.push(`pipeline workspace: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const nextState: PipelineState = {
    ...checkpoint,
    approved: status === "approved",
    status,
    timestamp: new Date().toISOString(),
    pendingRaceTraceId: undefined,
    raceCandidates: undefined,
    ...(workspaceCleared
      ? {
          workspacePath: undefined,
          workspaceRepoRoot: undefined,
          workspaceBaseRef: undefined,
        }
      : {}),
  };

  const saved = await saveCheckpoint(session.sessionId, nextState);
  if (!saved) {
    warnings.push(`failed to save checkpoint for session ${session.sessionId}`);
  }
  return warnings;
}

export async function applyRaceSession(traceId: string, winnerIndex: number): Promise<{
  status: "applied";
  traceId: string;
  winnerIndex: number;
  winnerProvider: string;
  appliedVia: "workspace" | "patch";
  filesModified?: string[];
  diffStat?: string;
  workspacesCleaned: number;
  cleanupErrors: string[];
}> {
  const session = getRaceSession(traceId);
  if (!session) {
    throw new Error(`No active race session found for traceId "${traceId}". It may have expired or already been applied.`);
  }
  if (winnerIndex < 0 || winnerIndex >= session.candidates.length) {
    throw new Error(`Invalid winnerIndex ${winnerIndex}. Must be 0-${session.candidates.length - 1}.`);
  }

  const winner = session.candidates[winnerIndex];
  let appliedVia: "workspace" | "patch" = "workspace";
  const cleanupErrors: string[] = [];
  let workspacesCleaned = await applyCheckpointSessionWorkspace(session);

  if (hasWorkspaceArtifact(winner)) {
    const workspace = await resumeCandidateWorkspace(winner);
    try {
      const patch = await workspace.collectPatch();
      await workspace.applyToSource(patch.patch);
    } finally {
      await workspace.destroy();
      workspacesCleaned += 1;
    }
  } else if (winner.patchText) {
    appliedVia = "patch";
    applyPatchText(session.applyTargetPath, winner.patchText);
  } else {
    throw new Error("Winning candidate did not include workspace metadata or a patch diff to apply.");
  }

  for (let idx = 0; idx < session.candidates.length; idx++) {
    if (idx === winnerIndex) continue;
    const candidate = session.candidates[idx];
    if (!hasWorkspaceArtifact(candidate)) continue;
    try {
      if (await cleanupCandidateWorkspace(candidate)) {
        workspacesCleaned += 1;
      }
    } catch (err: unknown) {
      cleanupErrors.push(`${candidate.providerName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  cleanupErrors.push(...(await updateCheckpointAfterRaceDecision(session, "approved")));

  updateTrace(traceId, {
    finalStatus: "approved",
    candidates: session.candidates.map((candidate, idx) => ({
      provider: candidate.providerName,
      durationMs: 0,
      filesModified: candidate.filesModified,
      diffStat: candidate.diffStat,
      isWinner: idx === winnerIndex,
    })),
  });

  deleteRaceSession(traceId);

  return {
    status: "applied",
    traceId,
    winnerIndex,
    winnerProvider: winner.providerName,
    appliedVia,
    filesModified: winner.filesModified,
    diffStat: winner.diffStat,
    workspacesCleaned,
    cleanupErrors,
  };
}

export async function abortRaceSession(traceId: string, reason?: string): Promise<{
  status: "aborted";
  traceId: string;
  reason?: string;
  workspacesCleaned: number;
  cleanupErrors: string[];
}> {
  const session = getRaceSession(traceId);
  if (!session) {
    throw new Error(`No active race session found for traceId "${traceId}". It may have expired.`);
  }

  let workspacesCleaned = 0;
  const cleanupErrors: string[] = [];

  for (const candidate of session.candidates) {
    if (!hasWorkspaceArtifact(candidate)) continue;
    try {
      if (await cleanupCandidateWorkspace(candidate)) {
        workspacesCleaned += 1;
      }
    } catch (err: unknown) {
      cleanupErrors.push(`${candidate.providerName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  cleanupErrors.push(...(await updateCheckpointAfterRaceDecision(session, "aborted")));

  updateTrace(traceId, {
    finalStatus: "aborted",
  });

  deleteRaceSession(traceId);

  return {
    status: "aborted",
    traceId,
    reason,
    workspacesCleaned,
    cleanupErrors,
  };
}

export function register(server: McpServer) {
  server.tool(
    "llm_race_apply",
    "Finalize a race: apply the winning candidate's changes to the source repo, clean up all candidate workspaces, and update the trace status.",
    {
      traceId: z.string().describe("The traceId returned by llm_run_pipeline in race mode"),
      winnerIndex: z.number().describe("The index of the winning candidate (0-based)"),
    },
    async ({ traceId, winnerIndex }) => {
      try {
        const result = await applyRaceSession(traceId, winnerIndex);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Race apply error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "llm_race_abort",
    "Abort a race session, reject all candidates, and clean up all candidate workspaces without applying anything.",
    {
      traceId: z.string().describe("The traceId returned by llm_run_pipeline in race mode"),
      reason: z.string().optional().describe("Reason for aborting the race"),
    },
    async ({ traceId, reason }) => {
      try {
        const result = await abortRaceSession(traceId, reason);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Race abort error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
