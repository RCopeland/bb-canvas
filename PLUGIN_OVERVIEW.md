# bb-canvas — overview

A **Canvas** page for bb: a freeform [Excalidraw](https://excalidraw.com)
drawing surface with **floating thread windows** on top. Sketch a plan, then
keep several live threads open beside it — each window is the real chat, and it
moves where you put it.

It reaches bb from its own **Canvas** sidebar entry.

## What you get

- **A real drawing tool.** The background is a full Excalidraw canvas: pen,
  shapes, arrows, text, frames, images, libraries, pan and zoom. Not a
  decorative backdrop.
- **Floating thread windows.** Open any thread into a draggable, resizable
  window that floats above the drawing. Windows are independent — open as many
  as you like, move and resize each one, and stack them in the order you last
  touched.
- **The real chat, not a copy.** Each window wraps bb's own `ThreadChat`
  component, so you get the actual timeline — tool calls, diffs, file rows,
  queued messages, drafts — plus the real composer, attachments, @-mentions,
  and the thread's own permission mode.
- **A thread list in the launcher.** The canvas's **Thread windows** panel lists
  your threads in bb's parent/child tree, with per-row expand/collapse and the
  host actions the built-in view has — pin, mark read, archive, open in the
  main app — plus drag-to-split. Threads waiting on you are flagged. The row
  shows a presence dot and the title; the rest of the status detail (indicator,
  unread, pinned, split pane, activity, branch, machine, project, provider, last
  activity) reaches assistive tech through each row's accessible name.
  This panel is canvas-local: it does *not* replace bb's own sidebar list.
- **Start a thread without leaving the canvas.** The **New thread** button in
  the launcher header opens bb's real new-thread composer inline — prompt,
  attachments, @-mentions, provider/model/reasoning, project, environment, and
  permission mode — so a thread can be created beside the drawing instead of on
  bb's separate new-thread screen. Submitting spawns the thread and opens its
  window immediately.
- **The drawing persists.** The scene is saved to the plugin's own storage, so
  a drawing survives reloads and app restarts.

## Two coordinate worlds, on purpose

The drawing and the windows live in different frames:

- **Excalidraw** owns its scene viewport (pan and zoom inside the canvas).
- **The windows** live in the page's screen frame, above the canvas.

Windows deliberately do **not** follow the canvas pan/zoom. They are a working
layer over a drawing surface, not objects pinned into the drawing, so a window
stays where you put it while you scroll the canvas beneath it. That is the
simpler of the two designs and the one that was asked for; making windows into
canvas objects would mean storing their positions in scene coordinates.

## An agent can draw here, without erasing you

The canvas is shared between you and agents. Two properties make that safe:

- **Writes are additive.** `canvas_draw` merges elements into the stored scene
  and never removes what is there. An agent sketching an explanation cannot
  wipe your drawing, because there is no code path that replaces the scene.
- **Writes are revision-guarded.** Every write bumps a `revision`. A writer that
  sends the `baseRevision` it loaded from is rejected if storage has moved on,
  so an open tab holding a stale copy cannot clobber newer work.

```sh
# Read the scene, its revision, and where free space starts
bb plugin rpc call canvas canvas_load --json

# Draw additively. `placement` says where new content will not overlap.
bb plugin rpc call canvas canvas_draw --input-file diagram.json --json
```

`canvas_draw` returns `added`, `total`, `revision`, `remapped` (ids it had to
re-issue on collision) and fresh `bounds`/`placement`. An id that collides with
an existing element is re-issued rather than overwriting it — stored elements
win, because other stored elements may reference them.

The page re-syncs on focus: come back to the canvas tab and an agent's drawing
appears without a manual reload. If a local edit is still pending, the local
edit wins instead of being discarded.

## The composer resolves selections, the plugin creates the thread

The inline composer is the host's `experimental_NewThreadComposer`, the same
component bb's own new-thread screen uses. It owns *user selections*; this
plugin owns *filing and attribution*. On submit it hands back a
JSON-serializable `NewThreadRequest`, which `CanvasPage` forwards verbatim to
`useSdk().threads.spawn`.

Two consequences worth knowing:

- **Creation runs with the signed-in user's authority, not a narrower plugin
  scope**, because `useSdk()` requests carry the user's session on the app
  origin. The plugin does not add a second permission layer and cannot widen a
  thread's permission mode: the composer's picker is the thread's own resolved
  setting, same as anywhere else in bb.
- **A created thread stays attributed to the plugin.** `threads.spawn` stamps
  `origin: "plugin"` and `originPluginId` unless the caller names another
  origin, so a thread started here is not silently re-attributed.

Handing off to `actions.openNewThread` was rejected: it navigates to bb's
new-thread screen, which takes the drawing out of view — the opposite of what
this page is for. Rendering a plain textarea plus a "Start thread" button was
rejected too: it cannot express environment or permission choices and bypasses
the host submit pipeline.

On a failed create the composer keeps its draft (that is host behaviour:
the draft clears only when `onSubmit` resolves), and the panel reports the
error rather than clearing what was typed.

## Closing a window hides it, it does not kill the thread

Hiding a window keeps its position and size, and the thread keeps running in
bb. The launcher reopens it where you left it.

## Why the window is the host's chat

Each window renders `ThreadChat` with `variant="compact"`,
`layout="contained"` and `permissionPolicy="inherit"`.

Hand-rolling a transcript from the timeline RPC was rejected: it drops
everything that is not plain conversation text (tool calls, diffs, file rows,
queued messages, drafts, attachments, @-mentions) and bypasses the host submit
pipeline, so sends lose the thread's resolved execution settings.
`permissionPolicy="inherit"` is not incidental either: it pins every send to
the thread's own resolved default and renders the picker as a dimmed label, so
a plugin surface can never widen a thread's permission mode.

## The list is canvas-local; bb's sidebar list is untouched

Earlier versions of this plugin registered its thread list through
`experimental_threadList`, which made it bb's real sidebar thread list while the
plugin was enabled. **That registration has been removed.** The plugin now
registers only its `navPanel`; bb's own sidebar list is what you see in the
sidebar, always, with no setting to undo.

Why it was removed: the slot is exclusive and activates automatically, so
enabling a drawing plugin silently replaced the sidebar thread list *everywhere*
in bb. That is a surprising amount of blast radius for a plugin whose headline
feature is a canvas, and it meant this plugin owned the presentation of every
thread in the sidebar.

The original motivation for registering was sound and is worth recording, but it
does not change the conclusion:

- **bb exposes no way to embed its own list.** The bundled list's component is a
  local closure inside the bundled `thread-list` plugin with no export, and the
  host's renderer mounts whichever plugin registered into the slot. So a
  canvas-side list can only ever be a *reimplementation* of host UI — which,
  over time, drifts from the host.
- **The slot is a replacement, not a wrapper.** Using it to get "a copy of the
  default list on the canvas" is not possible: you get a takeover of the
  sidebar instead of a copy on the canvas.

So the canvas keeps its own list, scoped to the **Thread windows** panel, and
bb's sidebar stays bb's. `canvas/SidebarThreadList.tsx`,
`canvas/ThreadListActionsMenu.tsx`, and `canvas/threadGrouping.ts` are retained
in the tree but are currently unreferenced. Re-registering is a two-line change
in `app.tsx` if the sidebar takeover is ever wanted again; until then these
files exist only as the path back to it.

### What the canvas panel covers, and what it does not

Implemented in the canvas's **Thread windows** panel: bb's parent/child tree
with per-row expand/collapse, per-row pin / mark read / archive / open, and
drag-to-split.

These belonged to the sidebar takeover and went with it, so they are *not* on
the canvas today: Pinned / custom-section / project / machine grouping, the
Active/Archived filter, the Organize / Sort by / New section actions menu, and
Custom (flat) mode. Any of them can be ported into `ThreadLauncher.tsx` on
request — the grouping logic in `threadGrouping.ts` is still present and tested.

## Known constraints

The now-unreferenced sidebar modules carry functionality worth porting to the
canvas if it is ever missed. The actions menu wrote the host's own `sidebar.*`
preferences through `uiPreferences`, so those settings stay consistent with the
CLI and with other windows; a failed write was reported rather than silently
reverted. **New project** was deliberately absent from it: the SDK exposes only
`projects.create(args)`, which needs a full project payload and belongs in a
dialog, not a menu.

Also not available on the canvas, for the same reason:

- **Drag-to-reorder** and manual ordering.
- **Environment grouping** (`sidebar.threadGrouping.environment`).
- **Progressive disclosure** for long group lists.
- **Collapse state** for group headings (rows expand/collapse and that persists
  for the session; group and section headings do not yet remember being
  collapsed).
- **Per-row PR badges** and the richer row detail bb's own rows can paint.
- **New project** from the actions menu (see above).
- **Sorting by "none"**: the host's fourth sort value exists in the schema but
  is not offered, because it means "leave the natural order alone" and reads as
  a duplicate of the default.

## Known constraints

These are real, and worth knowing before you rely on the plugin:

- **The frontend bundle is large (~8MB raw, ~2.4MB gzipped).** Excalidraw is a
  full drawing application. For comparison, bb's largest built-in plugin bundle
  (tasks) is ~0.9MB. There is no code-splitting escape hatch: `bb plugin build`
  emits a single `app.js` and inlines dynamic `import()` rather than emitting a
  chunk. Of the bundle, ~1.8MB is Excalidraw's text-measurement **WASM embedded
  as base64** (22% of the file), and the rest is its JS.
- **Excalidraw's stylesheet is vendored by hand.** Its package `exports` map
  gates the CSS behind `development`/`production` conditions the plugin build's
  bundler does not enable, and blocks every subpath, so it cannot be imported as
  a specifier. `canvas/vendor/excalidraw.css` is a copy with `@font-face` blocks
  stripped (the bundler has no `.woff2` loader). Refresh it after upgrading the
  dependency with `node scripts/vendor-excalidraw.mjs` (also `npm run
  vendor-excalidraw`).
- **Fonts load from Excalidraw's CDN.** Excalidraw resolves its hand-drawn fonts
  at runtime and falls back to `esm.sh`. In an offline environment, text falls
  back to a system font. Self-hosting is possible by serving the subsetted font
  files from a plugin HTTP route and setting `window.EXCALIDRAW_ASSET_PATH`, but
  that is not implemented here.
- **Windows are not persisted.** Their positions live in memory. The threads
  themselves are unaffected; only the window layout resets on reload.
- **The scene is stored as opaque JSON**, bounded at 8MB. Excalidraw owns the
  element schema and evolves it, so re-declaring it server-side would mean
  silently rejecting scenes a newer Excalidraw produced.

## For developers

- `app.tsx` registers the `navPanel` (sidebar entry + page route). It does
  **not** register `experimental_threadList`; doing so is what made this
  plugin's list take over bb's sidebar, and it was removed.
- `canvas/CanvasPage.tsx` — the page: Excalidraw surface, floating layer, and
  debounced scene persistence.
- `canvas/ThreadLauncher.tsx` — the canvas's floating **Thread windows** panel,
  which renders `ThreadRow` and opens windows instead of navigating. This is the
  plugin's only thread list now.
- `canvas/ThreadRow.tsx` — the one row, rendering the per-row host hooks
  (drag-to-split, PR lookup) and the row actions.
- `canvas/threadTree.ts` — pure parent/child grouping, kept dependency-free so
  its rules are unit-testable.
- `canvas/SidebarThreadList.tsx` — the former sidebar list. **Unreferenced**;
  retained as the path back to the sidebar takeover, and the only consumer of
  `ThreadListActionsMenu.tsx` and `threadGrouping.ts`.
- `canvas/threadGrouping.ts` — pure pinned/section/project/machine bucketing,
  kept dependency-free so its rules are unit-testable. **Unreferenced** (still
  tested).
- `canvas/ThreadWindow.tsx` — window chrome around the host's `ThreadChat`.
- `canvas/useWindowDrag.ts` — pointer drag and corner resize.
- `canvas/json.ts` — converts Excalidraw's live element objects to strict JSON
  before they cross the RPC boundary (see below).
- `canvas/types.ts` — thread presence/status mapping.
- `canvas/vendor/` — the vendored Excalidraw stylesheet.
- `server.ts` — scene persistence over RPC, with a size guard.
- `test/json.test.ts` — the sanitizer's edge cases (cycles, BigInt, NaN, holes).

```sh
npm run vendor-excalidraw   # refresh the vendored stylesheet
npm run typecheck
npm test                    # sanitizer edge cases
npm run build
bb plugin dev .             # watch, rebuild, reload on change
```

### The scene must be sanitized before it is saved

Excalidraw elements are **not** JSON documents as they exist in memory. The RPC
boundary requires every payload to be a real JSON value, and rejects the rest
with `rpc input at $input.scene.elements[0].customData is not a JSON value`.
The usual offender is `customData`, typed `Record<string, any>`, which carries
`undefined` for keys Excalidraw has not set.

`JSON.parse(JSON.stringify(x))` is not a safe shortcut: it throws on BigInt and
on cyclic references, which would break the save outright. `canvas/json.ts`
walks the value instead, dropping `undefined`/functions/symbols, mapping
`NaN`/`Infinity` to `null`, stringifying BigInt, breaking cycles, and preserving
array indices. `test/json.test.ts` covers each of those.
