import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { Subprocess } from "bun";
import type {
  ForceSpeakPayload,
  HandshakePayload,
  MeetingMessage,
  WsEnvelope,
} from "../../src/types.ts";

/**
 * Protocol-level E2E: 2 mock agents + Frodo, full conversation cycle.
 * No real Claude Code sessions — just WebSocket clients simulating agents.
 */

const MEETING_ID = `test-e2e-${Date.now()}`;
const PORT_FILE = `/tmp/elrond-${MEETING_ID}.port`;
let hubProc: Subprocess;
let port: number;

async function waitForPort(file: string): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    if (existsSync(file)) {
      const p = Number(readFileSync(file, "utf8").trim());
      if (p > 0) return p;
    }
    await Bun.sleep(100);
  }
  throw new Error("Timeout");
}

/** Connect a mock agent and wait for handshake_ack. */
async function connectAgent(
  id: string,
  name: string,
): Promise<{ ws: WebSocket; messages: WsEnvelope[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages: WsEnvelope[] = [];

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          type: "handshake",
          payload: { clientType: "agent", agentId: id, agentName: name } satisfies HandshakePayload,
          ts: Date.now(),
        } satisfies WsEnvelope),
      );
    });
    ws.addEventListener("message", (e) => {
      const env: WsEnvelope = JSON.parse(String(e.data));
      messages.push(env);
      if (env.type === "handshake_ack") resolve();
    });
    ws.addEventListener("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });

  return { ws, messages };
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

describe("Meeting E2E (protocol-level)", () => {
  test("2 agents exchange messages through Hub", async () => {
    const agent1 = await connectAgent("agent-1", "Architect");
    const agent2 = await connectAgent("agent-2", "Security");

    // Agent 1 sends a message via REST (simulating MCP tool call)
    await fetch(`http://127.0.0.1:${port}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "I suggest OAuth 2.0 with PKCE",
        sender: { id: "agent-1", name: "Architect" },
      }),
    });
    await Bun.sleep(200);

    // Agent 2 should receive the broadcast
    const agent2Broadcasts = agent2.messages.filter((m) => m.type === "message_broadcast");
    expect(agent2Broadcasts.length).toBeGreaterThan(0);
    const lastBroadcast = agent2Broadcasts[agent2Broadcasts.length - 1]!;
    expect((lastBroadcast.payload as MeetingMessage).content).toBe("I suggest OAuth 2.0 with PKCE");

    // Agent 2 responds
    await fetch(`http://127.0.0.1:${port}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Good foundation. What about token rotation?",
        sender: { id: "agent-2", name: "Security" },
      }),
    });
    await Bun.sleep(200);

    // Agent 1 should receive it
    const agent1Broadcasts = agent1.messages.filter((m) => m.type === "message_broadcast");
    const lastA1 = agent1Broadcasts[agent1Broadcasts.length - 1]!;
    expect((lastA1.payload as MeetingMessage).content).toContain("token rotation");

    agent1.ws.close();
    agent2.ws.close();
  });

  test("Frodo message reaches all agents", async () => {
    const agent1 = await connectAgent("agent-f1", "Dev1");
    const agent2 = await connectAgent("agent-f2", "Dev2");

    await fetch(`http://127.0.0.1:${port}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "What about WebAuthn?",
        sender: { id: "frodo", name: "Frodo" },
      }),
    });
    await Bun.sleep(200);

    const a1Got = agent1.messages.filter((m) => m.type === "message_broadcast");
    const a2Got = agent2.messages.filter((m) => m.type === "message_broadcast");
    expect(
      a1Got.some((m) => (m.payload as MeetingMessage).content === "What about WebAuthn?"),
    ).toBe(true);
    expect(
      a2Got.some((m) => (m.payload as MeetingMessage).content === "What about WebAuthn?"),
    ).toBe(true);

    agent1.ws.close();
    agent2.ws.close();
  });

  test("force-speak sends to targeted agent only", async () => {
    const agent1 = await connectAgent("agent-fs1", "Target");
    const agent2 = await connectAgent("agent-fs2", "Bystander");

    const beforeCount2 = agent2.messages.length;

    await fetch(`http://127.0.0.1:${port}/api/force-speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetAgentId: "agent-fs1", prompt: "Share your thoughts" }),
    });
    await Bun.sleep(200);

    // Target should get force_speak
    const forceMsgs = agent1.messages.filter((m) => m.type === "force_speak");
    expect(forceMsgs.length).toBe(1);
    expect((forceMsgs[0]?.payload as ForceSpeakPayload).prompt).toBe("Share your thoughts");

    // Bystander should NOT get force_speak (but may get system events)
    const bystanderForce = agent2.messages
      .slice(beforeCount2)
      .filter((m) => m.type === "force_speak");
    expect(bystanderForce.length).toBe(0);

    agent1.ws.close();
    agent2.ws.close();
  });

  test("participants list updates on join/leave", async () => {
    const agent1 = await connectAgent("agent-pl1", "Joiner");

    const resp1 = await fetch(`http://127.0.0.1:${port}/api/participants`);
    const data1 = (await resp1.json()) as { participants: Array<{ id: string }> };
    expect(data1.participants.some((p) => p.id === "agent-pl1")).toBe(true);

    agent1.ws.close();
    await Bun.sleep(300);

    const resp2 = await fetch(`http://127.0.0.1:${port}/api/participants`);
    const data2 = (await resp2.json()) as { participants: Array<{ id: string; status: string }> };
    const agent = data2.participants.find((p) => p.id === "agent-pl1");
    expect(agent?.status).toBe("disconnected");
  });
});
