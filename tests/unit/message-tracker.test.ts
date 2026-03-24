import { describe, test, expect } from "bun:test";
import { MessageTracker } from "../../src/lib/message-tracker.ts";

describe("MessageTracker", () => {
  test("starts with null", () => {
    const t = new MessageTracker();
    expect(t.getLastSeen()).toBeNull();
  });

  test("records and returns last seen", () => {
    const t = new MessageTracker();
    t.record("01ABC");
    t.record("01DEF");
    expect(t.getLastSeen()).toBe("01DEF");
  });
});
