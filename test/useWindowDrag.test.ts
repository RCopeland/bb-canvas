import { describe, expect, it } from "vitest";
import { clamp, computeDragPosition } from "../canvas/useWindowDrag";

describe("clamp", () => {
  it("returns the value when it is inside the range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it("clamps to lo when v is below", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });

  it("clamps to hi when v is above", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it("prefers the lower bound when hi < lo (tolerance fallback)", () => {
    // This path defends a caller that passes a negative max because the
    // layer is smaller than the element.
    expect(clamp(5, 0, -10)).toBe(0);
    expect(clamp(-5, 0, -10)).toBe(0);
    expect(clamp(20, 0, -10)).toBe(0);
  });
});

describe("computeDragPosition", () => {
  const BASE = {
    parentRect: { left: 10, top: 20 },
    grabX: 30,
    grabY: 40,
    elementWidth: 200,
    elementHeight: 150,
    bounds: { width: 1000, height: 800 },
  };

  it("computes the position in the parent frame and subtracts the grab offset", () => {
    // clientX = 500, clientY = 300
    // parentLeft = 10, parentTop = 20
    // grabX = 30, grabY = 40
    // x = 500 - 10 - 30 = 460
    // y = 300 - 20 - 40 = 240
    const result = computeDragPosition({
      clientX: 500,
      clientY: 300,
      ...BASE,
    });
    expect(result).toEqual({ x: 460, y: 240 });
  });

  it("clamps maxX at bounds.width - elementWidth", () => {
    // x would be 1000 - 10 - 30 = 960, but maxX = 1000 - 200 = 800
    const result = computeDragPosition({
      clientX: 1000,
      clientY: 300,
      ...BASE,
    });
    expect(result.x).toBe(800);
  });

  it("clamps maxY at bounds.height - elementHeight", () => {
    // y would be 800 - 20 - 40 = 740, but maxY = 800 - 150 = 650
    const result = computeDragPosition({
      clientX: 500,
      clientY: 800,
      ...BASE,
    });
    expect(result.y).toBe(650);
  });

  it("clamps negative values to the origin", () => {
    // x would be 0 - 10 - 30 = -40, clamped to 0
    // y would be 0 - 20 - 40 = -60, clamped to 0
    const result = computeDragPosition({
      clientX: 0,
      clientY: 0,
      ...BASE,
    });
    expect(result).toEqual({ x: 0, y: 0 });
  });

  it("prefers the lower bound when the element is larger than the bounds", () => {
    // maxX = Math.max(0, 100 - 200) = 0
    // maxY = Math.max(0, 100 - 250) = 0
    // So both x and y clamp to 0 regardless of pointer position.
    const result = computeDragPosition({
      clientX: 500,
      clientY: 500,
      parentRect: { left: 0, top: 0 },
      grabX: 0,
      grabY: 0,
      elementWidth: 200,
      elementHeight: 250,
      bounds: { width: 100, height: 100 },
    });
    expect(result).toEqual({ x: 0, y: 0 });
  });

  it("works correctly when the grab offset is zero", () => {
    // Pointer right at top-left of parent rectangle.
    const result = computeDragPosition({
      clientX: 10,
      clientY: 20,
      ...BASE,
      grabX: 0,
      grabY: 0,
    });
    expect(result).toEqual({ x: 0, y: 0 });
  });

  it("handles a zero-sized bounds by clamping to origin", () => {
    const result = computeDragPosition({
      clientX: 500,
      clientY: 500,
      parentRect: { left: 0, top: 0 },
      grabX: 10,
      grabY: 10,
      elementWidth: 100,
      elementHeight: 100,
      bounds: { width: 0, height: 0 },
    });
    expect(result).toEqual({ x: 0, y: 0 });
  });
});
