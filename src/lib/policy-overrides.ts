import { getDb } from "./db";
import { errorText, translator, type ErrorCode } from "./i18n";
import type { Refusal } from "./types";

/**
 * A manager's override of one of the venue's booking policies, for one
 * booking at the counter (ADR 0026; docs/features/booking.md#manager-overrides).
 *
 * Customer, counter and API bookings are held to the same venue policies
 * (lib/limits.ts `policyCheck`, the owner's decision of 28 October 2026). A
 * venue may let its managers go past some operational restrictions for one
 * booking: each is off until a manager turns it on for the venue
 * (`venue_override_permissions`, migration 0208), the request names the
 * policy and gives a reason, and the server checks again that the refusal is
 * one of these, that the venue permits it and that the member of staff is a
 * manager of that venue. Front desk never overrides; a venue's API key never
 * does. What was overridden is written with the booking, in its transaction
 * (`booking_policy_overrides`, migration 0209), and in the activity log.
 *
 * Only these, and only the refusals each answers for:
 * - `house_rules`: the house rules' limits on bookings at once, a week and a
 *   day (`LIMIT_UPCOMING`, `LIMIT_WEEK`, `LIMIT_DAY`). How far ahead may be
 *   booked is not one of them.
 * - `strikes`: too many no-shows and late cancellations (`STRIKES_COUNTER`).
 * - `guest_surge`: the limit on online bookings without an account (once
 *   called the guest limit: these are no member's guests), a flood of unpaid
 *   ones in the last hour (`GUEST_SURGE`).
 * - `assisted`: a weekly booking for a customer without an account
 *   (`SERIES_NEEDS_ACCOUNT`), booked for them by staff; everybody on it must
 *   still be eligible.
 * - `guest_allowance`: a member's or resident's guest allowance, where staff
 *   register the person booked as their guest (lib/guest-invites.ts
 *   `registerGuest`): the guests each may have on the list at once
 *   (`GC8_GUEST_ALLOWANCE`, `GC8_GUESTS_OFF` where it is none) and how long a guest's visit may run
 *   (`GC8_GUEST_DAYS`). The host must still be on the list, and the guest
 *   must not be on it in their own right or as somebody else's guest.
 *
 * Never: a refused number (taking it off the venue's refused list is the
 * workflow), the unpaid-bookings limit (taking payment for one, or
 * cancelling one, is), eligibility for a members-only or private venue or a
 * members' place, the venue being open, the booking window, waivers and
 * other safety prerequisites, capacity, availability and linked resources
 * (the database's), tenant isolation and payment.
 */
export const OVERRIDABLE = ["house_rules", "strikes", "guest_surge", "assisted", "guest_allowance"] as const;
export type OverridePolicy = (typeof OVERRIDABLE)[number];

/** The refusals each overridable policy answers for: no other refusal is ever let through. */
export const POLICY_REFUSALS: Record<OverridePolicy, readonly ErrorCode[]> = {
  house_rules: ["LIMIT_UPCOMING", "LIMIT_WEEK", "LIMIT_DAY"],
  strikes: ["STRIKES_COUNTER"],
  guest_surge: ["GUEST_SURGE"],
  assisted: ["SERIES_NEEDS_ACCOUNT"],
  guest_allowance: ["GC8_GUEST_ALLOWANCE", "GC8_GUESTS_OFF", "GC8_GUEST_DAYS"],
};

/** The overridable policy a refusal (by its policy code, lib/limits.ts) belongs to, or null: never overridable. */
export function overridablePolicy(code: string | undefined): OverridePolicy | null {
  if (!code) return null;
  for (const p of OVERRIDABLE) if ((POLICY_REFUSALS[p] as readonly string[]).includes(code)) return p;
  return null;
}

export const isOverridePolicy = (v: unknown): v is OverridePolicy => typeof v === "string" && (OVERRIDABLE as readonly string[]).includes(v);

/** A reason is required: a few words, and no essay. */
export const REASON_MIN = 5;
export const REASON_MAX = 300;

const ENGLISH = translator("en");
function refuse(code: ErrorCode, vars?: Record<string, string | number>): Refusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, ...(vars ? { vars } : {}) };
}

/** A refusal about overriding or paying at the counter, in English under its code. */
export function policyRefusal(code: ErrorCode, vars?: Record<string, string | number>): Refusal {
  return refuse(code, vars);
}

/** What a request asks to override, read from its body: none asked, or the policies and the reason, or why not. */
export type OverrideAsk = { policies: OverridePolicy[]; reason: string };

/**
 * `overridePolicies` (a list of policy names) and `overrideReason` from a
 * request's body. Null where neither is there. A refusal for anything not
 * overridable at all, or a reason missing, too short or too long.
 */
export function readOverride(body: Record<string, unknown>): OverrideAsk | Refusal | null {
  const { overridePolicies, overrideReason } = body;
  if ((overridePolicies === undefined || overridePolicies === null) && (overrideReason === undefined || overrideReason === null)) return null;
  if (!Array.isArray(overridePolicies) || overridePolicies.length === 0 || overridePolicies.length > OVERRIDABLE.length)
    return refuse("R9_OVERRIDE_NOT_OVERRIDABLE");
  if (!overridePolicies.every(isOverridePolicy)) return refuse("R9_OVERRIDE_NOT_OVERRIDABLE");
  const reason = typeof overrideReason === "string" ? overrideReason.trim() : "";
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) return refuse("R9_OVERRIDE_REASON", { max: REASON_MAX });
  return { policies: [...new Set(overridePolicies)], reason };
}

/** Does this body carry anything only a manager at the counter may send (an override, or a payment taken there)? */
export function asksStaffPowers(body: Record<string, unknown>): boolean {
  return ["overridePolicies", "overrideReason", "paidAtCounter"].some((k) => body[k] !== undefined && body[k] !== null);
}

/** The policies this venue's managers may override; none until a manager turns one on. */
export async function venueOverrides(venueId: number): Promise<OverridePolicy[]> {
  const rows = (await getDb()
    .prepare("SELECT policy FROM venue_override_permissions WHERE venue_id = ? ORDER BY policy")
    .all(venueId)) as { policy: string }[];
  return rows.map((r) => r.policy).filter(isOverridePolicy);
}

/** Set which policies the venue's managers may override (a manager's setting; app/api/admin/policy-overrides). */
export async function setVenueOverrides(
  venueId: number,
  policies: unknown,
  adminId: number
): Promise<{ ok: true; policies: OverridePolicy[]; before: OverridePolicy[] } | Refusal> {
  if (!Array.isArray(policies) || !policies.every(isOverridePolicy)) return refuse("R9_OVERRIDE_NOT_OVERRIDABLE");
  const wanted = [...new Set(policies as OverridePolicy[])];
  const before = await venueOverrides(venueId);
  const db = getDb();
  for (const p of before.filter((p) => !wanted.includes(p)))
    await db.prepare("DELETE FROM venue_override_permissions WHERE venue_id = ? AND policy = ?").run(venueId, p);
  for (const p of wanted.filter((p) => !before.includes(p)))
    await db
      .prepare("INSERT INTO venue_override_permissions (venue_id, policy, granted_by) VALUES (?, ?, ?) ON CONFLICT (venue_id, policy) DO NOTHING")
      .run(venueId, p, adminId);
  return { ok: true, policies: await venueOverrides(venueId), before };
}

/** Who is asking to override, as the booking routes know them. */
export interface OverridingStaff {
  id: number;
  name: string;
  role: "manager" | "desk";
}

/**
 * May this member of staff override these policies at this venue? A manager
 * of the venue (the caller has checked the venue is theirs), where the venue
 * permits each one. Front desk never (403, as every manager's power answers
 * them, lib/roles.ts).
 */
export async function overrideRefusal(staff: OverridingStaff | null, venueId: number, ask: OverrideAsk): Promise<{ refusal: Refusal; status: number } | null> {
  if (!staff || staff.role === "desk") return { refusal: refuse("R9_OVERRIDE_MANAGERS"), status: 403 };
  const permitted = await venueOverrides(venueId);
  const not = ask.policies.find((p) => !permitted.includes(p));
  if (not) return { refusal: refuse("R9_OVERRIDE_NOT_PERMITTED"), status: 403 };
  return null;
}

/** A refusal gone past for a booking: its policy and the refusal it answered. */
export interface OverriddenPolicy {
  policy: OverridePolicy;
  code: string;
}

/** What the booking engine writes with each booking an override let through (lib/store.ts createBookingSeries). */
export interface PolicyOverrideRecord {
  venueId: number;
  adminId: number;
  adminName: string;
  reason: string;
  overridden: OverriddenPolicy[];
}

/** Written with the booking, inside its transaction: one row per policy gone past. */
export async function recordOverrides(bookingId: number, record: PolicyOverrideRecord): Promise<void> {
  const db = getDb();
  for (const o of record.overridden)
    await db
      .prepare(
        `INSERT INTO booking_policy_overrides (venue_id, booking_id, policy, refusal_code, reason, admin_id, admin_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(record.venueId, bookingId, o.policy, o.code, record.reason, record.adminId, record.adminName);
}

export interface BookingOverride {
  policy: OverridePolicy;
  code: string;
  reason: string;
  adminName: string;
  createdAt: string;
}

/** The overrides on these bookings, for the staff dashboard. */
export async function overridesFor(bookingIds: number[]): Promise<Map<number, BookingOverride[]>> {
  const out = new Map<number, BookingOverride[]>();
  if (bookingIds.length === 0) return out;
  const rows = (await getDb()
    .prepare(
      `SELECT booking_id, policy, refusal_code, reason, admin_name, created_at FROM booking_policy_overrides
        WHERE booking_id IN (${bookingIds.map(() => "?").join(",")}) ORDER BY id`
    )
    .all(...bookingIds)) as { booking_id: number; policy: string; refusal_code: string; reason: string; admin_name: string; created_at: unknown }[];
  for (const r of rows) {
    if (!isOverridePolicy(r.policy)) continue;
    out.set(r.booking_id, [
      ...(out.get(r.booking_id) ?? []),
      {
        policy: r.policy,
        code: r.refusal_code,
        reason: r.reason,
        adminName: r.admin_name,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      },
    ]);
  }
  return out;
}

/** The policies' names, as the activity log says them (English, as it is stored). */
export const POLICY_NAMES: Record<OverridePolicy, string> = {
  house_rules: "the house rules",
  strikes: "no-show strikes",
  guest_surge: "the limit on online bookings without an account",
  assisted: "an assisted booking (a weekly booking without an account)",
  guest_allowance: "a member's or resident's guest allowance",
};
