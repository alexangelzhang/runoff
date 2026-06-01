import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ProviderCircuitBreaker,
  getProviderCircuit,
  isProviderAvailable,
  recordProviderOutcome,
  resetProviderCircuits,
  restoreProviderCircuitPersistenceState,
} from "../../src/routing/provider-circuit.ts";

test.afterEach(() => {
  resetProviderCircuits();
  restoreProviderCircuitPersistenceState();
});

test("ProviderCircuitBreaker: opens after threshold failures in window", () => {
  const cb = new ProviderCircuitBreaker({ failureThreshold: 2, windowMs: 60_000, cooldownMs: 1000 });
  assert.equal(cb.state, "closed");
  cb.recordFailure();
  assert.equal(cb.state, "closed");
  cb.recordFailure();
  assert.equal(cb.state, "open");
  assert.equal(cb.isAllowed(), false);
});

test("ProviderCircuitBreaker: success resets circuit", () => {
  const cb = new ProviderCircuitBreaker({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 60_000 });
  cb.recordFailure();
  assert.equal(cb.state, "open");
  cb.recordSuccess();
  assert.equal(cb.state, "closed");
  assert.equal(cb.isAllowed(), true);
});

test("ProviderCircuitBreaker: half-open after cooldown", () => {
  const cb = new ProviderCircuitBreaker({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 5 });
  cb.recordFailure();
  assert.equal(cb.state, "open");
  const start = Date.now();
  while (cb.state === "open" && Date.now() - start < 50) {
    /* spin until cooldown */
  }
  assert.equal(cb.state, "half-open");
  assert.equal(cb.isAllowed(), true);
});

test("ProviderCircuitBreaker: failure while half-open reopens circuit", () => {
  const cb = new ProviderCircuitBreaker({ failureThreshold: 1, windowMs: 60_000, cooldownMs: 5 });
  cb.recordFailure();
  const start = Date.now();
  while (cb.state !== "half-open" && Date.now() - start < 50) {
    /* wait cooldown */
  }
  assert.equal(cb.state, "half-open");
  cb.recordFailure();
  assert.equal(cb.state, "open");
  assert.equal(cb.isAllowed(), false);
});

test("isProviderAvailable + recordProviderOutcome: global registry", () => {
  assert.equal(isProviderAvailable("p-a"), true);
  recordProviderOutcome("p-a", false);
  recordProviderOutcome("p-a", false);
  recordProviderOutcome("p-a", false);
  assert.equal(isProviderAvailable("p-a"), false);
  recordProviderOutcome("p-a", true);
  assert.equal(isProviderAvailable("p-a"), true);
});

test("getProviderCircuit: reuses breaker per provider name", () => {
  const a = getProviderCircuit("shared");
  const b = getProviderCircuit("shared");
  assert.equal(a, b);
});

test("open provider circuit persists under RUNOFF_HOME", async () => {
  const home = mkdtempSync(join(tmpdir(), "lp-circuit-persist-"));
  const prevHome = process.env.RUNOFF_HOME;
  process.env.RUNOFF_HOME = home;
  try {
    resetProviderCircuits();
    restoreProviderCircuitPersistenceState();
    recordProviderOutcome("persist-provider", false);
    recordProviderOutcome("persist-provider", false);
    recordProviderOutcome("persist-provider", false);
    assert.equal(isProviderAvailable("persist-provider"), false);

    const file = join(home, "provider-circuits.json");
    assert.ok(existsSync(file));
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    assert.ok(raw["persist-provider"]);

    resetProviderCircuits();
    restoreProviderCircuitPersistenceState();
    assert.equal(isProviderAvailable("persist-provider"), false);
  } finally {
    if (prevHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    resetProviderCircuits();
  }
});

test("restoreProviderCircuitPersistenceState clears in-memory circuits", () => {
  const home = mkdtempSync(join(tmpdir(), "circuit-restore-"));
  const prevHome = process.env.RUNOFF_HOME;
  process.env.RUNOFF_HOME = home;
  try {
    resetProviderCircuits();
    restoreProviderCircuitPersistenceState();
    recordProviderOutcome("p-leak", false);
    recordProviderOutcome("p-leak", false);
    recordProviderOutcome("p-leak", false);
    assert.equal(isProviderAvailable("p-leak"), false);
    restoreProviderCircuitPersistenceState();
    const circuitFile = join(home, "provider-circuits.json");
    if (existsSync(circuitFile)) rmSync(circuitFile);
    assert.equal(isProviderAvailable("p-leak"), true);
  } finally {
    if (prevHome === undefined) delete process.env.RUNOFF_HOME;
    else process.env.RUNOFF_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    resetProviderCircuits();
  }
});
