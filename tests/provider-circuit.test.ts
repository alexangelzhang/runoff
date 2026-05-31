import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderCircuitBreaker,
  getProviderCircuit,
  isProviderAvailable,
  recordProviderOutcome,
  resetProviderCircuits,
} from "../src/routing/provider-circuit.ts";

test.afterEach(() => {
  resetProviderCircuits();
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
