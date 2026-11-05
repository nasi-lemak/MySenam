/**
 * How firmly a restriction holds: one vocabulary for the venue's own windows, its required supervision and qualifications, and the
 * closures that keep people safe (ADR 0046; docs/features/booking.md#advisory-and-hard-windows).
 *
 * - `advisory`: the venue's own judgement. A launch or tide window the venue left at its default, and a role's recommended
 *   qualification. An authorised manager may go past an advisory window for one booking, with a reason that is kept; a recommended
 *   qualification never stops anybody being rostered, and its absence is only flagged.
 * - `venue_required`: the venue says it must hold (a role's qualification the venue requires). It counts only where it is recorded.
 *   No override at the counter goes past it; a manager may let one session stand without cover, with a reason (ADR 0036).
 * - `hard`: a safety closure, a legal restriction, a change of the clocks, a window the venue marked hard, a qualification the venue
 *   declares legally required. No ordinary override goes past it. The app records the claim and the reference the venue gave for a
 *   legal one; it never judges lawfulness.
 *
 * Nothing here is a booking path: the paths ask `managerMayGoPast`, and the table below is what the documentation and a test hold them to.
 */

export const STRENGTHS = ["advisory", "venue_required", "hard"] as const;
export type Strength = (typeof STRENGTHS)[number];

/** A role's qualification: how firmly the venue requires it (`roster_roles.qualification_level`). */
export const QUALIFICATION_LEVELS = ["recommended", "venue_required", "legally_required"] as const;
export type QualificationLevel = (typeof QUALIFICATION_LEVELS)[number];

export const isQualificationLevel = (v: unknown): v is QualificationLevel => typeof v === "string" && (QUALIFICATION_LEVELS as readonly string[]).includes(v);

/** The strength a qualification level is. */
export function strengthOfLevel(level: QualificationLevel): Strength {
  return level === "recommended" ? "advisory" : level === "venue_required" ? "venue_required" : "hard";
}

/** Does a missing qualification at this level stop somebody counting as cover? Only a required one does. */
export const levelBlocks = (level: QualificationLevel): boolean => level !== "recommended";

/** May a manager's override of a window, from the counter, go past a restriction of this strength? Only an advisory one. */
export const managerMayGoPast = (strength: Strength): boolean => strength === "advisory";

/** The refusals of a launch or tide window (lib/launch-day.ts `launchRefusal`, lib/store.ts), the only ones this override reaches. */
export const WINDOW_CODES = ["LAUNCH_WINDOW", "LAUNCH_RETURN", "LAUNCH_CLOSED", "TIDE_NO_DATA", "LAUNCH_WEEK"] as const;
export type WindowCode = (typeof WINDOW_CODES)[number];
export const isWindowCode = (v: unknown): v is WindowCode => typeof v === "string" && (WINDOW_CODES as readonly string[]).includes(v);

/**
 * Every restriction on a booking and how firmly it holds, which the documentation shows as a table and a test holds the code to.
 * `override` says what a manager's window override (this ADR) does with it: `reason` goes past it with a recorded reason (when the
 * rule is advisory), `never` is not touched by it. Other, older overrides (a court's booking rules, a venue's policies) are as they were.
 */
export const RESTRICTIONS: { key: string; strength: Strength | "by_rule"; codes: readonly string[]; override: "reason" | "never" }[] = [
  { key: "launch_window_advisory", strength: "advisory", codes: WINDOW_CODES, override: "reason" },
  { key: "launch_window_hard", strength: "hard", codes: WINDOW_CODES, override: "never" },
  { key: "clock_change", strength: "hard", codes: ["CLOCK_CHANGE"], override: "never" },
  // A closure, outage, block or rain-out holds the court's time in the database (lib/claims.ts): nothing overrides it, marked a safety closure or not.
  { key: "safety_closure", strength: "hard", codes: [], override: "never" },
  { key: "other_closure", strength: "venue_required", codes: ["VENUE_CLOSED"], override: "never" },
  { key: "supervision_required", strength: "venue_required", codes: ["SV1_NO_SUPERVISOR", "SV1_NO_SUPERVISOR_ON"], override: "never" },
  { key: "supervision_legal", strength: "hard", codes: ["SV1_NO_SUPERVISOR", "SV1_NO_SUPERVISOR_ON"], override: "never" },
];

/**
 * The strength of a refusal a manager is told about at the counter: `advisory` or `hard` for a window (by the rule that made it),
 * `hard` for the clocks changing, `venue_required` for the roster; null for anything this vocabulary does not classify (the venue's
 * policies of ADR 0026 keep their own overrides).
 */
export function strengthOfCode(code: string | undefined, windowStrength?: "advisory" | "hard" | null): Strength | null {
  if (!code) return null;
  if (isWindowCode(code)) return windowStrength === "hard" ? "hard" : "advisory";
  if (code === "CLOCK_CHANGE") return "hard";
  if (code === "SV1_NO_SUPERVISOR" || code === "SV1_NO_SUPERVISOR_ON") return "venue_required";
  return null;
}
