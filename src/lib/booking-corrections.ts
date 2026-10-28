import { logAction } from "./activity";
import { logOverride } from "./counter-policy";
import { getDb, withTransaction } from "./db";
import { policyCheck } from "./limits";
import { venueIsOpen } from "./listing";
import { phoneKey } from "./phone";
import { ANONYMOUS } from "./privacy";
import { recordOverrides, type OverrideAsk, type OverriddenPolicy } from "./policy-overrides";
import type { StaffRole } from "./roles";
import { todayISO } from "./time";
import type { Refusal } from "./types";
import { findBookingByCode, getCourt, venueHours } from "./store";

/**
 * Staff correcting a booking's name, phone number or email (X1-3;
 * docs/features/venue-operations.md#correcting-a-bookings-details): a
 * mistyped number at the counter, a name spelt wrong. The booking, or the
 * weeks of its series, or the courts of its group, that still carry the
 * details being corrected.
 *
 * A new number is asked what a counter booking on it would be (lib/limits.ts
 * `policyCheck`, ADR 0026): who may book a members-only or private venue, the
 * house rules, the guest limit, a blocked number, no-show strikes and the
 * unpaid-bookings limit, for its dates still to come; paid bookings count as
 * paid at the counter. A refusal is said as the counter says it, and a
 * manager may override what the venue lets them, recorded as for a booking.
 * A name or email alone asks nothing.
 *
 * It is a correction of the record, not a change of customer: the account
 * the booking was made from, its payments and its receipts already issued
 * stay as they are. A booking whose customer was erased is not given details
 * back. The activity log keeps the name before and after, as it already
 * names customers, and only the last four digits of a number, as it does
 * elsewhere.
 */

export type CorrectionScope = "booking" | "series" | "group";

export interface CorrectionInput {
  code: string;
  name?: string;
  phone?: string;
  email?: string | null;
  scope?: CorrectionScope;
  staff: { id: number; name: string; role: StaffRole };
  /** A manager's override of the venue's policies for the new number, already authorised by the route. */
  override?: OverrideAsk;
}

export type CorrectionResult =
  | { ok: true; codes: string[]; changed: { name: boolean; phone: boolean; email: boolean }; overridden: OverriddenPolicy[]; venueId: number }
  | (Refusal & { policyRefusal?: true; venueId?: number });

/** Refusals, in English as sent; staff screens say them in their language (lib/staff-i18n/refusals-2.ts). */
export const CORRECTION_REFUSALS = {
  notFound: "Booking not found.",
  cancelled: "This booking is cancelled: there is nothing to correct.",
  erased: "This booking's customer asked to be forgotten: their details cannot be put back on it.",
  nothing: "Nothing to correct: give a new name, phone number or email.",
  name: "Please provide the customer's name.",
  phone: "Please provide a valid phone number.",
  email: "Please provide a valid email address.",
  noSeries: "This booking is not part of a weekly series.",
  noGroup: "This booking is not part of a group booking.",
} as const;

const refused = (error: string): Refusal => ({ ok: false, error });

const PHONE = /^\+?[0-9 -]{7,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 100;

/** An email as the activity log keeps it: its first letter and its domain. */
function maskEmail(email: string | null): string {
  if (!email) return "none";
  const [user, domain] = email.split("@");
  return `${user.slice(0, 1)}…@${domain ?? ""}`;
}

const ending = (phone: string) => `ending ${phoneKey(phone).slice(-4)}`;

export async function correctBookingDetails(input: CorrectionInput): Promise<CorrectionResult> {
  const booking = await findBookingByCode(input.code.trim());
  if (!booking) return refused(CORRECTION_REFUSALS.notFound);
  const court = await getCourt(booking.courtId);
  const venueId = court?.venueId ?? 0;
  if (booking.status !== "confirmed") return refused(CORRECTION_REFUSALS.cancelled);
  // Erased (lib/privacy.ts): the venue keeps the booking for its books, not whose it was.
  if (booking.name === ANONYMOUS || booking.phone.trim() === "") return refused(CORRECTION_REFUSALS.erased);

  const name = input.name?.trim();
  const phone = input.phone?.trim();
  const email = input.email === undefined ? undefined : input.email === null ? null : input.email.trim() || null;
  if (name !== undefined && (name.length < 2 || name.length > MAX_NAME)) return refused(CORRECTION_REFUSALS.name);
  if (phone !== undefined && !PHONE.test(phone)) return refused(CORRECTION_REFUSALS.phone);
  if (email !== undefined && email !== null && (email.length > 254 || !EMAIL.test(email))) return refused(CORRECTION_REFUSALS.email);
  const changed = {
    name: name !== undefined && name !== booking.name,
    phone: phone !== undefined && phone !== booking.phone,
    email: email !== undefined && (email ?? null) !== (booking.email ?? null),
  };
  if (!changed.name && !changed.phone && !changed.email) return refused(CORRECTION_REFUSALS.nothing);

  // Which bookings: this one, or those of its series or group that still carry the details being corrected
  // (a week given to somebody else since keeps theirs). Never another booking because its details match.
  const scope = input.scope ?? "booking";
  if (scope === "series" && !booking.seriesCode) return refused(CORRECTION_REFUSALS.noSeries);
  if (scope === "group" && !booking.groupCode) return refused(CORRECTION_REFUSALS.noGroup);
  const db = getDb();
  const targets =
    scope === "booking"
      ? [{ id: booking.id, code: booking.code, date: booking.date, payment_status: booking.paymentStatus }]
      : ((await db
          .prepare(
            `SELECT id, code, date, payment_status FROM bookings
              WHERE ${scope === "series" ? "UPPER(series_code) = UPPER(?)" : "UPPER(group_code) = UPPER(?)"}
                AND status = 'confirmed' AND phone_key = phone_key(?) AND name = ?
              ORDER BY date, start_min`
          )
          .all(scope === "series" ? booking.seriesCode : booking.groupCode, booking.phone, booking.name)) as {
          id: number;
          code: string;
          date: string;
          payment_status: string;
        }[]);

  // A new number: asked what booking on it at the counter would be, for the dates still to come.
  let overridden: OverriddenPolicy[] = [];
  if (changed.phone && phoneKey(phone!) !== phoneKey(booking.phone)) {
    const { zone } = await venueHours(venueId);
    const today = todayISO(zone);
    const upcoming = targets.filter((t) => t.date >= today);
    const people = (await db
      .prepare("SELECT takes_part_as, participant_id, name FROM booking_participants WHERE booking_id = ? ORDER BY id")
      .all(booking.id)) as { takes_part_as: string; participant_id: number | null; name: string | null }[];
    const participants = people.filter((p) => p.takes_part_as === "participant" && p.participant_id !== null).map((p) => ({ id: p.participant_id!, name: p.name ?? "" }));
    const answer = await policyCheck("staff", {
      venueId,
      phone: phone!,
      dates: upcoming.map((t) => t.date),
      weeks: 1,
      // Staff of a venue not yet open to customers are trying it out, as at the counter.
      preview: !(await venueIsOpen(venueId)),
      participants,
      customerTakesPart: people.length === 0 || people.some((p) => p.takes_part_as === "customer"),
      // Paid already: as paid at the counter, which a struck-out number or the guest limit asks.
      paidNow: upcoming.length > 0 && upcoming.every((t) => t.payment_status === "paid"),
      ...(input.override ? { overrides: input.override.policies } : {}),
    });
    if (answer.refusal) return { ...answer.refusal, policyRefusal: true, venueId };
    overridden = answer.overridden;
  }

  const sets = [...(changed.name ? ["name = ?"] : []), ...(changed.phone ? ["phone = ?"] : []), ...(changed.email ? ["email = ?"] : [])];
  const values = [...(changed.name ? [name] : []), ...(changed.phone ? [phone] : []), ...(changed.email ? [email ?? null] : [])];
  const record =
    overridden.length > 0 && input.override
      ? { venueId, adminId: input.staff.id, adminName: input.staff.name, reason: input.override.reason, overridden }
      : null;
  await withTransaction(async () => {
    for (const t of targets) {
      await db.prepare(`UPDATE bookings SET ${sets.join(", ")} WHERE id = ? AND status = 'confirmed'`).run(...values, t.id);
      if (record) await recordOverrides(t.id, record);
    }
  });

  const parts = [
    changed.name ? `name ${booking.name} → ${name}` : null,
    changed.phone ? `number ${ending(booking.phone)} → ${ending(phone!)}` : null,
    changed.email ? `email ${maskEmail(booking.email)} → ${maskEmail(email ?? null)}` : null,
  ].filter(Boolean);
  for (const t of targets) {
    if (record) await logOverride(input.staff, t.code, { name: name ?? booking.name, phone: phone! }, record);
    await logAction(input.staff, {
      venueId,
      action: "booking.details_corrected",
      bookingCode: t.code,
      detail: `Corrected ${parts.join("; ")}${targets.length > 1 ? ` (${targets.length} bookings of its ${scope})` : ""}${
        record ? `; overrode ${overridden.map((o) => o.policy).join(", ")}: ${record.reason}` : ""
      }`,
    });
  }
  return { ok: true, codes: targets.map((t) => t.code), changed, overridden, venueId };
}
