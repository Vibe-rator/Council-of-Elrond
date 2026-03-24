/**
 * WebSocket client with exponential backoff reconnection and state tracking.
 *
 * Backoff resets only after the full protocol handshake completes
 * (call `resetBackoff()` from the application layer after ACK + SYNC_COMPLETE).
 */

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export interface ReconnectConfig {
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  jitterFactor: number; // ±fraction of the computed delay
}

const DEFAULTS: ReconnectConfig = {
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  backoffFactor: 2,
  jitterFactor: 0.5,
};

export class ReconnectingWebSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private _state: ConnectionState = "disconnected";
  private intentionalClose = false;

  onMessage: ((data: string) => void) | null = null;
  onStateChange: ((state: ConnectionState) => void) | null = null;

  constructor(
    private url: string,
    private config: ReconnectConfig = DEFAULTS,
  ) {}

  get state(): ConnectionState {
    return this._state;
  }

  connect(): void {
    this.intentionalClose = false;
    this.attempt = 0;
    this.tryConnect();
  }

  /** Call after full protocol handshake (ACK + SYNC_COMPLETE). */
  resetBackoff(): void {
    this.attempt = 0;
  }

  send(data: string): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
      return true;
    }
    return false;
  }

  close(): void {
    this.intentionalClose = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.ws?.close(1000, "intentional");
    this.setState("disconnected");
  }

  // --- internal ---

  private setState(s: ConnectionState): void {
    if (this._state === s) return;
    this._state = s;
    this.onStateChange?.(s);
  }

  private tryConnect(): void {
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");

    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.addEventListener("open", () => {
      this.setState("connected");
    });

    this.ws.addEventListener("close", () => {
      if (this.intentionalClose) return;
      this.scheduleReconnect();
    });

    this.ws.addEventListener("error", () => {
      // close always fires after error — reconnect is handled there
    });

    this.ws.addEventListener("message", (event) => {
      this.onMessage?.(String(event.data));
    });
  }

  private scheduleReconnect(): void {
    const base = Math.min(
      this.config.initialDelayMs *
        Math.pow(this.config.backoffFactor, this.attempt),
      this.config.maxDelayMs,
    );
    const jitter = base * this.config.jitterFactor;
    const delay = base - jitter + Math.random() * jitter * 2;

    this.attempt++;
    this.setState("reconnecting");
    this.timer = setTimeout(() => this.tryConnect(), delay);
  }
}
