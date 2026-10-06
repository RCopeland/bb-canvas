// The canvas grid setting: default on, but the user's choice wins.
//
// Excalidraw treats grid mode as a UI preference rather than scene data —
// `gridModeEnabled` is deliberately absent from `cleanAppStateForExport` — so a
// scene round-tripped by Excalidraw alone carries no grid state and comes back
// as `false`. That means the plugin has to persist the choice itself if turning
// the grid off is meant to survive a reload.
//
// These two helpers are the whole of that logic, kept out of the component so
// they can be tested directly: `loadGridModeEnabled` decides what the canvas
// opens with, and `persistedAppState` decides what gets written to storage.
//
// Exported for tests: the "default only when never chosen" rule is exactly the
// kind of thing that regresses into a forced setting.

/** Grid is on for a canvas that has no stored preference. */
export const DEFAULT_GRID_MODE_ENABLED = true;

/**
 * The appState keys this page persists, beyond what Excalidraw round-trips.
 *
 * Only these are kept: the rest of appState is per-session UI state (scroll,
 * zoom, selection, open dialogs) that must not be written to storage.
 */
export const PERSISTED_APP_STATE_KEYS = [
  "viewBackgroundColor",
  "gridModeEnabled",
] as const;

/**
 * The grid setting to open a canvas with.
 *
 * A stored boolean is the user's own choice and always wins, including `false`.
 * Anything else — absent, or a non-boolean from an older or newer build — is
 * treated as "never chosen" and falls back to the default. Stored scenes are
 * opaque JSON (see server.ts), so the value cannot be trusted to have the right
 * type.
 */
export function loadGridModeEnabled(storedAppState: Record<string, unknown>): boolean {
  const stored = storedAppState.gridModeEnabled;
  return typeof stored === "boolean" ? stored : DEFAULT_GRID_MODE_ENABLED;
}

/**
 * Pick the persisted appState keys off a live Excalidraw appState.
 *
 * Keys that are absent are omitted rather than written as `undefined`, because
 * the RPC boundary rejects a payload that is not a real JSON value.
 */
export function persistedAppState(
  appState: Record<string, unknown>,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of PERSISTED_APP_STATE_KEYS) {
    if (appState[key] !== undefined) picked[key] = appState[key];
  }
  return picked;
}