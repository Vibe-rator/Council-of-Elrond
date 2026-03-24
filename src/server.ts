#!/usr/bin/env bun
/**
 * Elrond Channel MCP Server — one instance per Claude Code agent session.
 *
 * MCP face (stdio): exposes tools to Claude Code.
 * Hub face (WebSocket): receives broadcast messages and pushes them as
 * `notifications/claude/channel` into the Claude Code session.
 *
 * Pattern follows the Telegram plugin:
 *   ~/.claude/plugins/.../telegram/server.ts
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "fs";
import { join } from "path";

import type {
  LedgerEvaluation,
  MeetingMessage,
  WsEnvelope,
  ForceSpeakPayload,
  SystemEvent,
  HandshakePayload,
  AgentConfig,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    process.stderr.write(`[elrond-channel] Missing required env: ${name}\n`);
    process.exit(1);
  }
  return val;
}

const AGENT_ID = requireEnv("ELROND_AGENT_ID");
const AGENT_NAME = requireEnv("ELROND_AGENT_NAME");
const HUB_PORT = requireEnv("ELROND_HUB_PORT");
const WORKDIR = process.env.ELROND_WORKDIR ?? process.cwd();

// Persona read from file so MCP server restart picks up changes
const PERSONA = (() => {
  try {
    return readFileSync(join(WORKDIR, "persona.txt"), "utf8").trim();
  } catch {
    return "";
  }
})();

// ---------------------------------------------------------------------------
// Instructions builder
// ---------------------------------------------------------------------------

function buildInstructions(name: string, persona: string): string {
  return [
    `You are "${name}", a participant in a multi-agent meeting room called Elrond.`,
    "",
    persona ? `Your persona: ${persona}` : "",
    "",
    "## When It's Your Turn",
    "1. Use get_history to read ALL previous messages.",
    "2. If this is the first round (not everyone has spoken yet): share your initial perspective. No ledger evaluation needed yet.",
    "3. After the first round, also evaluate discussion progress (see Ledger below).",
    "4. Based on your evaluation:",
    "   - If consensus is NOT reached: share your perspective via send_message with your `ledger` evaluation and `nextSpeaker` nomination.",
    "   - If consensus IS reached: send a brief summary of what was agreed, set `ledger.consensusReached: true`, and nominate a `ledger.conclusionAgent` to produce the final output.",
    "5. If you have nothing meaningful to add, use pass_turn (you can still nominate nextSpeaker).",
    "",
    '- Messages from other participants arrive as <channel source="elrond" ...> tags. Read them but do not respond until your turn.',
    "",
    "## Ledger — Evaluating Discussion Progress",
    "- Include `ledger` with every send_message during discussion:",
    "  - `consensusReached`: true only if all major viewpoints have been heard and a clear agreement exists.",
    "  - `isInLoop`: true if the discussion is repeating the same points without new insights.",
    "  - `progressBeingMade`: true if new ideas, refined positions, or resolved disagreements are emerging.",
    "  - `conclusionAgent`: if consensusReached is true, name who should produce the final output.",
    "- Evaluate BEFORE you compose your message — your assessment drives what you say.",
    "",
    "## Nominating the Next Speaker",
    "- Include `nextSpeaker` with every send_message — the NAME of who should speak next.",
    "- Choose based on who has the most relevant expertise or the strongest reaction to the current point.",
    "- Use get_participants to see all participant names and their speak counts. Use display names (e.g. 'Gandalf'), not IDs.",
    "- Consider speak counts when nominating: prefer participants who have spoken less to ensure everyone's voice is heard.",
    "",
    "## Conclusion Phase",
    "- If you are designated as the conclusion agent, you will receive a special prompt.",
    "- Do NOT evaluate — just produce the final output.",
    "- Review the full discussion and deliver the definitive result (summary, code, document, etc.).",
    "- You may use Write, Edit, and Bash tools to create files or make code changes.",
    "- Send your final output via send_message (no ledger or nextSpeaker needed).",
    "",
    "## Other Rules",
    '- If event="force_speak", you MUST respond with send_message regardless of turn order.',
    '- If event="config_changed", acknowledge and apply the new settings.',
    "- If Frodo asks to stop, wrap up, or end the discussion (in any language), treat it as a conclusion request: set ledger.consensusReached to true and nominate a conclusionAgent.",
    "- Keep messages concise and substantive. Synthesize, don't repeat what others said.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: `elrond-channel-${AGENT_ID}`, version: "0.1.0" },
  {
    capabilities: { tools: {}, experimental: { "claude/channel": {} } },
    instructions: buildInstructions(AGENT_NAME, PERSONA),
  },
);

// --- Tools ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "send_message",
      description:
        "Send a message to the meeting room. Include nextSpeaker and ledger with every message.",
      inputSchema: {
        type: "object" as const,
        properties: {
          content: {
            type: "string",
            description: "The message content to send",
          },
          replyTo: {
            type: "string",
            description: "Optional: message ID to reply to",
          },
          nextSpeaker: {
            type: "string",
            description:
              "Name of the participant who should speak next (e.g. 'Gandalf'). Choose based on relevance to the current discussion point.",
          },
          ledger: {
            type: "object",
            description:
              "Your evaluation of discussion progress.",
            properties: {
              consensusReached: {
                type: "boolean",
                description: "Has the group reached agreement? True only if all key concerns are addressed.",
              },
              isInLoop: {
                type: "boolean",
                description: "Is the discussion repeating without new insights?",
              },
              progressBeingMade: {
                type: "boolean",
                description: "Are new ideas or resolved disagreements emerging?",
              },
              conclusionAgent: {
                type: "string",
                description: "If consensusReached is true: name of who should produce the final output.",
              },
            },
            required: ["consensusReached", "isInLoop", "progressBeingMade"],
          },
        },
        required: ["content"],
      },
    },
    {
      name: "get_history",
      description: "Retrieve recent message history from the meeting.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: {
            type: "number",
            description: "Number of messages (default 50, max 200)",
          },
          after: {
            type: "string",
            description: "Only messages after this ID",
          },
        },
      },
    },
    {
      name: "get_participants",
      description:
        "List all current participants in the meeting with their status.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "pass_turn",
      description:
        "Indicate you have nothing to add right now. You can still nominate the next speaker.",
      inputSchema: {
        type: "object" as const,
        properties: {
          reason: {
            type: "string",
            description: "Brief reason for passing (optional)",
          },
          nextSpeaker: {
            type: "string",
            description: "Name of who should speak next (optional)",
          },
        },
      },
    },
  ],
}));

// --- Outbound queue for resilience ---

import { OutboundQueue } from "./lib/outbound-queue.ts";
import { generateUlid } from "./lib/ulid.ts";

const outbound = new OutboundQueue();

// --- Helpers ---

async function hubFetch(path: string, init?: RequestInit): Promise<unknown> {
  const resp = await fetch(`http://127.0.0.1:${HUB_PORT}${path}`, init);
  if (!resp.ok) throw new Error(`Hub ${path}: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

// --- Tool call handler ---

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  try {
    switch (req.params.name) {
      case "send_message": {
        const content = args.content as string;
        const replyTo = args.replyTo as string | undefined;
        const nextSpeaker = args.nextSpeaker as string | undefined;
        const ledger = args.ledger as LedgerEvaluation | undefined;
        const outId = generateUlid();
        const payload = JSON.stringify({
          content,
          sender: { id: AGENT_ID, name: AGENT_NAME },
          ...(replyTo ? { replyTo } : {}),
          ...(nextSpeaker ? { nextSpeaker } : {}),
          ...(ledger ? { ledger } : {}),
        });
        outbound.enqueue(outId, payload);
        const result = (await hubFetch("/api/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        })) as { message: MeetingMessage };
        outbound.markAcked(outId);
        return {
          content: [
            { type: "text" as const, text: `Message sent (id: ${result.message.id})` },
          ],
        };
      }

      case "get_history": {
        const limit = Math.min(Number(args.limit ?? 50), 200);
        const after = args.after as string | undefined;
        const params = new URLSearchParams();
        params.set("limit", String(limit));
        if (after) params.set("after", after);
        const data = (await hubFetch(`/api/messages?${params}`)) as { messages: MeetingMessage[] };
        const formatted = data.messages
          .map((m: MeetingMessage) => `[${m.sender.name}] (${m.id}): ${m.content}`)
          .join("\n");
        return {
          content: [
            { type: "text" as const, text: formatted || "No messages yet." },
          ],
        };
      }

      case "get_participants": {
        const data = (await hubFetch("/api/participants")) as {
          participants: Array<{ id: string; name: string; status: string; speakCount?: number }>;
        };
        const formatted = data.participants
          .map((p) => `- ${p.name} (${p.id}): ${p.status}, spoken ${p.speakCount ?? 0} times`)
          .join("\n");
        return {
          content: [{ type: "text" as const, text: formatted }],
        };
      }

      case "pass_turn": {
        const reason = args.reason as string | undefined;
        const passNextSpeaker = args.nextSpeaker as string | undefined;
        await hubFetch("/api/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `[passes${reason ? `: ${reason}` : ""}]`,
            sender: { id: AGENT_ID, name: AGENT_NAME },
            meta: { pass: "true" },
            ...(passNextSpeaker ? { nextSpeaker: passNextSpeaker } : {}),
          }),
        });
        return {
          content: [{ type: "text" as const, text: "Turn passed." }],
        };
      }

      default:
        return {
          content: [
            {
              type: "text" as const,
              text: `unknown tool: ${req.params.name}`,
            },
          ],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: `${req.params.name}: ${err instanceof Error ? err.message : err}`,
        },
      ],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Connect MCP to Claude Code via stdio
// ---------------------------------------------------------------------------

await mcp.connect(new StdioServerTransport());

// ---------------------------------------------------------------------------
// Hub WebSocket connection — receive broadcasts, push as channel notifications
// ---------------------------------------------------------------------------

import { ReconnectingWebSocket } from "./lib/reconnecting-ws.ts";
import { MessageTracker } from "./lib/message-tracker.ts";

const tracker = new MessageTracker();

const hubWs = new ReconnectingWebSocket(`ws://127.0.0.1:${HUB_PORT}/ws`);

hubWs.onStateChange = (state) => {
  if (state === "connected") {
    const handshake: WsEnvelope = {
      type: "handshake",
      payload: {
        clientType: "agent",
        agentId: AGENT_ID,
        agentName: AGENT_NAME,
        lastSeenUlid: tracker.getLastSeen() ?? undefined,
      } satisfies HandshakePayload,
      ts: Date.now(),
    };
    hubWs.send(JSON.stringify(handshake));
    process.stderr.write(`[elrond-channel] ${AGENT_NAME} connected to hub\n`);
  } else if (state === "reconnecting") {
    process.stderr.write(`[elrond-channel] ${AGENT_NAME} reconnecting to hub...\n`);
  }
};

hubWs.onMessage = (data) => {
  let env: WsEnvelope;
  try {
    env = JSON.parse(data);
  } catch {
    return;
  }

  switch (env.type) {
    case "message_broadcast":
    case "replay": {
      const msg = env.payload as MeetingMessage;
      tracker.record(msg.id);
      if (msg.sender.id === AGENT_ID) break;
      void mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.content,
          meta: {
            source: "elrond",
            sender_id: msg.sender.id,
            sender_name: msg.sender.name,
            msg_id: msg.id,
            ts: new Date(msg.timestamp).toISOString(),
            ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
          },
        },
      });
      break;
    }

    case "system_event": {
      const evt = env.payload as SystemEvent;
      tracker.record(evt.id);
      void mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: evt.content,
          meta: {
            source: "elrond",
            event: evt.eventKind,
            msg_id: evt.id,
            ts: new Date(evt.timestamp).toISOString(),
          },
        },
      });
      break;
    }

    case "force_speak": {
      const fp = env.payload as ForceSpeakPayload;
      void mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: fp.prompt
            ? `Frodo wants you to speak. Prompt: "${fp.prompt}"`
            : "Frodo wants you to speak. Please contribute to the conversation.",
          meta: { source: "elrond", event: "force_speak", from: "Frodo" },
        },
      });
      break;
    }

    case "config_update": {
      const cfg = env.payload as AgentConfig;
      void mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: `Your settings have been updated. Model: ${cfg.model}, Effort: ${cfg.effort}${cfg.persona ? `, Persona: ${cfg.persona}` : ""}. Apply from your next message.`,
          meta: { source: "elrond", event: "config_changed" },
        },
      });
      break;
    }

    case "heartbeat_ping": {
      hubWs.send(
        JSON.stringify({
          type: "heartbeat_pong",
          payload: {},
          ts: Date.now(),
        } satisfies WsEnvelope),
      );
      break;
    }

    case "sync_complete": {
      hubWs.resetBackoff();
      // Re-send any un-acked messages after reconnection
      for (const pending of outbound.getUnacked()) {
        hubFetch("/api/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: pending.payload,
        })
          .then(() => outbound.markAcked(pending.id))
          .catch(() => {});
      }
      break;
    }

    case "sync_lost": {
      hubWs.resetBackoff();
      void mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content:
            "Connection was temporarily lost. Some messages may have been missed. Use get_history to review recent context.",
          meta: { source: "elrond", event: "sync_lost" },
        },
      });
      break;
    }

    case "handshake_ack": {
      const ack = env.payload as {
        meetingId: string;
        participants: unknown[];
        recentMessages: MeetingMessage[];
      };
      process.stderr.write(`[elrond-channel] ${AGENT_NAME} handshake acknowledged (${ack.recentMessages?.length ?? 0} recent msgs)\n`);
      // Forward recent messages as channel notifications so the agent
      // has full context even for messages sent before its WS connected.
      if (ack.recentMessages) {
        for (const msg of ack.recentMessages) {
          tracker.record(msg.id);
          if (msg.sender.id === AGENT_ID) continue;
          void mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: msg.content,
              meta: {
                source: "elrond",
                sender_id: msg.sender.id,
                sender_name: msg.sender.name,
                msg_id: msg.id,
                ts: new Date(msg.timestamp).toISOString(),
              },
            },
          });
        }
      }
      break;
    }
  }
};

hubWs.connect();
