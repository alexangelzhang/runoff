/**
 * Artifact ↔ Workspace bridge (Phase 4.1).
 *
 * SharedContext / step results produce typed artifacts; workspace applies
 * physical patches to the source repo.
 */

import type { SessionWorkspace } from "../runtime/workspace.js";
import type { Artifact, PatchArtifact } from "./artifacts.js";
import {
  createPatchArtifact,
  isDiffArtifact,
  isPatchArtifact,
} from "./artifacts.js";
import type { SharedContext } from "./shared-context.js";
import type { AgentId } from "./multi-agent-types.js";
import type { StepResult } from "../core/state.js";

export type WorkspaceApplyMethod = "patch-artifact" | "collect-patch" | "noop";

export interface WorkspaceApplyResult {
  method: WorkspaceApplyMethod;
  patchArtifact?: PatchArtifact;
}

/** Collect worktree diff and materialize a PatchArtifact. */
export async function capturePatchArtifactFromWorkspace(
  workspace: SessionWorkspace,
  producedBy?: string,
): Promise<PatchArtifact | undefined> {
  const collected = await workspace.collectPatch();
  if (!collected.patch.length) return undefined;
  return createPatchArtifact(
    collected.patch.toString("base64"),
    workspace.baseRef,
    collected.filesModified,
    collected.diffStat,
    { producedBy },
  );
}

/** Apply a PatchArtifact to the source repository. */
export async function applyPatchArtifactToSource(
  workspace: SessionWorkspace,
  artifact: PatchArtifact,
): Promise<void> {
  const patch = Buffer.from(artifact.patchBase64, "base64");
  if (!patch.length) return;
  await workspace.applyToSource(patch);
}

/** Prefer the latest patch artifact in the list. */
export function selectPatchArtifact(artifacts: readonly Artifact[]): PatchArtifact | undefined {
  for (let i = artifacts.length - 1; i >= 0; i--) {
    const a = artifacts[i];
    if (a && isPatchArtifact(a)) return a;
  }
  return undefined;
}

/** Gather artifacts from shared context and per-step results. */
export function collectRunArtifacts(input: {
  sharedContext?: SharedContext;
  stepResults?: Record<string, StepResult>;
}): Artifact[] {
  const out: Artifact[] = [];
  if (input.sharedContext) {
    out.push(...input.sharedContext.getMainArtifacts());
  }
  if (input.stepResults) {
    for (const sr of Object.values(input.stepResults)) {
      if (sr.artifacts?.length) out.push(...sr.artifacts);
    }
  }
  return out;
}

/**
 * Finalize pipeline workspace using artifact layer when possible.
 * 1. PatchArtifact → decode and apply
 * 2. DiffArtifact(s) present → collect patch from worktree and apply
 * 3. Otherwise noop (caller may still destroy workspace)
 */
export async function applyWorkspaceFromArtifacts(
  workspace: SessionWorkspace,
  artifacts: readonly Artifact[],
): Promise<WorkspaceApplyResult> {
  const patchArt = selectPatchArtifact(artifacts);
  if (patchArt) {
    await applyPatchArtifactToSource(workspace, patchArt);
    return { method: "patch-artifact", patchArtifact: patchArt };
  }

  if (artifacts.some(isDiffArtifact)) {
    await workspace.applyToSource();
    const captured = await capturePatchArtifactFromWorkspace(workspace);
    return { method: "collect-patch", patchArtifact: captured };
  }

  const collected = await workspace.collectPatch();
  if (collected.patch.length > 0) {
    await workspace.applyToSource(collected.patch);
    const captured = await createPatchArtifact(
      collected.patch.toString("base64"),
      workspace.baseRef,
      collected.filesModified,
      collected.diffStat,
    );
    return { method: "collect-patch", patchArtifact: captured };
  }

  return { method: "noop" };
}

/** Snapshot workspace patch into shared context (pick-winner merge). */
export async function recordWorkspacePatchInSharedContext(
  shared: SharedContext,
  workspace: SessionWorkspace,
  ownerId: AgentId,
): Promise<PatchArtifact | undefined> {
  const artifact = await capturePatchArtifactFromWorkspace(workspace, ownerId);
  if (!artifact) return undefined;

  let branch = shared.getBranchesForAgent(ownerId).find((b) => !b.merged);
  if (!branch) {
    branch = shared.createBranch(ownerId);
  }
  shared.addArtifact(branch.branchId, artifact, artifact.filesModified);
  shared.merge(branch.branchId, "pick-winner");
  return artifact;
}
