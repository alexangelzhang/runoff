import assert from "node:assert/strict";
import test from "node:test";
import { agentId } from "../src/orchestration/multi-agent-types.ts";
import { HttpA2ATransport } from "../src/orchestration/a2a/http-transport.ts";

const A = agentId("agent-a");
const B = agentId("agent-b");

test("HttpA2ATransport: POST deliver + handler", async () => {
  const transport = new HttpA2ATransport();
  await transport.start();

  let received = "";
  transport.onMessage(B, async (msg) => {
    received = String((msg.payload as { text?: string })?.text ?? "");
    return { ok: true };
  });

  await transport.send({
    id: "",
    from: A,
    to: B,
    method: "task",
    payload: { text: "hello-http" },
    timestamp: 0,
  });

  assert.equal(received, "hello-http");
  assert.equal(transport.getMessageLog().length, 1);
  await transport.stop();
});

test("HttpA2ATransport: SSE stream receives message", async () => {
  const transport = new HttpA2ATransport();
  const { url } = await transport.start();

  const events: string[] = [];
  const ac = new AbortController();
  const sseTask = (async () => {
    const res = await fetch(`${url}/a2a/agents/${encodeURIComponent(B)}/events`, {
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    while (events.length < 1) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value);
      if (chunk.includes("data:")) events.push(chunk);
    }
  })();

  transport.onMessage(B, async () => ({ ok: true }));
  await transport.send({
    id: "",
    from: A,
    to: B,
    method: "ping",
    payload: { n: 1 },
    timestamp: 0,
  });

  await new Promise((r) => setTimeout(r, 100));
  ac.abort();
  await sseTask.catch(() => {});

  assert.ok(events.some((e) => e.includes("ping")));
  await transport.stop();
});
