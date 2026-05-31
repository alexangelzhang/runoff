/**
 * A2A Transport Layer (Wave 7.9).
 *
 * Pluggable transport for A2A communication.
 * Reference: Google Agent2Agent Protocol — HTTP/SSE transport.
 *
 * In production, this would use HTTP + SSE for real network communication.
 * The in-memory transport is provided for testing and local multi-agent runs.
 */

import type { AgentId } from "../../orchestration/multi-agent-types.js";

// --- Transport Message ---

export interface A2ATransportMessage {
  id: string;
  from: AgentId;
  to: AgentId;
  method: string;
  payload: unknown;
  timestamp: number;
}

// --- Transport Interface ---

export interface A2ATransport {
  /** Send a message to another agent. */
  send(message: A2ATransportMessage): Promise<void>;
  /** Register a handler for incoming messages. */
  onMessage(agentId: AgentId, handler: (message: A2ATransportMessage) => Promise<unknown>): void;
  /** Remove handler. */
  offMessage(agentId: AgentId): void;
}

// --- In-Memory Transport ---

/**
 * In-memory transport for local/testing use.
 * Messages are delivered synchronously within the same process.
 */
export class InMemoryA2ATransport implements A2ATransport {
  private handlers = new Map<string, (message: A2ATransportMessage) => Promise<unknown>>();
  private messageLog: A2ATransportMessage[] = [];
  private nextId = 1;

  async send(message: A2ATransportMessage): Promise<void> {
    if (!message.id) {
      message.id = `a2a-msg-${this.nextId++}`;
    }
    if (!message.timestamp) {
      message.timestamp = Date.now();
    }
    this.messageLog.push(message);

    const handler = this.handlers.get(message.to);
    if (handler) {
      await handler(message);
    }
    // If no handler, message is silently queued (fire-and-forget).
  }

  onMessage(agentId: AgentId, handler: (message: A2ATransportMessage) => Promise<unknown>): void {
    this.handlers.set(agentId, handler);
  }

  offMessage(agentId: AgentId): void {
    this.handlers.delete(agentId);
  }

  /** Get all messages (for testing/debugging). */
  getMessageLog(): readonly A2ATransportMessage[] {
    return this.messageLog;
  }

  /** Get messages for a specific agent. */
  getMessagesFor(agentId: AgentId): A2ATransportMessage[] {
    return this.messageLog.filter((m) => m.to === agentId);
  }

  /** Get messages from a specific agent. */
  getMessagesFrom(agentId: AgentId): A2ATransportMessage[] {
    return this.messageLog.filter((m) => m.from === agentId);
  }

  /** Number of messages sent. */
  get messageCount(): number {
    return this.messageLog.length;
  }

  /** Clear all state. */
  clear(): void {
    this.handlers.clear();
    this.messageLog = [];
    this.nextId = 1;
  }
}
