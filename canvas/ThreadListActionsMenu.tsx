// The thread list's header actions menu.
//
// bb's own list puts Organize, Sort by, New section, and New project in a
// header menu. A replaced list owns presentation, so those controls have to
// live here or they are simply gone from the sidebar. This component supplies
// them.
//
// The menu writes through the host rather than keeping its own copy of the
// preference: `sidebar.organizationMode` and `sidebar.sortDirection` are
// server-backed and shared by every window, and the SDK's `uiPreferences.set`
// requires the revision it read, so it is the host that arbitrates concurrent
// writes. Local state would drift from the other windows.
//
// Deliberately NOT here: New project. The SDK exposes only
// `sdk.projects.create(args)`, which needs a full project payload (name,
// source, machine) and belongs in a dialog. bb's own menu opens such a flow; a
// menu item that half-implements it would be worse than the omission, so this
// menu offers New section only until a real create-project surface exists.
import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { usePortalScopeProps } from "@/lib/portal-scope";
import type { OrganizationMode } from "./threadGrouping";

/**
 * bb's sort fields, as the sidebar's Sort by menu offers them.
 *
 * These are the host's literal values for `sidebar.chronologicalSort` —
 * `alpha` rather than `title`, and `none` meaning "leave the list in its
 * natural order". Spelling them from the SDK schema rather than inventing
 * friendlier names is what keeps a write from being rejected at runtime.
 */
export type SortField = "none" | "created" | "updated" | "alpha";

export interface ThreadListPrefs {
  mode: OrganizationMode;
  sortField: SortField;
  sortDirection: "ascending" | "descending" | "default";
}

/**
 * The slice of the host's preference payload this menu reads.
 *
 * Typed structurally rather than by importing the SDK's own entry map, which is
 * not re-exported from the app entry point and would otherwise force a deep
 * import into SDK internals.
 */
interface PreferencesSnapshot {
  "sidebar.organizationMode": { value: string };
  "sidebar.chronologicalSort": { value: string };
  "sidebar.sortDirection": { value: string };
}

/** Narrow a raw preference set to the fields this menu understands. */
function readPrefs(preferences: PreferencesSnapshot): ThreadListPrefs {
  const mode = preferences["sidebar.organizationMode"].value;
  const sortField = preferences["sidebar.chronologicalSort"].value;
  const sortDirection = preferences["sidebar.sortDirection"].value;
  return {
    // `machine` is a current value; `chronological` is the schema's name for
    // the UI's "Custom". Anything unrecognised falls back to the default
    // rather than being written back verbatim.
    mode:
      mode === "machine" || mode === "chronological" ? mode : "project",
    sortField:
      sortField === "none" || sortField === "created" || sortField === "alpha"
        ? sortField
        : "updated",
    sortDirection:
      sortDirection === "ascending" || sortDirection === "descending"
        ? sortDirection
        : "default",
  };
}

/**
 * Read the sidebar preferences this menu edits.
 *
 * Returned as state rather than a promise because the list renders before the
 * read resolves; the defaults are the same ones bb uses on a fresh install.
 */
export function useThreadListPrefs(): ThreadListPrefs {
  const sdk = useSdk();
  const [prefs, setPrefs] = useState<ThreadListPrefs>({
    mode: "project",
    sortField: "updated",
    sortDirection: "default",
  });

  useEffect(() => {
    let cancelled = false;
    sdk.system.uiPreferences
      .list()
      .then((result) => {
        if (cancelled) return;
        setPrefs(readPrefs(result.preferences));
      })
      .catch(() => {
        // Preferences are cosmetic; keep the defaults.
      });
    return () => {
      cancelled = true;
    };
  }, [sdk]);

  return prefs;
}

const MENU_ITEM_CLASS =
  "flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";

const CONTENT_CLASS =
  "z-[400] min-w-44 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md";

function MenuRadio({
  value,
  selected,
  children,
  onSelect,
}: {
  value: string;
  selected: boolean;
  children: React.ReactNode;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.RadioItem
      className={MENU_ITEM_CLASS}
      value={value}
      // `onSelect` is the activation callback; `preventDefault` keeps the menu
      // open so the user can see the check move and pick another option without
      // reopening. The check itself comes from `selected`, which the parent
      // derives from the live preference, so the menu never shows a stale
      // choice if a write fails.
      onSelect={(event) => {
        event.preventDefault();
        onSelect();
      }}
    >
      <Icon
        name={selected ? "Check" : "Blank"}
        className={cn("size-3", !selected && "opacity-0")}
      />
      {children}
    </DropdownMenu.RadioItem>
  );
}

export interface ThreadListActionsMenuProps {
  prefs: ThreadListPrefs;
  /** Called after a preference write succeeds, so the list can re-group. */
  onChange: (next: Partial<ThreadListPrefs>) => void;
  /** Reports a failed write; the menu never silently swallows one. */
  onError: (message: string) => void;
}

/**
 * Header actions: Organize, Sort by, New section, New project.
 *
 * Every write is optimistic in the UI (the parent updates immediately) and
 * reports failure through `onError`, because a preference that silently failed
 * to save would look like the menu did nothing.
 */
export function ThreadListActionsMenu({
  prefs,
  onChange,
  onError,
}: ThreadListActionsMenuProps) {
  const sdk = useSdk();
  const portalScope = usePortalScopeProps();
  const [busy, setBusy] = useState(false);

  // `uiPreferences.set` is revision-guarded, so each write re-reads the current
  // revision first. Writing with a stale revision is rejected, and a second
  // window changing the same key is the normal case, not an edge case.
  //
  // The key union is spelled out because `set` is generic over the key and a
  // bare `string` collapses its value/revision types to `never`.
  type WritableKey =
    | "sidebar.organizationMode"
    | "sidebar.chronologicalSort"
    | "sidebar.sortDirection";

  const writePref = async (key: WritableKey, value: string) => {
    try {
      const current = await sdk.system.uiPreferences.list();
      await sdk.system.uiPreferences.set({
        key,
        value: value as never,
        expectedRevision: current.preferences[key].revision,
      });
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
      // Re-read so the menu snaps back to what was actually saved rather than
      // showing a choice that did not persist.
      const fresh = await sdk.system.uiPreferences.list().catch(() => null);
      if (fresh) onChange(readPrefs(fresh.preferences));
    }
  };

  const chooseMode = (mode: OrganizationMode) => {
    onChange({ mode });
    void writePref("sidebar.organizationMode", mode);
  };

  const chooseSort = (field: SortField) => {
    // Selecting the current field again reverses its direction, which is how
    // bb's own Sort by menu behaves. A different field starts at its default
    // direction rather than inheriting the previous field's.
    const direction =
      prefs.sortField === field
        ? prefs.sortDirection === "descending"
          ? "ascending"
          : "descending"
        : "default";
    onChange({ sortField: field, sortDirection: direction });
    void writePref("sidebar.chronologicalSort", field);
    void writePref("sidebar.sortDirection", direction);
  };

  const createSection = async () => {
    // A prompt is the honest control here: bb's own flow opens a naming dialog,
    // and inventing a default name would create sections the user did not ask
    // for. `window.prompt` is the smallest thing that does not require building
    // a whole dialog surface for one string.
    const name = window.prompt("Name the new section");
    if (name === null) return;
    const trimmed = name.trim();
    if (trimmed === "") return;
    setBusy(true);
    try {
      await sdk.threadSections.create({ name: trimmed });
      onError("");
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Thread list actions"
          title="Thread list actions"
        >
          <Icon name="MoreHorizontal" className="size-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...portalScope}
          className={CONTENT_CLASS}
          align="end"
          sideOffset={4}
        >
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={MENU_ITEM_CLASS}>
              <Icon name="ListTree" className="size-3" />
              <span className="flex-1">Organize</span>
              <Icon name="ChevronRight" className="size-3" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent {...portalScope} className={CONTENT_CLASS}>
                <DropdownMenu.RadioGroup value={prefs.mode}>
                  <MenuRadio
                    value="project"
                    selected={prefs.mode === "project"}
                    onSelect={() => chooseMode("project")}
                  >
                    By project
                  </MenuRadio>
                  <MenuRadio
                    value="machine"
                    selected={prefs.mode === "machine"}
                    onSelect={() => chooseMode("machine")}
                  >
                    By machine
                  </MenuRadio>
                  <MenuRadio
                    value="chronological"
                    selected={prefs.mode === "chronological"}
                    onSelect={() => chooseMode("chronological")}
                  >
                    Custom
                  </MenuRadio>
                </DropdownMenu.RadioGroup>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>

          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className={MENU_ITEM_CLASS}>
              <Icon name="ArrowUpDown" className="size-3" />
              <span className="flex-1">Sort by</span>
              <Icon name="ChevronRight" className="size-3" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent {...portalScope} className={CONTENT_CLASS}>
                <DropdownMenu.RadioGroup value={prefs.sortField}>
                  <MenuRadio
                    value="updated"
                    selected={prefs.sortField === "updated"}
                    onSelect={() => chooseSort("updated")}
                  >
                    Last activity
                    {prefs.sortField === "updated" && prefs.sortDirection !== "default"
                      ? ` (${prefs.sortDirection})`
                      : ""}
                  </MenuRadio>
                  <MenuRadio
                    value="created"
                    selected={prefs.sortField === "created"}
                    onSelect={() => chooseSort("created")}
                  >
                    Created
                    {prefs.sortField === "created" && prefs.sortDirection !== "default"
                      ? ` (${prefs.sortDirection})`
                      : ""}
                  </MenuRadio>
                  <MenuRadio
                    value="alpha"
                    selected={prefs.sortField === "alpha"}
                    onSelect={() => chooseSort("alpha")}
                  >
                    Title
                    {prefs.sortField === "alpha" && prefs.sortDirection !== "default"
                      ? ` (${prefs.sortDirection})`
                      : ""}
                  </MenuRadio>
                </DropdownMenu.RadioGroup>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>

          <DropdownMenu.Separator className="my-1 h-px bg-border" />

          <DropdownMenu.Item
            className={MENU_ITEM_CLASS}
            disabled={busy}
            onSelect={(event) => {
              event.preventDefault();
              void createSection();
            }}
          >
            <Icon name="FolderPlus" className="size-3" />
            New section…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
