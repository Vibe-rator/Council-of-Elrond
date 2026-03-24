#!/usr/bin/env bun
/**
 * Elrond TUI Viewer — @mariozechner/pi-tui based.
 *
 * Fixed layout:
 *   StatusBar (1 line)
 *   ChatLog (scrollable) │ AgentList (fixed 26 cols)
 *   HelpBar (1 line)
 *   InputBar (1 line)
 */

import {
  Input,
  Key,
  matchesKey,
  ProcessTerminal,
  TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import chalk from "chalk";
import { ReconnectingWebSocket } from "../lib/reconnecting-ws.ts";
import type {
  HandshakeAckPayload,
  HandshakePayload,
  MeetingMessage,
  ParticipantInfo,
  SystemEvent,
  WsEnvelope,
} from "../types.ts";
import { agentColor, type ElrondTheme, THEMES } from "./theme.ts";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let hubPort: number;
let theme: ElrondTheme = THEMES.cyberpunk;
let themeName: ElrondTheme["name"] = "cyberpunk";

const messages: MeetingMessage[] = [];
let participants: ParticipantInfo[] = [];
let hubState = "connecting";
let _meetingId = "";
let lastSeenUlid: string | null = null;
let selectedAgentIdx = 0;
let chatScrollOffset = 0; // lines from bottom
let totalChatLines = 0; // actual rendered line count (updated each render)
let startedAt = Date.now();

// ---------------------------------------------------------------------------
// Color helpers (using chalk for ANSI)
// ---------------------------------------------------------------------------

function hex(color: string) {
  return chalk.hex(color);
}

function hexBg(color: string) {
  return chalk.bgHex(color);
}

function padRight(str: string, width: number): string {
  const w = visibleWidth(str);
  if (w >= width) return truncateToWidth(str, width, "");
  return str + " ".repeat(width - w);
}

function initial(name: string): string {
  return (name[0] ?? "?").toUpperCase();
}

function formatTime(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}

// ---------------------------------------------------------------------------
// Build rendered lines from messages (CJK-aware)
// ---------------------------------------------------------------------------

interface ChatLine {
  text: string; // ANSI-formatted string
}

function buildChatLines(chatWidth: number): ChatLine[] {
  const lines: ChatLine[] = [];
  let prevSenderId: string | null = null;

  for (const msg of messages) {
    const isSystem = msg.type === "system";
    const isFrodo = msg.sender.id === "frodo";
    const isGap = msg.content.startsWith("\u26A0");
    const agentIdx = getAgentIndex(msg.sender.id);

    // Separator between different speakers
    if (prevSenderId !== null && prevSenderId !== msg.sender.id && !isGap) {
      lines.push({ text: hex(theme.colors.fgMuted)("  ─────") });
    }
    prevSenderId = msg.sender.id;

    if (isGap) {
      lines.push({ text: hex(theme.colors.warning)(`─── ${msg.content} ───`) });
      continue;
    }

    // Header line
    const time = hex(theme.colors.fgMuted)(`[${formatTime(msg.timestamp)}]`);
    if (isFrodo) {
      lines.push({ text: `${time} ${hex(theme.frodoColor).bold("▶ Frodo")}` });
    } else if (isSystem) {
      lines.push({ text: `${time} ${hex(theme.systemColor)("System")}` });
    } else {
      const color = agentColor(theme, agentIdx);
      lines.push({
        text: `${time} ${hexBg(color).black(` ${initial(msg.sender.name)} `)} ${hex(color).bold(msg.sender.name)}`,
      });
    }

    // Content lines — wrapped for CJK
    const indent = isFrodo ? "   " : "  ";
    const wrapWidth = Math.max(chatWidth - visibleWidth(indent) - 1, 20);
    const contentColor = isFrodo
      ? theme.frodoColor
      : isSystem
        ? theme.colors.fgMuted
        : theme.colors.fg;
    const contentBold = isFrodo;

    for (const paragraph of msg.content.split("\n")) {
      if (paragraph === "") {
        lines.push({ text: "" });
        continue;
      }
      const wrapped = wrapTextWithAnsi(paragraph, wrapWidth);
      for (const wline of wrapped) {
        const styled = contentBold ? hex(contentColor).bold(wline) : hex(contentColor)(wline);
        lines.push({ text: `${indent}${styled}` });
      }
    }
  }

  return lines;
}

function getAgentIndex(senderId: string): number {
  const agents = participants.filter((p) => p.clientType === "agent");
  const idx = agents.findIndex((a) => a.id === senderId);
  return idx >= 0 ? idx : 0;
}

// ---------------------------------------------------------------------------
// Build agent list lines
// ---------------------------------------------------------------------------

function buildAgentLines(width: number): string[] {
  const agents = participants.filter((p) => p.clientType === "agent");
  if (agents.length === 0) {
    return [hex(theme.colors.fgMuted)(" Waiting...")];
  }

  const lines: string[] = [];
  agents.forEach((agent, idx) => {
    const color = agentColor(theme, idx);
    const isSpeaking = agent.status === "speaking";
    const selected = idx === selectedAgentIdx;

    // Arrow
    const arrow = isSpeaking
      ? hex(theme.colors.success).bold("▶ ")
      : selected
        ? hex(theme.colors.accent)("▸ ")
        : "  ";

    // Name
    lines.push(
      truncateToWidth(
        `${arrow}${hexBg(color).black(` ${initial(agent.name)} `)} ${hex(color).bold(agent.name)}`,
        width,
        "",
      ),
    );

    // Model + effort
    const model = agent.config?.model?.replace("claude-", "").replace("-20250514", "") ?? "?";
    lines.push(
      truncateToWidth(
        `     ${hex(theme.colors.fgMuted)(`${model} · ${agent.config?.effort ?? "?"}`)}`,
        width,
        "",
      ),
    );

    // Status
    const isConcluding = agent.status === "concluding";
    const si = isSpeaking
      ? "●"
      : isConcluding
        ? "★"
        : agent.status === "idle"
          ? "○"
          : agent.status === "disconnected"
            ? "✕"
            : "◐";
    const sc = isSpeaking
      ? theme.colors.success
      : isConcluding
        ? theme.colors.warning
        : agent.status === "idle"
          ? theme.colors.fgMuted
          : agent.status === "disconnected"
            ? theme.colors.error
            : theme.colors.warning;
    lines.push(truncateToWidth(`     ${hex(sc)(`${si} ${agent.status}`)}`, width, ""));
    lines.push(""); // spacing
  });

  return lines;
}

// ---------------------------------------------------------------------------
// Custom Components
// ---------------------------------------------------------------------------

/** StatusBar: 1-line top bar */
class StatusBar {
  private cache?: string[];

  render(width: number): string[] {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const h = String(Math.floor(elapsed / 3600)).padStart(2, "0");
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
    const s = String(elapsed % 60).padStart(2, "0");

    const agents = participants.filter((p) => p.clientType === "agent");
    const hubSym = hubState === "connected" ? "●" : hubState === "disconnected" ? "✕" : "◐";
    const hubClr =
      hubState === "connected"
        ? theme.colors.success
        : hubState === "disconnected"
          ? theme.colors.error
          : theme.colors.warning;

    const left = [
      hex(theme.colors.accentSecondary)("◢◤"),
      hex(theme.colors.accent).bold(" ELROND "),
      hex(theme.colors.accentSecondary)("◤◢"),
      hex(theme.colors.fgMuted)("│"),
      hex(hubClr)(`${hubSym} ${hubState}`),
      hex(theme.colors.fgMuted)("│"),
      hex(theme.colors.fgSecondary)(`${agents.length} agents`),
      hex(theme.colors.fgMuted)("│"),
      hex(theme.colors.fgSecondary)(`${h}:${m}:${s}`),
      hex(theme.colors.fgMuted)("│"),
      hex(theme.colors.fgSecondary)(`${messages.length} msgs`),
    ].join(" ");

    const right = [
      hex(theme.colors.accent).bold("^F"),
      hex(theme.colors.fgMuted)("Force"),
      hex(theme.colors.accent).bold("^T"),
      hex(theme.colors.fgMuted)("Theme"),
      hex(theme.colors.accent).bold("^Q"),
      hex(theme.colors.fgMuted)("Quit"),
    ].join(" ");

    const line = padRight(left, width - visibleWidth(right) - 1) + right;
    return [truncateToWidth(line, width, "")];
  }

  invalidate() {
    this.cache = undefined;
  }
}

/** MainArea: horizontal split — ChatLog (scrollable) | AgentList */
class MainArea {
  private termHeight = 24;
  private tui: TUI;

  constructor(tui: TUI) {
    this.tui = tui;
  }

  setTermHeight(h: number) {
    this.termHeight = h;
  }

  render(width: number): string[] {
    const agentWidth = 26;
    const dividerWidth = 1;
    const chatWidth = Math.max(width - agentWidth - dividerWidth, 20);
    // Main area height: total - statusBar(1) - helpBar(1) - inputLine(1)
    const areaHeight = Math.max(this.termHeight - 3, 5);

    // Build chat lines
    const allChatLines = buildChatLines(chatWidth);
    totalChatLines = allChatLines.length;

    // Typing indicators
    const speakingAgents = participants.filter(
      (p) => p.clientType === "agent" && p.status === "speaking",
    );
    const typingLines: string[] = [];
    for (const agent of speakingAgents.slice(0, 2)) {
      const idx = getAgentIndex(agent.id);
      const color = agentColor(theme, idx);
      typingLines.push(
        `  ${hexBg(color).black(` ${initial(agent.name)} `)} ${hex(theme.colors.fgMuted)(`${agent.name} is thinking...`)}`,
      );
    }

    // Scroll indicator
    const scrollInfo =
      chatScrollOffset > 0
        ? hex(theme.colors.warning).bold(`  ▲ ${chatScrollOffset} lines below — ↓ to scroll`)
        : hex(theme.colors.fgMuted)("  ▼ latest");

    // Reserve lines for typing + scroll indicator
    const reservedBottom = typingLines.length + 1;
    const chatViewHeight = areaHeight - reservedBottom;

    // Slice chat lines for viewport
    const totalChat = allChatLines.length;
    const endIdx = totalChat - chatScrollOffset;
    const startIdx = Math.max(0, endIdx - chatViewHeight);
    const visibleChat = allChatLines.slice(startIdx, Math.max(endIdx, 0)).map((l) => l.text);

    // Pad chat to fill viewport
    while (visibleChat.length < chatViewHeight) {
      visibleChat.unshift(""); // pad top
    }

    // Add typing + scroll indicator
    const chatColumn = [...visibleChat, ...typingLines, scrollInfo];

    // Build agent column
    const agentLines = buildAgentLines(agentWidth - 2); // -2 for padding
    const agentColumn: string[] = [];
    // Agent panel title
    agentColumn.push(
      hex(theme.colors.fgMuted)(" ─ ") +
        hex(theme.colors.fgSecondary).bold("AGENTS") +
        hex(theme.colors.fgMuted)(" ─"),
    );
    for (const al of agentLines) {
      agentColumn.push(` ${al}`);
    }

    // Pad to match height
    while (agentColumn.length < areaHeight) {
      agentColumn.push("");
    }

    // Combine columns side by side
    const divider = hex(theme.border.unfocused)("│");
    const result: string[] = [];
    for (let i = 0; i < areaHeight; i++) {
      const chatLine = padRight(chatColumn[i] ?? "", chatWidth);
      const agentLine = padRight(agentColumn[i] ?? "", agentWidth);
      result.push(`${chatLine}${divider}${agentLine}`);
    }

    return result;
  }

  invalidate() {}
}

/** HelpBar: 1-line keyboard hints */
class HelpBar {
  render(width: number): string[] {
    const items = [
      [hex(theme.colors.accent).bold("Enter"), "Send"],
      [hex(theme.colors.accent).bold("↑/↓/PgUp/Dn"), "Scroll"],
      [hex(theme.colors.accent).bold("^Y"), "Copy"],
      [hex(theme.colors.accent).bold("^F"), "Force"],
      [hex(theme.colors.accent).bold("^T"), "Theme"],
      [hex(theme.colors.accent).bold("^Q"), "Quit"],
    ];
    const line = items.map(([k, v]) => `${k} ${hex(theme.colors.fgMuted)(v!)}`).join("  ");
    return [truncateToWidth(` ${line}`, width, "")];
  }

  invalidate() {}
}

// ---------------------------------------------------------------------------
// Hub connection
// ---------------------------------------------------------------------------

let rws: ReconnectingWebSocket;

function connectToHub(): void {
  rws = new ReconnectingWebSocket(`ws://127.0.0.1:${hubPort}/ws`);

  rws.onStateChange = (state) => {
    hubState = state;
    if (state === "connected") {
      const handshake: WsEnvelope = {
        type: "handshake",
        payload: {
          clientType: "viewer",
          lastSeenUlid: lastSeenUlid ?? undefined,
        } satisfies HandshakePayload,
        ts: Date.now(),
      };
      rws.send(JSON.stringify(handshake));
    }
    tui?.requestRender();
  };

  rws.onMessage = (data) => {
    let env: WsEnvelope;
    try {
      env = JSON.parse(data);
    } catch {
      return;
    }

    switch (env.type) {
      case "handshake_ack": {
        const ack = env.payload as HandshakeAckPayload;
        _meetingId = ack.meetingId;
        participants = ack.participants;
        if (messages.length === 0 && ack.recentMessages.length > 0) {
          for (const msg of ack.recentMessages) messages.push(msg);
          const last = ack.recentMessages[ack.recentMessages.length - 1];
          if (last) lastSeenUlid = last.id;
        }
        tui?.requestRender();
        break;
      }

      case "message_broadcast":
      case "replay": {
        const msg = env.payload as MeetingMessage;
        if (messages.some((m) => m.id === msg.id)) break;
        lastSeenUlid = msg.id;
        messages.push(msg);
        if (chatScrollOffset === 0) {
          // Auto-scroll: stay at bottom
        }
        tui?.requestRender();
        break;
      }

      case "system_event": {
        const evt = env.payload as SystemEvent;
        if (messages.some((m) => m.id === evt.id)) break;
        lastSeenUlid = evt.id;
        messages.push(evt);
        if (
          [
            "agent_joined",
            "agent_left",
            "agent_crashed",
            "turn_start",
            "turn_timeout",
            "consensus_reached",
            "conclusion_start",
            "conclusion_complete",
          ].includes(evt.eventKind)
        ) {
          fetch(`http://127.0.0.1:${hubPort}/api/participants`)
            .then((r) => r.json())
            .then((d) => {
              participants = (d as { participants: ParticipantInfo[] }).participants;
              tui?.requestRender();
            })
            .catch(() => {});
        }
        tui?.requestRender();
        break;
      }

      case "sync_lost": {
        rws.resetBackoff();
        messages.push({
          id: `gap-${Date.now()}`,
          type: "system",
          timestamp: Date.now(),
          sender: { id: "system", name: "System" },
          content: "\u26A0 connection lost — some messages may be missing",
        });
        tui?.requestRender();
        break;
      }

      case "sync_complete":
        rws.resetBackoff();
        break;
    }
  };

  rws.connect();
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

function sendMessage(content: string): void {
  fetch(`http://127.0.0.1:${hubPort}/api/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, sender: { id: "frodo", name: "Frodo" } }),
  }).catch(() => {});
}

function copyRecentToClipboard(count: number): void {
  const recent = messages.slice(-count);
  const text = recent
    .map((m) => {
      const time = formatTime(m.timestamp);
      return `[${time}] ${m.sender.name}: ${m.content}`;
    })
    .join("\n\n");

  // macOS pbcopy
  try {
    const proc = Bun.spawn(["pbcopy"], { stdin: "pipe" });
    proc.stdin.write(text);
    proc.stdin.end();
    // Visual feedback via system message in chat
    messages.push({
      id: `clip-${Date.now()}`,
      type: "system",
      timestamp: Date.now(),
      sender: { id: "system", name: "System" },
      content: `Copied ${recent.length} messages to clipboard.`,
    });
  } catch {
    messages.push({
      id: `clip-err-${Date.now()}`,
      type: "system",
      timestamp: Date.now(),
      sender: { id: "system", name: "System" },
      content: `Failed to copy to clipboard.`,
    });
  }
}

function forceSpeak(): void {
  const agents = participants.filter((p) => p.clientType === "agent");
  if (agents.length === 0) return;
  const agent = agents[selectedAgentIdx % agents.length];
  if (!agent) return;
  fetch(`http://127.0.0.1:${hubPort}/api/force-speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetAgentId: agent.id }),
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// TUI setup
// ---------------------------------------------------------------------------

let tui: TUI;
let viewerDone: (() => void) | null = null;

export function startViewer(port: number): Promise<void> {
  hubPort = port;
  startedAt = Date.now();

  const terminal = new ProcessTerminal();
  tui = new TUI(terminal);

  const statusBar = new StatusBar();
  const mainArea = new MainArea(tui);
  const helpBar = new HelpBar();

  // Input component
  const input = new Input();
  input.onSubmit = (value: string) => {
    if (value.trim()) {
      sendMessage(value.trim());
      chatScrollOffset = 0; // snap to bottom
    }
    input.setValue("");
    tui.requestRender();
  };

  // Layout component — renders everything except the Input line
  const layout = {
    render(width: number): string[] {
      const termH = (terminal as any).rows ?? process.stdout.rows ?? 24;
      mainArea.setTermHeight(termH);

      const lines: string[] = [];
      lines.push(...statusBar.render(width));
      lines.push(...mainArea.render(width));
      lines.push(...helpBar.render(width));
      return lines;
    },

    invalidate() {
      statusBar.invalidate();
    },
  };

  // Keyboard shortcuts — processed before Input via inputListener
  tui.addInputListener((data: string) => {
    // Ctrl+Y: copy recent messages to clipboard
    if (matchesKey(data, Key.ctrl("y"))) {
      copyRecentToClipboard(20);
      tui.requestRender();
      return { consume: true };
    }

    // Ctrl+Q: quit
    if (matchesKey(data, Key.ctrl("q"))) {
      process.stdout.write("\x1b[?1006l\x1b[?1000l"); // disable mouse mode
      tui.stop();
      viewerDone?.();
      return { consume: true };
    }

    // Ctrl+T: theme toggle
    if (matchesKey(data, Key.ctrl("t"))) {
      const order: ElrondTheme["name"][] = ["cyberpunk", "matrix", "amber", "mono"];
      const idx = order.indexOf(themeName);
      themeName = order[(idx + 1) % order.length]!;
      theme = THEMES[themeName];
      tui.requestRender();
      return { consume: true };
    }

    // Ctrl+F: force speak
    if (matchesKey(data, Key.ctrl("f"))) {
      forceSpeak();
      tui.requestRender();
      return { consume: true };
    }

    // Ctrl+J: next agent
    if (matchesKey(data, Key.ctrl("j"))) {
      const agents = participants.filter((p) => p.clientType === "agent");
      if (agents.length > 0) {
        selectedAgentIdx = (selectedAgentIdx + 1) % agents.length;
        tui.requestRender();
      }
      return { consume: true };
    }

    // Ctrl+K: prev agent
    if (matchesKey(data, Key.ctrl("k"))) {
      const agents = participants.filter((p) => p.clientType === "agent");
      if (agents.length > 0) {
        selectedAgentIdx = (selectedAgentIdx - 1 + agents.length) % agents.length;
        tui.requestRender();
      }
      return { consume: true };
    }

    // Arrow Up: scroll chat up
    if (matchesKey(data, Key.up)) {
      chatScrollOffset = Math.min(chatScrollOffset + 3, Math.max(totalChatLines, 0));
      tui.requestRender();
      return { consume: true };
    }

    // Arrow Down: scroll chat down
    if (matchesKey(data, Key.down)) {
      chatScrollOffset = Math.max(chatScrollOffset - 3, 0);
      tui.requestRender();
      return { consume: true };
    }

    // Page Up / Page Down
    if (matchesKey(data, Key.pageUp)) {
      chatScrollOffset = Math.min(chatScrollOffset + 20, Math.max(totalChatLines, 0));
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, Key.pageDown)) {
      chatScrollOffset = Math.max(chatScrollOffset - 20, 0);
      tui.requestRender();
      return { consume: true };
    }

    // Mouse wheel scroll (SGR mouse mode: \x1b[<64;x;yM = up, \x1b[<65;x;yM = down)
    const mouseMatch = data.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
    if (mouseMatch) {
      const btn = Number(mouseMatch[1]);
      if (btn === 64) {
        // wheel up
        chatScrollOffset = Math.min(chatScrollOffset + 3, Math.max(totalChatLines, 0));
        tui.requestRender();
      } else if (btn === 65) {
        // wheel down
        chatScrollOffset = Math.max(chatScrollOffset - 3, 0);
        tui.requestRender();
      }
      return { consume: true };
    }

    return undefined; // Pass through to focused Input component
  });

  tui.addChild(layout);
  tui.addChild(input);
  tui.setFocus(input);

  // Periodic status bar refresh (elapsed time)
  setInterval(() => {
    tui.requestRender();
  }, 1000);

  connectToHub();
  tui.start();

  // Enable SGR mouse mode for wheel scrolling
  process.stdout.write("\x1b[?1000h\x1b[?1006h");

  // tui.start() is synchronous — use manual promise that resolves on Ctrl+Q
  return new Promise<void>((resolve) => {
    viewerDone = resolve;
  });
}

// Allow direct execution
if (import.meta.main) {
  const port = Number(process.argv[2]);
  if (!port) {
    process.stderr.write("Usage: bun run src/ui/viewer.ts <hub-port>\n");
    process.exit(1);
  }
  startViewer(port);
}
