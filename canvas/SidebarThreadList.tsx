// The sidebar thread list, registered through `experimental_threadList`.
//
// This is bb's REAL sidebar list while the plugin is enabled — not a copy of
// it. That distinction is the whole reason this file exists: the canvas panel
// alone was a hand-rolled reimplementation that could drift from the host, and
// the host exposes no way to embed its own list. Registering into the slot
// makes one implementation the actual list.
//
// READ THIS BEFORE CHANGING THE SLOT: the slot is EXCLUSIVE and activation is
// automatic. `__automatic__` resolves to "the first registered list whose
// plugin id is not the bundled `thread-list/thread-list`", so simply having this
// plugin enabled replaces bb's sidebar thread list everywhere. To get bb's own
// list back, pin `thread-list/thread-list` under
// Settings → Appearance → Sidebar. That is a product-level consequence, so it
// is documented in the README as well.
//
// The host owns the chrome around this component. The New-thread button, the
// search action, the plugin nav rows, and the sidebar footer are all
// host-rendered in every sidebar, and a replaced list must not try to draw
// them. This component gets the scrolling list and nothing else.
import { Fragment, useCallback, useMemo, useState } from "react";
import type {
  PluginThreadListProps,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import {
  experimental_useProviders,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import { ThreadRow } from "./ThreadRow";
import { needsAttention } from "./types";
import { buildTree } from "./threadTree";
import { groupThreads, orderThreads } from "./threadGrouping";
import {
  ThreadListActionsMenu,
  useThreadListPrefs,
  type ThreadListPrefs,
} from "./ThreadListActionsMenu";

/** Which lifecycles the list shows. Mirrors bb's thread-list Filter. */
type LifecycleFilter = "active" | "archived";

/**
 * Row density for the sidebar. Slightly roomier than the canvas panel because
 * the sidebar is the primary surface and rows carry per-row actions that need
 * a comfortable hit target.
 */
const ROW_CLASS =
  "flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1.5 text-left text-xs hover:bg-accent aria-[current=true]:bg-accent aria-[current=true]:font-medium";

const FILTER_CLASS =
  "rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground aria-pressed:font-medium";

/** A non-interactive group heading. */
function GroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <li className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {label}
      <span className="ml-1 font-normal normal-case">({count})</span>
    </li>
  );
}

/**
 * Read, and locally override, the sidebar preferences this list obeys.
 *
 * The SDK exposes uiPreferences as a promise, not a reactive hook, so the
 * stored values are read once. The menu's own writes update the local copy
 * immediately (so the list re-groups without a refetch) and, on failure, the
 * menu reports the error and restores what was actually saved.
 *
 * Preferences are cosmetic: a failed read keeps the defaults rather than
 * blocking the list, which is the same state a fresh install starts in.
 */
function usePrefs(): {
  prefs: ThreadListPrefs;
  apply: (next: Partial<ThreadListPrefs>) => void;
  error: string | null;
  setError: (message: string | null) => void;
} {
  const stored = useThreadListPrefs();
  const [override, setOverride] = useState<Partial<ThreadListPrefs> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const prefs = useMemo(
    () => ({ ...stored, ...override }),
    [stored, override],
  );

  const apply = useCallback((next: Partial<ThreadListPrefs>) => {
    setOverride((current) => ({ ...current, ...next }));
  }, []);

  return { prefs, apply, error, setError };
}

export function SidebarThreadList({
  activeThreadId,
  onNavigate,
}: PluginThreadListProps) {
  // Hooks run unconditionally, before anything below can return early.
  const actions = experimental_useSidebarThreadActions();
  const { providers } = experimental_useProviders();
  const sidebar = experimental_useSidebarThreads({
    // The archived bucket is a separate paginated query on the host. Asking for
    // it up front is what lets the filter switch without a refetch.
    experimental_lifecycles: ["active", "archived"],
  });
  const { prefs, apply, error: prefError, setError: setPrefError } = usePrefs();
  const mode = prefs.mode;

  const [filter, setFilter] = useState<LifecycleFilter>("active");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const toggleExpanded = useCallback((threadId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  }, []);

  // Navigate and close the mobile drawer. `onNavigate` is the host's hook for
  // exactly this; skipping it leaves the drawer covering the thread on phones.
  const activate = useCallback(
    (threadId: string) => {
      actions.open(threadId);
      onNavigate();
    },
    [actions, onNavigate],
  );

  const { threads, projects, sections, experimental_archived, status } = sidebar;

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

  // Active threads come from the main list; archived ones come back in the same
  // array when requested. `isArchived` is the discriminator, and filtering
  // explicitly keeps the two buckets from overlapping.
  const visible = useMemo(
    () =>
      threads.filter((thread) => {
        if (thread.isHidden) return false;
        return filter === "archived" ? thread.isArchived : !thread.isArchived;
      }),
    [threads, filter],
  );

  const ordered = useMemo(() => {
    const sorted = orderThreads(visible, needsAttention);
    // `orderThreads` is newest-and-attention-first, which is bb's "Last
    // activity" with its default direction. The other sort choices are applied
    // on top so attention still floats to the top of each — that ordering is a
    // property of the list, not of the chosen field.
    const field = prefs.sortField;
    const direction = prefs.sortDirection;
    // "none" is the host's name for "leave the natural order alone", and
    // "updated" at its default direction is exactly what orderThreads already
    // produced. Both skip the second pass.
    if (field === "none") return sorted;
    if (field === "updated" && direction === "default") return sorted;
    const factor = direction === "ascending" ? 1 : -1;
    return [...sorted].sort((a, b) => {
      // Attention still floats to the top of every field: "needs you" is a
      // property of the list, not of the chosen sort.
      const attention = Number(needsAttention(b)) - Number(needsAttention(a));
      if (attention !== 0) return attention;
      if (field === "alpha") {
        return a.displayTitle.localeCompare(b.displayTitle) * factor;
      }
      const av = field === "created" ? a.createdAt : a.updatedAt;
      const bv = field === "created" ? b.createdAt : b.updatedAt;
      return (av - bv) * factor;
    });
  }, [visible, prefs.sortField, prefs.sortDirection]);

  // Grouping is pure and lives in its own module so its rules are tested
  // directly. Pinned and section precedence is decided there.
  const { pinned, sections: sectionBuckets, groups } = useMemo(
    () => groupThreads(ordered, projects, sections, prefs.mode),
    [ordered, projects, sections, prefs.mode],
  );

  // The tree is built from every visible thread so a child is still found when
  // its parent is filtered into another bucket. `buildTree` promotes orphans to
  // roots, so a child whose parent is hidden still renders.
  const { children: childMap } = useMemo(() => buildTree(ordered), [ordered]);

  const renderThread = useCallback(
    (thread: PluginSidebarThread, depth = 0): React.ReactNode => {
      const childThreads = childMap.get(thread.id) ?? [];
      const isParent = childThreads.length > 0;
      const isExpanded = expanded.has(thread.id);
      return (
        <Fragment key={thread.id}>
          <ThreadRow
            thread={thread}
            projectName={projectNames.get(thread.projectId) ?? null}
            providerName={providerNames.get(thread.providerId) ?? null}
            isParent={isParent}
            isExpanded={isExpanded}
            isActive={thread.id === activeThreadId}
            depth={depth}
            actions={actions}
            onActivate={activate}
            onToggleExpanded={toggleExpanded}
            rowClassName={ROW_CLASS}
          />
          {isExpanded
            ? childThreads.map((child) => renderThread(child, depth + 1))
            : null}
        </Fragment>
      );
    },
    [
      childMap,
      expanded,
      projectNames,
      providerNames,
      activeThreadId,
      actions,
      activate,
      toggleExpanded,
    ],
  );

  if (status === "loading") {
    return (
      <p className="px-3 py-4 text-center text-xs text-muted-foreground">
        Loading threads…
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      {/* Filter row. bb's own list has this inside its header; the slot hands a
          replaced list the scroll area only, so it draws its own. */}
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        {(["active", "archived"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={FILTER_CLASS}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {value === "active" ? "Active" : "Archived"}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {ordered.length}
        </span>
        {/* Organize / Sort by / New section. A replaced list owns presentation,
            so these controls have to live here or they are simply gone from the
            sidebar. */}
        <ThreadListActionsMenu
          prefs={prefs}
          onChange={apply}
          onError={(message) => setPrefError(message === "" ? null : message)}
        />
      </div>
      {prefError !== null ? (
        <p role="alert" className="px-2 pb-1 text-[10px] text-destructive">
          Could not save that preference: {prefError}
        </p>
      ) : null}

      <ul className="flex flex-col" aria-label="Threads">
        {ordered.length === 0 ? (
          <li
            className="px-3 py-4 text-center text-xs text-muted-foreground"
            role="status"
          >
            {filter === "archived" ? "No archived threads." : "No threads yet."}
          </li>
        ) : null}

        {pinned.length > 0 ? (
          <>
            <GroupHeading label="Pinned" count={pinned.length} />
            {pinned.map((thread) => renderThread(thread))}
          </>
        ) : null}

        {sectionBuckets.map(({ section, threads: sectionThreads }) => (
          <Fragment key={section.id}>
            <GroupHeading label={section.name} count={sectionThreads.length} />
            {sectionThreads.map((thread) => renderThread(thread))}
          </Fragment>
        ))}

        {groups.map((group) => (
          <Fragment key={group.key}>
            {/* Custom mode is a single flat bucket, so a heading would be noise. */}
            {mode === "chronological" ? null : (
              <GroupHeading label={group.label} count={group.threads.length} />
            )}
            {group.threads.map((thread) => renderThread(thread))}
          </Fragment>
        ))}
      </ul>

      {filter === "archived" && experimental_archived?.hasNextPage ? (
        <button
          type="button"
          className="mx-2 mb-2 shrink-0 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          onClick={() => void experimental_archived.fetchNextPage()}
          disabled={experimental_archived.isFetchingNextPage}
        >
          {experimental_archived.isFetchingNextPage
            ? "Loading…"
            : "Load more archived threads"}
        </button>
      ) : null}
    </div>
  );
}
