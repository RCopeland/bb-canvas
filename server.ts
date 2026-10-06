// bb-canvas — backend entry.
//
// Server-side jobs: persist the drawing, and merge agent-drawn content into it
// without destroying what is already there.
//
// Why the merge lives here: the canvas has more than one writer. The user draws
// in the browser, and an agent draws through `canvas_draw`. Only this process
// sees the true stored state, so this is the one place a merge can be done
// correctly. The original design replaced the whole scene on save, which meant
// every agent write erased the user's drawing — and an open page could erase a
// newer scene with its own stale copy. Both are fixed below:
//
//   * Writes are additive. `canvas_draw` merges elements in; `canvas_save`
//     keeps whole-scene replacement for the browser (it *is* the full drawing
//     the user sees) but is revision-guarded so it cannot clobber newer work.
//   * Every successful write bumps a revision. A writer that sends the
//     revision it loaded from has its write rejected if storage has moved on,
//     which turns silent data loss into a detectable conflict.
//
// The scene is stored as an opaque JSON blob deliberately: Excalidraw owns the
// element schema and evolves it, so re-declaring it here would mean owning a
// schema we do not control and silently rejecting scenes a newer Excalidraw
// produced. We bound the size and require the shape the loader needs, and pass
// the rest through untouched.
//
// Note the boundary also requires every payload to be a *real JSON value* — no
// `undefined`, functions, or NaN. Excalidraw elements do not satisfy that as
// they exist in memory, so the client sanitizes the scene before sending it
// (see canvas/json.ts); the schema here is the second line of defence.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  EMPTY_SCENE,
  mergeElements,
  placementHint,
  sceneBounds,
  type Scene,
} from "./canvas/scene";

/** One drawing, as Excalidraw round-trips it. */
const sceneSchema = z.object({
  elements: z.array(z.unknown()),
  appState: z.record(z.string(), z.unknown()),
  files: z.record(z.string(), z.unknown()),
});
export type CanvasScene = z.infer<typeof sceneSchema>;

const boundsSchema = z
  .object({
    minX: z.number(),
    minY: z.number(),
    maxX: z.number(),
    maxY: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .nullable();

const placementSchema = z.object({
  x: z.number(),
  y: z.number(),
  existingWidth: z.number(),
  existingHeight: z.number(),
  sceneWasEmpty: z.boolean(),
});

/**
 * Serialized scenes are capped so one drawing cannot exhaust the store.
 *
 * This must stay under the host's per-value KV ceiling (256KB, see
 * PluginKvStorage) — a scene larger than that cannot be persisted at all, and
 * the cap exists to fail with a clear message instead of an opaque storage
 * error. 200KB leaves headroom for the JSON envelope around the scene.
 */
const MAX_SCENE_BYTES = 200 * 1024;

const SCENE_KEY = "scene";

/** Where the floating-window layout lives. Deliberately not `SCENE_KEY`: see
 * canvas/windowLayout.ts for why window layout is kept out of the scene. */
const WINDOWS_KEY = "windows";

/**
 * One persisted floating window. The fields the page actually restores; `z` is
 * intentionally absent because stacking is re-derived within a session.
 */
const windowSchema = z.object({
  threadId: z.string().min(1),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  visible: z.boolean(),
});

/** A stored layout is a convenience, not content, so it stays small. */
const MAX_WINDOWS_BYTES = 64 * 1024;

/**
 * Stored shape is `{ scene, revision }`. Scenes written by the previous build
 * were a bare `CanvasScene`; `readStored` still accepts that so an existing
 * drawing is not lost on upgrade.
 */
interface StoredScene {
  scene: Scene;
  revision: number;
}

export const rpcContract = defineRpcContract({
  canvas_load: {
    input: z.null(),
    output: z.object({
      scene: sceneSchema.nullable(),
      revision: z.number(),
      bounds: boundsSchema,
      placement: placementSchema,
    }),
  },
  canvas_save: {
    input: z.object({
      scene: sceneSchema,
      /**
       * Revision the caller loaded from. Optional so an older build of the page
       * still works; when supplied, a stale value is rejected instead of
       * overwriting newer storage.
       */
      baseRevision: z.number().optional(),
    }),
    output: z.object({ saved: z.boolean(), revision: z.number() }),
  },
  windows_load: {
    input: z.null(),
    /** `null` means no layout was ever stored (a first run). */
    output: z.object({ windows: z.array(windowSchema).nullable() }),
  },
  windows_save: {
    input: z.object({ windows: z.array(windowSchema) }),
    output: z.object({ saved: z.boolean() }),
  },
  canvas_draw: {
    /**
     * Additive draw: the elements are merged into the stored scene and nothing
     * already present is removed. This is the method an agent uses.
     */
    input: z.object({
      elements: z.array(z.unknown()),
      baseRevision: z.number().optional(),
      /** Optional appState patch, e.g. a background colour for a fresh canvas. */
      appState: z.record(z.string(), z.unknown()).optional(),
    }),
    output: z.object({
      added: z.number(),
      total: z.number(),
      revision: z.number(),
      remapped: z.record(z.string(), z.string()),
      bounds: boundsSchema,
      placement: placementSchema,
    }),
  },
});

/** Raised when a write is based on a revision that storage has moved past. */
export class StaleRevisionError extends Error {
  constructor(
    readonly baseRevision: number,
    readonly currentRevision: number,
  ) {
    super(
      `This canvas changed elsewhere (revision ${currentRevision}, you had ${baseRevision}). ` +
        `Your drawing was not overwritten — reload and try again.`,
    );
    this.name = "StaleRevisionError";
  }
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  /** Read storage, tolerating the pre-revision bare-scene shape. */
  async function readStored(): Promise<StoredScene> {
    const raw = await bb.storage.kv.get<unknown>(SCENE_KEY);
    if (raw === null || raw === undefined) {
      return { scene: { ...EMPTY_SCENE }, revision: 0 };
    }
    // Upgrade path: an old bare scene carries no revision. Treating it as
    // revision 0 means the first guarded write after upgrade can still be
    // rejected by a *later* write, which is the behaviour we want.
    if (typeof raw === "object" && "scene" in (raw as object)) {
      const stored = raw as StoredScene;
      const revision = typeof stored.revision === "number" ? stored.revision : 0;
      return {
        scene: {
          elements: Array.isArray(stored.scene?.elements) ? stored.scene.elements : [],
          appState:
            stored.scene?.appState && typeof stored.scene.appState === "object"
              ? stored.scene.appState
              : {},
          files:
            stored.scene?.files && typeof stored.scene.files === "object"
              ? stored.scene.files
              : {},
        },
        revision,
      };
    }
    return { scene: raw as Scene, revision: 0 };
  }

  async function writeStored(scene: Scene, baseRevision: number | undefined) {
    const bytes = Buffer.byteLength(JSON.stringify({ scene, revision: 0 }), "utf8");
    if (bytes > MAX_SCENE_BYTES) {
      throw new Error(
        `Drawing is too large to save (${Math.round(bytes / 1024 / 1024)}MB, limit ${
          MAX_SCENE_BYTES / 1024 / 1024
        }MB).`,
      );
    }
    const current = await readStored();
    if (baseRevision !== undefined && current.revision > baseRevision) {
      throw new StaleRevisionError(baseRevision, current.revision);
    }
    const revision = current.revision + 1;
    await bb.storage.kv.set(SCENE_KEY, { scene, revision });
    return revision;
  }

  function describe(scene: Scene) {
    return { bounds: sceneBounds(scene), placement: placementHint(scene) };
  }

  /**
   * Read the stored window layout.
   *
   * Tolerant by design: the value is opaque JSON, so anything that is not an
   * array comes back as `null` ("no stored layout") rather than throwing. A
   * corrupt layout should cost the user their window positions, not access to
   * the canvas.
   */
  async function readWindows(): Promise<z.infer<typeof windowSchema>[] | null> {
    const raw = await bb.storage.kv.get<unknown>(WINDOWS_KEY);
    if (!Array.isArray(raw)) return null;
    return raw as z.infer<typeof windowSchema>[];
  }

  bb.rpc.register(rpcContract, {
    async canvas_load() {
      const { scene, revision } = await readStored();
      return { scene, revision, ...describe(scene) };
    },

    async windows_load() {
      return { windows: await readWindows() };
    },

    async windows_save({ windows }) {
      const bytes = Buffer.byteLength(JSON.stringify(windows), "utf8");
      if (bytes > MAX_WINDOWS_BYTES) {
        // Unlike the scene, a layout has no legitimate reason to be large, so
        // this is a bug or a bad caller rather than a big drawing. Reject it
        // instead of silently truncating someone's layout.
        throw new Error(
          `Window layout is too large to save (${Math.round(bytes / 1024)}KB, limit ${
            MAX_WINDOWS_BYTES / 1024
          }KB).`,
        );
      }
      await bb.storage.kv.set(WINDOWS_KEY, windows);
      return { saved: true };
    },

    async canvas_save({ scene, baseRevision }) {
      const revision = await writeStored(scene as Scene, baseRevision);
      return { saved: true, revision };
    },

    async canvas_draw({ elements, baseRevision, appState }) {
      const { scene: current } = await readStored();
      const merged = mergeElements(
        current.elements,
        elements as Record<string, unknown>[],
      );
      const next: Scene = {
        elements: merged.elements,
        // Draw never discards stored appState; an explicit patch is layered on.
        appState: appState ? { ...current.appState, ...appState } : current.appState,
        files: current.files,
      };
      const revision = await writeStored(next, baseRevision);
      return {
        added: merged.elements.length - current.elements.length,
        total: merged.elements.length,
        revision,
        remapped: merged.remapped,
        ...describe(next),
      };
    },
  });
}
