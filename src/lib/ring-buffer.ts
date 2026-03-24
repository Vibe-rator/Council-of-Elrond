/**
 * Fixed-capacity circular buffer. Oldest entries are overwritten when full.
 * Items must have a string `id` field for lookup.
 */
export class RingBuffer<T extends { id: string }> {
  private buf: (T | null)[];
  private head = 0; // next write position
  private count = 0;

  constructor(private capacity: number = 10_000) {
    this.buf = new Array<T | null>(capacity).fill(null);
  }

  get length(): number {
    return this.count;
  }

  push(item: T): void {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Return the last `n` items in insertion order. */
  last(n: number): T[] {
    const take = Math.min(n, this.count);
    const result: T[] = [];
    for (let i = this.count - take; i < this.count; i++) {
      const idx = this.indexAt(i);
      const item = this.buf[idx];
      if (item) result.push(item);
    }
    return result;
  }

  /**
   * Return all items inserted after the item with the given id.
   * Returns `null` if the id has been overwritten (gap too large).
   */
  after(id: string): T[] | null {
    const entries = this.ordered();
    const anchor = entries.findIndex((m) => m.id === id);
    if (anchor === -1) return null;
    return entries.slice(anchor + 1);
  }

  /** The oldest id still in the buffer, or null if empty. */
  oldestId(): string | null {
    if (this.count === 0) return null;
    return this.buf[this.indexAt(0)]?.id ?? null;
  }

  /** Return all entries in insertion order. */
  ordered(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const item = this.buf[this.indexAt(i)];
      if (item) result.push(item);
    }
    return result;
  }

  /** Map a logical index (0 = oldest) to a physical buffer index. */
  private indexAt(logicalIdx: number): number {
    const start =
      this.count < this.capacity ? 0 : this.head;
    return (start + logicalIdx) % this.capacity;
  }
}
