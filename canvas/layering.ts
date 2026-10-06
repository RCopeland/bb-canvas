// Stacking order for the canvas page.
//
// The page has three stacked surfaces: Excalidraw's drawing surface at the
// bottom, the floating thread-window layer above it, and the launcher panel
// above that. Excalidraw renders its own on-canvas chrome (toolbar, menus,
// zoom controls) INSIDE the drawing surface, at z-index 4 in
// `.layer-ui__wrapper` and 100 in `.layer-ui__wrapper__footer-right`.
//
// That is the trap this module exists to avoid. Window z values are a private
// ordering counter that starts at 1 (`zCounter` in CanvasPage), so if the
// float layer itself had no z-index, the first few windows would tie with or
// lose to Excalidraw's z-index-4 toolbar: the panel would paint over the
// window and swallow clicks aimed at the window beneath it. Depending on how
// many windows were open, the same click would land on the window or the
// panel — which is exactly the "sometimes I can't click the tool panel"
// report this fixes.
//
// So the float layer owns an explicit z-index that clears Excalidraw's in-page
// chrome but stays below its true overlays (modal 1000, toast 999999), so an
// Excalidraw dialog still opens above the windows. Window z values are then
// local to the float layer's stacking context and can grow without ever
// escaping it.
//
// Kept out of the component so the ordering rule is testable without a DOM.

/** Excalidraw `.layer-ui__wrapper` (toolbar, menus, zoom). Mirrors its CSS. */
export const EXCALIDRAW_UI_LAYER_Z = 4;

/** Excalidraw `.layer-ui__wrapper__footer-right` — the highest in-page chrome. */
export const EXCALIDRAW_UI_CHROME_MAX_Z = 100;

/** Excalidraw `.Modal` — real overlays must stay above the windows. */
export const EXCALIDRAW_MODAL_Z = 1000;

/** The floating window layer: above all Excalidraw in-canvas chrome. */
export const FLOAT_LAYER_Z = 200;

/** The launcher panel: above the windows it launches. */
export const LAUNCHER_Z = 300;

/**
 * The stacking contract, as a predicate.
 *
 * True when the float layer clears Excalidraw's in-page chrome yet still sits
 * below Excalidraw's modal overlay, and the launcher sits above the windows.
 * A change to any of the constants above is expected to keep this true; the
 * test suite asserts it.
 */
export function layeringIsSound(): boolean {
  return (
    FLOAT_LAYER_Z > EXCALIDRAW_UI_CHROME_MAX_Z &&
    FLOAT_LAYER_Z < EXCALIDRAW_MODAL_Z &&
    LAUNCHER_Z > FLOAT_LAYER_Z
  );
}
