#!/usr/bin/env bun
/**
 * Elrond Hub — Message broker + REST API + WebSocket server.
 *
 * Launched by the Launcher as a background process.
 * Agents and Viewer connect via WebSocket; REST is used for Frodo's messages
 * and config changes.
 */

import type { ServerWebSocket } from "bun";
import { unlinkSync, mkdirSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { RingBuffer } from "./lib/ring-buffer.ts";
import { generateUlid } from "./lib/ulid.ts";
import type {
  AgentConfig,
  ConfigUpdatePayload,
  ForceSpeakPayload,
  HandshakeAckPayload,
  HandshakePayload,
  LedgerEvaluation,
  MeetingMessage,
  MeetingState,
  ParticipantInfo,
  PostMessageBody,
  RegisterAgentBody,
  SavedAgentConfig,
  SyncCompletePayload,
  SyncLostPayload,
  SystemEvent,
  SystemEventKind,
  WsClientData,
  WsEnvelope,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const MEETING_ID = process.env.ELROND_MEETING_ID ?? `elrond-${Date.now().toString(36)}`;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface RegisteredAgent {
  id: string;
  name: string;
  config: AgentConfig;
  ws: ServerWebSocket<WsClientData> | null;
  lastPong: number;
  joinedAt: number;
  tmuxPane: string; // for /model, /effort injection
  _idleTimer: ReturnType<typeof setTimeout> | null;
}

const WS_OPEN = 1; // WebSocket.OPEN — Bun ServerWebSocket uses raw readyState numbers

const agents = new Map<string, RegisteredAgent>();
const viewers = new Set<ServerWebSocket<WsClientData>>();
const messages = new RingBuffer<MeetingMessage>(10_000);
const startedAt = Date.now();

// ---------------------------------------------------------------------------
// Turn-based sequencing (Swarm + MagenticOne hybrid)
// ---------------------------------------------------------------------------

/** Ordered list of agent IDs — used as fallback round-robin order. */
const turnOrder: string[] = [];
/** Index into turnOrder pointing to the agent whose turn it is. */
let currentTurnIdx = 0;
/** Whether we're waiting for the current agent to finish speaking. */
let turnInProgress = false;
/** Timer that auto-advances if the current agent doesn't respond. */
let turnTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
/** How long to wait for an agent to respond before skipping (ms). */
const TURN_TIMEOUT_MS = 120_000; // 2 minutes
const CONCLUSION_TIMEOUT_MS = 300_000; // 5 minutes for conclusion phase
/** Track last speaker to prevent consecutive self-nomination. Set when agent actually speaks, not on turn start. */
let lastSpeakerId: string | null = null;
/** Pending advanceTurn timer — stored so it can be cancelled to prevent races. */
let pendingAdvanceTimer: ReturnType<typeof setTimeout> | null = null;

// --- MagenticOne Ledger State ---

interface LedgerEntry {
  agentId: string;
  agentName: string;
  timestamp: number;
  ledger: LedgerEvaluation;
}

const ledgerHistory: LedgerEntry[] = [];
const MAX_LEDGER_HISTORY = 100;
const STALL_THRESHOLD = 3;
const LOOP_THRESHOLD = 2;

/** Meeting phase: agents discuss, then one agent produces the final output. */
let meetingPhase: "discussion" | "conclusion" = "discussion";
let conclusionAgentId: string | null = null;
/** Whether the meeting is paused by Frodo. */
let meetingPaused = false;

/** Total turns elapsed — used to determine if first round is complete. */
let totalTurns = 0;

function isFirstRoundComplete(): boolean {
  if (turnOrder.length === 0) return false;
  return turnOrder.every((id) => (speakCount.get(id) ?? 0) > 0);
}

/** Parse Frodo's message for /stop or /resume commands. Returns null if not a command. */
function parseFrodoCommand(content: string): "stop" | "resume" | "save" | null {
  const trimmed = content.trim().toLowerCase();
  if (trimmed === "/stop" || trimmed === "/pause") return "stop";
  if (trimmed === "/resume" || trimmed === "/continue") return "resume";
  if (trimmed === "/save") return "save";
  return null;
}

function pauseMeeting(): void {
  if (meetingPaused) return;
  meetingPaused = true;
  clearTurnTimeout();
  if (pendingAdvanceTimer) { clearTimeout(pendingAdvanceTimer); pendingAdvanceTimer = null; }
  turnInProgress = false;
  // Reset conclusion phase if active
  if (meetingPhase === "conclusion") {
    meetingPhase = "discussion";
    conclusionAgentId = null;
  }
  broadcastSystemEvent("meeting_ended", "Meeting paused by Frodo.");
  process.stderr.write("[elrond-hub] Meeting paused\n");
}

function resumeMeeting(): void {
  if (!meetingPaused) return;
  meetingPaused = false;
  broadcastSystemEvent("meeting_started", "Meeting resumed by Frodo.");
  process.stderr.write("[elrond-hub] Meeting resumed\n");
  startCurrentTurn();
}

// --- Save / Restore ---

const SAVE_DIR = join(homedir(), ".elrond", "meetings");

function saveMeetingState(topic?: string): string {
  mkdirSync(SAVE_DIR, { recursive: true });

  const agentConfigs: SavedAgentConfig[] = [];
  for (const [, a] of agents) {
    agentConfigs.push({
      id: a.id,
      name: a.name,
      model: a.config.model,
      effort: a.config.effort,
      persona: a.config.persona,
    });
  }

  const state: MeetingState = {
    version: 1,
    meetingId: MEETING_ID,
    topic: topic ?? extractTopic(),
    savedAt: Date.now(),
    startedAt,
    agents: agentConfigs,
    messages: messages.last(10_000),
    turnOrder: [...turnOrder],
    currentTurnIdx,
    totalTurns,
    speakCount: Object.fromEntries(speakCount),
    ledgerHistory: [...ledgerHistory],
    meetingPhase,
    conclusionAgentId,
    meetingPaused,
  };

  const filePath = join(SAVE_DIR, `${MEETING_ID}.json`);
  void Bun.write(filePath, JSON.stringify(state, null, 2)).catch((err) => {
    process.stderr.write(`[elrond-hub] Save failed: ${err}\n`);
  });
  process.stderr.write(`[elrond-hub] Meeting saved to ${filePath}\n`);
  return filePath;
}

/** Extract topic from the first system message. */
function extractTopic(): string {
  const all = messages.last(100);
  for (const m of all) {
    if (m.type === "system" && m.content.startsWith("Meeting topic:")) {
      return m.content.replace("Meeting topic:", "").split("\n")[0]!.trim();
    }
  }
  return "Untitled meeting";
}

function loadMeetingState(filePath: string): void {
  const raw = readFileSync(filePath, "utf8");
  const state = JSON.parse(raw) as MeetingState;

  // Clear existing state before restoring
  speakCount.clear();
  ledgerHistory.length = 0;

  // Restore messages
  for (const msg of state.messages) {
    messages.push(msg);
  }

  // Restore turn state
  turnOrder.length = 0;
  turnOrder.push(...state.turnOrder);
  currentTurnIdx = state.currentTurnIdx;
  totalTurns = state.totalTurns;
  meetingPhase = state.meetingPhase;
  conclusionAgentId = state.conclusionAgentId ?? null;
  meetingPaused = state.meetingPaused ?? false;

  // Restore speak counts
  for (const [id, count] of Object.entries(state.speakCount)) {
    speakCount.set(id, count);
  }

  // Restore ledger history
  ledgerHistory.push(...state.ledgerHistory);

  process.stderr.write(`[elrond-hub] Meeting restored from ${filePath} (${state.messages.length} messages)\n`);
}

// Load saved state on startup if env is set
// --- Speaking count ---

/** Number of times each agent has spoken (by agent ID). */
const speakCount = new Map<string, number>();

// --- Restore saved state on startup ---

const RESTORE_FILE = process.env.ELROND_RESTORE_FILE;
if (RESTORE_FILE && existsSync(RESTORE_FILE)) {
  loadMeetingState(RESTORE_FILE);
}

// --- Name resolution ---

function resolveAgentByName(name: string): RegisteredAgent | undefined {
  const lower = name.toLowerCase();
  for (const [, agent] of agents) {
    if (agent.name.toLowerCase() === lower) return agent;
  }
  for (const [, agent] of agents) {
    if (agent.name.toLowerCase().startsWith(lower)) return agent;
  }
  return undefined;
}

function resolveNextSpeakerId(nomination: string | undefined): string | undefined {
  if (!nomination) return undefined;
  if (agents.has(nomination)) return nomination;
  return resolveAgentByName(nomination)?.id;
}

// --- Turn mechanics ---

function currentTurnAgentId(): string | undefined {
  if (turnOrder.length === 0) return undefined;
  return turnOrder[currentTurnIdx % turnOrder.length];
}

function clearTurnTimeout(): void {
  if (turnTimeoutTimer) {
    clearTimeout(turnTimeoutTimer);
    turnTimeoutTimer = null;
  }
}

function advanceTurn(nominatedNextSpeaker?: string): void {
  if (turnOrder.length === 0) return;
  clearTurnTimeout();
  turnInProgress = false;

  // Don't advance during conclusion phase
  if (meetingPhase === "conclusion") return;

  totalTurns++;

  // Auto-save at the end of each full round
  if (turnOrder.length > 0 && totalTurns % turnOrder.length === 0) {
    saveMeetingState();
  }

  const resolvedId = resolveNextSpeakerId(nominatedNextSpeaker);

  if (resolvedId && turnOrder.includes(resolvedId)) {
    // Block consecutive self-nomination
    if (resolvedId === lastSpeakerId) {
      process.stderr.write(`[elrond-hub] Self-nomination blocked, falling back to round-robin\n`);
      currentTurnIdx = (currentTurnIdx + 1) % turnOrder.length;
    } else {
      currentTurnIdx = turnOrder.indexOf(resolvedId);
      process.stderr.write(`[elrond-hub] Swarm: next speaker → ${agents.get(resolvedId)?.name}\n`);
    }
  } else {
    if (nominatedNextSpeaker) {
      process.stderr.write(`[elrond-hub] Swarm: could not resolve "${nominatedNextSpeaker}", round-robin fallback\n`);
    }
    currentTurnIdx = (currentTurnIdx + 1) % turnOrder.length;
  }

  startCurrentTurn();
}

function startCurrentTurn(): void {
  if (meetingPaused) return;
  const agentId = currentTurnAgentId();
  if (!agentId || turnInProgress) return;
  const agent = agents.get(agentId);
  if (!agent || !agent.tmuxPane) return;

  // Skip disconnected agents with loop protection
  if (agent.config.status === "disconnected") {
    const connected = turnOrder.some((id) => {
      const a = agents.get(id);
      return a && a.config.status !== "disconnected";
    });
    if (!connected) {
      process.stderr.write("[elrond-hub] All agents disconnected, pausing turns\n");
      return;
    }
    advanceTurn();
    return;
  }

  turnInProgress = true;
  agent.config.status = "speaking";

  clearTurnTimeout();
  turnTimeoutTimer = setTimeout(() => {
    const currentId = currentTurnAgentId();
    if (turnInProgress && currentId === agentId) {
      process.stderr.write(`[elrond-hub] Turn timeout: ${agent.name} did not respond within ${TURN_TIMEOUT_MS / 1000}s, skipping\n`);
      broadcastSystemEvent("turn_timeout", `${agent.name} timed out — skipping turn.`);
      agent.config.status = "idle";
      turnInProgress = false;
      advanceTurn();
    }
  }, TURN_TIMEOUT_MS);

  const nudge = isFirstRoundComplete()
    ? `Your turn. Review the discussion with get_history, evaluate progress, then respond with send_message.`
    : `Your turn. Use get_history to see what's been said, then share your initial perspective with send_message.`;

  broadcastSystemEvent("turn_start", `It's ${agent.name}'s turn to speak.`);
  Bun.spawnSync(["tmux", "send-keys", "-t", agent.tmuxPane, "-l", nudge]);
  Bun.spawnSync(["tmux", "send-keys", "-t", agent.tmuxPane, "Enter"]);
}

// --- MagenticOne: Ledger processing ---

function processLedger(senderAgent: RegisteredAgent, ledger: LedgerEvaluation): void {
  ledgerHistory.push({
    agentId: senderAgent.id,
    agentName: senderAgent.name,
    timestamp: Date.now(),
    ledger,
  });
  // Cap ledger history to prevent unbounded growth
  if (ledgerHistory.length > MAX_LEDGER_HISTORY) {
    ledgerHistory.splice(0, ledgerHistory.length - MAX_LEDGER_HISTORY);
  }

  if (ledger.consensusReached && meetingPhase === "discussion") {
    handleConsensusReached(ledger.conclusionAgent);
    return;
  }

  checkForStallOrLoop();
}

function handleConsensusReached(conclusionAgentName?: string): void {
  meetingPhase = "conclusion";

  const resolvedId = resolveNextSpeakerId(conclusionAgentName);
  conclusionAgentId = resolvedId && agents.has(resolvedId)
    ? resolvedId
    : turnOrder[0] ?? null;

  if (!conclusionAgentId) return;

  const cAgent = agents.get(conclusionAgentId)!;
  if (resolvedId !== conclusionAgentId) {
    process.stderr.write(
      `[elrond-hub] Consensus: "${conclusionAgentName}" not found, defaulting to ${cAgent.name}\n`,
    );
  }

  broadcastSystemEvent(
    "consensus_reached",
    `Consensus reached. ${cAgent.name} will produce the final output.`,
  );

  startConclusionTurn();
}

function startConclusionTurn(): void {
  if (!conclusionAgentId) return;
  const agent = agents.get(conclusionAgentId);
  if (!agent?.tmuxPane) return;

  clearTurnTimeout();
  turnInProgress = true;
  agent.config.status = "concluding";
  currentTurnIdx = turnOrder.indexOf(conclusionAgentId);

  broadcastSystemEvent("conclusion_start", `${agent.name} is producing the final output.`);

  const nudge = [
    `The group has reached consensus. You have been designated to produce the final output.`,
    `Review the full discussion using get_history, then deliver the result.`,
    `You may use Write, Edit, and Bash tools to produce files, code changes, or other artifacts.`,
    `When done, send a final summary message using send_message.`,
  ].join(" ");

  turnTimeoutTimer = setTimeout(() => {
    if (turnInProgress && meetingPhase === "conclusion") {
      process.stderr.write(`[elrond-hub] Conclusion timeout for ${agent.name}\n`);
      broadcastSystemEvent("turn_timeout", `${agent.name} conclusion timed out.`);
      agent.config.status = "idle";
      meetingPhase = "discussion";
      conclusionAgentId = null;
      turnInProgress = false;
      advanceTurn();
    }
  }, CONCLUSION_TIMEOUT_MS);

  Bun.spawnSync(["tmux", "send-keys", "-t", agent.tmuxPane, "-l", nudge]);
  Bun.spawnSync(["tmux", "send-keys", "-t", agent.tmuxPane, "Enter"]);
}

function checkForStallOrLoop(): void {
  if (ledgerHistory.length < STALL_THRESHOLD) return;
  const recent = ledgerHistory.slice(-STALL_THRESHOLD);

  const loopCount = recent.filter((e) => e.ledger.isInLoop).length;
  if (loopCount >= LOOP_THRESHOLD) {
    broadcastSystemEvent(
      "loop_detected",
      "The discussion appears to be going in circles. Consider changing approach or re-framing the problem.",
    );
    return;
  }

  const noProgressCount = recent.filter((e) => !e.ledger.progressBeingMade).length;
  if (noProgressCount >= STALL_THRESHOLD) {
    broadcastSystemEvent(
      "stall_detected",
      "Progress has stalled. Try breaking the problem down, identifying specific blockers, or proposing a concrete next step.",
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envelope(type: WsEnvelope["type"], payload: unknown): string {
  return JSON.stringify({ type, payload, ts: Date.now() } satisfies WsEnvelope);
}

function broadcast(msg: MeetingMessage, excludeId?: string): void {
  const data = envelope("message_broadcast", msg);
  for (const [id, agent] of agents) {
    if (id !== excludeId && agent.ws?.readyState === WS_OPEN) agent.ws.send(data);
  }
  for (const v of viewers) {
    if (v.readyState === WS_OPEN) v.send(data);
  }
}

function broadcastSystemEvent(kind: SystemEventKind, content: string): void {
  const evt: SystemEvent = {
    id: generateUlid(),
    type: "system",
    timestamp: Date.now(),
    sender: { id: "system", name: "System" },
    content,
    eventKind: kind,
  };
  messages.push(evt);
  const data = envelope("system_event", evt);
  for (const [, agent] of agents) {
    if (agent.ws?.readyState === WS_OPEN) agent.ws.send(data);
  }
  for (const v of viewers) {
    if (v.readyState === WS_OPEN) v.send(data);
  }
}

const RESERVED_IDS = new Set(["frodo", "system"]);

function senderType(id: string): MeetingMessage["type"] {
  if (id === "frodo") return "user";
  if (id === "system") return "system";
  return "agent";
}

function createMessage(body: PostMessageBody): MeetingMessage {
  const msg: MeetingMessage = {
    id: generateUlid(),
    type: senderType(body.sender.id),
    timestamp: Date.now(),
    sender: body.sender,
    content: body.content,
    ...(body.replyTo ? { replyTo: body.replyTo } : {}),
    ...(body.meta ? { meta: body.meta } : {}),
    ...(body.nextSpeaker ? { nextSpeaker: body.nextSpeaker } : {}),
    ...(body.ledger ? { ledger: body.ledger } : {}),
  };
  messages.push(msg);
  return msg;
}

function participantList(): ParticipantInfo[] {
  const list: ParticipantInfo[] = [];
  for (const [, a] of agents) {
    list.push({
      id: a.id,
      name: a.name,
      clientType: "agent",
      status: a.config.status,
      config: a.config,
      speakCount: speakCount.get(a.id) ?? 0,
    });
  }
  return list;
}

/** Inject a slash command into an agent's tmux pane. */
function tmuxInject(pane: string, command: string): void {
  if (!pane) return;
  Bun.spawnSync(["tmux", "send-keys", "-t", pane, command, "Enter"], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// WebSocket: handshake
// ---------------------------------------------------------------------------

function handleHandshake(
  ws: ServerWebSocket<WsClientData>,
  payload: HandshakePayload,
): void {
  if (payload.clientType === "agent" && payload.agentId) {
    if (RESERVED_IDS.has(payload.agentId)) {
      ws.close(4002, `reserved agent id: ${payload.agentId}`);
      return;
    }
    ws.data.clientType = "agent";
    ws.data.clientId = payload.agentId;
    ws.data.handshakeComplete = true;

    let agent = agents.get(payload.agentId);
    if (!agent) {
      agent = {
        id: payload.agentId,
        name: payload.agentName ?? payload.agentId,
        config: {
          id: payload.agentId,
          name: payload.agentName ?? payload.agentId,
          model: "unknown",
          effort: "high",
          persona: "",
          status: "idle",
        },
        ws,
        lastPong: Date.now(),
        joinedAt: Date.now(),
        tmuxPane: "",
        _idleTimer: null,
      };
      agents.set(payload.agentId, agent);
      broadcastSystemEvent("agent_joined", `${agent.name} joined the meeting.`);
    } else {
      // Close stale connection if still open
      if (agent.ws && agent.ws !== ws && agent.ws.readyState === WS_OPEN) {
        agent.ws.close(4001, "replaced_by_reconnect");
      }
      agent.ws = ws;
      agent.config.status = "idle";
      agent.lastPong = Date.now();
    }

    // Gap recovery
    handleSync(ws, payload.lastSeenUlid);

    // Send ACK
    const ack: HandshakeAckPayload = {
      success: true,
      meetingId: MEETING_ID,
      participants: participantList(),
      recentMessages: messages.last(50),
    };
    ws.send(envelope("handshake_ack", ack));
  } else if (payload.clientType === "viewer") {
    ws.data.clientType = "viewer";
    ws.data.clientId = `viewer-${Date.now()}`;
    ws.data.handshakeComplete = true;
    viewers.add(ws);

    handleSync(ws, payload.lastSeenUlid);

    const ack: HandshakeAckPayload = {
      success: true,
      meetingId: MEETING_ID,
      participants: participantList(),
      recentMessages: messages.last(100),
    };
    ws.send(envelope("handshake_ack", ack));
  }
}

function handleSync(
  ws: ServerWebSocket<WsClientData>,
  lastSeenUlid?: string,
): void {
  if (!lastSeenUlid) {
    ws.send(envelope("sync_complete", { missedCount: 0 } satisfies SyncCompletePayload));
    return;
  }

  const missed = messages.after(lastSeenUlid);
  if (missed === null) {
    ws.send(
      envelope("sync_lost", {
        oldestAvailable: messages.oldestId(),
        reason: "ring_buffer_overflow",
      } satisfies SyncLostPayload),
    );
    return;
  }

  for (const m of missed) {
    ws.send(envelope("replay", m));
  }
  ws.send(envelope("sync_complete", { missedCount: missed.length } satisfies SyncCompletePayload));
}

// ---------------------------------------------------------------------------
// WebSocket: message routing
// ---------------------------------------------------------------------------

function handleWsMessage(
  ws: ServerWebSocket<WsClientData>,
  raw: string,
): void {
  let env: WsEnvelope;
  try {
    env = JSON.parse(raw);
  } catch {
    return;
  }

  switch (env.type) {
    case "handshake":
      handleHandshake(ws, env.payload as HandshakePayload);
      break;

    case "send_message": {
      const body = env.payload as PostMessageBody;
      body.sender = { id: ws.data.clientId, name: agents.get(ws.data.clientId)?.name ?? ws.data.clientId };
      const msg = createMessage(body);
      broadcast(msg, ws.data.clientId);
      // ack with the created message id
      ws.send(envelope("message_broadcast", msg));
      break;
    }

    case "heartbeat_pong":
      ws.data.lastPong = Date.now();
      if (ws.data.clientType === "agent") {
        const agent = agents.get(ws.data.clientId);
        if (agent) agent.lastPong = Date.now();
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

async function handleRest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;

  // GET /api/status
  if (method === "GET" && url.pathname === "/api/status") {
    return json({
      meetingId: MEETING_ID,
      startedAt,
      messageCount: messages.length,
      participants: participantList(),
      currentTurn: currentTurnAgentId() ?? null,
      turnOrder,
      meetingPhase,
      meetingPaused,
      conclusionAgent: conclusionAgentId ? agents.get(conclusionAgentId)?.name ?? null : null,
      recentLedger: ledgerHistory.slice(-5),
    });
  }

  // GET /api/messages?limit=N&after=ID
  if (method === "GET" && url.pathname === "/api/messages") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);
    const after = url.searchParams.get("after");
    let result: MeetingMessage[];
    if (after) {
      result = messages.after(after) ?? messages.last(limit);
    } else {
      result = messages.last(limit);
    }
    return json({ messages: result });
  }

  // GET /api/participants
  if (method === "GET" && url.pathname === "/api/participants") {
    return json({ participants: participantList() });
  }

  // POST /api/message — Frodo, system, or agent sends a message
  if (method === "POST" && url.pathname === "/api/message") {
    const body = (await req.json()) as PostMessageBody;
    if (!body.content || !body.sender?.id) {
      return json({ error: "content and sender.id required" }, 400);
    }
    const msg = createMessage(body);
    broadcast(msg);

    const agent = agents.get(body.sender.id);
    if (agent) {
      if (agent._idleTimer) clearTimeout(agent._idleTimer);
      agent._idleTimer = null;

      // Track speaking count for fairness (passes don't count)
      if (body.meta?.pass !== "true") {
        speakCount.set(agent.id, (speakCount.get(agent.id) ?? 0) + 1);
        // #7: Set lastSpeakerId when agent actually speaks, not on turn start
        lastSpeakerId = agent.id;
      }

      // #3: Conclusion check BEFORE ledger processing to prevent re-entrant consensus
      if (meetingPhase === "conclusion" && body.sender.id === conclusionAgentId) {
        agent.config.status = "idle";
        broadcastSystemEvent("conclusion_complete", `${agent.name} has delivered the final output.`);
        clearTurnTimeout();
        turnInProgress = false;
        meetingPhase = "discussion";
        conclusionAgentId = null;
        // Auto-save on conclusion
        saveMeetingState();
        return json({ message: msg });
      }

      // Process ledger if present (only during discussion phase)
      if (body.ledger && meetingPhase === "discussion") {
        processLedger(agent, body.ledger);
      }

      // Normal discussion: advance turn with swarm nomination
      agent.config.status = "idle";
      if (body.sender.id === currentTurnAgentId()) {
        clearTurnTimeout();
        // #1: Cancel any pending advance timer before scheduling new one
        if (pendingAdvanceTimer) { clearTimeout(pendingAdvanceTimer); pendingAdvanceTimer = null; }
        pendingAdvanceTimer = setTimeout(() => {
          pendingAdvanceTimer = null;
          advanceTurn(body.nextSpeaker);
        }, 2_000);
      }
    }

    // Frodo message: check for commands
    if (body.sender.id === "frodo") {
      const cmd = parseFrodoCommand(body.content);
      if (cmd === "stop") {
        pauseMeeting();
        return json({ message: msg });
      }
      if (cmd === "resume") {
        resumeMeeting();
        return json({ message: msg });
      }
      if (cmd === "save") {
        const filePath = saveMeetingState();
        broadcastSystemEvent("meeting_ended", `Meeting saved to ${filePath}`);
        return json({ message: msg });
      }
    }

    // Frodo or system message: if no turn is in progress, kick off the next turn
    if (!agent && !turnInProgress && !meetingPaused && turnOrder.length > 0) {
      setTimeout(() => startCurrentTurn(), 1_000);
    }

    return json({ message: msg });
  }

  // POST /api/register-agent — Launcher registers agents with tmux pane info
  if (method === "POST" && url.pathname === "/api/register-agent") {
    const body = (await req.json()) as RegisterAgentBody;
    let agent = agents.get(body.agentId);
    if (!agent) {
      agent = {
        id: body.agentId,
        name: body.name,
        config: {
          id: body.agentId,
          name: body.name,
          model: body.model,
          effort: body.effort as AgentConfig["effort"],
          persona: body.persona,
          status: "launching",
        },
        ws: null,
        lastPong: Date.now(),
        joinedAt: Date.now(),
        tmuxPane: body.tmuxPane,
        _idleTimer: null,
      };
      agents.set(body.agentId, agent);
      // Add to turn order
      if (!turnOrder.includes(body.agentId)) {
        turnOrder.push(body.agentId);
      }
    } else {
      agent.tmuxPane = body.tmuxPane;
      agent.config.model = body.model;
      agent.config.effort = body.effort as AgentConfig["effort"];
    }
    return json({ success: true });
  }

  // POST /api/force-speak
  if (method === "POST" && url.pathname === "/api/force-speak") {
    const body = (await req.json()) as ForceSpeakPayload;
    const agent = agents.get(body.targetAgentId);
    if (!agent?.ws) {
      return json({ error: "agent not connected" }, 404);
    }
    agent.ws.send(
      envelope("force_speak", body),
    );
    return json({ success: true });
  }

  // PATCH /api/agent/:id/config
  if (method === "PATCH" && url.pathname.startsWith("/api/agent/")) {
    const parts = url.pathname.split("/");
    const agentId = parts[3]; // /api/agent/<id>/config
    const agent = agents.get(agentId ?? "");
    if (!agent) return json({ error: "agent not found" }, 404);

    const update = (await req.json()) as ConfigUpdatePayload;
    if (update.model) agent.config.model = update.model;
    if (update.effort) agent.config.effort = update.effort;
    if (update.persona !== undefined) agent.config.persona = update.persona;

    // Inject /model and /effort via tmux for actual CC session change
    if (update.model && agent.tmuxPane) {
      tmuxInject(agent.tmuxPane, `/model ${update.model}`);
    }
    if (update.effort && agent.tmuxPane) {
      tmuxInject(agent.tmuxPane, `/effort ${update.effort}`);
    }

    // Broadcast config_changed to the target agent (channel notification)
    if (agent.ws?.readyState === WS_OPEN) {
      agent.ws.send(envelope("config_update", { ...agent.config }));
    }
    broadcastSystemEvent("config_changed", `${agent.name}'s config updated.`);
    return json({ config: agent.config });
  }

  return new Response("Not found", { status: 404 });
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

setInterval(() => {
  const ping = envelope("heartbeat_ping", { ts: Date.now() });
  const now = Date.now();

  for (const [id, agent] of agents) {
    if (agent.ws?.readyState === WS_OPEN) {
      agent.ws.send(ping);
      if (now - agent.lastPong > HEARTBEAT_TIMEOUT_MS) {
        agent.config.status = "disconnected";
        agent.ws.close(4000, "heartbeat_timeout");
        agent.ws = null;
        broadcastSystemEvent("agent_crashed", `${agent.name} is unresponsive.`);
      }
    }
  }
}, HEARTBEAT_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const server = Bun.serve<WsClientData>({
  port: 0, // random free port
  hostname: "127.0.0.1",

  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade on /ws
    if (url.pathname === "/ws" && req.headers.get("upgrade") === "websocket") {
      const ok = server.upgrade(req, {
        data: {
          clientType: "unknown" as const,
          clientId: "",
          handshakeComplete: false,
          lastPong: Date.now(),
        },
      });
      return ok ? undefined : new Response("Upgrade failed", { status: 400 });
    }

    return handleRest(req);
  },

  websocket: {
    idleTimeout: 120,
    sendPings: true,

    open(_ws) {
      // Wait for handshake message
    },

    message(ws, raw) {
      handleWsMessage(ws, String(raw));
    },

    close(ws) {
      if (ws.data.clientType === "viewer") {
        viewers.delete(ws);
        return;
      }
      if (ws.data.clientType === "agent") {
        const agent = agents.get(ws.data.clientId);
        if (agent) {
          agent.ws = null;
          agent.config.status = "disconnected";
          broadcastSystemEvent("agent_left", `${agent.name} disconnected.`);
        }
      }
    },
  },
});

// Write port file for discovery by other processes
const portFile = `/tmp/elrond-${MEETING_ID}.port`;
await Bun.write(portFile, String(server.port));

process.stderr.write(
  `[elrond-hub] meeting=${MEETING_ID} port=${server.port} portFile=${portFile}\n`,
);

// Cleanup port file on exit
function cleanup() {
  try { unlinkSync(portFile); } catch {}
}
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
