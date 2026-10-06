import { describe, expect, it } from "vitest";
import {
  liveElements,
  mergeElements,
  placementHint,
  sceneBounds,
  type Scene,
  type SceneElement,
} from "../canvas/scene";

/** A deterministic id source so collisions are assertable. */
function idFactory(ids: string[]) {
  let i = 0;
  return () => ids[i++] ?? `fallback-${i}`;
}

const rect = (id: string, x: number, y: number, w = 100, h = 50): SceneElement => ({
  id,
  type: "rectangle",
  x,
  y,
  width: w,
  height: h,
  isDeleted: false,
});

const scene = (elements: SceneElement[]): Scene => ({
  elements,
  appState: {},
  files: {},
});

describe("mergeElements", () => {
  it("appends without removing anything already drawn", () => {
    const existing = [rect("a", 0, 0), rect("b", 200, 0)];
    const incoming = [rect("c", 400, 0)];
    const { elements } = mergeElements(existing, incoming);

    expect(elements.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(elements).toHaveLength(3);
  });

  it("never drops a stored element even when the batch is empty", () => {
    const existing = [rect("a", 0, 0)];
    const { elements } = mergeElements(existing, []);
    expect(elements).toHaveLength(1);
    expect(elements[0].id).toBe("a");
  });

  it("re-issues an id that collides with a stored element", () => {
    const existing = [rect("same", 0, 0)];
    const incoming = [rect("same", 500, 500)];
    const { elements, remapped } = mergeElements(
      existing,
      incoming,
      idFactory(["fresh"]),
    );

    expect(elements.map((e) => e.id)).toEqual(["same", "fresh"]);
    expect(remapped).toEqual({ same: "fresh" });
    // The stored element is untouched; the newcomer moved.
    expect(elements[0].x).toBe(0);
    expect(elements[1].x).toBe(500);
  });

  it("resolves a collision between two elements in the same batch", () => {
    const { elements } = mergeElements([], [rect("dup", 0, 0), rect("dup", 10, 0)], idFactory(["second"]));
    expect(elements.map((e) => e.id)).toEqual(["dup", "second"]);
  });

  it("assigns an id to an element that has none", () => {
    const noId = { type: "ellipse", x: 1, y: 2 } as SceneElement;
    const { elements } = mergeElements([], [noId], idFactory(["generated"]));
    expect(elements[0].id).toBe("generated");
  });

  it("rewrites containerId and boundElements to the re-issued id", () => {
    const existing = [rect("box", 0, 0)];
    const label: SceneElement = {
      ...rect("box", 5, 5, 10, 10),
      type: "text",
      containerId: "box",
    };
    const holder: SceneElement = {
      ...rect("holder", 300, 0),
      boundElements: [{ id: "box", type: "text" }],
    };

    const { elements } = mergeElements(
      [...existing, holder],
      [label],
      idFactory(["newid"]),
    );

    const merged = elements.find((e) => e.id === "newid");
    expect(merged?.containerId).toBe("newid");
    // The pre-existing holder still points at the original, untouched box.
    const storedHolder = elements.find((e) => e.id === "holder");
    expect(storedHolder?.boundElements).toEqual([{ id: "box", type: "text" }]);
  });

  it("drops payloads that are not element objects", () => {
    const { elements } = mergeElements(
      [rect("a", 0, 0)],
      [null as unknown as SceneElement, "junk" as unknown as SceneElement, 42 as unknown as SceneElement],
    );
    expect(elements.map((e) => e.id)).toEqual(["a"]);
  });
});

describe("sceneBounds", () => {
  it("returns null for an empty drawing", () => {
    expect(sceneBounds(scene([]))).toBeNull();
  });

  it("spans every element", () => {
    const bounds = sceneBounds(scene([rect("a", 0, 0, 100, 50), rect("b", 200, 30, 100, 50)]));
    expect(bounds).toEqual({
      minX: 0,
      minY: 0,
      maxX: 300,
      maxY: 80,
      width: 300,
      height: 80,
    });
  });

  it("ignores deleted elements", () => {
    const deleted = { ...rect("gone", 900, 900, 500, 500), isDeleted: true };
    const bounds = sceneBounds(scene([rect("a", 0, 0, 10, 10), deleted]));
    expect(bounds?.maxX).toBe(10);
  });

  it("includes points-based extent for arrows", () => {
    const arrow: SceneElement = {
      id: "ar",
      type: "arrow",
      x: 100,
      y: 100,
      width: 0,
      height: 0,
      points: [
        [0, 0],
        [50, 40],
      ],
    };
    const bounds = sceneBounds(scene([arrow]));
    expect(bounds?.maxX).toBe(150);
    expect(bounds?.maxY).toBe(140);
  });

  it("does not shrink a rotated element", () => {
    const rotated = { ...rect("r", 0, 0, 100, 100), angle: Math.PI / 4 };
    const bounds = sceneBounds(scene([rotated]));
    // A 100x100 square rotated 45deg covers ~141x141.
    expect(bounds!.width).toBeGreaterThan(140);
    expect(bounds!.width).toBeLessThan(142);
  });

  it("skips unusable elements instead of throwing", () => {
    const bad: SceneElement = { id: "bad", type: "rectangle", x: "nope", y: NaN };
    const bounds = sceneBounds(scene([bad, rect("a", 10, 10, 10, 10)]));
    expect(bounds?.minX).toBe(10);
  });
});

describe("placementHint", () => {
  it("uses the origin for an empty scene", () => {
    const hint = placementHint(scene([]));
    expect(hint.sceneWasEmpty).toBe(true);
    expect(hint.x).toBe(0);
    expect(hint.y).toBe(0);
  });

  it("places new content clear to the right of existing work", () => {
    const hint = placementHint(scene([rect("a", 0, 0, 100, 50)]), 80);
    expect(hint.x).toBe(180);
    expect(hint.y).toBe(0);
    expect(hint.sceneWasEmpty).toBe(false);
    expect(hint.existingWidth).toBe(100);
  });
});

describe("liveElements", () => {
  it("filters deleted elements", () => {
    expect(liveElements(scene([rect("a", 0, 0), { ...rect("b", 0, 0), isDeleted: true }]))).toHaveLength(1);
  });
});
