import { describe, expect, test } from "bun:test";
import { OutboundQueue } from "../../src/lib/outbound-queue.ts";

describe("OutboundQueue", () => {
  test("enqueue and getUnacked returns pending messages", () => {
    const q = new OutboundQueue();
    q.enqueue("1", '{"msg":"hello"}');
    q.enqueue("2", '{"msg":"world"}');

    const unacked = q.getUnacked();
    expect(unacked.length).toBe(2);
    expect(unacked[0]?.id).toBe("1");
  });

  test("markAcked removes message", () => {
    const q = new OutboundQueue();
    q.enqueue("1", "a");
    q.enqueue("2", "b");
    q.markAcked("1");

    const unacked = q.getUnacked();
    expect(unacked.length).toBe(1);
    expect(unacked[0]?.id).toBe("2");
  });

  test("clear removes all", () => {
    const q = new OutboundQueue();
    q.enqueue("1", "a");
    q.enqueue("2", "b");
    q.clear();

    expect(q.getUnacked().length).toBe(0);
  });

  test("stale messages (>30s) are discarded on getUnacked", () => {
    const q = new OutboundQueue();
    q.enqueue("old", "stale-payload");

    // Manually backdate the sentAt by accessing internal state
    // We need to test the time-based expiry, so we monkey-patch Date.now
    const realNow = Date.now;
    try {
      // Simulate 31 seconds passing
      Date.now = () => realNow() + 31_000;
      const unacked = q.getUnacked();
      expect(unacked.length).toBe(0); // old message should be discarded
    } finally {
      Date.now = realNow;
    }
  });

  test("fresh messages survive getUnacked", () => {
    const q = new OutboundQueue();
    q.enqueue("fresh", "fresh-payload");

    const realNow = Date.now;
    try {
      // Only 5 seconds later — should still be alive
      Date.now = () => realNow() + 5_000;
      const unacked = q.getUnacked();
      expect(unacked.length).toBe(1);
      expect(unacked[0]?.id).toBe("fresh");
    } finally {
      Date.now = realNow;
    }
  });

  test("duplicate enqueue overwrites previous", () => {
    const q = new OutboundQueue();
    q.enqueue("dup", "first");
    q.enqueue("dup", "second");

    const unacked = q.getUnacked();
    expect(unacked.length).toBe(1);
    expect(unacked[0]?.payload).toBe("second");
  });

  test("markAcked is idempotent", () => {
    const q = new OutboundQueue();
    q.enqueue("1", "a");
    q.markAcked("1");
    q.markAcked("1"); // second call should not throw
    expect(q.getUnacked().length).toBe(0);
  });
});
