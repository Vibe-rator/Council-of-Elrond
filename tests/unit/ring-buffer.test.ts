import { describe, expect, test } from "bun:test";
import { RingBuffer } from "../../src/lib/ring-buffer.ts";

type Item = { id: string; val: number };

function item(id: string, val = 0): Item {
  return { id, val };
}

describe("RingBuffer", () => {
  test("push and last(n)", () => {
    const buf = new RingBuffer<Item>(5);
    buf.push(item("a", 1));
    buf.push(item("b", 2));
    buf.push(item("c", 3));

    expect(buf.length).toBe(3);
    expect(buf.last(2)).toEqual([item("b", 2), item("c", 3)]);
    expect(buf.last(10)).toEqual([item("a", 1), item("b", 2), item("c", 3)]);
  });

  test("overflow: oldest items are dropped", () => {
    const buf = new RingBuffer<Item>(3);
    buf.push(item("a"));
    buf.push(item("b"));
    buf.push(item("c"));
    buf.push(item("d")); // overwrites "a"

    expect(buf.length).toBe(3);
    expect(buf.ordered().map((i) => i.id)).toEqual(["b", "c", "d"]);
    expect(buf.last(2).map((i) => i.id)).toEqual(["c", "d"]);
  });

  test("after(id) returns items after given id", () => {
    const buf = new RingBuffer<Item>(10);
    buf.push(item("a"));
    buf.push(item("b"));
    buf.push(item("c"));
    buf.push(item("d"));

    expect(buf.after("b")?.map((i) => i.id)).toEqual(["c", "d"]);
    expect(buf.after("d")).toEqual([]);
  });

  test("after(id) returns null if id was overwritten", () => {
    const buf = new RingBuffer<Item>(3);
    buf.push(item("a"));
    buf.push(item("b"));
    buf.push(item("c"));
    buf.push(item("d")); // "a" overwritten

    expect(buf.after("a")).toBeNull();
    expect(buf.after("b")?.map((i) => i.id)).toEqual(["c", "d"]);
  });

  test("oldestId returns oldest remaining id", () => {
    const buf = new RingBuffer<Item>(3);
    expect(buf.oldestId()).toBeNull();

    buf.push(item("a"));
    expect(buf.oldestId()).toBe("a");

    buf.push(item("b"));
    buf.push(item("c"));
    buf.push(item("d")); // "a" overwritten

    expect(buf.oldestId()).toBe("b");
  });

  test("large capacity works correctly", () => {
    const buf = new RingBuffer<Item>(100);
    for (let i = 0; i < 150; i++) {
      buf.push(item(String(i)));
    }
    expect(buf.length).toBe(100);
    expect(buf.oldestId()).toBe("50");
    expect(buf.last(1)[0]?.id).toBe("149");
  });
});
