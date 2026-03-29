/**
 * llm_race_apply + llm_race_abort — Race session finalization tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { updateTrace } from "../trace.js";
import { raceSessions, type RaceCandidateSnapshot } from "../race-registry.js";
import { SessionWorkspace } from "../workspace.js";

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
  );
}

async function cleanupCandidateWorkspace(candidate: RaceCandidateSnapshot): Promise<boolean> {
  if (!hasWorkspaceArtifact(candidate)) return false;
  const workspace = await resumeCandidateWorkspace(candidate);
  await workspace.destroy();
  return true;
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
  const session = raceSessions.get(traceId);
  if (!session) {
    throw new Error(`No active race session found for traceId "${traceId}". It may have expired or already been applied.`);
  }
  if (winnerIndex < 0 || winnerIndex >= session.candidates.length) {
    throw new Error(`Invalid winnerIndex ${winnerIndex}. Must be 0-${session.candidates.length - 1}.`);
  }

  const winner = session.candidates[winnerIndex];
  let appliedVia: "workspace" | "patch" = "workspace";
  const cleanupErrors: string[] = [];
  let workspacesCleaned = 0;

  try {
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
      if (idx == winnerIndex) continue;
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

    updateTrace(traceId, {
      finalStatus: "approved",
      candidates: session.candidates.map((c: RaceCandidateSnapshot, idx: number) => ({
        provider: c.providerName,
        durationMs: 0,
        filesModified: c.filesModified,
        diffStat: c.diffStat,
        isWinner: idx === winnerIndex,
      })),
    });

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
  } finally {
    raceSessions.delete(traceId);
  }
}

export async function abortRaceSession(traceId: string, reason?: string): Promise<{
  status: "aborted";
  traceId: string;
  reason?: string;
  workspacesCleaned: number;
  cleanupErrors: string[];
}> {
  const session = raceSessions.get(traceId);
  if (!session) {
    throw new Error(`No active race session found for traceId "${traceId}". It may have expired.`);
  }

  let workspacesCleaned = 0;
  const cleanupErrors: string[] = [];
  try {
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

    updateTrace(traceId, {
      finalStatus: "aborted",
    });

    return {
      status: "aborted",
      traceId,
      reason,
      workspacesCleaned,
      cleanupErrors,
    };
  } finally {
    raceSessions.delete(traceId);
  }
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
