/**
 * Shared remote memory client interface (HTTP / Mem0 / Zep).
 */

import type { MemoryEntry, MemoryQuery } from "./memory.js";

export interface RemoteMemoryClient {
  push(entry: MemoryEntry): Promise<void>;
  search(query: MemoryQuery): Promise<MemoryEntry[]>;
}
