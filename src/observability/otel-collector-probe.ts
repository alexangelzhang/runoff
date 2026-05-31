/**
 * Probe OTLP/HTTP collector reachability (TCP + optional export smoke).
 */

import { connect } from "node:net";

export function parseOtlpHttpEndpoint(endpoint: string): { host: string; port: number } {
  const url = new URL(endpoint.includes("://") ? endpoint : `http://${endpoint}`);
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 4318;
  return { host: url.hostname || "127.0.0.1", port };
}

/** True if something accepts TCP on the OTLP HTTP port. */
export function probeOtlpTcp(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: timeoutMs }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}
