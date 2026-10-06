import { describe, expect, it } from "vitest";
import { buildTree } from "../canvas/threadTree";
import { activitySummary, relativeTime } from "../canvas/types";

// The launcher builds a tree from bb's FLAT sidebar array and must never drop a
// thread. These cases cover the three ways that can go wrong: a nested thread,
// an orphan whose parent is filtered out, and ordering.

/** Minimal thread stub: only the fields the helpers under test read. */
function thread(
  id: string,
  parentThreadId: string | null = null,
): { id: string; parentThreadId: string | null } {
  return { id, parentThreadId };
}

describe("buildTree", () => {
  it("keeps top-level threads as roots in source order", () => {
    const { roots, children } = buildTree([
      thread("a"),
      thread("b"),
      thread("c"),
    ]);
    expect(roots.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(children.size).toBe(0);
  });

  it("nests a child under its parent and removes it from the roots", () => {
    const { roots, children } = buildTree([
      thread("parent"),
      thread("child", "parent"),
    ]);
    expect(roots.map((t) => t.id)).toEqual(["parent"]);
    expect(children.get("parent")?.map((t) => t.id)).toEqual(["child"]);
  });

  it("preserves sibling order", () => {
    const { children } = buildTree([
      thread("parent"),
      thread("c1", "parent"),
      thread("c2", "parent"),
      thread("c3", "parent"),
    ]);
    expect(children.get("parent")?.map((t) => t.id)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
  });

  it("promotes an orphan to a root rather than dropping it", () => {
    // The parent is not in the list (archived, hidden, another section). The
    // child must still be visible.
    const { roots, children } = buildTree([thread("orphan", "missing-parent")]);
    expect(roots.map((t) => t.id)).toEqual(["orphan"]);
    expect(children.size).toBe(0);
  });

  it("never drops or duplicates a thread across mixed shapes", () => {
    const input = [
      thread("a"),
      thread("a1", "a"),
      thread("a2", "a"),
      thread("orphan", "gone"),
      thread("b"),
    ];
    const { roots, children } = buildTree(input);

    const seen: string[] = [];
    const walk = (list: ReturnType<typeof buildTree>["roots"]) => {
      for (const node of list) {
        seen.push(node.id);
        walk(children.get(node.id) ?? []);
      }
    };
    walk(roots);

    expect(seen).toHaveLength(input.length);
    expect(new Set(seen).size).toBe(input.length);
    expect(seen.sort()).toEqual(["a", "a1", "a2", "b", "orphan"]);
  });

  it("handles an empty list", () => {
    const { roots, children } = buildTree([]);
    expect(roots).toEqual([]);
    expect(children.size).toBe(0);
  });
});

describe("relativeTime", () => {
  const now = 1_700_000_000_000;

  it("returns an empty string for a bad timestamp", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(relativeTime(bad, now)).toBe("");
    }
  });

  it("uses 'just now' under a minute", () => {
    expect(relativeTime(now - 5_000, now)).toBe("just now");
    expect(relativeTime(now - 40_000, now)).toBe("just now");
  });

  it("rolls up through minutes, hours, days, months and years", () => {
    const minute = 60_000;
    expect(relativeTime(now - 3 * minute, now)).toBe("3m ago");
    expect(relativeTime(now - 5 * 60 * minute, now)).toBe("5h ago");
    expect(relativeTime(now - 3 * 24 * 60 * minute, now)).toBe("3d ago");
    expect(relativeTime(now - 90 * 24 * 60 * minute, now)).toBe("3mo ago");
    expect(relativeTime(now - 800 * 24 * 60 * minute, now)).toBe("2y ago");
  });
});

describe("activitySummary", () => {
  it("returns null when nothing is running", () => {
    expect(
      activitySummary({
        activity: {
          workflows: 0,
          backgroundAgents: 0,
          backgroundCommands: 0,
          planMode: 0,
          goals: 0,
        },
      }),
    ).toBeNull();
  });

  it("pluralises correctly", () => {
    expect(
      activitySummary({
        activity: {
          workflows: 0,
          backgroundAgents: 1,
          backgroundCommands: 1,
          planMode: 0,
          goals: 0,
        },
      }),
    ).toBe("1 agent · 1 cmd");
    expect(
      activitySummary({
        activity: {
          workflows: 2,
          backgroundAgents: 2,
          backgroundCommands: 2,
          planMode: 0,
          goals: 2,
        },
      }),
    ).toBe("2 agents · 2 workflows · 2 cmds · 2 goals");
  });

  it("renders planning without a count", () => {
    expect(
      activitySummary({
        activity: {
          workflows: 0,
          backgroundAgents: 0,
          backgroundCommands: 0,
          planMode: 1,
          goals: 0,
        },
      }),
    ).toBe("planning");
  });
});
