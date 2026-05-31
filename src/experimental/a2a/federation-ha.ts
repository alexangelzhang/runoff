/**
 * P3 — Federation HA helpers (backup copy + peer health).
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getA2AFederationDir } from "../../core/paths.js";

function federationFilePath(customPath?: string): string {
  return customPath ?? join(getA2AFederationDir(), "agents.json");
}

/** Copy federation store to a backup path (best-effort). */
export function backupFederationStore(storePath?: string, backupPath?: string): boolean {
  if (!backupPath) return false;
  const src = federationFilePath(storePath);
  if (!existsSync(src)) return false;
  try {
    mkdirSync(dirname(backupPath), { recursive: true });
    copyFileSync(src, backupPath);
    return true;
  } catch {
    return false;
  }
}

/** HEAD/GET probe — true when directory endpoint responds 2xx. */
export async function probeFederationPeer(
  baseUrl: string,
  bearerToken?: string,
): Promise<boolean> {
  const url = baseUrl.replace(/\/$/, "") + "/a2a/federation/directory";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;
  try {
    const res = await fetch(url, { method: "GET", headers });
    return res.ok;
  } catch {
    return false;
  }
}

export async function probeFederationPeers(
  peerUrls: string[],
  bearerToken?: string,
): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  await Promise.all(
    peerUrls.map(async (peer) => {
      out[peer] = await probeFederationPeer(peer, bearerToken);
    }),
  );
  return out;
}
