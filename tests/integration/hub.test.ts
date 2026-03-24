import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { Subprocess } from "bun";
import type { HandshakePayload, MeetingMessage, WsEnvelope } from "../../src/types.ts";

const MEETING_ID = `test-hub-${Date.now()}`;
const PORT_FILE = `/tmp/elrond-${MEETING_ID}.port`;
let hubProc: Subprocess;
let port: number;

async function waitForPort(file: string, timeoutMs = 10_000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(file)) {
      const p = Number(readFileSync(file, "utf8").trim());
      if (p > 0) return p;
    }
    await Bun.sleep(100);
  }
  throw new Error("Timeout waiting for Hub port");
}

function hubUrl(path: string) {
  return `http://127.0.0.1:${port}${path}`;
}

beforeAll(async () => {
  hubProc = Bun.spawn(["bun", "run", resolve(__dirname, "../../src/hub.ts")], {
    env: { ...process.env, ELROND_MEETING_ID: MEETING_ID },
    stdout: "pipe",
    stderr: "pipe",
  });
  port = await waitForPort(PORT_FILE);
});

afterAll(() => {
  hubProc.kill();
  try {
    unlinkSync(PORT_FILE);
  } catch {}
});

describe("Hub REST API", () => {
  test("GET /api/status returns meeting info", async () => {
    const resp = await fetch(hubUrl("/api/status"));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { meetingId: string };
    expect(data.meetingId).toBe(MEETING_ID);
  });

  test("POST /api/message creates and returns message", async () => {
    const resp = await fetch(hubUrl("/api/message"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Hello from Frodo",
        sender: { id: "frodo", name: "Frodo" },
      }),
    });
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as { message: MeetingMessage };
    expect(data.message.content).toBe("Hello from Frodo");
    expect(data.message.type).toBe("user");
    expect(data.message.id).toBeTruthy();
  });

  test("GET /api/messages returns posted message", async () => {
    const resp = await fetch(hubUrl("/api/messages?limit=10"));
    const data = (await resp.json()) as { messages: MeetingMessage[] };
    expect(data.messages.length).toBeGreaterThan(0);
    expect(data.messages.some((m) => m.content === "Hello from Frodo")).toBe(true);
  });

  test("POST /api/message rejects empty body", async () => {
    const resp = await fetch(hubUrl("/api/message"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "", sender: { id: "" } }),
    });
    expect(resp.status).toBe(400);
  });
});

describe("Hub WebSocket", () => {
  test("handshake + broadcast flow", async () => {
    // Connect two WebSocket clients
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    const ws1Messages: WsEnvelope[] = [];
    const ws2Messages: WsEnvelope[] = [];

    await new Promise<void>((resolve) => {
      ws1.addEventListener("open", () => {
        ws1.send(
          JSON.stringify({
            type: "handshake",
            payload: {
              clientType: "agent",
              agentId: "test-a1",
              agentName: "TestAgent1",
            } satisfies HandshakePayload,
            ts: Date.now(),
          } satisfies WsEnvelope),
        );
      });
      ws2.addEventListener("open", () => {
        ws2.send(
          JSON.stringify({
            type: "handshake",
            payload: {
              clientType: "agent",
              agentId: "test-a2",
              agentName: "TestAgent2",
            } satisfies HandshakePayload,
            ts: Date.now(),
          } satisfies WsEnvelope),
        );
      });

      ws1.addEventListener("message", (e) => {
        ws1Messages.push(JSON.parse(String(e.data)));
      });
      ws2.addEventListener("message", (e) => {
        ws2Messages.push(JSON.parse(String(e.data)));
      });

      // Wait for both to connect
      setTimeout(resolve, 500);
    });

    // ws1 should have received handshake_ack
    expect(ws1Messages.some((m) => m.type === "handshake_ack")).toBe(true);

    // Post a message via REST — both should receive broadcast
    const beforeCount1 = ws1Messages.length;
    const beforeCount2 = ws2Messages.length;

    await fetch(hubUrl("/api/message"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Broadcast test",
        sender: { id: "frodo", name: "Frodo" },
      }),
    });

    await Bun.sleep(200);

    const newMsgs1 = ws1Messages.slice(beforeCount1);
    const newMsgs2 = ws2Messages.slice(beforeCount2);
    expect(newMsgs1.some((m) => m.type === "message_broadcast")).toBe(true);
    expect(newMsgs2.some((m) => m.type === "message_broadcast")).toBe(true);

    ws1.close();
    ws2.close();
  });

  test("gap recovery: sync_complete with lastSeenUlid", async () => {
    // Post some messages first
    for (let i = 0; i < 3; i++) {
      await fetch(hubUrl("/api/message"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `Gap test msg ${i}`,
          sender: { id: "system", name: "System" },
        }),
      });
    }

    // Get all messages to find a ULID
    const resp = await fetch(hubUrl("/api/messages?limit=100"));
    const data = (await resp.json()) as { messages: MeetingMessage[] };
    const secondLast = data.messages[data.messages.length - 2];

    // Connect with lastSeenUlid
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const received: WsEnvelope[] = [];

    await new Promise<void>((resolve) => {
      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            type: "handshake",
            payload: {
              clientType: "viewer",
              lastSeenUlid: secondLast?.id,
            } satisfies HandshakePayload,
            ts: Date.now(),
          } satisfies WsEnvelope),
        );
      });
      ws.addEventListener("message", (e) => {
        received.push(JSON.parse(String(e.data)));
      });
      setTimeout(resolve, 500);
    });

    // Should receive replay messages + sync_complete
    const replays = received.filter((m) => m.type === "replay");
    const syncComplete = received.find((m) => m.type === "sync_complete");
    expect(syncComplete).toBeTruthy();
    expect(replays.length).toBeGreaterThanOrEqual(1);

    ws.close();
  });

  test("WS send_message from agent is broadcast to others", async () => {
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const ws2Messages: WsEnvelope[] = [];

    await new Promise<void>((resolve) => {
      ws1.addEventListener("open", () => {
        ws1.send(
          JSON.stringify({
            type: "handshake",
            payload: {
              clientType: "agent",
              agentId: "ws-sender",
              agentName: "Sender",
            } satisfies HandshakePayload,
            ts: Date.now(),
          } satisfies WsEnvelope),
        );
      });
      ws2.addEventListener("open", () => {
        ws2.send(
          JSON.stringify({
            type: "handshake",
            payload: {
              clientType: "agent",
              agentId: "ws-receiver",
              agentName: "Receiver",
            } satisfies HandshakePayload,
            ts: Date.now(),
          } satisfies WsEnvelope),
        );
      });
      ws2.addEventListener("message", (e) => {
        ws2Messages.push(JSON.parse(String(e.data)));
      });
      setTimeout(resolve, 400);
    });

    // Agent sends via WS send_message type
    const before = ws2Messages.length;
    ws1.send(
      JSON.stringify({
        type: "send_message",
        payload: { content: "WS direct send", sender: { id: "ws-sender", name: "Sender" } },
        ts: Date.now(),
      } satisfies WsEnvelope),
    );

    await Bun.sleep(200);
    const newMsgs = ws2Messages.slice(before);
    expect(newMsgs.some((m) => m.type === "message_broadcast")).toBe(true);
    const bc = newMsgs.find((m) => m.type === "message_broadcast");
    expect((bc?.payload as MeetingMessage).content).toBe("WS direct send");

    ws1.close();
    ws2.close();
  });
});

describe("Hub Config Update", () => {
  test("PATCH /api/agent/:id/config updates and notifies", async () => {
    // Connect an agent first
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const received: WsEnvelope[] = [];

    await new Promise<void>((resolve) => {
      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            type: "handshake",
            payload: {
              clientType: "agent",
              agentId: "cfg-agent",
              agentName: "ConfigTarget",
            } satisfies HandshakePayload,
            ts: Date.now(),
          } satisfies WsEnvelope),
        );
      });
      ws.addEventListener("message", (e) => {
        received.push(JSON.parse(String(e.data)));
      });
      setTimeout(resolve, 300);
    });

    const before = received.length;
    const resp = await fetch(hubUrl("/api/agent/cfg-agent/config"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4-20250514", effort: "max" }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { config: { model: string; effort: string } };
    expect(body.config.model).toBe("claude-opus-4-20250514");
    expect(body.config.effort).toBe("max");

    await Bun.sleep(200);
    const newMsgs = received.slice(before);
    // Should receive config_update + system_event
    expect(newMsgs.some((m) => m.type === "config_update")).toBe(true);
    expect(newMsgs.some((m) => m.type === "system_event")).toBe(true);

    ws.close();
  });

  test("PATCH /api/agent/:id/config returns 404 for unknown agent", async () => {
    const resp = await fetch(hubUrl("/api/agent/nonexistent/config"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test" }),
    });
    expect(resp.status).toBe(404);
  });
});

describe("Hub Reserved IDs", () => {
  test("rejects agent with reserved id 'frodo'", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            type: "handshake",
            payload: {
              clientType: "agent",
              agentId: "frodo",
              agentName: "Imposter",
            } satisfies HandshakePayload,
            ts: Date.now(),
          } satisfies WsEnvelope),
        );
      });
      ws.addEventListener("close", (e) => resolve(e.code));
      setTimeout(() => resolve(-1), 2000);
    });
    expect(closeCode).toBe(4002);
  });
});
