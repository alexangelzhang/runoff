/**
 * Provider circuit breaker primitive — sliding window failure tracking (no I/O).
 */

export type CircuitState = "closed" | "open" | "half-open";

export type CircuitSnapshot = {
  failureTimestamps: number[];
  openedAt?: number;
};

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
  }

  toSnapshot(): CircuitSnapshot {
    this.prune();
    return {
      failureTimestamps: [...this.failureTimestamps],
      openedAt: this.openedAt,
    };
  }

  restoreFromSnapshot(snap: CircuitSnapshot): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    this.failureTimestamps = snap.failureTimestamps.filter((t) => t >= cutoff);
    this.openedAt =
      snap.openedAt !== undefined && now - snap.openedAt < this.cooldownMs * 4
        ? snap.openedAt
        : undefined;
    this.prune(now);
  }
}
