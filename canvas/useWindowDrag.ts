// Pointer drag + corner resize for a floating window that sits in the page's
// own coordinate frame (above the Excalidraw canvas).
//
// The one subtlety worth naming: `PointerEvent.clientX/Y` are viewport
// coordinates, but a window's `left`/`top` are resolved against its offset
// parent. If the two frames differ (they do — the plugin panel is offset by
// the app chrome), naive maths makes the window trail the cursor. So both
// hooks cache the offset parent's rect at gesture start and do all arithmetic
// in that frame.
//
// A third hook (`useLauncherDrag`) lives here because it follows the same
// arithmetic and guarding rules; it differs only in how it discovers the
// draggable element and its offset parent, since the launcher is not nested
// inside `[data-float-layer]`.
import { useCallback } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/** Live size of the floating layer, held in a ref so a drag in progress always
 * reads the latest layout without re-binding listeners. */
export interface LayerBoundsRef {
  current: { width: number; height: number };
}

export interface WindowBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_W = 280;
export const MIN_H = 260;

/** Clamp v into [lo, hi], tolerating hi < lo by preferring the lower bound. */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

export interface ComputeDragPositionInput {
  clientX: number;
  clientY: number;
  parentRect: { left: number; top: number };
  grabX: number;
  grabY: number;
  elementWidth: number;
  elementHeight: number;
  bounds: { width: number; height: number };
}

/**
 * Compute the constrained {x, y} position for a dragged element.
 *
 * This pure helper mirrors the arithmetic both `useWindowDrag` and
 * `useLauncherDrag` need: subtract the grab offset from the pointer position,
 * translate into the offset-parent frame, and clamp so the element stays
 * inside the given bounds.
 *
 * The clamp tolerates a layer smaller than the element by preferring the
 * lower bound (origin), which keeps the element reachable.
 */
export function computeDragPosition({
  clientX,
  clientY,
  parentRect,
  grabX,
  grabY,
  elementWidth,
  elementHeight,
  bounds,
}: ComputeDragPositionInput): { x: number; y: number } {
  const maxX = Math.max(0, bounds.width - elementWidth);
  const maxY = Math.max(0, bounds.height - elementHeight);
  const x = clamp(clientX - parentRect.left - grabX, 0, maxX);
  const y = clamp(clientY - parentRect.top - grabY, 0, maxY);
  return { x, y };
}

/**
 * Drag a floating window by its title bar. Returns a spreadable handler —
 * apply it to the title-bar element. The window is clamped inside the layer so
 * it can never be dragged out of reach.
 */
export function useWindowDrag(
  bounds: LayerBoundsRef,
  onMove: (x: number, y: number) => void,
) {
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      // Let the title-bar buttons handle their own clicks.
      if ((event.target as HTMLElement).closest("button,[data-no-drag]")) return;
      event.preventDefault();

      const handle = event.currentTarget as HTMLElement;
      const win = handle.closest<HTMLElement>("[data-float-window]");
      const layer = handle.closest<HTMLElement>("[data-float-layer]");
      if (!win || !layer) return;

      const layerRect = layer.getBoundingClientRect();
      const winRect = win.getBoundingClientRect();
      // Grab offset *within* the window, in px — frame-independent.
      const grabX = event.clientX - winRect.left;
      const grabY = event.clientY - winRect.top;

      const move = (ev: PointerEvent) => {
        const { x, y } = computeDragPosition({
          clientX: ev.clientX,
          clientY: ev.clientY,
          parentRect: { left: layerRect.left, top: layerRect.top },
          grabX,
          grabY,
          elementWidth: win.offsetWidth,
          elementHeight: win.offsetHeight,
          bounds: bounds.current,
        });
        onMove(x, y);
      };
      const end = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
      };
      window.addEventListener("pointermove", move);
      // End on release AND on cancel, so listeners never leak.
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
    [bounds, onMove],
  );

  return { onPointerDown };
}

export type ResizeCorner = "se" | "sw";

/**
 * Resize a floating window from a bottom corner. West-corner drags keep the
 * opposite edge pinned so the gesture feels natural. Apply the returned
 * handler to a corner handle.
 */
export function useWindowResize(
  bounds: LayerBoundsRef,
  corner: ResizeCorner,
  onResize: (box: WindowBox) => void,
  onFocus?: () => void,
) {
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      onFocus?.();

      const handle = event.currentTarget as HTMLElement;
      const win = handle.closest<HTMLElement>("[data-float-window]");
      const layer = handle.closest<HTMLElement>("[data-float-layer]");
      if (!win || !layer) return;

      const layerRect = layer.getBoundingClientRect();
      const winRect = win.getBoundingClientRect();
      const start: WindowBox = {
        x: winRect.left - layerRect.left,
        y: winRect.top - layerRect.top,
        width: winRect.width,
        height: winRect.height,
      };
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      const west = corner === "sw";

      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - startClientX;
        const dy = ev.clientY - startClientY;
        const maxW = Math.max(MIN_W, bounds.current.width - start.x);
        const maxH = Math.max(MIN_H, bounds.current.height - start.y);

        let width = clamp(start.width + dx, MIN_W, maxW);
        let x = start.x;
        if (west) {
          // Keep the east edge fixed: grow leftwards, but never past 0.
          const right = start.x + start.width;
          width = clamp(start.width - dx, MIN_W, right);
          x = right - width;
        }
        const height = clamp(start.height + dy, MIN_H, maxH);
        onResize({ x, y: start.y, width, height });
      };
      const end = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
    [bounds, corner, onFocus, onResize],
  );

  return { onPointerDown };
}

/**
 * Drag the launcher panel by its header. Mirrors `useWindowDrag` exactly,
 * but the launcher is a sibling of the float layer (both are absolute inside
 * the same relative page container), so it uses `offsetParent` instead of
 * `closest('[data-float-layer]')` for the coordinate frame. The same clamp
 * against `bounds` keeps the panel reachable no matter where the gesture
 * starts. The existing `windows` layout path is intentionally left untouched.
 *
 * SHARED-FRAME INVARIANT: `bounds` is measured from `[data-float-layer]`
 * via `clientWidth/Height`, while the drag frame here is
 * `offsetParent.getBoundingClientRect()`. These match only when the shared
 * relative container has no border or padding. Adding either would make
 * `bounds` (content-box) smaller than the frame (border-box) and silently
 * introduce cursor drift or overshoot.
 */
export function useLauncherDrag(
  bounds: LayerBoundsRef,
  onMove: (x: number, y: number) => void,
) {
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      // Let the header buttons handle their own clicks.
      if ((event.target as HTMLElement).closest("button,[data-no-drag]"))
        return;
      event.preventDefault();

      const handle = event.currentTarget as HTMLDivElement;
      const launcher = handle.closest<HTMLElement>("[data-launcher]");
      const parent = launcher?.offsetParent as HTMLElement | null;
      if (!launcher || !parent) return;

      const parentRect = parent.getBoundingClientRect();
      const launcherRect = launcher.getBoundingClientRect();
      const grabX = event.clientX - launcherRect.left;
      const grabY = event.clientY - launcherRect.top;

      const move = (ev: PointerEvent) => {
        const { x, y } = computeDragPosition({
          clientX: ev.clientX,
          clientY: ev.clientY,
          parentRect: { left: parentRect.left, top: parentRect.top },
          grabX,
          grabY,
          elementWidth: launcher.offsetWidth,
          elementHeight: launcher.offsetHeight,
          bounds: bounds.current,
        });
        onMove(x, y);
      };
      const end = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
    [bounds, onMove],
  );

  return { onPointerDown };
}
