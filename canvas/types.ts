// Thread presentation helpers.
//
// These map a sidebar thread onto the small vocabulary the canvas UI needs: a
// presence dot, a short status phrase, and a "needs you" signal. They read only
// fields the host already resolved, so the canvas never re-derives state bb
// owns. `needsAttention` deliberately mirrors bb's own notion so the window
// emphasis and the launcher badge agree with the rest of the app.
//
// The unions below are the host's real values (see PluginSidebarThreadIndicator
// and ThreadRuntimeDisplayStatus in the SDK declarations). They are spelled out
// rather than guessed: an earlier version compared against "error"/"success"
// and "offline", which never matched, so the "needs you" badge and presence dot
// were silently always off.
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

export type Presence = "needs" | "busy" | "idle" | "error" | "unavailable";

/** Threads whose agent is running work right now. */
const BUSY_STATUSES: ReadonlySet<string> = new Set([
  "starting",
  "active",
  "stopping",
  "pending",
]);

/** Runtime states that mean the machine is not ready, so the agent cannot run. */
const UNAVAILABLE_STATUSES: ReadonlySet<string> = new Set([
  "host-reconnecting",
  "waiting-for-host",
  "provisioning",
]);

/** Indicators that mean the user is being asked for something. */
const ATTENTION_INDICATORS: ReadonlySet<string> = new Set([
  "waiting-for-input",
  "unread-error",
  "unread-success",
]);

/** True when the thread's agent is mid-turn. */
export function isBusy(thread: PluginSidebarThread): boolean {
  return BUSY_STATUSES.has(thread.status) || thread.queuedWork === "waiting";
}

/**
 * Does this thread want the user? Blocked on input, a pending interaction, or
 * an unread terminal event. This is the same condition the host uses for its
 * "needs you" indicator, so the canvas never disagrees with the sidebar.
 */
export function needsAttention(thread: PluginSidebarThread): boolean {
  if (thread.hasPendingInteraction) return true;
  return thread.isUnread && ATTENTION_INDICATORS.has(thread.indicator);
}

export function threadPresence(thread: PluginSidebarThread): Presence {
  if (needsAttention(thread)) return "needs";
  if (thread.runtimeStatus === "error") return "error";
  if (UNAVAILABLE_STATUSES.has(thread.runtimeStatus)) return "unavailable";
  if (isBusy(thread)) return "busy";
  return "idle";
}

/** A one-word status for the window header. */
export function presenceText(presence: Presence): string {
  switch (presence) {
    case "needs":
      return "Needs you";
    case "busy":
      return "Working";
    case "error":
      return "Failed";
    case "unavailable":
      return "Unavailable";
    default:
      return "Idle";
  }
}

/**
 * The thread's secondary line: what the agent is doing, or a short reminder of
 * where it lives. Deliberately terse — the window has the real chat below.
 */
export function presenceLabel(thread: PluginSidebarThread): string {
  if (thread.hasPendingInteraction) return "waiting for your answer";
  if (thread.queuedWork === "waiting") return "message queued";
  if (thread.queuedWork === "failed") return "queued send failed";
  if (thread.indicator === "unread-error") return "last run failed";
  if (isBusy(thread)) return "running";
  const branch = thread.environment?.branchName;
  if (branch) return branch;
  const host = thread.host?.name;
  if (host) return host;
  return "no environment";
}

/** The title to draw, falling back the way bb's own rows do. */
export function threadName(thread: PluginSidebarThread): string {
  return thread.title ?? thread.titleFallback ?? "Untitled thread";
}

/**
 * True when the agent is blocked on the user: an approval or a question.
 *
 * Narrower than {@link needsAttention}, which also fires on an unread terminal
 * event. The launcher uses this for the "waiting for input" wording, and
 * `indicatorLabel` for everything else, so the two never disagree about *why*
 * a thread wants the user.
 */
export function isWaitingForInput(thread: PluginSidebarThread): boolean {
  return thread.indicator === "waiting-for-input" || thread.hasPendingInteraction;
}

/**
 * Relative "last activity" text for a launcher row, e.g. "3m ago". Kept terse
 * because rows are narrow. A bad timestamp (missing, zero, NaN, negative)
 * yields an empty string rather than "Invalid Date" or "-1m ago", so the
 * caller can drop the segment entirely.
 *
 * `now` is injectable so the buckets are testable without freezing the clock.
 */
export function relativeTime(timestamp: number, now = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/**
 * A compact "what is running" summary, or null when nothing is running.
 *
 * Feeds the row's accessible name only — the visual row stays a dot and a
 * title, because a row that paints five counters is the unreadable dense row
 * this design deliberately replaced.
 */
export function activitySummary(thread: PluginSidebarThread): string | null {
  const a = thread.activity;
  const parts: string[] = [];
  if (a.backgroundAgents > 0) {
    parts.push(`${a.backgroundAgents} agent${a.backgroundAgents === 1 ? "" : "s"}`);
  }
  if (a.workflows > 0) {
    parts.push(`${a.workflows} workflow${a.workflows === 1 ? "" : "s"}`);
  }
  if (a.backgroundCommands > 0) {
    parts.push(`${a.backgroundCommands} cmd${a.backgroundCommands === 1 ? "" : "s"}`);
  }
  // These two have no natural plural: "planning" and "1 goal"/"2 goals".
  if (a.planMode > 0) parts.push("planning");
  if (a.goals > 0) parts.push(`${a.goals} goal${a.goals === 1 ? "" : "s"}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
