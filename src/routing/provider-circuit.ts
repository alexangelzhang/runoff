/**
 * Provider circuit breaker — re-exports primitive + global registry.
 */

export {
  ProviderCircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitSnapshot,
  type CircuitState,
} from "./provider-circuit-breaker.js";

export {
  getProviderCircuit,
  isProviderAvailable,
  recordProviderOutcome,
  resetProviderCircuits,
  restoreProviderCircuitPersistenceState,
  enableProviderCircuitPersistence,
} from "./provider-circuit-registry.js";
