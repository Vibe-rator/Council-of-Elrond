// === Agent ===

export interface AgentConfig {
  id: string;
  name: string;
  model: string;
  effort: "low" | "medium" | "high" | "max";
  persona: string;
  status: AgentStatus;
}

export type AgentStatus =
  | "launching"
  | "connected"
  | "idle"
  | "speaking"
  | "concluding"
  | "disconnected";

// === Messages ===

export type MessageType = "agent" | "user" | "system";

export interface LedgerEvaluation {
  consensusReached: boolean;
  isInLoop: boolean;
  progressBeingMade: boolean;
  conclusionAgent?: string; // agent display name
}

export interface MeetingMessage {
  id: string; // ULID — generated at Hub
  type: MessageType;
  timestamp: number; // Date.now() epoch ms
  sender: { id: string; name: string };
  content: string;
  replyTo?: string;
  meta?: Record<string, string>;
  nextSpeaker?: string;
  ledger?: LedgerEvaluation;
}

// === Hub WebSocket Protocol ===

export interface WsEnvelope {
  type: WsMessageType;
  payload: unknown;
  ts: number;
}

export type WsMessageType =
  | "handshake"
  | "handshake_ack"
  | "send_message"
  | "message_broadcast"
  | "system_event"
  | "heartbeat_ping"
  | "heartbeat_pong"
  | "force_speak"
  | "config_update"
  | "sync_complete"
  | "sync_lost"
  | "replay";

// --- Handshake ---

export interface HandshakePayload {
  clientType: "agent" | "viewer";
  agentId?: string;
  agentName?: string;
  lastSeenUlid?: string; // for gap recovery on reconnect
}

export interface HandshakeAckPayload {
  success: boolean;
  meetingId: string;
  participants: ParticipantInfo[];
  recentMessages: MeetingMessage[];
}

// --- Participants ---

export interface ParticipantInfo {
  id: string;
  name: string;
  clientType: "agent" | "viewer";
  status: AgentStatus;
  speakCount?: number;
  config?: AgentConfig;
}

// --- System Events ---

export type SystemEventKind =
  | "meeting_started"
  | "meeting_ended"
  | "agent_joined"
  | "agent_left"
  | "agent_crashed"
  | "force_speak"
  | "config_changed"
  | "turn_start"
  | "turn_timeout"
  | "consensus_reached"
  | "conclusion_start"
  | "conclusion_complete"
  | "stall_detected"
  | "loop_detected";

export interface SystemEvent extends MeetingMessage {
  type: "system";
  eventKind: SystemEventKind;
}

// --- Sync Protocol ---

export interface SyncCompletePayload {
  missedCount: number;
}

export interface SyncLostPayload {
  oldestAvailable: string | null;
  reason: string;
}

// --- Force Speak ---

export interface ForceSpeakPayload {
  targetAgentId: string;
  prompt?: string;
}

// --- Config Update ---

export interface ConfigUpdatePayload {
  agentId: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  persona?: string;
}

// --- Agent Registration (Launcher → Hub) ---

export interface RegisterAgentBody {
  agentId: string;
  name: string;
  model: string;
  effort: string;
  persona: string;
  tmuxPane: string; // e.g. "elrond-abc:0.0"
}

// --- Hub REST API request bodies ---

export interface PostMessageBody {
  content: string;
  sender: { id: string; name: string };
  replyTo?: string;
  meta?: Record<string, string>;
  nextSpeaker?: string;
  ledger?: LedgerEvaluation;
}

// --- Meeting State (save/restore) ---

export interface SavedAgentConfig {
  id: string;
  name: string;
  model: string;
  effort: string;
  persona: string;
}

export interface MeetingState {
  version: 1;
  meetingId: string;
  topic: string;
  savedAt: number;
  startedAt: number;
  agents: SavedAgentConfig[];
  messages: MeetingMessage[];
  turnOrder: string[];
  currentTurnIdx: number;
  totalTurns: number;
  speakCount: Record<string, number>;
  ledgerHistory: Array<{
    agentId: string;
    agentName: string;
    timestamp: number;
    ledger: LedgerEvaluation;
  }>;
  meetingPhase: "discussion" | "conclusion";
  conclusionAgentId?: string | null;
  meetingPaused?: boolean;
}

// --- WebSocket client data attached to each connection ---

export interface WsClientData {
  clientType: "agent" | "viewer" | "unknown";
  clientId: string;
  handshakeComplete: boolean;
  lastPong: number;
}
