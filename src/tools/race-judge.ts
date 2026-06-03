/**
 * runoff_race_judge — Automatically rank race candidates using rubric-based scoring.
 *
 * Given an active race session, generates a rubric from the task description,
 * scores each candidate patch, and returns a ranked result. Optionally applies
 * the winner automatically (autoApply: true).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "../core/config.js";
import { getRaceSession } from "../runtime/race-registry.js";
import { applyRaceSession } from "../runtime/race-finalize.js";
import { judgeRaceCandidates } from "../orchestration/rubric-judge.js";
import { mcpJson, mcpErrorFrom } from "./mcp-response.js";

export function register(server: McpServer) {
  server.tool(
    "runoff_race_judge",
    [
      "Score all candidates in an active race session using rubric-based evaluation",
      "(Scale AI Agentic Rubrics, arXiv 2601.04171). Generates a weighted checklist from",
      "the task description, scores each patch against it, and returns candidates ranked",
      "by weighted score. Set autoApply: true to apply the winner immediately.",
    ].join(" "),
    {
      traceId: z
        .string()
        .describe("The traceId of the active race session (from runoff_run_pipeline)"),
      taskDescription: z
        .string()
        .describe(
          "Natural-language description of what the task requires (issue text, PR description, or prompt). " +
          "Used to generate rubric criteria — be specific.",
        ),
      autoApply: z
        .boolean()
        .optional()
        .describe(
          "If true, automatically apply the highest-scoring candidate. Default false.",
        ),
      excludeProviders: z
        .array(z.string())
        .optional()
        .describe(
          "Provider names to exclude from judging (e.g. the providers that generated the candidates). " +
          "Defaults to the providers that ran in the race, to avoid self-evaluation bias.",
        ),
    },
    async ({ traceId, taskDescription, autoApply = false, excludeProviders }) => {
      try {
        const session = getRaceSession(traceId);
        if (!session) {
          return mcpErrorFrom(
            "Race judge error",
            new Error(
              `No active race session found for traceId "${traceId}". ` +
              "It may have expired or already been finalized.",
            ),
          );
        }

        if (session.candidates.length < 2) {
          return mcpErrorFrom(
            "Race judge error",
            new Error(
              `Race session has only ${session.candidates.length} candidate(s). ` +
              "Judging requires at least 2.",
            ),
          );
        }

        // Collect diffs — prefer patchText, fall back to diffStat as a proxy label
        const candidates = session.candidates.map((c) => ({
          providerName: c.providerName,
          diff: c.patchText ?? c.diffStat ?? "(no diff available)",
        }));

        // By default exclude the providers that ran in the race (avoid self-evaluation)
        const defaultExclusions = session.candidates.map((c) => c.providerName);
        const exclusions = excludeProviders ?? defaultExclusions;

        const config = loadConfig();
        const judgeResult = await judgeRaceCandidates({
          taskDescription,
          candidates,
          config,
          excludeProviders: exclusions,
          // Pass the repo root so an agent-read provider can explore it before rubric generation
          repoPath: session.applyTargetPath,
        });

        let applyResult: Record<string, unknown> | undefined;
        if (autoApply) {
          applyResult = await applyRaceSession(traceId, judgeResult.winnerIndex);
        }

        return mcpJson({
          status: "judged",
          traceId,
          judgeProvider: judgeResult.judgeProvider,
          agenticContext: judgeResult.agenticContext,
          rubricItemCount: judgeResult.rubric.length,
          rubric: judgeResult.rubric,
          ranked: judgeResult.ranked.map((c, rank) => ({
            rank: rank + 1,
            providerName: c.providerName,
            score: Math.round(c.score * 100) / 100,
            items: c.rubricScore.items,
          })),
          winnerIndex: judgeResult.winnerIndex,
          winnerProvider: judgeResult.ranked[0]!.providerName,
          ...(autoApply ? { applied: applyResult } : { applied: false }),
        });
      } catch (err: unknown) {
        return mcpErrorFrom("Race judge error", err);
      }
    },
  );
}
