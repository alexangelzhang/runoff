/**
 * Global provider circuit registry with cross-process disk persistence.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getPipelineHomeDir } from "../core/paths.js";
import { logger } from "../core/logger.js";
import {
  ProviderCircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitSnapshot,
} from "./provider-circuit-breaker.js";

function circuitsFilePath(): string {
  return join(getPipelineHomeDir(), "provider-circuits.json");
}

let diskLoadedOnce = false;
let lastDiskMtimeMs = 0;
let persistToDisk = true;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

const circuits = new Map<string, ProviderCircuitBreaker>();

function readCircuitsPayload(path: string): Record<string, CircuitSnapshot> {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, CircuitSnapshot>;
  } catch {
    return {};
  }
}

function syncCircuitsFromDisk(): void {
  if (!persistToDisk) return;
  const path = circuitsFilePath();
  if (!existsSync(path)) {
    if (lastDiskMtimeMs !== 0) {
      for (const circuit of circuits.values()) {
        circuit.recordSuccess();
      }
    }
    lastDiskMtimeMs = 0;
    return;
  }

  let mtime = 0;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    return;
  }
  if (diskLoadedOnce && mtime === lastDiskMtimeMs) return;

  lastDiskMtimeMs = mtime;
  diskLoadedOnce = true;
  const payload = readCircuitsPayload(path);

  for (const [name, snap] of Object.entries(payload)) {
    let circuit = circuits.get(name);
    if (!circuit) {
      circuit = new ProviderCircuitBreaker();
      circuits.set(name, circuit);
    }
    circuit.restoreFromSnapshot(snap);
  }

  for (const [name, circuit] of circuits) {
    if (!(name in payload)) {
      circuit.recordSuccess();
    }
  }
}

function schedulePersist(): void {
  if (!persistToDisk) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    safeFlushCircuitsToDisk();
  }, 400);
}

function safeFlushCircuitsToDisk(): void {
  try {
    flushCircuitsToDisk();
  } catch (err: unknown) {
    logger.warn(
      "provider-circuit",
      `Failed to persist circuits: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function flushCircuitsToDisk(): void {
  if (!persistToDisk) return;
  const path = circuitsFilePath();
  const payload: Record<string, CircuitSnapshot> = existsSync(path) ? readCircuitsPayload(path) : {};
  for (const [name, circuit] of circuits) {
    if (circuit.state !== "closed") {
      payload[name] = circuit.toSnapshot();
    } else {
      delete payload[name];
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmpFile = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(payload, null, 2));
  renameSync(tmpFile, path);
  try {
    lastDiskMtimeMs = statSync(path).mtimeMs;
    diskLoadedOnce = true;
  } catch {
    // best-effort mtime cache
  }
}

export function getProviderCircuit(
  providerName: string,
  options?: CircuitBreakerOptions,
): ProviderCircuitBreaker {
  syncCircuitsFromDisk();
  let circuit = circuits.get(providerName);
  if (!circuit) {
    circuit = new ProviderCircuitBreaker(options);
    circuits.set(providerName, circuit);
  }
  return circuit;
}

export function isProviderAvailable(providerName: string): boolean {
  return getProviderCircuit(providerName).isAllowed();
}

export function recordProviderOutcome(providerName: string, ok: boolean): void {
  const circuit = getProviderCircuit(providerName);
  const stateBefore = circuit.state;
  if (ok) circuit.recordSuccess();
  else circuit.recordFailure();
  const stateAfter = circuit.state;
  if (stateAfter === "open" && stateBefore !== "open") {
    safeFlushCircuitsToDisk();
  } else {
    schedulePersist();
  }
}

/** Test helper — reset in-memory circuits; skips disk load/persist until re-enabled. */
export function resetProviderCircuits(): void {
  circuits.clear();
  diskLoadedOnce = false;
  lastDiskMtimeMs = 0;
  persistToDisk = false;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
}

/** Restore default persistence after test isolation (call from test afterEach). */
export function restoreProviderCircuitPersistenceState(): void {
  circuits.clear();
  persistToDisk = true;
  diskLoadedOnce = false;
  lastDiskMtimeMs = 0;
}

/** @deprecated Use restoreProviderCircuitPersistenceState */
export function enableProviderCircuitPersistence(): void {
  restoreProviderCircuitPersistenceState();
}
