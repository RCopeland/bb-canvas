import { describe, expect, it } from "vitest";
import { groupThreads, orderThreads } from "../canvas/threadGrouping";

// Grouping decides what the sidebar shows and where. The failure modes that
// matter are a thread appearing twice (pinned AND in its project) and a thread
// disappearing (a section or project that is not in the list).

/** Minimal thread stub carrying only the fields grouping reads. */
function thread(
  id: string,
  overrides: Partial<{
    isPinned: boolean;
    sectionId: string | null;
    projectId: string;
    hostId: string | null;
    updatedAt: number;
  }> = {},
) {
  return {
    id,
    isPinned: overrides.isPinned ?? false,
    sectionId: overrides.sectionId ?? null,
    projectId: overrides.projectId ?? "p1",
    host: overrides.hostId ? { id: overrides.hostId, name: overrides.hostId } : null,
    updatedAt: overrides.updatedAt ?? 0,
  } as never;
}

function project(id: string, name: string) {
  return { id, name } as never;
}

function section(id: string, name: string) {
  return { id, name, createdAt: 0, updatedAt: 0 } as never;
}

const P1 = project("p1", "Alpha");
const P2 = project("p2", "Beta");

describe("orderThreads", () => {
  it("puts attention threads first, then newest", () => {
    const threads = [
      thread("old", { updatedAt: 100 }),
      thread("new", { updatedAt: 300 }),
      thread("needs", { updatedAt: 1 }),
    ];
    const ordered = orderThreads(threads, (t) => (t as never as { id: string }).id === "needs");
    expect(ordered.map((t) => (t as never as { id: string }).id)).toEqual([
      "needs",
      "new",
      "old",
    ]);
  });
});

describe("groupThreads", () => {
  it("separates pinned threads from their project group", () => {
    const result = groupThreads(
      [thread("a"), thread("b", { isPinned: true })],
      [P1],
      [],
      "project",
    );
    expect(result.pinned.map((t) => (t as never as { id: string }).id)).toEqual(["b"]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].threads.map((t) => (t as never as { id: string }).id)).toEqual([
      "a",
    ]);
  });

  it("never duplicates a thread across pinned and groups", () => {
    const result = groupThreads(
      [thread("a", { isPinned: true }), thread("b")],
      [P1],
      [],
      "project",
    );
    const all = [
      ...result.pinned,
      ...result.groups.flatMap((g) => g.threads),
      ...result.sections.flatMap((s) => s.threads),
    ].map((t) => (t as never as { id: string }).id);
    expect(all).toHaveLength(2);
    expect(new Set(all).size).toBe(2);
  });

  it("files a sectioned thread under its section, not its project", () => {
    const result = groupThreads(
      [thread("a", { sectionId: "s1" }), thread("b")],
      [P1],
      [section("s1", "Later")],
      "project",
    );
    expect(result.sections.map((s) => s.section.name)).toEqual(["Later"]);
    expect(
      result.sections[0].threads.map((t) => (t as never as { id: string }).id),
    ).toEqual(["a"]);
    expect(result.groups[0].threads.map((t) => (t as never as { id: string }).id)).toEqual([
      "b",
    ]);
  });

  it("treats a missing section as loose rather than dropping the thread", () => {
    const result = groupThreads(
      [thread("a", { sectionId: "gone" })],
      [P1],
      [],
      "project",
    );
    expect(result.sections).toEqual([]);
    expect(result.groups[0].threads.map((t) => (t as never as { id: string }).id)).toEqual([
      "a",
    ]);
  });

  it("omits empty sections so a deleted section leaves no bare heading", () => {
    const result = groupThreads([thread("a")], [P1], [section("s1", "Empty")], "project");
    expect(result.sections).toEqual([]);
  });

  it("groups by project and sorts the headings", () => {
    const result = groupThreads(
      [thread("a", { projectId: "p2" }), thread("b", { projectId: "p1" })],
      [P1, P2],
      [],
      "project",
    );
    expect(result.groups.map((g) => g.label)).toEqual(["Alpha", "Beta"]);
  });

  it("keeps a thread whose project is unknown, under its own group", () => {
    const result = groupThreads([thread("a", { projectId: "ghost" })], [P1], [], "project");
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].label).toBe("Unknown project");
    expect(result.groups[0].threads).toHaveLength(1);
  });

  it("groups by machine, including threads with no machine", () => {
    const result = groupThreads(
      [thread("a", { hostId: "h1" }), thread("b")],
      [P1],
      [],
      "machine",
      [{ id: "h1", name: "box-one" }],
    );
    expect(result.groups.map((g) => g.label)).toEqual(["box-one", "No machine"]);
  });

  it("returns one ungrouped bucket in custom mode", () => {
    const result = groupThreads(
      [thread("a", { projectId: "p1" }), thread("b", { projectId: "p2" })],
      [P1, P2],
      [],
      "chronological",
    );
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].key).toBe("all");
    expect(result.groups[0].threads).toHaveLength(2);
  });

  it("returns no groups for an empty list", () => {
    const result = groupThreads([], [P1], [], "project");
    expect(result.pinned).toEqual([]);
    expect(result.sections).toEqual([]);
    expect(result.groups).toEqual([]);
  });
});
