// Persistence for the floating thread windows.
//
// The windows live in the page's own coordinate frame (they deliberately do not
// follow the canvas pan/zoom — see CanvasPage.tsx), so their layout is page UI
// state rather than drawing content. It is stored under its own `plugin_kv` key
// for that reason: folding it into the scene would make every window drag bump
// the scene revision, which is the value the agent's `canvas_draw` and the
// page's `canvas_save` use to detect real conflicts. A dragged window is not a
// conflicting edit and must not look like one.
//
// Everything here is a pure function over plain data so the rules that are easy
// to get wrong can be tested directly:
//
//   * a stored layout is opaque JSON, so every field is validated rather than
//     trusted — a window restored with `NaN` coordinates would render off-screen
//     and be undraggable;
//   * a layout saved on a large display must still land on-screen when restored
//     on a small one, so positions are clamped into the current layer;
//   * windows for threads that no longer exist are dropped — but only once the
//     thread list is actually known, so a slow sidebar load cannot erase a
//     layout that is merely not visible yet.
//
// Exported for tests: these are exactly the regressions that show up as "my
// windows came back in the wrong place" and are near-impossible to eyeball.

/** The subset of FloatWindowState that is worth persisting. */
export interface StoredWindow {
  threadId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

/** Sizes below this are unusable; they match useWindowDrag's own minimums. */
const MIN_W = 280;
const MIN_H = 260;

/**
 * A stored layout larger than this is treated as corrupt rather than clamped.
 * The real value is a few hundred bytes; the guard exists because the read is
 * an opaque JSON blob and an enormous one should not be walked element by
 * element.
 */
const MAX_WINDOWS = 64;

/** A finite number, or `undefined` for anything else (missing, NaN, string). */
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(v: number, lo: number, hi: number): number {
  // Tolerates hi < lo (a layer narrower than the window) by preferring lo.
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

/**
 * Read a stored layout into clean, usable window states.
 *
 * Anything unusable is dropped rather than repaired into a plausible-looking
 * window: a layout is a convenience, and inventing positions would be worse
 * than falling back to the normal cascade. Returns `[]` for missing or corrupt
 * input, which the caller treats as "no stored layout".
 *
 * `layer` is the current floating layer size. Positions are clamped into it so
 * a layout saved on a larger display does not restore off-screen.
 */
export function readWindowLayout(
  raw: unknown,
  layer: { width: number; height: number },
): StoredWindow[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  if (raw.length > MAX_WINDOWS) return [];

  const seen = new Set<string>();
  const result: StoredWindow[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;

    const threadId = item.threadId;
    if (typeof threadId !== "string" || threadId.length === 0) continue;
    // A duplicate id would produce two windows bound to one thread, where
    // dragging either moves the other. Keep the first.
    if (seen.has(threadId)) continue;

    const x = num(item.x);
    const y = num(item.y);
    const width = num(item.width);
    const height = num(item.height);
    if (x === undefined || y === undefined) continue;
    if (width === undefined || height === undefined) continue;

    const w = Math.max(width, MIN_W);
    const h = Math.max(height, MIN_H);
    // Keep the whole window inside the layer where it fits; `clamp` prefers the
    // origin for a layer smaller than the window, so it stays reachable.
    const cx = clamp(x, 0, layer.width - w);
    const cy = clamp(y, 0, layer.height - h);

    seen.add(threadId);
    result.push({
      threadId,
      x: Math.round(cx),
      y: Math.round(cy),
      width: Math.round(w),
      height: Math.round(h),
      visible: item.visible !== false,
    });
  }
  return result;
}

/**
 * The payload written to storage: only the persisted fields, in a stable order.
 *
 * `z` is deliberately not persisted. It is a within-session stacking counter,
 * and restoring raw values from a previous session would not mean anything;
 * the caller re-stacks restored windows in order instead.
 */
export function serializeWindowLayout(
  windows: readonly StoredWindow[],
): StoredWindow[] {
  return windows.map((w) => ({
    threadId: w.threadId,
    x: Math.round(w.x),
    y: Math.round(w.y),
    width: Math.round(w.width),
    height: Math.round(w.height),
    visible: w.visible,
  }));
}

/**
 * Drop stored windows whose thread no longer exists.
 *
 * `knownThreadIds` must be the real thread list. Callers must not pass an empty
 * set while threads are still loading, or a cold start would silently discard
 * the whole layout — that is why this is a separate step rather than being
 * folded into `readWindowLayout`.
 */
export function retainKnownThreads(
  windows: readonly StoredWindow[],
  knownThreadIds: ReadonlySet<string>,
): StoredWindow[] {
  return windows.filter((w) => knownThreadIds.has(w.threadId));
}

/**
 * Do two layouts describe the same thing?
 *
 * Used to skip a write when nothing moved. Window drags fire continuously, and
 * the debounced save should not touch storage unless the layout actually
 * changed.
 */
export function layoutsEqual(
  a: readonly StoredWindow[],
  b: readonly StoredWindow[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.threadId !== y.threadId ||
      Math.round(x.x) !== Math.round(y.x) ||
      Math.round(x.y) !== Math.round(y.y) ||
      Math.round(x.width) !== Math.round(y.width) ||
      Math.round(x.height) !== Math.round(y.height) ||
      x.visible !== y.visible
    ) {
      return false;
    }
  }
  return true;
}