# bb-canvas

A freeform [Excalidraw](https://excalidraw.com) drawing surface with floating
thread windows on top, for [bb](https://getbb.app). Reach it from the **Canvas**
entry in the sidebar.

Sketch a plan, then keep several live threads open beside it — each window is
bb's real chat, and it moves where you put it.

```sh
# from a local clone
git clone --depth 1 https://github.com/RCopeland/bb-canvas.git
bb plugin install ./bb-canvas
bb plugin reload canvas
```

Requires bb `>=0.44` and plugin SDK `>=0.5.29`.

The package is named `bb-plugin-canvas`, which is what sets the install and
reload id (`bb` strips the `bb-plugin-` prefix, so the id is `canvas`). That
prefix is mandatory — `bb`'s own scaffolder forces a name of the form
`bb-plugin-<id>` — so the package name cannot be shortened to `bb-canvas`. The
GitHub repo and the product name are `bb-canvas`; only the package name keeps
the prefix.

This plugin does **not** replace bb's sidebar thread list. It registers only
its own Canvas entry; the sidebar stays bb's own. The canvas's **Thread
windows** panel draws its own list, scoped to that panel.

> Earlier versions registered into the exclusive `experimental_threadList`
> slot, which silently replaced the sidebar list everywhere in bb. That is
> removed. If you are on such a version, pin bb's list back with
> `bb settings ui set sidebar.threadListProvider thread-list/thread-list`, or
> update — the current version needs no setting.

See [PLUGIN_OVERVIEW.md](./PLUGIN_OVERVIEW.md) for what the plugin does, the
coordinate-frame design, and the known constraints (notably the large frontend
bundle, a consequence of Excalidraw being a full drawing application).

## License

[MIT](./LICENSE)

## Development

```sh
npm install
npm run vendor-excalidraw   # refresh canvas/vendor/excalidraw.css after upgrading excalidraw
npm run typecheck
npm test                    # sanitizer, scene merge, grid, window layout, launcher grouping
npm run build               # bb plugin build — the plugin-contract gate
bb plugin dev .             # watch, rebuild, and reload on change
```

### Storage

Two independent keys in the plugin's key/value store, deliberately separate:

| Key | Contents |
| --- | --- |
| `scene` | `{ scene, revision }` — the drawing. Revision-guarded, and the target of the agent's `canvas_draw` |
| `windows` | The floating-window layout. Plain array, **no revision** |

Keeping the layout out of the scene is load-bearing. The scene revision is how a
stale write is detected, so a dragged window must not bump it — otherwise moving
a window would look like a conflicting edit to an agent drawing at the same time.

### Layout

| Path | Purpose |
| --- | --- |
| `app.tsx` | `navPanel` registration: the sidebar entry and page route |
| `canvas/CanvasPage.tsx` | Excalidraw surface, floating layer, scene persistence |
| `canvas/SidebarThreadList.tsx` | Sidebar-style thread list: filter, grouping, sections, expand/collapse. **Currently unreferenced** after the sidebar takeover was removed |
| `canvas/ThreadRow.tsx` | The one thread row, used by the canvas **Thread windows** panel |
| `canvas/ThreadLauncher.tsx` | Canvas **Thread windows** panel: opens floating windows instead of navigating |
| `canvas/ThreadListActionsMenu.tsx` | Organize / Sort by / New section, written through `uiPreferences`. **Currently unreferenced** |
| `canvas/threadGrouping.ts` | Pure pinned / section / project / machine bucketing. **Currently unreferenced** |
| `canvas/threadTree.ts` | Pure parent/child grouping |
| `canvas/ThreadWindow.tsx` | Window chrome wrapping the host's `ThreadChat` |
| `canvas/useWindowDrag.ts` | Pointer drag and corner resize |
| `canvas/windowLayout.ts` | Validates, clamps, and diffs the saved floating-window layout |
| `canvas/gridPreference.ts` | Grid default plus the persisted appState keys |
| `canvas/json.ts` | Sanitizes Excalidraw elements to strict JSON before saving |
| `canvas/types.ts` | Thread presence/status mapping and launcher row helpers |
| `canvas/scene.ts` | Server-side additive element merge and layout hints |
| `canvas/vendor/` | Vendored Excalidraw stylesheet |
| `server.ts` | Scene and window-layout persistence over RPC, with size guards |
| `test/json.test.ts` | Sanitizer edge cases: cycles, BigInt, NaN, array holes |
| `test/windowLayout.test.ts` | Layout validation, clamping, thread retention, change detection |
| `test/scene.test.ts` | Merge and placement behaviour |
| `test/threadLauncher.test.ts` | Tree grouping, relative time, activity summaries |
| `test/threadGrouping.test.ts` | Pinned/section/project/machine bucketing, no duplication or loss |
| `components/`, `lib/`, `hooks/` | Vendored shadcn source (yours to edit) |
