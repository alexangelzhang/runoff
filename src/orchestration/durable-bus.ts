/**
 * File-backed MessageBus (Gate 2.3 — persist + query after restart).
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import type { AgentId } from "./multi-agent-types.js";
import type { AgentMessage, AgentMessageType } from "./messages.js";
import { appendJsonl, readJsonl } from "./durable-io.js";
import type { MessageBus, MessageHandler, MessageQuery, MessageSubscription } from "./bus.js";

export class FileMessageBus implements MessageBus {
  private readonly logPath: string;
  private messages: AgentMessage[] = [];
  private agentHandlers = new Map<string, Set<MessageHandler>>();
  private globalHandlers = new Set<MessageHandler>();

  constructor(logPath: string) {
    this.logPath = logPath;
    this.reload();
  }

  private reload(): void {
    this.messages = readJsonl<AgentMessage>(this.logPath);
  }

  send(partial: Omit<AgentMessage, "id" | "timestamp"> & { id?: string; timestamp?: number }): AgentMessage {
    const message = {
      ...partial,
      id: partial.id ?? randomUUID().slice(0, 12),
      timestamp: partial.timestamp ?? Date.now(),
    } as AgentMessage;

    this.messages.push(message);
    appendJsonl(this.logPath, message);

    const handlers = this.agentHandlers.get(message.to);
    if (handlers) {
      for (const h of handlers) h(message);
    }
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
    return { unsubscribe: () => { this.globalHandlers.delete(handler); } };
  }

  query(q: MessageQuery): AgentMessage[] {
    let results = [...this.messages];
    if (q.from) results = results.filter((m) => m.from === q.from);
    if (q.to) results = results.filter((m) => m.to === q.to);
    if (q.type) results = results.filter((m) => m.type === q.type);
    if (q.correlationId) results = results.filter((m) => m.correlationId === q.correlationId);
    if (q.since) results = results.filter((m) => m.timestamp >= q.since!);
    results.sort((a, b) => a.timestamp - b.timestamp);
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
    if (existsSync(this.logPath)) unlinkSync(this.logPath);
  }
}
