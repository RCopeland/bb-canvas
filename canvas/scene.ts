// Scene merging for the canvas plugin.
//
// Why this module exists: the canvas is shared between the user's own drawing
// and whatever an agent draws onto it. The original save path replaced the
// whole scene, so any agent write erased everything already there. The fix is
// to make writes *additive* — new elements are merged into the stored scene,
// and nothing already present is removed.
//
// This is deliberately server-side logic rather than page logic. The page is
// one writer among several (the user's browser, an agent through `canvas_draw`),
// and only the server sees the true current state, so the merge has to happen
// where the state lives.
//
// Kept free of Excalidraw imports: this runs in the plugin's server process,
// which has no DOM and no Excalidraw runtime. Elements are treated as opaque
// JSON objects with a handful of fields we actually rely on.

/** An element as far as this module cares: opaque JSON plus the fields we read. */
export type SceneElement = Record<string, unknown>;

export interface Scene {
  elements: SceneElement[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

/** Axis-aligned bounds in scene coordinates. */
export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export const EMPTY_SCENE: Scene = { elements: [], appState: {}, files: {} };

/** Read a finite number, or `undefined` for anything else (missing, NaN, strings). */
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The element's id, when it has a usable one. */
function idOf(element: SceneElement): string | undefined {
  const id = element?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Live (non-deleted) elements only: a deleted element is not part of the drawing. */
export function liveElements(scene: Scene): SceneElement[] {
  return scene.elements.filter((element) => element?.isDeleted !== true);
}

/**
 * Bounding box over every live element, or `null` for an empty drawing.
 *
 * Rotation is handled conservatively: a rotated element contributes the bounds
 * of its rotated corners rather than its axis-aligned `width`/`height`, so a
 * rotated shape cannot report a box smaller than what it actually covers.
 * `elbow`/`arrow`/`line` elements may carry `points`, which mark the real
 * extent; when present they are included too. Anything unparseable is skipped
 * rather than throwing — a bad element must not make the whole canvas
 * unreadable.
 */
export function sceneBounds(scene: Scene): BoundingBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;

  const include = (x: number, y: number) => {
    found = true;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const element of liveElements(scene)) {
    const x = num(element.x);
    const y = num(element.y);
    const w = num(element.width);
    const h = num(element.height);
    if (x === undefined || y === undefined) continue;

    const angle = num(element.angle) ?? 0;
    if (angle !== 0 && w !== undefined && h !== undefined) {
      // Rotate the four corners about the element's top-left origin. Excalidraw
      // rotates around the element centre, so work from the centre to match.
      const cx = x + w / 2;
      const cy = y + h / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      for (const [dx, dy] of [
        [-w / 2, -h / 2],
        [w / 2, -h / 2],
        [w / 2, h / 2],
        [-w / 2, h / 2],
      ]) {
        include(cx + dx * cos - dy * sin, cy + dx * sin + dy * cos);
      }
    } else if (w !== undefined && h !== undefined) {
      include(x, y);
      include(x + w, y + h);
    } else {
      include(x, y);
    }

    // Points-based elements (line, arrow, freedraw) describe their extent as
    // offsets from x/y; without this an arrow reports a box of its own origin.
    const points = element.points;
    if (Array.isArray(points)) {
      for (const point of points) {
        if (!Array.isArray(point)) continue;
        const px = num(point[0]);
        const py = num(point[1]);
        if (px === undefined || py === undefined) continue;
        include(x + px, y + py);
      }
    }
  }

  if (!found) return null;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/** A place new content can go without covering what is already drawn. */
export interface PlacementHint {
  /** Left edge for new content: clear of everything already in the scene. */
  x: number;
  /** Top edge, aligned with the top of the existing drawing. */
  y: number;
  /** Width of the existing drawing, for callers laying out beside it. */
  existingWidth: number;
  /** Height of the existing drawing, for callers matching its scale. */
  existingHeight: number;
  /** True when the scene was empty and `x`/`y` are just the origin. */
  sceneWasEmpty: boolean;
}

/**
 * Where a caller should put new elements so they do not land on existing work.
 *
 * Additive drawing creates a new failure mode that replacing never had: every
 * diagram stacks up. Telling the caller the free space to the right means an
 * agent can lay diagrams out in a row instead of painting over the user's work.
 */
export function placementHint(scene: Scene, gap = 80): PlacementHint {
  const bounds = sceneBounds(scene);
  if (!bounds) {
    return { x: 0, y: 0, existingWidth: 0, existingHeight: 0, sceneWasEmpty: true };
  }
  return {
    x: bounds.maxX + gap,
    y: bounds.minY,
    existingWidth: bounds.width,
    existingHeight: bounds.height,
    sceneWasEmpty: false,
  };
}

/**
 * Merge `incoming` into `existing` without removing anything.
 *
 * Id collisions are resolved in favour of the element already in storage: the
 * incoming element is re-issued a fresh id. Stored elements win because they
 * may be referenced by other stored elements (`containerId`, `boundElements`,
 * arrows bound to shapes), and rewriting those references is a far larger
 * problem than re-issuing an id on the newcomer.
 *
 * Returns the merged array plus the ids that were rewritten, so a caller can
 * report what happened.
 */
export function mergeElements(
  existing: readonly SceneElement[],
  incoming: readonly SceneElement[],
  makeId: () => string = defaultMakeId,
): { elements: SceneElement[]; remapped: Record<string, string> } {
  const taken = new Set<string>();
  for (const element of existing) {
    const id = idOf(element);
    if (id !== undefined) taken.add(id);
  }

  const remapped: Record<string, string> = {};
  const added: SceneElement[] = [];

  for (const element of incoming) {
    if (element === null || typeof element !== "object" || Array.isArray(element)) {
      // Not an element shape at all. Carrying it through would put junk in the
      // scene that Excalidraw then has to cope with; drop it.
      continue;
    }
    const id = idOf(element);
    if (id === undefined) {
      const fresh = makeId();
      added.push({ ...element, id: fresh });
      taken.add(fresh);
      continue;
    }
    if (!taken.has(id)) {
      taken.add(id);
      added.push(element);
      continue;
    }
    const fresh = makeId();
    remapped[id] = fresh;
    taken.add(fresh);
    added.push({ ...element, id: fresh });
  }

  // Rewrite intra-batch references so a re-issued id does not leave an arrow
  // pointing at the element it was attached to under its old id.
  if (Object.keys(remapped).length > 0) {
    for (let i = 0; i < added.length; i += 1) {
      const element = added[i];
      let next = element;
      const containerId = element.containerId;
      if (typeof containerId === "string" && remapped[containerId]) {
        next = { ...next, containerId: remapped[containerId] };
      }
      if (Array.isArray(element.boundElements)) {
        next = {
          ...next,
          boundElements: element.boundElements.map((bound) => {
            if (bound === null || typeof bound !== "object") return bound;
            const boundId = (bound as Record<string, unknown>).id;
            if (typeof boundId === "string" && remapped[boundId]) {
              return { ...(bound as Record<string, unknown>), id: remapped[boundId] };
            }
            return bound;
          }),
        };
      }
      if (next !== element) added[i] = next;
    }
  }

  return { elements: [...existing, ...added], remapped };
}

/** Excalidraw-shaped random id. Matches the shape the app itself generates. */
export function defaultMakeId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  let out = "";
  for (let i = 0; i < 20; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
