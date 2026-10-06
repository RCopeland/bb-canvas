// Grouping logic for the sidebar thread list.
//
// Kept pure and dependency-free (no React, no SDK values at import time) so the
// bucketing rules are unit-testable in the node test environment. The component
// in `SidebarThreadList.tsx` does the rendering; this module decides what goes
// where.
//
// The list has to reconcile three things that overlap: pinned threads, user
// sections, and the chosen organization mode (project / machine / custom). The
// precedence below is the one bb's own list uses, so a thread never appears
// twice and never disappears:
//
//   1. Pinned   — always first, regardless of mode or section.
//   2. Sections — a thread with a `sectionId` is filed there, not in its
//                 project/machine group, but only when the section exists.
//   3. Groups   — everything left, bucketed by the organization mode.
import type {
  PluginSidebarProject,
  PluginSidebarSection,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";

/** How the sidebar buckets loose threads. Matches `sidebar.organizationMode`. */
export type OrganizationMode = "chronological" | "project" | "machine";

export interface ThreadGroup {
  /** Stable key, used for collapse state and React keys. */
  key: string;
  /** Heading text. */
  label: string;
  threads: PluginSidebarThread[];
}

export interface GroupedThreads {
  pinned: PluginSidebarThread[];
  sections: { section: PluginSidebarSection; threads: PluginSidebarThread[] }[];
  groups: ThreadGroup[];
}

/**
 * Order threads the way bb's list reads them: attention first, then most
 * recently updated. This is a reading order, not a ranking — the tree structure
 * is applied on top by the caller.
 */
export function orderThreads(
  threads: readonly PluginSidebarThread[],
  isAttention: (thread: PluginSidebarThread) => boolean,
): PluginSidebarThread[] {
  return [...threads].sort((a, b) => {
    const attention = Number(isAttention(b)) - Number(isAttention(a));
    if (attention !== 0) return attention;
    return b.updatedAt - a.updatedAt;
  });
}

/**
 * Bucket threads into pinned / sections / groups.
 *
 * `visible` is the caller's already-filtered set (archived filter applied), so
 * this function never has to know about lifecycle rules.
 *
 * A section only becomes a bucket when it has at least one thread in `visible`.
 * An empty section would otherwise render a heading with nothing under it,
 * which reads as a bug rather than an empty state.
 */
export function groupThreads(
  visible: readonly PluginSidebarThread[],
  projects: readonly PluginSidebarProject[],
  sections: readonly PluginSidebarSection[],
  mode: OrganizationMode,
  hosts: readonly { id: string; name: string }[] = [],
): GroupedThreads {
  const pinned: PluginSidebarThread[] = [];
  const loose: PluginSidebarThread[] = [];
  const bySection = new Map<string, PluginSidebarThread[]>();
  const sectionIds = new Set(sections.map((section) => section.id));

  for (const thread of visible) {
    if (thread.isPinned) {
      // Pinned wins outright: a pinned thread is deliberately held at the top,
      // and showing it in its section too would duplicate it.
      pinned.push(thread);
      continue;
    }
    if (thread.sectionId !== null && sectionIds.has(thread.sectionId)) {
      const bucket = bySection.get(thread.sectionId) ?? [];
      bucket.push(thread);
      bySection.set(thread.sectionId, bucket);
      continue;
    }
    // A sectionId pointing at a missing section is treated as loose rather than
    // dropped: the section may have been deleted, and the thread still exists.
    loose.push(thread);
  }

  const sectionBuckets = sections
    .map((section) => ({
      section,
      threads: bySection.get(section.id) ?? [],
    }))
    .filter((bucket) => bucket.threads.length > 0);

  return {
    pinned,
    sections: sectionBuckets,
    groups: bucketLoose(loose, projects, mode, hosts),
  };
}

function bucketLoose(
  loose: readonly PluginSidebarThread[],
  projects: readonly PluginSidebarProject[],
  mode: OrganizationMode,
  hosts: readonly { id: string; name: string }[],
): ThreadGroup[] {
  if (mode === "chronological") {
    // Custom mode is one flat list; bb calls this "Custom" in the UI and
    // "chronological" in the preference. No heading is needed for a single
    // ungrouped bucket, but returning it as a group keeps the renderer uniform.
    return loose.length > 0
      ? [{ key: "all", label: "Threads", threads: [...loose] }]
      : [];
  }

  if (mode === "machine") {
    const names = new Map(hosts.map((host) => [host.id, host.name]));
    const buckets = new Map<string, PluginSidebarThread[]>();
    for (const thread of loose) {
      // A thread with no environment has no host; bb groups those under
      // "No machine" rather than hiding them.
      const key = thread.host?.id ?? "no-machine";
      const bucket = buckets.get(key) ?? [];
      bucket.push(thread);
      buckets.set(key, bucket);
    }
    return [...buckets.entries()]
      .map(([key, threads]) => ({
        key: `machine:${key}`,
        label:
          key === "no-machine"
            ? "No machine"
            : (names.get(key) ?? threads[0]?.host?.name ?? "Unknown machine"),
        threads,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  // project: the default organization. A thread whose project is not in the
  // list (personal project, or a project the user cannot see) is grouped under
  // its own id rather than dropped.
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const buckets = new Map<string, PluginSidebarThread[]>();
  for (const thread of loose) {
    const bucket = buckets.get(thread.projectId) ?? [];
    bucket.push(thread);
    buckets.set(thread.projectId, bucket);
  }
  return [...buckets.entries()]
    .map(([key, threads]) => ({
      key: `project:${key}`,
      label: projectNames.get(key) ?? "Unknown project",
      threads,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
