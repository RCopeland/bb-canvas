import { describe, expect, it } from "vitest";
import {
  layoutsEqual,
  readWindowLayout,
  retainKnownThreads,
  serializeWindowLayout,
  type StoredWindow,
} from "../canvas/windowLayout";

const LAYER = { width: 1200, height: 800 };

function win(over: Partial<StoredWindow> = {}): StoredWindow {
  return {
    threadId: "t1",
    x: 40,
    y: 60,
    width: 460,
    height: 560,
    visible: true,
    ...over,
  };
}

describe("readWindowLayout", () => {
  it("returns an empty list for missing or non-array input", () => {
    expect(readWindowLayout(null, LAYER)).toEqual([]);
    expect(readWindowLayout(undefined, LAYER)).toEqual([]);
    expect(readWindowLayout({}, LAYER)).toEqual([]);
    expect(readWindowLayout("nope", LAYER)).toEqual([]);
    expect(readWindowLayout([], LAYER)).toEqual([]);
  });

  it("reads a well-formed layout back", () => {
    expect(readWindowLayout([win()], LAYER)).toEqual([win()]);
  });

  it("drops entries that are missing required fields", () => {
    const raw = [
      win({ threadId: "keep" }),
      { threadId: "no-coords" },
      { x: 1, y: 2, width: 460, height: 560, visible: true },
      win({ threadId: "", }),
      null,
      "junk",
      win({ threadId: "keep2" }),
    ];
    const result = readWindowLayout(raw, LAYER);
    expect(result.map((w) => w.threadId)).toEqual(["keep", "keep2"]);
  });

  it("rejects NaN and Infinity coordinates rather than restoring off-screen", () => {
    // This is the case that would silently produce an undraggable window.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const raw = [win({ x: bad })];
      expect(readWindowLayout(raw, LAYER)).toEqual([]);
    }
    expect(readWindowLayout([win({ width: Number.NaN })], LAYER)).toEqual([]);
  });

  it("rejects non-numeric coordinates", () => {
    const raw = [{ ...win(), x: "40", y: null }];
    expect(readWindowLayout(raw, LAYER)).toEqual([]);
  });

  it("keeps only the first entry for a duplicated thread", () => {
    const raw = [win({ threadId: "dup", x: 10 }), win({ threadId: "dup", x: 99 })];
    const result = readWindowLayout(raw, LAYER);
    expect(result).toHaveLength(1);
    expect(result[0]!.x).toBe(10);
  });

  it("clamps a layout saved on a bigger display back on-screen", () => {
    // Saved when the layer was 2560x1440, restored in a 1200x800 layer.
    const raw = [win({ x: 2000, y: 1200, width: 460, height: 560 })];
    const [only] = readWindowLayout(raw, LAYER);
    expect(only!.x).toBe(1200 - 460);
    expect(only!.y).toBe(800 - 560);
  });

  it("clamps negative coordinates to the origin", () => {
    const [only] = readWindowLayout([win({ x: -500, y: -500 })], LAYER);
    expect(only!.x).toBe(0);
    expect(only!.y).toBe(0);
  });

  it("enforces a usable minimum size", () => {
    const [only] = readWindowLayout([win({ width: 10, height: 10 })], LAYER);
    expect(only!.width).toBe(280);
    expect(only!.height).toBe(260);
  });

  it("still returns a reachable window when the layer is smaller than it", () => {
    // A narrow panel must not push windows out of reach.
    const tiny = { width: 200, height: 150 };
    const [only] = readWindowLayout([win({ x: 100, y: 100 })], tiny);
    expect(only!.x).toBe(0);
    expect(only!.y).toBe(0);
  });

  it("treats a missing `visible` as visible and an explicit false as hidden", () => {
    const withoutVisible = { ...win({ threadId: "a" }) } as Record<string, unknown>;
    delete withoutVisible.visible;
    const result = readWindowLayout(
      [withoutVisible, win({ threadId: "b", visible: false })],
      LAYER,
    );
    expect(result[0]!.visible).toBe(true);
    expect(result[1]!.visible).toBe(false);
  });

  it("refuses an absurdly large layout instead of walking it", () => {
    const raw = Array.from({ length: 200 }, (_, i) => win({ threadId: `t${i}` }));
    expect(readWindowLayout(raw, LAYER)).toEqual([]);
  });
});

describe("serializeWindowLayout", () => {
  it("drops z, which is a within-session counter", () => {
    const live = [
      { ...win(), z: 99 } as unknown as StoredWindow,
    ];
    const stored = serializeWindowLayout(live);
    expect(stored).toHaveLength(1);
    expect("z" in stored[0]!).toBe(false);
  });

  it("rounds sub-pixel positions so drag noise does not create writes", () => {
    const stored = serializeWindowLayout([
      win({ x: 40.4, y: 60.6, width: 460.2, height: 559.8 }),
    ]);
    expect(stored[0]).toEqual(win({ x: 40, y: 61, width: 460, height: 560 }));
  });

  it("produces a value that survives the JSON boundary", () => {
    const stored = serializeWindowLayout([win()]);
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored);
  });
});

describe("retainKnownThreads", () => {
  it("drops windows whose thread is gone", () => {
    const windows = [win({ threadId: "alive" }), win({ threadId: "gone" })];
    const result = retainKnownThreads(windows, new Set(["alive"]));
    expect(result.map((w) => w.threadId)).toEqual(["alive"]);
  });

  it("keeps everything when every thread is known", () => {
    const windows = [win({ threadId: "a" }), win({ threadId: "b" })];
    expect(retainKnownThreads(windows, new Set(["a", "b"]))).toHaveLength(2);
  });

  it("an empty known-set keeps nothing, which is why callers must wait for threads", () => {
    // Documents the hazard the restore effect guards against: calling this with
    // threads still loading would discard the entire layout.
    expect(retainKnownThreads([win()], new Set())).toEqual([]);
  });
});

describe("layoutsEqual", () => {
  it("treats identical layouts as equal", () => {
    expect(layoutsEqual([win()], [win()])).toBe(true);
  });

  it("ignores sub-pixel differences that serialize to the same value", () => {
    expect(layoutsEqual([win({ x: 40.1 })], [win({ x: 40.4 })])).toBe(true);
  });

  it("detects a moved window", () => {
    expect(layoutsEqual([win()], [win({ x: 41 })])).toBe(false);
  });

  it("detects a resized window", () => {
    expect(layoutsEqual([win()], [win({ width: 461 })])).toBe(false);
  });

  it("detects a visibility change", () => {
    expect(layoutsEqual([win()], [win({ visible: false })])).toBe(false);
  });

  it("detects added and removed windows", () => {
    expect(layoutsEqual([win()], [])).toBe(false);
    expect(layoutsEqual([], [win()])).toBe(false);
    expect(layoutsEqual([win({ threadId: "a" })], [win({ threadId: "b" })])).toBe(false);
  });

  it("treats an identical layout as equal and a reorder as a change", () => {
    const a = win({ threadId: "a" });
    const b = win({ threadId: "b", x: 100 });
    expect(layoutsEqual([a, b], [a, b])).toBe(true);
    // Order carries stacking meaning, so a swap is a change.
    expect(layoutsEqual([a, b], [b, a])).toBe(false);
  });
});

describe("layout round trip", () => {
  it("survives serialize -> JSON -> read unchanged", () => {
    const original = [
      win({ threadId: "one", x: 24, y: 24 }),
      win({ threadId: "two", x: 200, y: 150, width: 500, height: 600, visible: false }),
    ];
    const stored = serializeWindowLayout(original);
    const reloaded = readWindowLayout(JSON.parse(JSON.stringify(stored)), LAYER);
    // `layoutsEqual` is the comparison the save path uses; it must agree here.
    expect(layoutsEqual(reloaded, stored)).toBe(true);
  });

  it("clamps on reload when the display shrank, and that is detected as a change", () => {
    const stored = serializeWindowLayout([win({ x: 2000, y: 1200 })]);
    const reloaded = readWindowLayout(stored, LAYER);
    expect(layoutsEqual(reloaded, stored)).toBe(false);
  });
});