/**
 * Tracks outbound messages that have not yet been acknowledged by the Hub.
 * After reconnection, un-acked messages can be re-sent.
 * Messages older than STALE_MS are silently discarded to prevent duplicates.
 */

interface PendingMessage {
  id: string;
  payload: string;
  sentAt: number;
}

const STALE_MS = 30_000;

export class OutboundQueue {
  private pending = new Map<string, PendingMessage>();

  enqueue(id: string, payload: string): void {
    this.pending.set(id, { id, payload, sentAt: Date.now() });
  }

  markAcked(id: string): void {
    this.pending.delete(id);
  }

  /** Return un-acked messages that are still fresh enough to re-send. */
  getUnacked(): PendingMessage[] {
    const now = Date.now();
    const result: PendingMessage[] = [];
    for (const [id, msg] of this.pending) {
      if (now - msg.sentAt > STALE_MS) {
        this.pending.delete(id);
      } else {
        result.push(msg);
      }
    }
    return result;
  }

  clear(): void {
    this.pending.clear();
  }
}
