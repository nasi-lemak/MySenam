import { getDb } from "../../src/lib/db";

/**
 * Move a booking to another day, as time passing would make it: its date,
 * its moments, and the claims holding its court and coach, all by the same
 * number of days. For tests of what happens once something has been played.
 */
export async function moveBookingToDate(bookingId: number, date: string): Promise<void> {
  const db = getDb();
  const row = (await db.prepare("SELECT date FROM bookings WHERE id = ?").get(bookingId)) as { date: string };
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${row.date}T00:00:00Z`)) / 86_400_000);
  const shift = `(${days} * interval '1 day')`;
  await db.transaction(async () => {
    await db
      .prepare(`UPDATE bookings SET date = ?, starts_at = starts_at + ${shift}, ends_at = ends_at + ${shift} WHERE id = ?`)
      .run(date, bookingId);
    await db
      .prepare(
        `UPDATE claims SET during = tstzrange(lower(during) + ${shift}, upper(during) + ${shift}, '[)'),
                           occupied = tstzrange(lower(occupied) + ${shift}, upper(occupied) + ${shift}, '[)')
          WHERE booking_id = ?`
      )
      .run(bookingId);
    await db
      .prepare(`UPDATE coach_claims SET during = tstzrange(lower(during) + ${shift}, upper(during) + ${shift}, '[)') WHERE booking_id = ?`)
      .run(bookingId);
  })();
}

/** What holds the court for a booking: each active claim's court and minutes of the booking's day. */
export async function claimsOf(bookingId: number): Promise<{ court_id: number; date: string; start: number; end: number }[]> {
  return (await getDb()
    .prepare(
      `SELECT c.court_id, b.date, b.start_min AS start, b.end_min AS "end"
         FROM claims c JOIN bookings b ON b.id = c.booking_id
        WHERE c.booking_id = ? AND c.active ORDER BY c.id`
    )
    .all(bookingId)) as { court_id: number; date: string; start: number; end: number }[];
}

/** Bookings on a court's space that overlap a block there: what must never happen. */
export async function bookingsInsideBlocks(bookingId: number): Promise<number> {
  const row = (await getDb()
    .prepare(
      `SELECT COUNT(*)::int AS n FROM claims a JOIN claims k
           ON k.space_id = a.space_id AND k.kind = 'block' AND k.active AND k.occupied && a.occupied
        WHERE a.booking_id = ? AND a.active`
    )
    .get(bookingId)) as { n: number };
  return row.n;
}
