import { describe, expect, it } from "vitest";
import {
  DEFAULT_GRID_MODE_ENABLED,
  loadGridModeEnabled,
  persistedAppState,
} from "../canvas/gridPreference";
import { toJsonValue } from "../canvas/json";

describe("loadGridModeEnabled", () => {
  it("defaults the grid on when nothing was stored", () => {
    expect(loadGridModeEnabled({})).toBe(true);
    expect(DEFAULT_GRID_MODE_ENABLED).toBe(true);
  });

  it("defaults the grid on for a scene saved without the key", () => {
    // Every scene this plugin saved before the setting existed looks like this.
    expect(loadGridModeEnabled({ viewBackgroundColor: "#ffffff" })).toBe(true);
  });

  it("keeps a stored false, so turning the grid off survives a reload", () => {
    expect(loadGridModeEnabled({ gridModeEnabled: false })).toBe(false);
  });

  it("keeps a stored true", () => {
    expect(loadGridModeEnabled({ gridModeEnabled: true })).toBe(true);
  });

  it("falls back to the default for a non-boolean value", () => {
    // Scenes are stored as opaque JSON, so a value can arrive with any type.
    for (const bad of ["false", 0, 1, null, {}, []]) {
      expect(loadGridModeEnabled({ gridModeEnabled: bad })).toBe(true);
    }
  });
});

describe("persistedAppState", () => {
  it("keeps the grid choice and the background color", () => {
    expect(
      persistedAppState({
        viewBackgroundColor: "#ffffff",
        gridModeEnabled: false,
      }),
    ).toEqual({ viewBackgroundColor: "#ffffff", gridModeEnabled: false });
  });

  it("drops per-session UI state that must not be persisted", () => {
    const picked = persistedAppState({
      viewBackgroundColor: "#ffffff",
      gridModeEnabled: true,
      scrollX: 123,
      scrollY: -40,
      zoom: { value: 2 },
      selectedElementIds: { rect1: true },
      openDialog: { name: "help" },
      activeTool: { type: "selection" },
    });
    expect(Object.keys(picked).sort()).toEqual([
      "gridModeEnabled",
      "viewBackgroundColor",
    ]);
  });

  it("omits an absent key rather than writing undefined", () => {
    // The RPC boundary rejects a payload that is not a real JSON value, so an
    // `undefined` here would fail the save outright.
    const picked = persistedAppState({ viewBackgroundColor: "#ffffff" });
    expect(picked).toEqual({ viewBackgroundColor: "#ffffff" });
    expect("gridModeEnabled" in picked).toBe(false);
  });
});

describe("grid preference round trip", () => {
  it("survives the sanitizer the save path runs, for both states", () => {
    for (const enabled of [true, false]) {
      const scene = toJsonValue({
        elements: [],
        appState: persistedAppState({
          viewBackgroundColor: "#ffffff",
          gridModeEnabled: enabled,
          scrollX: 10,
        }),
        files: {},
      }) as {
        appState: Record<string, unknown>;
      };
      // Real JSON, which is what the server stores and reads back.
      const stored = JSON.parse(JSON.stringify(scene)) as typeof scene;
      expect(loadGridModeEnabled(stored.appState)).toBe(enabled);
    }
  });
});