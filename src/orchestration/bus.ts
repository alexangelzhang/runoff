/**
 * Message Bus (Wave 7.2).
 *
 * Interface + in-memory implementation for inter-agent messaging.
 * Production deployments should swap InMemoryMessageBus for a durable adapter.
 */

import type { AgentId } from "./multi-agent-types.js";
import type { AgentMessage, AgentMessageType } from "./messages.js";
import { randomUUID } from "node:crypto";

// --- Subscription ---

export type MessageHandler = (message: AgentMessage) => void | Promise<void>;

export interface MessageSubscription {
  unsubscribe(): void;
}

// --- Query ---

export interface MessageQuery {
  from?: AgentId;
  to?: AgentId;
  type?: AgentMessageType;
  correlationId?: string;
  since?: number;
  limit?: number;
}

// --- Bus Interface ---

export interface MessageBus {
  /** Send a message. Assigns id and timestamp if not set. */
  send(message: Omit<AgentMessage, "id" | "timestamp"> & { id?: string; timestamp?: number }): AgentMessage;

  /** Subscribe to messages directed at a specific agent. */
  subscribe(agentId: AgentId, handler: MessageHandler): MessageSubscription;

  /** Subscribe to all messages (for logging/tracing). */
  subscribeAll(handler: MessageHandler): MessageSubscription;

  /** Query message history. */
  query(q: MessageQuery): AgentMessage[];

  /** Total messages sent through this bus. */
  readonly messageCount: number;

  /** Clear all messages and subscriptions. */
  clear(): void;
}

// --- In-Memory Implementation ---

export class InMemoryMessageBus implements MessageBus {
  private messages: AgentMessage[] = [];
  private agentHandlers = new Map<string, Set<MessageHandler>>();
  private globalHandlers = new Set<MessageHandler>();

  send(partial: Omit<AgentMessage, "id" | "timestamp"> & { id?: string; timestamp?: number }): AgentMessage {
    const message = {
      ...partial,
      id: partial.id ?? randomUUID().slice(0, 12),
      timestamp: partial.timestamp ?? Date.now(),
    } as AgentMessage;

    this.messages.push(message);

    // Notify target agent subscribers
    const handlers = this.agentHandlers.get(message.to);
    if (handlers) {
      for (const h of handlers) h(message);
    }

    // Notify global subscribers
    for (const h of this.globalHandlers) h(message);

    return message;
  }

  subscribe(agentId: AgentId, handler: MessageHandler): MessageSubscription {
    let handlers = this.agentHandlers.get(agentId);
    if (!handlers) {
      handlers = new Set();
      this.agentHandlers.set(agentId, handlers);
    }
    handlers.add(handler);

    return {
      unsubscribe: () => {
        handlers!.delete(handler);
        if (handlers!.size === 0) this.agentHandlers.delete(agentId);
      },
    };
  }

  subscribeAll(handler: MessageHandler): MessageSubscription {
    this.globalHandlers.add(handler);
    return {
      unsubscribe: () => { this.globalHandlers.delete(handler); },
    };
  }

  query(q: MessageQuery): AgentMessage[] {
    let results = this.messages;

    if (q.from) results = results.filter((m) => m.from === q.from);
    if (q.to) results = results.filter((m) => m.to === q.to);
    if (q.type) results = results.filter((m) => m.type === q.type);
    if (q.correlationId) results = results.filter((m) => m.correlationId === q.correlationId);
    if (q.since) results = results.filter((m) => m.timestamp >= q.since!);
    if (q.limit) results = results.slice(0, q.limit);

    return results;
  }

  get messageCount(): number {
    return this.messages.length;
  }

  clear(): void {
    this.messages = [];
    this.agentHandlers.clear();
    this.globalHandlers.clear();
  }
}
