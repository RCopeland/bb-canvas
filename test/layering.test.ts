import { describe, expect, it } from "vitest";
import {
  EXCALIDRAW_MODAL_Z,
  EXCALIDRAW_UI_CHROME_MAX_Z,
  EXCALIDRAW_UI_LAYER_Z,
  FLOAT_LAYER_Z,
  LAUNCHER_Z,
  layeringIsSound,
} from "../canvas/layering";

// Regression guard for the reported bug: a floating thread window that lands
// over Excalidraw's tool panel made the panel unclickable. The cause was the
// float layer having no z-index, so it tied with / lost to Excalidraw's
// z-index-4 UI chrome. These assertions pin the ordering that fixes it.
describe("canvas layering", () => {
  it("keeps the float layer above Excalidraw's in-page chrome", () => {
    expect(FLOAT_LAYER_Z).toBeGreaterThan(EXCALIDRAW_UI_LAYER_Z);
    expect(FLOAT_LAYER_Z).toBeGreaterThan(EXCALIDRAW_UI_CHROME_MAX_Z);
  });

  it("keeps Excalidraw's modal above the floating windows", () => {
    expect(FLOAT_LAYER_Z).toBeLessThan(EXCALIDRAW_MODAL_Z);
  });

  it("keeps the launcher above the windows it launches", () => {
    expect(LAUNCHER_Z).toBeGreaterThan(FLOAT_LAYER_Z);
  });

  it("reports the ordering as sound", () => {
    expect(layeringIsSound()).toBe(true);
  });
});
