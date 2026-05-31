/**
 * Race session finalization (apply winner / abort) — shared by MCP and CLI.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCheckpoint, saveCheckpoint, type PipelineState } from "../core/state.js";
import { logger } from "../core/logger.js";
import { updateTrace } from "../observability/trace.js";
import {
  deleteRaceSession,
  getRaceSession,
  type RaceCandidateSnapshot,
  type RaceSession,
} from "./race-registry.js";
import { SessionWorkspace } from "./workspace.js";

const GIT_APPLY_TIMEOUT_MS = 120_000;

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
      timeout: GIT_APPLY_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
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

async function applyCheckpointSessionWorkspace(
  session: RaceSession,
): Promise<{ cleaned: number; error?: string }> {
  if (!session.sessionId) return { cleaned: 0 };
  const checkpoint = await loadCheckpoint(session.sessionId);
  if (!checkpoint?.workspacePath || !checkpoint.workspaceRepoRoot || !checkpoint.workspaceBaseRef) {
    return { cleaned: 0 };
  }
  const sharedWithRace = session.candidates.some((candidate) =>
    sameWorkspacePath(candidate.workspacePath, checkpoint.workspacePath),
  );
  if (sharedWithRace) return { cleaned: 0 };

  try {
    const workspace = await SessionWorkspace.resume(
      checkpoint.workspacePath,
      checkpoint.workspaceRepoRoot,
      checkpoint.workspaceBaseRef,
      checkpoint.traceId ?? session.sessionId,
      undefined,
      { registerActive: false },
    );
    await workspace.releaseLock();
    return { cleaned: 1 };
  } catch (err: unknown) {
    return {
      cleaned: 0,
      error: `checkpoint workspace: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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

/** Clear race fields after apply failure so checkpoint/session are not stuck awaiting judge. */
async function clearRaceCheckpointAfterApplyFailure(session: RaceSession): Promise<string[]> {
  const warnings: string[] = [];
  if (!session.sessionId) return warnings;

  const checkpoint = await loadCheckpoint(session.sessionId);
  if (!checkpoint) {
    warnings.push(`checkpoint not found for session ${session.sessionId}`);
    return warnings;
  }

  const saved = await saveCheckpoint(session.sessionId, {
    ...checkpoint,
    pendingRaceTraceId: undefined,
    raceCandidates: undefined,
    timestamp: new Date().toISOString(),
  });
  if (!saved) {
    warnings.push(`failed to save checkpoint after race apply failure for session ${session.sessionId}`);
  }
  return warnings;
}

async function releaseRaceSessionAfterApplyFailure(
  traceId: string,
  session: RaceSession,
  cleanupErrors: string[],
): Promise<number> {
  let workspacesCleaned = 0;
  const cleanup = await cleanupCandidateWorkspaces(session.candidates);
  workspacesCleaned += cleanup.cleaned;
  cleanupErrors.push(...cleanup.errors);

  cleanupErrors.push(...(await clearRaceCheckpointAfterApplyFailure(session)));

  const traceUpdated = updateTrace(traceId, { finalStatus: "failed" });
  if (!traceUpdated) {
    cleanupErrors.push("Failed to persist trace finalStatus=failed after race apply failure");
    logger.warn("race-finalize", `Trace update failed after race apply failure: ${traceId}`);
  }

  deleteRaceSession(traceId);
  return workspacesCleaned;
}

async function cleanupCandidateWorkspaces(
  candidates: RaceCandidateSnapshot[],
  excludeIndex?: number,
): Promise<{ cleaned: number; errors: string[] }> {
  let cleaned = 0;
  const errors: string[] = [];
  for (let idx = 0; idx < candidates.length; idx++) {
    if (idx === excludeIndex) continue;
    const candidate = candidates[idx]!;
    if (!hasWorkspaceArtifact(candidate)) continue;
    try {
      if (await cleanupCandidateWorkspace(candidate)) cleaned += 1;
    } catch (err: unknown) {
      errors.push(`${candidate.providerName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { cleaned, errors };
}

export async function resolveRaceTraceId(opts: {
  traceId?: string;
  sessionId?: string;
}): Promise<string> {
  if (opts.traceId?.trim()) return opts.traceId.trim();
  if (opts.sessionId?.trim()) {
    const checkpoint = await loadCheckpoint(opts.sessionId.trim());
    if (!checkpoint?.pendingRaceTraceId) {
      throw new Error(
        `Checkpoint ${opts.sessionId} has no pendingRaceTraceId (not awaiting judge or already finalized)`,
      );
    }
    return checkpoint.pendingRaceTraceId;
  }
  throw new Error("Provide traceId or sessionId");
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
    throw new Error(
      `No active race session found for traceId "${traceId}". It may have expired or already been applied.`,
    );
  }
  if (winnerIndex < 0 || winnerIndex >= session.candidates.length) {
    throw new Error(`Invalid winnerIndex ${winnerIndex}. Must be 0-${session.candidates.length - 1}.`);
  }

  const winner = session.candidates[winnerIndex];
  let appliedVia: "workspace" | "patch" = "workspace";
  const cleanupErrors: string[] = [];
  const checkpointCleanup = await applyCheckpointSessionWorkspace(session);
  let workspacesCleaned = checkpointCleanup.cleaned;
  if (checkpointCleanup.error) cleanupErrors.push(checkpointCleanup.error);

  try {
    if (hasWorkspaceArtifact(winner)) {
      const workspace = await resumeCandidateWorkspace(winner);
      try {
        const patch = await workspace.collectPatch();
        await workspace.applyToSource(patch.patch);
      } finally {
        try {
          await workspace.destroy();
          workspacesCleaned += 1;
        } catch (destroyErr: unknown) {
          cleanupErrors.push(
            `${winner.providerName} workspace destroy: ${destroyErr instanceof Error ? destroyErr.message : String(destroyErr)}`,
          );
        }
      }
    } else if (winner.patchText) {
      appliedVia = "patch";
      applyPatchText(session.applyTargetPath, winner.patchText);
    } else {
      throw new Error("Winning candidate did not include workspace metadata or a patch diff to apply.");
    }

    const loserCleanup = await cleanupCandidateWorkspaces(session.candidates, winnerIndex);
    workspacesCleaned += loserCleanup.cleaned;
    cleanupErrors.push(...loserCleanup.errors);

    const traceUpdated = updateTrace(traceId, {
      finalStatus: "approved",
      candidates: session.candidates.map((candidate, idx) => ({
        provider: candidate.providerName,
        durationMs: 0,
        filesModified: candidate.filesModified,
        diffStat: candidate.diffStat,
        isWinner: idx === winnerIndex,
      })),
    });
    if (!traceUpdated) {
      cleanupErrors.push("Failed to persist trace finalStatus=approved");
      logger.warn("race-finalize", `Trace update failed after race apply: ${traceId}`);
      cleanupErrors.push(...(await clearRaceCheckpointAfterApplyFailure(session)));
      deleteRaceSession(traceId);
      throw new Error(
        `Race winner applied to repo but trace persist failed for ${traceId}; repo may contain winner changes — do not call llm_race_apply again`,
      );
    }

    cleanupErrors.push(...(await updateCheckpointAfterRaceDecision(session, "approved")));
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
  } catch (applyErr: unknown) {
    const applyMsg = applyErr instanceof Error ? applyErr.message : String(applyErr);
    cleanupErrors.push(`race apply failed: ${applyMsg}`);
    workspacesCleaned += await releaseRaceSessionAfterApplyFailure(traceId, session, cleanupErrors);
    throw applyErr;
  }
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

  const cleanup = await cleanupCandidateWorkspaces(session.candidates);
  workspacesCleaned += cleanup.cleaned;
  cleanupErrors.push(...cleanup.errors);

  cleanupErrors.push(...(await updateCheckpointAfterRaceDecision(session, "aborted")));

  const traceUpdated = updateTrace(traceId, { finalStatus: "aborted" });
  if (!traceUpdated) {
    cleanupErrors.push("Failed to persist trace finalStatus=aborted");
    logger.warn("race-finalize", `Trace update failed after race abort: ${traceId}`);
  }
  deleteRaceSession(traceId);

  return {
    status: "aborted",
    traceId,
    reason,
    workspacesCleaned,
    cleanupErrors,
  };
}
