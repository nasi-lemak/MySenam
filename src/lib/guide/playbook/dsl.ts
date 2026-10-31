import { staffMay, type StaffActionName, type StaffRole } from "../../roles";
import type { DashboardTab, GuideRole } from "../shell";
import type { Block, CalloutKind, Fact, GuideLink, ModuleContext, PhraseKey, Step, Value, Words } from "./types";

/**
 * The small vocabulary modules and topics are written in: a phrase and its
 * values, and the blocks made of them. Browser-safe, no state.
 */

export type Vars = Record<string, Value>;

/** A phrase and its values. */
export const w = (key: PhraseKey, vars?: Vars): Words => (vars ? { key, vars } : { key });

export const para = (key: PhraseKey, vars?: Vars): Block => ({ type: "paragraph", text: w(key, vars) });
export const heading = (key: PhraseKey, id?: string, level: 3 | 4 = 3, vars?: Vars): Block => ({ type: "heading", level, text: w(key, vars), ...(id ? { id } : {}) });
export const callout = (kind: CalloutKind, key: PhraseKey, vars?: Vars): Block => ({ type: "callout", kind, text: w(key, vars) });
export const note = (key: PhraseKey, vars?: Vars): Block => callout("note", key, vars);
export const warning = (key: PhraseKey, vars?: Vars): Block => callout("warning", key, vars);
export const policy = (key: PhraseKey, vars?: Vars): Block => callout("policy", key, vars);

/** One step: its words, and the screen that does it where this role may open it. */
export const step = (key: PhraseKey, vars?: Vars, link?: GuideLink): Step => ({ text: w(key, vars), ...(link ? { link } : {}) });

/** Ordered steps; a `false`/`null` entry (a step that does not apply) is left out. */
export const steps = (...items: (Step | null | false | undefined)[]): Block => ({ type: "steps", items: items.filter((s): s is Step => !!s) });

export const fact = (label: PhraseKey, value: PhraseKey, vars?: Vars, link?: GuideLink): Fact => ({ label: w(label), value: w(value, vars), ...(link ? { link } : {}) });
export const facts = (...items: (Fact | null | false | undefined)[]): Block => ({ type: "facts", items: items.filter((f): f is Fact => !!f) });

export const table = (head: PhraseKey[], rows: (Words | PhraseKey)[][]): Block => ({
  type: "table",
  head: head.map((k) => w(k)),
  rows: rows.map((r) => r.map((c) => (typeof c === "string" ? w(c) : c))),
});

/** A word that is a value, not a phrase: what the venue typed, a count. */
export const count = (n: number): Value => n;

/** The dashboard's name for a screen, as its tab says it (a staff-dictionary phrase). */
export const SCREEN_PHRASE: Record<DashboardTab, PhraseKey> = {
  bookings: "sh.tab.bookings",
  schedule: "sh.tab.schedule",
  occupancy: "sh.tab.occupancy",
  reports: "sh.tab.reports",
  courts: "sh.tab.courts",
  classes: "sh.tab.classes",
  tournaments: "sh.tab.tournaments",
  leagues: "sh.tab.leagues",
  credit: "sh.tab.credit",
  venues: "sh.tab.venueDetails",
  guide: "gd.tab",
};

export const screen = (tab: DashboardTab): Words => w(SCREEN_PHRASE[tab]);

/**
 * The tabs a front-desk account has, and may open without a manager's
 * action (src/app/admin/page.tsx hides Reports from it; Courts & rates and
 * Venue details it only reads). A desk guide links only to these, and only
 * where `staffMay` agrees with the action the link names.
 */
export const DESK_TABS: readonly DashboardTab[] = ["bookings", "schedule", "occupancy", "classes", "tournaments", "leagues", "credit", "guide"];

/**
 * Whether a role may be shown a link: a coach has no dashboard; the front
 * desk only its own tabs and only actions `MANAGER_ONLY` lets it make; a
 * manager what `staffMay` allows (everything). The one rule every link in
 * every guide passes through, held to the real rules by
 * tests/guide-playbook-roles.test.ts.
 */
export function linkAllowed(role: GuideRole, tab: DashboardTab, action?: StaffActionName): boolean {
  if (role === "coach") return false;
  const staff: StaffRole = role === "desk" ? "desk" : "manager";
  if (staff === "desk" && !DESK_TABS.includes(tab)) return false;
  return action === undefined || staffMay(staff)[action];
}

/** The link to a screen for a role, or undefined where the role may not use it. */
export function linkFor(role: GuideRole, tab: DashboardTab, action?: StaffActionName, view?: string): GuideLink | undefined {
  if (!linkAllowed(role, tab, action)) return undefined;
  return { tab, ...(view ? { view } : {}), label: w("gp.link.open", { screen: screen(tab) }), ...(action ? { staffAction: action } : {}) };
}

export const goFor =
  (role: GuideRole): ModuleContext["go"] =>
  (tab, action, view) =>
    linkFor(role, tab, action, view);

/** Whether a value is a nested phrase. */
export const isWords = (v: Value): v is Words => typeof v === "object" && v !== null && "key" in v;
