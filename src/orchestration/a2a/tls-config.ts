/**
 * Phase 7.9 — TLS / mTLS options for A2A HTTP transport.
 */

import { readFileSync } from "node:fs";
import type { ServerOptions } from "node:https";
import type { RequestOptions } from "node:https";

export interface A2AServerTlsConfig {
  certPath: string;
  keyPath: string;
  /** CA for validating client certs when requestClientCert is true. */
  caPath?: string;
  requestClientCert?: boolean;
}

export interface A2AClientTlsConfig {
  certPath?: string;
  keyPath?: string;
  caPath?: string;
  rejectUnauthorized?: boolean;
}

function readOpt(path: string | undefined): Buffer | undefined {
  if (!path) return undefined;
  return readFileSync(path);
}

/** Build Node https server options; returns null when TLS is not configured. */
export function loadServerTlsOptions(
  tls: A2AServerTlsConfig | undefined,
): ServerOptions | null {
  if (!tls?.certPath || !tls.keyPath) return null;
  const cert = readFileSync(tls.certPath);
  const key = readFileSync(tls.keyPath);
  const ca = readOpt(tls.caPath);
  const opts: ServerOptions = { cert, key };
  if (ca) opts.ca = ca;
  if (tls.requestClientCert) {
    opts.requestCert = true;
    opts.rejectUnauthorized = true;
  }
  return opts;
}

/** Attach client cert options to https.request. */
export function applyClientTlsToRequest(
  reqOpts: RequestOptions,
  tls: A2AClientTlsConfig | undefined,
): RequestOptions {
  if (!tls) return reqOpts;
  const cert = readOpt(tls.certPath);
  const key = readOpt(tls.keyPath);
  const ca = readOpt(tls.caPath);
  if (cert) reqOpts.cert = cert;
  if (key) reqOpts.key = key;
  if (ca) reqOpts.ca = ca;
  if (tls.rejectUnauthorized !== undefined) {
    reqOpts.rejectUnauthorized = tls.rejectUnauthorized;
  }
  return reqOpts;
}
