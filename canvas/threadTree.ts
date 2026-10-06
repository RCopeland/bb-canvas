// Thread tree shaping for the launcher.
//
// Kept out of `ThreadLauncher.tsx` on purpose: that file imports React and the
// host plugin SDK, so a test importing it pulls in modules the node test
// environment cannot resolve. This module is pure and dependency-free, which is
// what makes the tree rules testable.
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

/**
 * Split the flat sidebar `threads` into roots + a parent → children map.
 *
 * Roots are top-level threads (`parentThreadId === null`); a thread whose
 * parent is not in the list (an orphan — the parent is archived, hidden, or in
 * another section) is promoted to a root so nothing is ever dropped from the
 * list. An invisible thread is worse than a misplaced one: the user cannot even
 * see that it is gone.
 *
 * Children preserve source order, so the caller's sort is the reading order at
 * every depth.
 */
export function buildTree(threads: readonly PluginSidebarThread[]): {
  roots: PluginSidebarThread[];
  children: Map<string, PluginSidebarThread[]>;
} {
  const known = new Set<string>();
  for (const thread of threads) known.add(thread.id);

  const children = new Map<string, PluginSidebarThread[]>();
  const roots: PluginSidebarThread[] = [];
  for (const thread of threads) {
    if (thread.parentThreadId === null) {
      roots.push(thread);
      continue;
    }
    if (known.has(thread.parentThreadId)) {
      const siblings = children.get(thread.parentThreadId) ?? [];
      siblings.push(thread);
      children.set(thread.parentThreadId, siblings);
    } else {
      roots.push(thread);
    }
  }
  return { roots, children };
}
