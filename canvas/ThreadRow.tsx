// The one thread row, for the canvas's floating "Thread windows" panel.
//
// An earlier version shared this row with a sidebar list registered through
// `experimental_threadList`. That registration is gone, so this is now the only
// consumer — but it is deliberately still its own component, because the
// per-row hooks below have a hooks rule that is easy to violate in a parent.
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
  /**
   * Toggles a parent's children. Called by the inline chevron, which stops the
   * click from reaching the row body so expanding never also activates.
   */
  onToggleExpanded: (threadId: string) => void;
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
      style={depth > 0 ? { paddingLeft: `${depth * 12}px` } : undefined}
    >
      {/* No caret column. There used to be one — a chevron for parents and an
          inert same-width spacer for leaves — so all names shared a left edge.
          It reserved ~20px on every row to serve the minority of rows that have
          children, which made the list look randomly indented.

          Nesting is now just `depth` moving the row over, and a parent's
          chevron is a sibling of the row button (NOT nested inside it — a
          button inside a button is invalid and breaks screen readers). Being a
          sibling is also what lets one click mean one thing: the chevron
          toggles children, the row body activates the thread. */}
      {isParent ? (
        <button
          type="button"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={
            isExpanded ? `Collapse ${name} children` : `Expand ${name} children`
          }
          aria-expanded={isExpanded}
          onClick={() => onToggleExpanded(thread.id)}
        >
          <Icon
            name={isExpanded ? "ChevronDown" : "ChevronRight"}
            className="size-4"
          />
        </button>
      ) : null}

      <button
        type="button"
        // `splitProps` carries the host's split-drag gesture; spreading it is
        // safe when splits are unavailable (it is then empty).
        {...split.splitProps}
        className={
          rowClassName ??
          // Keep this the single source of row density for the canvas panel:
          // `px-2 py-1.5` gives each row breathing room, and `text-sm` reads
          // comfortably beside the `size-4` icons and `size-6` action buttons.
          "flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
        }
        onClick={() => onActivate(thread.id)}
        aria-current={isActive ? "true" : undefined}
        aria-label={label}
        title={label}
      >
        <span
          className={`size-2 shrink-0 rounded-full ${PRESENCE_DOT[presence]}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {thread.isPinned ? (
          <Icon
            name="Star"
            className="size-4 shrink-0 fill-current text-amber-500"
            aria-hidden="true"
          />
        ) : null}
        {attention ? (
          <Icon
            name="AlertCircle"
            className="size-4 shrink-0 text-destructive"
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
        <button
          type="button"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={thread.isPinned ? `Unpin ${name}` : `Pin ${name}`}
          title={thread.isPinned ? `Unpin ${name}` : `Pin ${name}`}
          onClick={() => void actions.setPinned(thread.id, !thread.isPinned)}
        >
          <Icon
            name="Pin"
            className={`size-4${thread.isPinned ? " fill-current text-amber-500" : ""}`}
          />
        </button>
        <button
          type="button"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={thread.isUnread ? `Mark ${name} read` : `Mark ${name} unread`}
          title={thread.isUnread ? `Mark ${name} read` : `Mark ${name} unread`}
          onClick={() => void actions.setRead(thread.id, thread.isUnread)}
        >
          <Icon name={thread.isUnread ? "Mail" : "MailOpen"} className="size-4" />
        </button>
        <button
          type="button"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={`Archive ${name}`}
          title={`Archive ${name}`}
          onClick={() => actions.archive(thread.id)}
        >
          <Icon name="Archive" className="size-4" />
        </button>
      </span>
    </li>
  );
}
