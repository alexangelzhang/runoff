import type { PipelineStatus } from "../core/state.js";

/**
 * Only successful review completion should merge agent worktree into the source repo and remove the worktree.
 * Other outcomes keep the worktree so checkpoint resume can reattach to the same path (issue 6.6).
 */
export function shouldFinalizeAgentWorkspace(finalStatus: PipelineStatus): boolean {
  return finalStatus === "approved";
}
