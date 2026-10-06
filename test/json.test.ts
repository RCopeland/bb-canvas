import { describe, expect, it } from "vitest";
import { toJsonValue } from "../canvas/json";

/** Round-trip through real JSON, which is the boundary the server enforces. */
function assertIsJson(value: unknown): void {
  const encoded = JSON.stringify(value);
  expect(encoded).toBeDefined();
  expect(JSON.parse(encoded)).toEqual(value);
}

describe("toJsonValue", () => {
  it("keeps JSON-native scalars", () => {
    for (const value of ["s", 1, 0, -1.5, true, false, null]) {
      expect(toJsonValue(value)).toBe(value);
      assertIsJson(toJsonValue(value));
    }
  });

  it("drops undefined object keys, the customData case that broke saving", () => {
    // Excalidraw types customData as Record<string, any> and leaves keys
    // undefined. This is the exact shape that produced
    // "...customData is not a JSON value".
    const element = {
      id: "rect-1",
      type: "rectangle",
      customData: { link: undefined, keep: "yes" },
    };
    const result = toJsonValue(element) as Record<string, unknown>;
    expect(result.customData).toEqual({ keep: "yes" });
    assertIsJson(result);
  });

  it("nulls undefined array entries so indices stay aligned", () => {
    expect(toJsonValue([1, undefined, 3])).toEqual([1, null, 3]);
    assertIsJson(toJsonValue([1, undefined, 3]));
  });

  it("converts NaN and Infinity to null, as JSON.stringify does", () => {
    expect(toJsonValue({ a: NaN, b: Infinity, c: -Infinity })).toEqual({
      a: null,
      b: null,
      c: null,
    });
    assertIsJson(toJsonValue({ a: NaN }));
  });

  it("converts BigInt to a string instead of throwing", () => {
    // JSON.stringify throws on BigInt; a throw here would break the save.
    expect(() => JSON.stringify({ n: 1n })).toThrow();
    expect(toJsonValue({ n: 10n })).toEqual({ n: "10" });
    assertIsJson(toJsonValue({ n: 10n }));
  });

  it("drops functions and symbols", () => {
    const value = { fn: () => 1, sym: Symbol("s"), ok: 1 };
    expect(toJsonValue(value)).toEqual({ ok: 1 });
    assertIsJson(toJsonValue(value));
  });

  it("breaks cycles instead of throwing", () => {
    const node: Record<string, unknown> = { id: "a" };
    node.self = node;
    expect(() => toJsonValue(node)).not.toThrow();
    const result = toJsonValue(node) as Record<string, unknown>;
    expect(result.id).toBe("a");
    // The cyclic branch is dropped, not serialized.
    expect("self" in result).toBe(false);
    assertIsJson(result);
  });

  it("breaks cycles through arrays", () => {
    const list: unknown[] = [1];
    list.push(list);
    const result = toJsonValue({ list }) as { list: unknown[] };
    expect(result.list[0]).toBe(1);
    assertIsJson(result);
  });

  it("serializes a shared (non-cyclic) subtree at every occurrence", () => {
    // Sharing is not a cycle: the same object appearing in two sibling
    // branches must be written twice, not dropped.
    const shared = { v: 1 };
    const result = toJsonValue({ a: shared, b: shared });
    expect(result).toEqual({ a: { v: 1 }, b: { v: 1 } });
    assertIsJson(result);
  });

  it("sanitizes a realistic Excalidraw element list end to end", () => {
    const scene = {
      elements: [
        {
          id: "e1",
          type: "freedraw",
          x: 0,
          y: 0,
          width: 10,
          height: NaN,
          customData: { link: undefined },
          seed: 12345,
        },
      ],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    };
    const result = toJsonValue(scene);
    assertIsJson(result);
    const element = (result as { elements: Record<string, unknown>[] }).elements[0];
    expect(element.height).toBeNull();
    expect(element.customData).toEqual({});
  });
});
