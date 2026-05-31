/**
 * Provider circuit breaker (Phase 5.2) — sliding window failure tracking.
 */

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  windowMs?: number;
  cooldownMs?: number;
}

export class ProviderCircuitBreaker {
  private failureTimestamps: number[] = [];
  private openedAt?: number;
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.windowMs = options.windowMs ?? 60_000;
    this.cooldownMs = options.cooldownMs ?? 30_000;
  }

  get state(): CircuitState {
    this.prune();
    if (this.openedAt === undefined) return "closed";
    if (Date.now() - this.openedAt >= this.cooldownMs) return "half-open";
    return "open";
  }

  isAllowed(): boolean {
    const s = this.state;
    return s === "closed" || s === "half-open";
  }

  recordSuccess(): void {
    this.failureTimestamps = [];
    this.openedAt = undefined;
  }

  recordFailure(): void {
    const now = Date.now();
    this.failureTimestamps.push(now);
    this.prune(now);
    if (this.failureTimestamps.length >= this.failureThreshold) {
      this.openedAt = now;
    }
  }

  private prune(now = Date.now()): void {
    const cutoff = now - this.windowMs;
    this.failureTimestamps = this.failureTimestamps.filter((t) => t >= cutoff);
    if (this.openedAt !== undefined && this.failureTimestamps.length < this.failureThreshold) {
      if (now - this.openedAt >= this.cooldownMs) {
        // half-open: keep openedAt until success clears
      }
    }
  }
}

const circuits = new Map<string, ProviderCircuitBreaker>();

export function getProviderCircuit(
  providerName: string,
  options?: CircuitBreakerOptions,
): ProviderCircuitBreaker {
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
  if (ok) circuit.recordSuccess();
  else circuit.recordFailure();
}

/** Test helper — reset all circuits. */
export function resetProviderCircuits(): void {
  circuits.clear();
}
