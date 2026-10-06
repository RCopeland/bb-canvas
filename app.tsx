// bb-canvas — frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never
// bundled), so this file must be loaded by BB, not imported directly.
//
// One surface: a `navPanel` (its own sidebar entry and host-wrapped route)
// rendering the Canvas page — a freeform Excalidraw drawing surface with
// floating thread windows on top. Registering it as a navPanel, rather than an
// app-wide overlay, keeps the canvas chrome confined to its own page and out of
// every other route.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { CanvasPage } from "./canvas/CanvasPage";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "canvas",
    title: "Canvas",
    icon: "PenTool",
    // Routed at /plugins/canvas/canvas; the component receives the route
    // remainder as `subPath` (always "" here).
    path: "canvas",
    component: CanvasPage,
  });
});
