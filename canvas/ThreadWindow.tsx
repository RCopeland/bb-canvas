// A floating thread window drawn above the canvas.
//
// The window is chrome we own (title bar, presence strip, drag and resize
// handles) wrapped around the host's OWN chat component, `ThreadChat`. That is
// deliberate and load-bearing: hand-rolling a transcript from the timeline RPC
// drops everything that is not plain conversation text — tool calls, diffs,
// file rows, queued messages, drafts, attachments, @-mentions — and bypasses
// the host submit pipeline, so sends lose attachments and the thread's
// resolved execution settings. `ThreadChat` is bb's real chat, so the window
// keeps working as bb evolves.
//
// `permissionPolicy="inherit"` is not incidental: it pins every send to the
// thread's own resolved default and renders the picker as a dimmed label, so a
// plugin surface can never widen a thread's permission mode.
import {
  ThreadChat,
  experimental_useProviders,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import {
  presenceLabel,
  presenceText,
  threadName,
  threadPresence,
  type Presence,
} from "./types";
import {
  useWindowDrag,
  useWindowResize,
  type LayerBoundsRef,
} from "./useWindowDrag";

export interface FloatWindowState {
  threadId: string;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  /** Hidden windows keep their position and state; the thread keeps running. */
  visible: boolean;
}

export const DEFAULT_W = 460;
export const DEFAULT_H = 560;

/** Presence dot colour, one class per presence state. */
const PRESENCE_DOT: Record<Presence, string> = {
  needs: "bg-destructive",
  busy: "bg-amber-500",
  error: "bg-destructive",
  unavailable: "bg-muted-foreground/40",
  idle: "bg-emerald-500",
};

export interface ThreadWindowProps {
  state: FloatWindowState;
  thread: PluginSidebarThread;
  bounds: LayerBoundsRef;
  onFocus: () => void;
  onMove: (x: number, y: number) => void;
  onResize: (box: { x: number; y: number; width: number; height: number }) => void;
  onHide: () => void;
}

export function ThreadWindow({
  state,
  thread,
  bounds,
  onFocus,
  onMove,
  onResize,
  onHide,
}: ThreadWindowProps) {
  const { providers } = experimental_useProviders();
  const drag = useWindowDrag(bounds, onMove);
  const resizeSE = useWindowResize(bounds, "se", onResize, onFocus);
  const resizeSW = useWindowResize(bounds, "sw", onResize, onFocus);
  const presence = threadPresence(thread);
  const name = threadName(thread);
  const provider =
    providers.find((entry) => entry.id === thread.providerId)?.displayName ??
    thread.providerId;
  const branch = thread.environment?.branchName;
  const host = thread.host?.name;

  if (!state.visible) return null;

  return (
    <section
      data-float-window
      role="dialog"
      aria-label={`Thread — ${name}`}
      className="pointer-events-auto absolute flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl ring-1 ring-black/5"
      style={{
        left: state.x,
        top: state.y,
        width: state.width,
        height: state.height,
        zIndex: state.z,
      }}
      onPointerDown={onFocus}
    >
      {/* Title bar: the drag handle. */}
      <header
        {...drag}
        className="flex h-9 shrink-0 cursor-grab touch-none select-none items-center gap-2 border-b border-border bg-muted/60 px-2 active:cursor-grabbing"
      >
        <span
          className={`size-2 shrink-0 rounded-full ${PRESENCE_DOT[presence]}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold" title={name}>
          {name}
        </span>
        <button
          type="button"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={`Close ${name}'s window`}
          title="Close window (the thread keeps running)"
          onClick={onHide}
        >
          <Icon name="X" className="size-3.5" />
        </button>
      </header>

      {/* Status strip: says why the window matters without stealing chat space. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-2.5 py-1.5 text-[11px]">
        <span className="font-medium">{presenceText(presence)}</span>
        <span className="min-w-0 truncate text-muted-foreground">
          {presenceLabel(thread)}
        </span>
        <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
          {provider}
        </span>
        {branch ? (
          <span
            className="max-w-[10rem] shrink-0 truncate rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
            title={`Branch: ${branch}`}
          >
            {branch}
          </span>
        ) : null}
        {host ? (
          <span
            className="max-w-[8rem] shrink-0 truncate rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
            title={`Machine: ${host}`}
          >
            {host}
          </span>
        ) : null}
      </div>

      {/* The real chat. `contained` fills and scrolls inside this bounded
          parent; `inherit` keeps sends on the thread's own permission mode. */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <ThreadChat
          threadId={thread.id}
          variant="compact"
          layout="contained"
          permissionPolicy="inherit"
          className="h-full"
        />
      </div>

      {/* Bottom corner resize handles. Top corners stay clear for the
          title-bar controls. */}
      <span
        {...resizeSE}
        aria-hidden="true"
        className="absolute bottom-0 right-0 size-3.5 cursor-se-resize touch-none"
      />
      <span
        {...resizeSW}
        aria-hidden="true"
        className="absolute bottom-0 left-0 size-3.5 cursor-sw-resize touch-none"
      />
    </section>
  );
}
