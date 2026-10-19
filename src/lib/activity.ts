import type { NextRequest } from "next/server";
import { getDb } from "./db";
import { getSessionAdmin, type Admin } from "./admin-auth";

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

/** Write one entry. Never throws: a log that fails must not undo what was done. */
export async function logAction(
  admin: Pick<Admin, "id" | "name">,
  entry: { venueId: number | null; action: string; bookingCode?: string | null; detail?: string | null }
): Promise<void> {
  try {
    await getDb()
      .prepare("INSERT INTO staff_actions (admin_id, admin_name, venue_id, booking_code, action, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(admin.id, admin.name, entry.venueId, entry.bookingCode ?? null, entry.action, entry.detail?.slice(0, 500) ?? null);
  } catch (err) {
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

/** The log for these venues (all, for the platform owner), newest first. */
export async function listActivity(
  venueIds: number[] | null,
  filter: { from?: string; to?: string; bookingCode?: string; limit?: number } = {}
): Promise<StaffAction[]> {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (venueIds) {
    if (venueIds.length === 0) return [];
    clauses.push(`venue_id IN (${venueIds.map(() => "?").join(",")})`);
    params.push(...venueIds);
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
