/**
 * runoff_query_picks — Query race pick history from ~/.runoff/picks/picks.jsonl.
 *
 * Returns per-provider win statistics and recent pick entries, so users can
 * verify what the system has learned from their race decisions.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPipelineHomeDir } from "../core/paths.js";
import { mcpJson, mcpErrorFrom } from "./mcp-response.js";

interface PickEntry {
  ts: string;
  traceId: string;
  winnerIndex: number;
  winnerProvider: string;
  providers: string[];
}

function loadPicks(): PickEntry[] {
  const path = join(getPipelineHomeDir(), "picks", "picks.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as PickEntry];
      } catch {
        return [];
      }
    });
}

function buildStats(picks: PickEntry[]): Record<string, { wins: number; races: number; winRate: number }> {
  const stats: Record<string, { wins: number; races: number }> = {};
  for (const pick of picks) {
    for (const provider of pick.providers) {
      stats[provider] ??= { wins: 0, races: 0 };
      stats[provider]!.races += 1;
      if (provider === pick.winnerProvider) {
        stats[provider]!.wins += 1;
      }
    }
  }
  return Object.fromEntries(
    Object.entries(stats)
      .sort((a, b) => b[1].wins / b[1].races - a[1].wins / a[1].races)
      .map(([name, s]) => [name, { ...s, winRate: Math.round((s.wins / s.races) * 100) / 100 }]),
  );
}

export function register(server: McpServer) {
  server.tool(
    "runoff_query_picks",
    [
      "Query race pick history (~/.runoff/picks/picks.jsonl).",
      "Returns provider win statistics and recent picks so you can verify what the system",
      "learned from your race decisions. Use format='stats' for win rates, 'entries' for raw picks.",
    ].join(" "),
    {
      format: z
        .enum(["stats", "entries", "both"])
        .optional()
        .describe("Response shape — stats (win rates per provider), entries (raw picks), both (default)"),
      provider: z.string().optional().describe("Filter entries by provider name (winner or participant)"),
      limit: z.number().optional().describe("Max entries to return (most recent first, default 20)"),
      since: z.string().optional().describe("ISO timestamp — entries on or after"),
    },
    async ({ format = "both", provider, limit = 20, since }) => {
      try {
        let picks = loadPicks();

        if (since) {
          const sinceMs = new Date(since).getTime();
          picks = picks.filter((p) => new Date(p.ts).getTime() >= sinceMs);
        }
        if (provider) {
          picks = picks.filter(
            (p) => p.winnerProvider === provider || p.providers.includes(provider),
          );
        }

        const recentEntries = [...picks].reverse().slice(0, limit);
        const stats = buildStats(picks);

        const result: Record<string, unknown> = {
          totalPicks: picks.length,
        };

        if (format === "stats" || format === "both") {
          result.providerStats = stats;
          result.nextRetune = picks.length > 0
            ? `after ${10 - (picks.length % 10)} more picks`
            : "after 10 picks";
        }
        if (format === "entries" || format === "both") {
          result.entries = recentEntries;
        }

        return mcpJson(result);
      } catch (err: unknown) {
        return mcpErrorFrom("query-picks error", err);
      }
    },
  );
}
