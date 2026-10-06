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
import { SidebarThreadList } from "./canvas/SidebarThreadList";

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

  // Register as the sidebar's thread list.
  //
  // WARNING — this slot is EXCLUSIVE and activates automatically. bb resolves
  // `__automatic__` to "the first registered list whose plugin id is not the
  // bundled `thread-list/thread-list`", so enabling this plugin replaces bb's
  // own sidebar thread list everywhere, not just on the canvas page. The user
  // can pin bb's list back under Settings → Appearance → Sidebar.
  //
  // The same component is rendered on the canvas page, so there is exactly one
  // list implementation behind both surfaces rather than a copy that drifts.
  app.slots.experimental_threadList({
    id: "sidebar-thread-list",
    title: "Canvas thread list",
    description:
      "Threads grouped by project, with sections, pinning, nesting and an archived filter. The same list the Canvas page draws.",
    component: SidebarThreadList,
  });
});
