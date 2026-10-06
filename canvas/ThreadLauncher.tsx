// The canvas's "Thread windows" panel: a floating list that opens threads as
// windows over the drawing.
//
// This is the canvas-local surface. The sidebar surface
// (`SidebarThreadList.tsx`) is registered as bb's real thread list; both render
// the same `ThreadRow`, so there is one row implementation rather than two that
// drift apart.
//
// What differs is only what a click does: here it opens a floating window on
// the canvas, because the whole point of this panel is to keep the drawing in
// view. The sidebar navigates.
import { Fragment, useMemo } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  experimental_useProviders,
  experimental_useSidebarThreadActions,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { ThreadRow } from "./ThreadRow";
import { buildTree } from "./threadTree";

interface ThreadLauncherTreeProps {
  threads: readonly PluginSidebarThread[];
  projects: readonly { id: string; name: string }[];
  /** Ids of threads whose floating window is currently open. */
  openThreadIds: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  onToggleExpanded: (threadId: string) => void;
  /** Opens (or focuses) a thread's floating window on the canvas. */
  onOpenWindow: (threadId: string) => void;
}

/**
 * The list body: threads in bb's parent/child tree, rendered with the shared
 * row. Split out so the panel chrome below stays readable.
 */
function ThreadLauncherTree({
  threads,
  projects,
  openThreadIds,
  expanded,
  onToggleExpanded,
  onOpenWindow,
}: ThreadLauncherTreeProps) {
  const actions = experimental_useSidebarThreadActions();
  const { providers } = experimental_useProviders();

  const { roots, children } = useMemo(() => buildTree(threads), [threads]);

  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) map.set(project.id, project.name);
    return map;
  }, [projects]);

  const providerNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const provider of providers) map.set(provider.id, provider.displayName);
    return map;
  }, [providers]);

  // Render a row, recursing into an expanded parent's descendants. Depth
  // drives the indent; rows stay flat siblings inside the list so the
  // accessible structure is a clean set of rows rather than nested lists.
  const renderThread = (
    thread: PluginSidebarThread,
    depth = 0,
  ): React.ReactNode => {
    const childThreads = children.get(thread.id) ?? [];
    return (
      <Fragment key={thread.id}>
        <ThreadRow
          thread={thread}
          projectName={projectNames.get(thread.projectId) ?? null}
          providerName={providerNames.get(thread.providerId) ?? null}
          isParent={childThreads.length > 0}
          isExpanded={expanded.has(thread.id)}
          // In this panel "active" means "already open as a window", which is
          // what the surface is for. The sidebar means the routed thread.
          isActive={openThreadIds.has(thread.id)}
          depth={depth}
          actions={actions}
          onActivate={onOpenWindow}
          onToggleExpanded={onToggleExpanded}
          trailing={
            openThreadIds.has(thread.id) ? (
              <Icon
                name="Eye"
                className="mr-0.5 size-3 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            ) : null
          }
        />
        {expanded.has(thread.id)
          ? childThreads.map((child) => renderThread(child, depth + 1))
          : null}
      </Fragment>
    );
  };

  if (threads.length === 0) {
    return (
      <p
        className="px-2 py-3 text-center text-xs text-muted-foreground"
        role="status"
      >
        No threads yet.
      </p>
    );
  }

  return (
    <ul className="flex flex-col" aria-label="Threads you can open as windows">
      {roots.map((thread) => renderThread(thread))}
    </ul>
  );
}

export interface ThreadLauncherProps {
  /** Threads to list, already filtered and sorted by the caller. */
  threads: readonly PluginSidebarThread[];
  /** Every known project, for resolving a thread's project name. */
  projects: readonly { id: string; name: string }[];
  /** Ids of threads whose floating window is currently open. */
  openThreadIds: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  onToggleExpanded: (threadId: string) => void;
  open: boolean;
  onToggleOpen: () => void;
  composing: boolean;
  onToggleCompose: () => void;
  onOpenWindow: (threadId: string) => void;
  /** Spread onto the header row so the caller can attach a drag gesture. */
  dragHandleProps?: {
    onPointerDown?: React.PointerEventHandler<HTMLDivElement>;
  };
}

/**
 * The visual drag affordance: six dots, drawn in CSS.
 *
 * Deliberately not an `<Icon>`: the host resolves icon names at runtime from
 * its own registry, and a name it does not know renders nothing at all — an
 * invisible handle is worse than no handle, because it looks like the panel
 * simply is not draggable. Two columns of `bg-current` dots inherit the muted
 * foreground and cannot fail to draw.
 *
 * `aria-hidden` is defensive rather than load-bearing: six empty spans carry no
 * text, so most screen readers would skip them anyway. Marking it explicitly
 * keeps that true if the dots ever gain a glyph or a title.
 */
function GripDots() {
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 grid-cols-2 gap-x-[3px] gap-y-[3px] opacity-60"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <span key={index} className="size-[2px] rounded-full bg-current" />
      ))}
    </span>
  );
}

export function ThreadLauncher({
  threads,
  projects,
  openThreadIds,
  expanded,
  onToggleExpanded,
  open,
  onToggleOpen,
  composing,
  onToggleCompose,
  onOpenWindow,
  dragHandleProps,
}: ThreadLauncherProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card/95 shadow-lg backdrop-blur">
      {/* The header row is always visible, so the new-thread affordance lives
          here rather than inside the collapsible body: collapsing the launcher
          to see more canvas must not take creating a thread off screen.

          It is a plain `<div>` carrying `onPointerDown`. Pointer-only
          dragging is an enhancement, not the primary interaction — the two
          real buttons inside (collapse and new thread) remain fully
          keyboard-operable. Do NOT add `role="button"`: nesting interactive
          children inside a role="button" is worse for screen readers than
          leaving it a plain div.

          The grab cursor and the grip dots live on the ROW, not on either
          button, so the affordance reads as "this whole bar moves" — which is
          true: the buttons opt out of the gesture themselves, via the
          `closest("button,[data-no-drag]")` guard in `useLauncherDrag`. This
          mirrors the floating window's title bar, which is the same
          arrangement. `touch-none` is required, not decorative: without it a
          touch drag scrolls the page instead of moving the panel. */}
      <div
        className="flex cursor-grab touch-none select-none items-stretch active:cursor-grabbing"
        {...dragHandleProps}
      >
        <span className="flex shrink-0 items-center pl-2.5 text-muted-foreground">
          <GripDots />
        </span>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-xs font-semibold hover:bg-accent/50"
          aria-expanded={open}
          onClick={onToggleOpen}
        >
          <Icon name="AppWindow" className="size-3.5" />
          <span className="flex-1">Thread windows</span>
          <span className="text-muted-foreground">{openThreadIds.size}</span>
          <Icon
            name={open ? "ChevronUp" : "ChevronDown"}
            className="size-3.5 text-muted-foreground"
          />
        </button>
        <button
          type="button"
          className="flex shrink-0 items-center gap-1.5 border-l border-border px-2.5 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-pressed:bg-state-active aria-pressed:text-foreground"
          aria-pressed={composing}
          onClick={onToggleCompose}
          title="Start a new thread"
        >
          <Icon name={composing ? "X" : "Plus"} className="size-3.5" />
          <span>{composing ? "Cancel" : "New thread"}</span>
        </button>
      </div>
      {open ? (
        <div className="max-h-80 overflow-y-auto border-t border-border p-1">
          <ThreadLauncherTree
            threads={threads}
            projects={projects}
            openThreadIds={openThreadIds}
            expanded={expanded}
            onToggleExpanded={onToggleExpanded}
            onOpenWindow={onOpenWindow}
          />
        </div>
      ) : null}
    </div>
  );
}
