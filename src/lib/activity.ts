import type { NextRequest } from "next/server";
import { aside, getDb, mustRethrow } from "./db";
import { getSessionAdmin, type Admin } from "./admin-auth";
import { formatMinute } from "./interval";
import { money } from "./region";
import type { Booking, ClassSession } from "./types";

/**
 * Who did what: the staff activity log.
 *
 * Every payment marked at the desk (and how it came in), every booking staff
 * make, cancel, move or change, every no-show, price change, refund, void,
 * credit movement, and change to how the venue is set up or who works there.
 * It is what squares the till at the end of a shift, and what answers "who
 * cancelled my booking?" without guessing. Written by the route that did the
 * thing, after it succeeded; read by managers under *Reports → Staff activity*.
 *
 * Entries keep the staff member's name as it was, so the log still reads
 * right after an account is removed. They are kept two years
 * (lib/privacy.ts).
 */

export type { StaffAction } from "./activity-labels";
export { ACTION_LABELS } from "./activity-labels";
import type { StaffAction } from "./activity-labels";

/**
 * Write one entry. Never throws: a log that fails must not undo what was done (inside a transaction it is
 * written under a savepoint), except a serialization failure or deadlock, which runs the transaction again. No `id`: somebody without a staff account (a coach at their own link), by name. */
export async function logAction(
  admin: Pick<Admin, "name"> & { id: number | null },
  entry: { venueId: number | null; businessId?: number | null; action: string; bookingCode?: string | null; detail?: string | null }
): Promise<void> {
  try {
    await aside(() =>
      getDb()
        .prepare("INSERT INTO staff_actions (admin_id, admin_name, venue_id, business_id, booking_code, action, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
        // `businessId` is for what has no venue: a change at business level, which the business's own managers read.
        .run(admin.id, admin.name, entry.venueId, entry.venueId === null ? entry.businessId ?? null : null, entry.bookingCode ?? null, entry.action, entry.detail?.slice(0, 500) ?? null)
    );
  } catch (err) {
    if (mustRethrow(err)) throw err;
    console.error("[mysenam] could not write the staff activity log:", err);
  }
}

/** For a route that has the request but not the staff member to hand. */
export async function logFromRequest(
  req: NextRequest,
  entry: { venueId: number | null; action: string; bookingCode?: string | null; detail?: string | null }
): Promise<void> {
  const admin = await getSessionAdmin(req);
  if (admin) await logAction(admin, entry);
}

/**
 * The log for these venues (all, for the platform owner), newest first; with `businessId`, also what was done at that
 * business's own level (its managers invited, removed, changed), which no venue holds.
 */
export async function listActivity(
  venueIds: number[] | null,
  filter: { from?: string; to?: string; bookingCode?: string; limit?: number; businessId?: number | null } = {}
): Promise<StaffAction[]> {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (venueIds) {
    const business = filter.businessId ?? null;
    if (venueIds.length === 0 && business === null) return [];
    const parts = [
      ...(venueIds.length > 0 ? [`venue_id IN (${venueIds.map(() => "?").join(",")})`] : []),
      ...(business !== null ? ["business_id = ?"] : []),
    ];
    clauses.push(`(${parts.join(" OR ")})`);
    params.push(...venueIds, ...(business !== null ? [business] : []));
  }
  if (filter.from) {
    clauses.push("created_at >= ?");
    params.push(`${filter.from} 00:00:00`);
  }
  if (filter.to) {
    clauses.push("created_at <= ?");
    params.push(`${filter.to} 23:59:59`);
  }
  if (filter.bookingCode) {
    clauses.push("UPPER(booking_code) = UPPER(?)");
    params.push(filter.bookingCode.trim());
  }
  const rows = (await getDb()
    .prepare(
      `SELECT * FROM staff_actions ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`
    )
    .all(...params, Math.min(Math.max(filter.limit ?? 200, 1), 1000))) as {
    id: number;
    admin_id: number | null;
    admin_name: string;
    venue_id: number | null;
    booking_code: string | null;
    action: string;
    detail: string | null;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    adminId: r.admin_id,
    adminName: r.admin_name,
    venueId: r.venue_id,
    bookingCode: r.booking_code,
    action: r.action,
    detail: r.detail,
    createdAt: r.created_at,
  }));
}

/**
 * One `booking.cancelled` entry for each booking a bulk action called off
 * (a closed day, a cancelled class), worded as the single cancellation's
 * (api/admin/bookings/cancel) with what did it, so "who cancelled my
 * booking?" has an answer by the booking's code however it went.
 */
export async function logCancelledBookings(
  admin: Pick<Admin, "name"> & { id: number | null },
  venueId: number,
  bookings: (Pick<Booking, "code" | "date" | "startMin" | "name" | "totalPrice" | "paymentStatus"> & Partial<Pick<Booking, "id" | "paidVia">>)[],
  why: string
): Promise<void> {
  for (const b of bookings) {
    // A booking a pass paid gives entries back, never money (ADR 0068): say what the pass took back.
    const pass = b.paymentStatus === "paid" && b.paidVia === "pass" && b.id !== undefined ? (await import("./counter-refunds")).passGivenBackWords(b.id) : null;
    await logAction(admin, {
      venueId,
      action: "booking.cancelled",
      bookingCode: b.code,
      detail: `${b.date} ${formatMinute(b.startMin)}, ${b.name}, ${money(b.totalPrice)}${b.paymentStatus === "paid" ? " (was paid)" : ""}; ${why}${pass ? await pass : ""}`,
    });
  }
}

/** A class called off: one `class.cancelled` entry with its count, and a `booking.cancelled` for each enrolment it cancelled. */
export async function logClassCancelled(
  admin: Pick<Admin, "name"> & { id: number | null },
  session: Pick<ClassSession, "id" | "venueId" | "name" | "date" | "startMin">,
  enrolments: Parameters<typeof logCancelledBookings>[2],
  why?: string
): Promise<void> {
  await logAction(admin, {
    venueId: session.venueId,
    action: "class.cancelled",
    detail: `${session.name}, ${session.date} ${formatMinute(session.startMin)}: ${enrolments.length} enrolment(s) cancelled${why ? `; ${why}` : ""}`,
  });
  await logCancelledBookings(admin, session.venueId, enrolments, `class ${session.name} cancelled${why ? `, ${why}` : ""}`);
}
