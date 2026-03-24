/**
 * Tracks the ULID of the last received message.
 * Used during reconnection to request gap recovery from the Hub.
 */
export class MessageTracker {
  private lastSeenUlid: string | null = null;

  record(ulid: string): void {
    this.lastSeenUlid = ulid;
  }

  getLastSeen(): string | null {
    return this.lastSeenUlid;
  }
}
