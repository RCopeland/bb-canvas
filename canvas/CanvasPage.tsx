// The Canvas page: a freeform Excalidraw drawing surface with floating thread
// windows on top.
//
// Two coordinate worlds live here on purpose:
//
//   * Excalidraw owns its own scene/viewport (pan and zoom inside the canvas).
//   * The floating windows live in the page's screen frame, above the canvas.
//
// The windows deliberately do NOT follow the canvas pan/zoom. They are a
// working layer over a drawing surface, not objects pinned into the drawing,
// so a window stays where you put it while you scroll the canvas beneath it.
//
// Persistence: the scene is saved to the plugin's own storage through RPC, so
// a drawing survives reloads and app restarts. Windows are kept in memory —
// they represent live threads, which the host already owns.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
// Vendored copy of Excalidraw's stylesheet. Its package `exports` map gates
// the CSS on "development"/"production" conditions that the plugin build's
// bundler does not enable, and no subpath can be imported at all — so the file
// is copied in here, the same "vendor source you own" approach the plugin
// guide uses for components. Refresh it with:
//   cp node_modules/@excalidraw/excalidraw/dist/prod/index.css canvas/vendor/excalidraw.css
import "./vendor/excalidraw.css";
import {
  // Aliased on import: JSX reads a lowercase-initial name as an intrinsic
  // element, so `<experimental_NewThreadComposer />` does not compile.
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_useSidebarThreads,
  useRpc,
  useSdk,
  type NewThreadRequest,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import type { rpcContract, CanvasScene } from "../server";
import { needsAttention } from "./types";
import { FLOAT_LAYER_Z, LAUNCHER_Z } from "./layering";
import { ThreadLauncher } from "./ThreadLauncher";
import {
  DEFAULT_H,
  DEFAULT_W,
  ThreadWindow,
  type FloatWindowState,
} from "./ThreadWindow";
import { useLauncherDrag } from "./useWindowDrag";
import type { LayerBoundsRef } from "./useWindowDrag";
import { toJsonValue } from "./json";
import { loadGridModeEnabled, persistedAppState } from "./gridPreference";
import {
  layoutsEqual,
  readWindowLayout,
  retainKnownThreads,
  serializeWindowLayout,
  type StoredWindow,
} from "./windowLayout";

/** How often the debounced scene save fires after the last edit. */
const SAVE_DEBOUNCE_MS = 900;

/**
 * How long a window drag/resize is allowed to settle before the layout is
 * written. Shorter than the scene save: a layout write is tiny, and losing a
 * position is more annoying than losing it is expensive.
 */
const WINDOW_SAVE_DEBOUNCE_MS = 400;

/**
 * Threads the launcher lists: every thread bb would show, ordered for reading.
 * Attention first, then busy, then the rest by recency. Purely a reading order
 * — the launcher renders bb's own parent/child tree on top of it.
 */
function useLauncherThreads() {
  const { threads, projects } = experimental_useSidebarThreads();
  return useMemo(
    () => ({
      threads: [...threads]
        .filter((thread) => !thread.isHidden && !thread.isArchived)
        // The host already resolved busy state; sorting on `updatedAt` alone
        // would bury a running thread under a newer idle one.
        .sort((a, b) => {
          const attention = Number(needsAttention(b)) - Number(needsAttention(a));
          if (attention !== 0) return attention;
          return b.updatedAt - a.updatedAt;
        }),
      projects,
    }),
    [threads, projects],
  );
}

export function CanvasPage() {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const { threads } = experimental_useSidebarThreads();
  const { threads: launcherThreads, projects: launcherProjects } =
    useLauncherThreads();

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | null>(
    null,
  );
  const [sceneLoaded, setSceneLoaded] = useState(false);
  const [windows, setWindows] = useState<FloatWindowState[]>([]);
  // Monotonic z-index source. Kept in a ref, not state: bumping it while
  // updating `windows` must not be a second render trigger, and reading it
  // from state inside the updater would be a stale closure when two windows
  // are opened in the same tick.
  const zCounter = useRef(1);
  const [launcherOpen, setLauncherOpen] = useState(true);
  // Which parents in the launcher's tree are expanded. Kept here rather than
  // inside the launcher so the tree survives the launcher being collapsed and
  // reopened, and so the launcher itself stays a pure render of props.
  const [expandedThreads, setExpandedThreads] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Whether the inline compose panel is showing. Starting a thread on the
  // canvas rather than navigating to bb's new-thread screen keeps the drawing
  // in view — which is the whole point of this page.
  const [composing, setComposing] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  // Bumped on each open so the composer remounts with a fresh focus request;
  // without it the caret would not land in the editor on the second open.
  //
  // The remount does NOT discard the draft: `draftKey` persists it, so
  // reopening (or reloading the page) brings back what the user had typed.
  // That is the behaviour we want — cancelling a compose should not throw away
  // a half-written prompt.
  const [composerKey, setComposerKey] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);

  const layerRef = useRef<HTMLDivElement | null>(null);
  const bounds: LayerBoundsRef = useRef({ width: 0, height: 0 });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Skip the change events Excalidraw emits while it applies our own initial
  // scene, so loading a drawing does not immediately "save" it back.
  const hydrating = useRef(true);
  // The revision this page last saw from storage. Sent with every save so the
  // server can reject a write built on a stale scene — an agent drawing onto
  // the canvas, or another tab, would otherwise be silently overwritten by this
  // page's in-memory copy. See server.ts (StaleRevisionError).
  const revisionRef = useRef(0);
  // Serialises the save/flush path so two writes cannot race the same revision.
  const savingRef = useRef(false);

  // --- Window layout persistence -------------------------------------------
  // The layout that was last written to (or read from) storage. Compared
  // against the live layout so a re-render, a focus change, or the restore
  // itself does not trigger a redundant write.
  const savedLayoutRef = useRef<StoredWindow[] | null>(null);
  // Restore happens once, as soon as both the stored layout and a measured
  // layer are available. A ref (not state) because it is a one-shot latch, and
  // making it state would re-run the restore effect on every render.
  const restoredLayout = useRef(false);
  const windowSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Floating layer bounds -------------------------------------------------
  useEffect(() => {
    const element = layerRef.current;
    if (!element) return;
    const measure = () => {
      bounds.current = {
        width: element.clientWidth,
        height: element.clientHeight,
      };
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // --- Load the saved scene --------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    rpc.call("canvas_load", null).then(
      (result) => {
        if (cancelled) return;
        revisionRef.current = result.revision;
        // Open with the stored grid choice, falling back to the default only
        // when the scene has none. See gridPreference.ts.
        const scene = (result.scene ?? {
          elements: [],
          appState: {},
        }) as unknown as ExcalidrawInitialDataState;
        const stored = (scene.appState ?? {}) as Record<string, unknown>;
        setInitialData({
          ...scene,
          appState: { ...stored, gridModeEnabled: loadGridModeEnabled(stored) },
        });
        setSceneLoaded(true);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setSaveError(cause instanceof Error ? cause.message : String(cause));
        setSceneLoaded(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  // Let the hydration flag clear one tick after the first scene is applied.
  useEffect(() => {
    if (!sceneLoaded) return;
    const timer = setTimeout(() => {
      hydrating.current = false;
    }, 0);
    return () => clearTimeout(timer);
  }, [sceneLoaded]);

  /**
   * Pull the stored scene in and apply it to the live editor.
   *
   * Used when this page learns storage moved past its copy. Adopting the
   * stored scene (rather than retrying our own write) is what makes an agent's
   * drawing survive instead of being overwritten by this tab.
   *
   * `needsReview` reports the case where local unsaved work had to give way.
   * Silent replacement would be a data-loss bug the user cannot even see, so
   * the caller surfaces it.
   */
  const resync = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    const result = await rpc.call("canvas_load", null);
    if (!api || !result.scene) {
      // Nothing to apply to, but storage did move. Record it so this page does
      // not keep re-fetching on every focus.
      revisionRef.current = result.revision;
      return;
    }
    const stored = (result.scene.appState ?? {}) as Record<string, unknown>;
    // Suppress the change event Excalidraw emits for this programmatic update,
    // otherwise applying the scene schedules a save of what we just loaded.
    hydrating.current = true;
    try {
      api.updateScene({
        elements: result.scene.elements as never,
        appState: { gridModeEnabled: loadGridModeEnabled(stored) },
      });
      // Adopt the revision only after the scene is actually applied. Setting it
      // first would let a save fired mid-apply write a scene this page never
      // showed, stamped with a revision that made it look current.
      revisionRef.current = result.revision;
    } finally {
      // Cleared on a macrotask so any change event Excalidraw emits for this
      // update — sync or batched — is still suppressed when it lands.
      setTimeout(() => {
        hydrating.current = false;
      }, 0);
    }
    setSaveError(null);
  }, [rpc]);

  // The save paths are callbacks whose identity would otherwise change with
  // `resync`; going through a ref keeps `saveNow` stable so the unmount flush
  // effect below can stay mounted-once.
  const resyncRef = useRef(resync);
  useEffect(() => {
    resyncRef.current = resync;
  }, [resync]);

  // --- Persist the scene, debounced -----------------------------------------
  //
  // Writes the current scene to storage. Called on the debounce timer and,
  // crucially, as a flush when the page unmounts — see below.
  const saveNow = useCallback(() => {
    const api = apiRef.current;
    if (!api || savingRef.current) return;
    // Excalidraw's element objects carry values JSON cannot express — most
    // visibly `undefined` inside `customData` — and the RPC boundary rejects
    // a payload that is not a real JSON value. `toJsonValue` rebuilds the
    // scene as strict JSON; without it, drawing anything fails to save with
    // "...customData is not a JSON value".
    //
    // `gridModeEnabled` is picked off appState here because Excalidraw omits it
    // from its own scene serialization; without this the user's grid choice
    // would be forgotten on reload and fall back to the default.
    const scene = toJsonValue({
      elements: api.getSceneElements(),
      appState: persistedAppState(api.getAppState() as unknown as Record<string, unknown>),
      files: api.getFiles(),
    }) as CanvasScene;
    savingRef.current = true;
    rpc
      .call("canvas_save", { scene, baseRevision: revisionRef.current })
      .then(
        (result) => {
          revisionRef.current = result.revision;
          setSaveError(null);
        },
        (cause: unknown) => {
          // A stale-revision rejection is the expected outcome when an agent
          // drew onto this canvas while the page was open. Storage is fine — it
          // simply moved past what this page loaded — so re-sync rather than
          // reporting an error the user cannot act on. The rejection means this
          // page's own edit was not written, so say so rather than pretending
          // nothing happened.
          const message = cause instanceof Error ? cause.message : String(cause);
          if (message.includes("changed elsewhere")) {
            void resyncRef.current().then(() => {
              setSaveError(
                "This canvas changed elsewhere, so your last edit was not saved. The canvas now shows the newer version.",
              );
            });
            return;
          }
          setSaveError(message);
        },
      )
      .finally(() => {
        savingRef.current = false;
      });
  }, [rpc]);

  const scheduleSave = useCallback(() => {
    if (hydrating.current) return;
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      saveNow();
    }, SAVE_DEBOUNCE_MS);
  }, [saveNow]);

  // Leaving the canvas must not drop an in-flight edit. The debounce exists to
  // coalesce rapid changes, not to lose the last one, and navigating away is
  // exactly when a just-made change (toggling the grid, a final stroke) is most
  // likely to still be pending. Flush instead of clearing.
  //
  // The flush goes through a ref so this effect can stay mounted-once: keying it
  // on `saveNow` would also run the cleanup on every change of its identity,
  // firing writes to storage as a side effect of unrelated re-renders.
  const saveNowRef = useRef(saveNow);
  useEffect(() => {
    saveNowRef.current = saveNow;
  }, [saveNow]);

  // The window layout needs the same treatment for the same reason: dropping
  // the debounce timer on unmount would lose a drag made just before leaving.
  // Kept separate from the scene flush because the two write to different keys
  // and a failure in one must not skip the other.
  const flushWindowsRef = useRef<() => void>(() => {});

  useEffect(
    () => () => {
      if (saveTimer.current !== null) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        saveNowRef.current();
      }
      if (windowSaveTimer.current !== null) {
        clearTimeout(windowSaveTimer.current);
        windowSaveTimer.current = null;
        flushWindowsRef.current();
      }
    },
    [],
  );

  // --- Re-sync when this page comes back into focus ---------------------------
  //
  // An open canvas holds its scene in memory and never re-reads storage, so an
  // agent drawing onto the canvas — or a drawing made in another tab — stays
  // invisible until a manual reload. Coming back to the tab is the natural
  // moment to check, and it is cheap: `canvas_load` returns a revision, so we
  // only touch the editor when storage actually moved.
  //
  // A pending local edit wins: if a save is still queued there is unsaved work
  // in the editor, and replacing the scene underneath it would lose that edit.
  useEffect(() => {
    const sync = () => {
      if (document.visibilityState === "hidden") return;
      if (saveTimer.current !== null || savingRef.current) return;
      rpc.call("canvas_load", null).then(
        async (result) => {
          if (result.revision === revisionRef.current) return;
          await resync();
        },
        () => {
          // A failed check is not worth surfacing; the next focus retries.
        },
      );
    };
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [rpc, resync]);

  // --- Restore the stored window layout --------------------------------------
  //
  // Restoring needs three things at once: the stored layout, a measured layer
  // to clamp into, and the thread list. The thread list matters because a
  // window for a thread that no longer exists is dropped, and doing that while
  // threads are still loading would throw away the whole layout on a cold start.
  //
  // So this waits rather than guessing, and applies exactly once. Threads that
  // disappear later are handled by `retainKnownThreads` on the way out instead.
  useEffect(() => {
    if (restoredLayout.current) return;
    if (bounds.current.width === 0 || bounds.current.height === 0) return;
    if (threads.length === 0) return;

    let cancelled = false;
    rpc.call("windows_load", null).then(
      (result) => {
        if (cancelled || restoredLayout.current) return;
        restoredLayout.current = true;

        const known = new Set(threads.map((thread) => thread.id));
        const restored = retainKnownThreads(
          readWindowLayout(result.windows, bounds.current),
          known,
        );
        // Nothing stored (a first run) or nothing survived validation: leave
        // the canvas with no windows, which is the same state a fresh page has.
        if (restored.length === 0) {
          savedLayoutRef.current = [];
          return;
        }

        // Assign z in restore order so the last window in the stored layout
        // ends up on top. Raw z values are not persisted — they are a
        // within-session counter and would not mean anything here.
        setWindows(
          restored.map((entry, index) => ({
            ...entry,
            z: index + 1,
          })),
        );
        zCounter.current = restored.length;
        savedLayoutRef.current = serializeWindowLayout(restored);
      },
      () => {
        // A failed read is not worth blocking the canvas over; the layout is a
        // convenience. Latch so we do not retry on every render, and let the
        // next save overwrite whatever is there.
        if (cancelled || restoredLayout.current) return;
        restoredLayout.current = true;
        savedLayoutRef.current = [];
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, threads]);

  // --- Save the window layout, debounced -------------------------------------
  //
  // Depends on the live `windows` array, so it re-runs after every drag,
  // resize, open, or hide. The comparison against the last saved layout is what
  // keeps that from writing on every pointer move: a drag that ends where it
  // started, or a focus change that only touches `z`, compares equal and skips
  // the write entirely.
  useEffect(() => {
    // Until the initial restore has run, `windows` is not the user's layout —
    // writing now would persist an empty list over a real one.
    if (!restoredLayout.current) return;

    const current = serializeWindowLayout(
      retainKnownThreads(
        windows,
        new Set(threads.map((thread) => thread.id)),
      ),
    );
    if (layoutsEqual(current, savedLayoutRef.current ?? [])) return;

    const write = () => {
      // Clear the flush hook first: this is now the newest layout, so an unmount
      // must not write it a second time.
      flushWindowsRef.current = () => {};
      savedLayoutRef.current = current;
      rpc.call("windows_save", { windows: current }).then(
        () => setSaveError(null),
        (cause: unknown) =>
          setSaveError(cause instanceof Error ? cause.message : String(cause)),
      );
    };
    // Leave the flush hook armed until the debounce actually fires, so a drag
    // made in the last moments before leaving is still written.
    flushWindowsRef.current = write;

    if (windowSaveTimer.current !== null) clearTimeout(windowSaveTimer.current);
    windowSaveTimer.current = setTimeout(() => {
      windowSaveTimer.current = null;
      write();
    }, WINDOW_SAVE_DEBOUNCE_MS);

    return () => {
      if (windowSaveTimer.current !== null) {
        clearTimeout(windowSaveTimer.current);
        windowSaveTimer.current = null;
      }
    };
  }, [windows, threads, rpc]);

  // --- Window management -----------------------------------------------------
  const openWindow = useCallback((threadId: string) => {
    setWindows((current) => {
      const z = ++zCounter.current;
      const existing = current.find((entry) => entry.threadId === threadId);
      if (existing) {
        return current.map((entry) =>
          entry.threadId === threadId ? { ...entry, visible: true, z } : entry,
        );
      }
      // Cascade new windows so they do not land exactly on top of each other.
      const offset = (current.length % 6) * 28;
      return [
        ...current,
        {
          threadId,
          x: 24 + offset,
          y: 24 + offset,
          z,
          width: DEFAULT_W,
          height: DEFAULT_H,
          visible: true,
        },
      ];
    });
  }, []);

  const focusWindow = useCallback((threadId: string) => {
    setWindows((current) => {
      const top = current.reduce((max, entry) => Math.max(max, entry.z), 0);
      const target = current.find((entry) => entry.threadId === threadId);
      // Already on top: leave the array alone so this is not a no-op render.
      if (!target || target.z === top) return current;
      const z = ++zCounter.current;
      return current.map((entry) =>
        entry.threadId === threadId ? { ...entry, z } : entry,
      );
    });
  }, []);

  const moveWindow = useCallback((threadId: string, x: number, y: number) => {
    setWindows((current) =>
      current.map((entry) => (entry.threadId === threadId ? { ...entry, x, y } : entry)),
    );
  }, []);

  const resizeWindow = useCallback(
    (
      threadId: string,
      box: { x: number; y: number; width: number; height: number },
    ) => {
      setWindows((current) =>
        current.map((entry) =>
          entry.threadId === threadId ? { ...entry, ...box } : entry,
        ),
      );
    },
    [],
  );

  const hideWindow = useCallback((threadId: string) => {
    setWindows((current) =>
      current.map((entry) =>
        entry.threadId === threadId ? { ...entry, visible: false } : entry,
      ),
    );
  }, []);

  // Toggle a parent's children in the launcher tree. A copy-on-write Set so
  // React sees a new identity; mutating in place would not re-render.
  const toggleExpandedThread = useCallback((threadId: string) => {
    setExpandedThreads((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  }, []);

  // Launcher drag position. Kept in component state only — not persisted —
  // so the existing `windows` key stays untouched and we avoid inventing a
  // second storage schema for a single point.
  const [launcherPos, setLauncherPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const moveLauncher = useCallback((x: number, y: number) => {
    setLauncherPos({ x, y });
  }, []);
  const launcherDrag = useLauncherDrag(bounds, moveLauncher);

  // Thread ids whose floating window is currently visible, as a Set for the
  // launcher's per-row `open` check. Derived here (not in the launcher) because
  // `windows` lives on this page and hiding a window must not remount the tree.
  const openThreadIds = useMemo(
    () =>
      new Set(
        windows
          .filter((entry) => entry.visible)
          .map((entry) => entry.threadId),
      ),
    [windows],
  );

  // Open (or close) the inline compose panel. The thread is created here on the
  // canvas rather than on bb's new-thread screen, so the drawing stays in view.
  const startNewThread = useCallback(() => {
    // Toggle: the same button closes the panel, labelled "Cancel".
    if (composing) {
      setComposing(false);
      setComposeError(null);
      return;
    }
    setComposeError(null);
    setComposerKey((key) => key + 1);
    setComposing(true);
  }, [composing]);

  // Creating the thread is this plugin's job, not the composer's: the composer
  // resolves the user's selections and hands back a JSON-serializable
  // `NewThreadRequest`, which `threads.spawn` accepts verbatim. Going through
  // `useSdk().threads.spawn` (rather than `actions.openNewThread`) is what lets
  // the thread start here instead of on bb's new-thread screen, and the SDK
  // stamps `origin: "plugin"` so the thread stays attributed to this plugin.
  //
  // The composer keeps its draft when `onSubmit` throws, so reporting the
  // failure here never costs the user what they typed.
  const submitNewThread = useCallback(
    async (request: NewThreadRequest) => {
      try {
        const thread = await sdk.threads.spawn(request);
        // Open the new thread as a window straight away: the user asked for it
        // by name, and a spawned thread with no visible surface looks like
        // nothing happened.
        openWindow(thread.id);
        setComposing(false);
        setComposeError(null);
        // Remount so the next open starts focused. The draft itself is cleared
        // by the composer when this submit resolves.
        setComposerKey((key) => key + 1);
      } catch (cause) {
        setComposeError(cause instanceof Error ? cause.message : String(cause));
        // Rethrow so the composer keeps the draft instead of clearing it.
        throw cause;
      }
    },
    [sdk, openWindow],
  );

  // Render windows bottom-first so the DOM order matches the z-index order,
  // which keeps tab order and assistive-tech reading order sane.
  const orderedWindows = useMemo(
    () => [...windows].sort((a, b) => a.z - b.z),
    [windows],
  );

  const titleFor = useCallback(
    (threadId: string) => threads.find((thread) => thread.id === threadId) ?? null,
    [threads],
  );

  return (
    <div className="relative flex h-full min-h-0 w-full overflow-hidden">
      {/* The drawing surface. Excalidraw fills this layer; its own UI chrome
          (toolbar, zoom, menus) is left in place deliberately — this is a real
          drawing tool, not a decorative backdrop. */}
      <div className="absolute inset-0" data-canvas-surface>
        {sceneLoaded ? (
          <Excalidraw
            initialData={initialData ?? undefined}
            excalidrawAPI={(api) => {
              apiRef.current = api;
            }}
            onChange={scheduleSave}
            // `theme` is intentionally omitted so Excalidraw follows the host
            // theme via CSS variables rather than being pinned to one scheme.
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Loading drawing…
          </div>
        )}
      </div>

      {/* The floating layer. `pointer-events-none` lets strokes through in the
          gaps; each window re-enables pointer events for itself.

          The z-index is not decoration: it lifts the windows above
          Excalidraw's own on-canvas chrome (toolbar, menus, zoom), which would
          otherwise paint over a window and swallow clicks aimed at it. See
          `./layering` for the full contract. */}
      <div
        ref={layerRef}
        data-float-layer
        style={{ zIndex: FLOAT_LAYER_Z }}
        className="pointer-events-none absolute inset-0"
      >
        {orderedWindows.map((state) => {
          const thread = titleFor(state.threadId);
          if (!thread) return null;
          return (
            <ThreadWindow
              key={state.threadId}
              state={state}
              thread={thread}
              bounds={bounds}
              onFocus={() => focusWindow(state.threadId)}
              onMove={(x, y) => moveWindow(state.threadId, x, y)}
              onResize={(box) => resizeWindow(state.threadId, box)}
              onHide={() => hideWindow(state.threadId)}
            />
          );
        })}
      </div>

      {/* Inline compose surface. Deliberately not bb's new-thread screen: this
          page exists so a sketch and its threads share one view, and
          navigating away to create a thread would break that.

          Wider than the launcher on purpose — the composer's control row
          (project, environment, permissions) does not fit in a ~420px column,
          so the panel is sized for the row rather than the launcher's list.

          No `overflow-hidden` on this panel: the composer's
          provider/model/environment pickers open popovers that must escape it,
          so the rounded corners are clipped per-child instead. */}
      {composing ? (
        <div
          className="pointer-events-auto absolute right-[17.5rem] top-3 flex max-h-[calc(100%-1.5rem)] w-[min(46rem,calc(100%-19.5rem))] flex-col rounded-lg border border-border bg-card/95 shadow-xl backdrop-blur"
          style={{ zIndex: LAUNCHER_Z }}
          role="dialog"
          aria-label="Start a new thread"
        >
          <div className="flex shrink-0 items-center gap-2 rounded-t-lg border-b border-border px-3 py-2">
            <Icon name="MessageSquarePlus" className="size-3.5" />
            <span className="flex-1 text-xs font-semibold">New thread</span>
            <button
              type="button"
              className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Close the new thread composer"
              onClick={() => setComposing(false)}
            >
              <Icon name="X" className="size-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            <NewThreadComposer
              key={composerKey}
              layout="contained"
              draftKey="canvas-new-thread"
              placeholder="What should this thread work on?"
              focusRequest={composerKey}
              onSubmit={submitNewThread}
            />
          </div>
          {composeError !== null ? (
            <p
              role="alert"
              className="shrink-0 rounded-b-lg border-t border-border px-3 py-2 text-[11px] text-destructive"
            >
              Could not start the thread: {composeError}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Launcher: open a thread's floating window, tree-shaped, with the same
          row actions the built-in thread view has. Collapsible so it does not
          permanently cover the canvas. */}
      <div
        className={`pointer-events-auto absolute w-[22.5rem] ${launcherPos === null ? "right-3 top-[7rem]" : ""}`}
        data-launcher
        style={{
          zIndex: LAUNCHER_Z,
          ...(launcherPos !== null
            ? { left: launcherPos.x, top: launcherPos.y }
            : {}),
        }}
      >
        <ThreadLauncher
          threads={launcherThreads}
          projects={launcherProjects}
          openThreadIds={openThreadIds}
          expanded={expandedThreads}
          onToggleExpanded={toggleExpandedThread}
          open={launcherOpen}
          onToggleOpen={() => setLauncherOpen((open) => !open)}
          composing={composing}
          onToggleCompose={startNewThread}
          onOpenWindow={openWindow}
          dragHandleProps={launcherDrag}
        />
        {saveError !== null ? (
          <p role="alert" className="mt-2 text-[11px] text-destructive">
            Could not save the drawing: {saveError}
          </p>
        ) : null}
      </div>
    </div>
  );
}
