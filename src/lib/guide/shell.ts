/**
 * Where the guide sits in the dashboard, and whose version of it is whose.
 * Browser-safe: no database, only data (docs/features/venue-guide.md#interfaces).
 */

/**
 * The dashboard's tabs, in the order it shows them. `src/app/admin/page.tsx`
 * keeps the same list for the address (`?tab=`); `tests/guide-shell.test.ts`
 * holds the two together, so a capability's `configure.tab` can never name a
 * screen that is not there.
 */
export const DASHBOARD_TABS = [
  "bookings",
  "schedule",
  "occupancy",
  "reports",
  "courts",
  "classes",
  "tournaments",
  "leagues",
  "credit",
  "venues",
  "guide",
] as const;
export type DashboardTab = (typeof DASHBOARD_TABS)[number];

/** The guide's views, in the address as `?tab=guide&view=setup`. */
export const GUIDE_VIEWS = ["setup", "playbook", "discover"] as const;
export type GuideView = (typeof GUIDE_VIEWS)[number];

/** Where an existing screen is: a tab, and on some a part of it. */
export interface ConfigureTarget {
  tab: DashboardTab;
  /** A part of the tab, where one is addressable; the tab alone otherwise. */
  view?: string;
}

/**
 * Whose guide it is. A role is what a person may do, not who they are:
 * `manager` (an owner, a business manager or a branch manager), `desk` (front
 * desk) and `coach` (a coach working from their own link; no dashboard
 * account, so only ever *previewed* by staff, never the session's own).
 * To add a role: add it here, in `GUIDE_ROLE_RANK`, and give the playbook
 * modules that are for it (docs/features/venue-guide.md#adding-a-role).
 */
export const GUIDE_ROLES = ["manager", "desk", "coach"] as const;
export type GuideRole = (typeof GUIDE_ROLES)[number];

/** Higher sees more: a role may be previewed by itself and by any role above it, never below. */
export const GUIDE_ROLE_RANK: Record<GuideRole, number> = { coach: 1, desk: 2, manager: 3 };

export const isGuideRole = (v: unknown): v is GuideRole => typeof v === "string" && (GUIDE_ROLES as readonly string[]).includes(v);

/**
 * May somebody whose own role is `own` ask for the guide written for `asked`?
 * Only for a role at or below their own (a manager preparing training for
 * the desk); never above. The server decides the role a guide is *for*
 * from the session and uses this for the preview, never trusting a parameter
 * alone.
 */
export function mayViewAs(own: GuideRole, asked: GuideRole): boolean {
  return GUIDE_ROLE_RANK[asked] <= GUIDE_ROLE_RANK[own];
}
