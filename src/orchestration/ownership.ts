/**
 * Workspace ownership / lease registry (Phase 7.4).
 *
 * Complements Python repo locks: TS-side tracking for which agent holds
 * exclusive vs shared access to a workdir key before delegating to CLI.
 */

export type LeaseMode = "exclusive" | "shared";

export interface WorkspaceLease {
  key: string;
  holderId: string;
  mode: LeaseMode;
  acquiredAt: number;
  expiresAt?: number;
}

export class WorkspaceOwnershipRegistry {
  private leases = new Map<string, WorkspaceLease>();

  /**
   * Acquire a lease. Exclusive rejects other holders; shared allows same key with shared mode.
   */
  acquire(
    key: string,
    holderId: string,
    mode: LeaseMode = "exclusive",
    ttlMs?: number,
  ): boolean {
    const existing = this.leases.get(key);
    if (existing && existing.holderId !== holderId) {
      if (existing.mode === "exclusive" || mode === "exclusive") {
        return false;
      }
    }
    const now = Date.now();
    this.leases.set(key, {
      key,
      holderId,
      mode,
      acquiredAt: now,
      expiresAt: ttlMs ? now + ttlMs : undefined,
    });
    return true;
  }

  release(key: string, holderId: string): boolean {
    const lease = this.leases.get(key);
    if (!lease || lease.holderId !== holderId) return false;
    this.leases.delete(key);
    return true;
  }

  getLease(key: string): WorkspaceLease | undefined {
    const lease = this.leases.get(key);
    if (!lease) return undefined;
    if (lease.expiresAt && lease.expiresAt < Date.now()) {
      this.leases.delete(key);
      return undefined;
    }
    return lease;
  }

  /** Remove expired leases; returns count removed. */
  sweepExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, lease] of this.leases) {
      if (lease.expiresAt && lease.expiresAt < now) {
        this.leases.delete(key);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.leases.clear();
  }

  get size(): number {
    return this.leases.size;
  }
}
