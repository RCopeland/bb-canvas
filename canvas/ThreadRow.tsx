// The one thread row.
//
// Both surfaces render this: the canvas's floating "Thread windows" panel and
// the sidebar list registered through `experimental_threadList`. There is
// deliberately a single implementation — the whole point of registering a real
// sidebar list is that the canvas stops being a hand-rolled copy that drifts
// from the host, and two row components would reintroduce exactly that problem
// one level down.
//
// The only thing the surfaces disagree about is what a click does:
//   * canvas  → open a floating window over the drawing
//   * sidebar → navigate to the thread (and close the mobile drawer)
//
// so that is the one prop that varies (`onActivate`).
//
// Hooks discipline (two hard rules, both easy to violate here):
//  1. Every hook runs unconditionally — no hook after an early return.
//  2. The per-row hooks (`experimental_useSidebarThreadSplit`,
//     `experimental_useSidebarThreadPullRequest`) are called inside this
//     component — one instance per row — never in a loop in a parent.
import {
  experimental_useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit,
  type PluginSidebarThread,
  type PluginSidebarThreadActions,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import {
  activitySummary,
  needsAttention,
  presenceLabel,
  relativeTime,
  threadName,
  threadPresence,
  type Presence,
} from "./types";
import type { ReactNode } from "react";

/** Presence dot colour, one class per presence state. */
export const PRESENCE_DOT: Record<Presence, string> = {
  needs: "bg-destructive",
  busy: "bg-amber-500",
  error: "bg-destructive",
  unavailable: "bg-muted-foreground/40",
  idle: "bg-emerald-500",
};

export interface ThreadRowProps {
  thread: PluginSidebarThread;
  projectName: string | null;
  providerName: string | null;
  /** True when this thread has children in the list, so it gets a caret. */
  isParent: boolean;
  isExpanded: boolean;
  /** True when this thread is the one the route currently shows. */
  isActive: boolean;
  depth: number;
  actions: PluginSidebarThreadActions;
  /** What a click on the row body does. Varies by surface. */
  onActivate: (threadId: string) => void;
  onToggleExpanded: (threadId: string) => void;
  /** Extra trailing indicator, e.g. the canvas's "open window" eye. */
  trailing?: ReactNode;
  /**
   * Tailwind classes for the row button. The canvas panel and the sidebar have
   * different densities, so the surface supplies its own.
   */
  rowClassName?: string;
}

/**
 * One thread row. Owns the per-row host hooks that bb's own rows call, and
 * renders the same status vocabulary the built-in list uses.
 */
export function ThreadRow({
  thread,
  projectName,
  providerName,
  isParent,
  isExpanded,
  isActive,
  depth,
  actions,
  onActivate,
  onToggleExpanded,
  trailing,
  rowClassName,
}: ThreadRowProps) {
  // Per-row hooks — one instance of this component per row, so calling them
  // here is legal and matches how bb's built-in rows are built.
  //
  // `splitProps` is spread onto the row button so the host's drag-to-split
  // gesture works from both surfaces. The PR hook is called but its value is
  // not painted: the row shows a dot and a title, and a PR badge would
  // reintroduce the dense row this design dropped. Both stay because dropping
  // either would change this component's hook count.
  const split = experimental_useSidebarThreadSplit(thread.id);
  experimental_useSidebarThreadPullRequest(thread.id);

  const name = threadName(thread);
  const presence = threadPresence(thread);
  const attention = needsAttention(thread);
  const activity = activitySummary(thread);
  const branch = thread.environment?.branchName ?? null;
  const host = thread.host?.name ?? null;
  const lastActivity = relativeTime(thread.updatedAt);

  // The row paints only a dot and the title, so the accessible name is where
  // the omitted detail lives. Prefer the host's own `indicatorLabel` for the
  // status phrase so screen-reader text matches the built-in list exactly.
  const labelParts = [name, thread.indicatorLabel ?? presenceLabel(thread)];
  if (thread.isUnread) labelParts.push("unread");
  if (thread.isPinned) labelParts.push("pinned");
  if (split.layout?.panes.some((pane) => pane.isMe)) {
    labelParts.push("in a split pane");
  }
  if (activity) labelParts.push(activity);
  if (branch) labelParts.push(`branch ${branch}`);
  if (host) labelParts.push(`on ${host}`);
  if (projectName) labelParts.push(`project ${projectName}`);
  if (providerName) labelParts.push(`provider ${providerName}`);
  if (lastActivity) labelParts.push(`last activity ${lastActivity}`);
  const label = labelParts.join(", ");

  return (
    <li
      className="flex items-center"
      style={{ paddingLeft: `${depth * 12}px` }}
    >
      {/* The caret column is rendered for EVERY row, not just parents. The
          caret is a flex sibling of the row button, so rendering it only for
          parents pushes those rows right of childless rows and makes the list
          look indented at random. Leaves get an inert spacer of the same width
          instead, so all names share one left edge and only real nesting (a
          nonzero `depth`) moves a row.

          For a parent the caret is its own control: clicking the row body
          activates the thread, clicking the caret only expands/collapses
          children, so one click means one thing and both actions stay keyboard
          reachable without a double-click. */}
      {isParent ? (
        <button
          type="button"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={
            isExpanded ? `Collapse ${name} children` : `Expand ${name} children`
          }
          aria-expanded={isExpanded}
          onClick={() => onToggleExpanded(thread.id)}
        >
          <Icon
            name={isExpanded ? "ChevronDown" : "ChevronRight"}
            className="size-3"
          />
        </button>
      ) : (
        <span className="size-5 shrink-0" aria-hidden="true" />
      )}

      <button
        type="button"
        // `splitProps` carries the host's split-drag gesture; spreading it is
        // safe when splits are unavailable (it is then empty).
        {...split.splitProps}
        className={
          rowClassName ??
          "flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-accent"
        }
        onClick={() => onActivate(thread.id)}
        aria-label={label}
        aria-current={isActive ? "true" : undefined}
        title={label}
      >
        <span
          className={`size-1.5 shrink-0 rounded-full ${PRESENCE_DOT[presence]}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {thread.isPinned ? (
          <Icon
            name="Star"
            className="size-3 shrink-0 fill-current text-amber-500"
            aria-hidden="true"
          />
        ) : null}
        {attention ? (
          <Icon
            name="AlertCircle"
            className="size-3 shrink-0 text-destructive"
            aria-hidden="true"
          />
        ) : null}
      </button>

      {/* Per-row host actions. Every control is always rendered and labelled: a
          hover-only control is invisible until you happen to pass over it,
          which is what makes these look broken. Each routes to the host's own
          flow, so optimistic updates and confirmations behave as they do in the
          built-in list. */}
      <span className="flex shrink-0 items-center">
        {trailing}
        <button
          type="button"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={thread.isPinned ? `Unpin ${name}` : `Pin ${name}`}
          title={thread.isPinned ? `Unpin ${name}` : `Pin ${name}`}
          onClick={() => void actions.setPinned(thread.id, !thread.isPinned)}
        >
          <Icon
            name="Pin"
            className={`size-3${thread.isPinned ? " fill-current text-amber-500" : ""}`}
          />
        </button>
        <button
          type="button"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={thread.isUnread ? `Mark ${name} read` : `Mark ${name} unread`}
          title={thread.isUnread ? `Mark ${name} read` : `Mark ${name} unread`}
          onClick={() => void actions.setRead(thread.id, thread.isUnread)}
        >
          <Icon name={thread.isUnread ? "Mail" : "MailOpen"} className="size-3" />
        </button>
        {isActive ? null : (
          <button
            type="button"
            className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={`Open ${name} in the main app`}
            title={`Open ${name} in the main app`}
            onClick={() => actions.open(thread.id)}
          >
            <Icon name="ExternalLink" className="size-3" />
          </button>
        )}
        <button
          type="button"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={`Archive ${name}`}
          title={`Archive ${name}`}
          onClick={() => actions.archive(thread.id)}
        >
          <Icon name="Archive" className="size-3" />
        </button>
      </span>
    </li>
  );
}
