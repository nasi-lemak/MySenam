import { getDb } from "./db";

/**
 * Draft venues nobody came back to.
 *
 * Anybody can sign up and get a draft (lib/applications.ts), and most who
 * try a thing and leave never say so. A business that never went live, and
 * whose people have not signed in for `STALE_DRAFT_DAYS`, is deleted with
 * everything it set up — courts, classes, its staff's test bookings, its
 * accounts — by the daily retention run (lib/privacy.ts).
 *
 * Except anything that is somebody else's: a pass, a membership or credit
 * sold to a customer, an online payment, an invoice. A draft holding one of
 * those is left alone for the platform owner to look at, rather than
 * deleting a record of money.
 */

export const STALE_DRAFT_DAYS = 90;

/** Businesses due to go, each with its venues. */
export async function staleDrafts(): Promise<{ businessId: number; venueIds: number[] }[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT b.id AS business_id, array_agg(v.id ORDER BY v.id) AS venue_ids
         FROM businesses b JOIN venues v ON v.business_id = b.id
        WHERE NOT EXISTS (SELECT 1 FROM venues l WHERE l.business_id = b.id AND l.published_at IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM venue_applications va
             WHERE va.status = 'pending' AND va.venue_id IN (SELECT id FROM venues WHERE business_id = b.id))
          AND NOT EXISTS (
            SELECT 1 FROM admins a
             WHERE (a.business_id = b.id OR a.venue_id IN (SELECT id FROM venues WHERE business_id = b.id))
               AND COALESCE(a.last_seen_at, a.created_at) >= datetime('now', ?))
          AND NOT EXISTS (SELECT 1 FROM passes p WHERE p.venue_id IN (SELECT id FROM venues WHERE business_id = b.id))
          AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.venue_id IN (SELECT id FROM venues WHERE business_id = b.id))
          AND NOT EXISTS (SELECT 1 FROM wallet_entries w WHERE w.venue_id IN (SELECT id FROM venues WHERE business_id = b.id))
          AND NOT EXISTS (SELECT 1 FROM online_payments o WHERE o.venue_id IN (SELECT id FROM venues WHERE business_id = b.id))
          AND NOT EXISTS (
            SELECT 1 FROM venue_invoices i
             WHERE i.business_id = b.id OR i.venue_id IN (SELECT id FROM venues WHERE business_id = b.id))
        GROUP BY b.id ORDER BY b.id`
    )
    .all(`-${STALE_DRAFT_DAYS} days`)) as { business_id: number; venue_ids: number[] }[];
  return rows.map((r) => ({ businessId: r.business_id, venueIds: r.venue_ids.map(Number) }));
}

/**
 * Delete them. Run inside the retention run's transaction. Their photos'
 * files are not in the database, so their names are added to `photoKeys`
 * for the caller to remove once the transaction has committed.
 */
export async function deleteStaleDrafts(photoKeys: string[] = []): Promise<number> {
  const db = getDb();
  const due = await staleDrafts();
  for (const { businessId, venueIds } of due) {
    const v = venueIds.map(() => "?").join(",");
    photoKeys.push(
      ...((await db.prepare(`SELECT key FROM venue_photos WHERE venue_id IN (${v})`).all(...venueIds)) as { key: string }[]).map((r) => r.key)
    );
    const courts = `SELECT id FROM courts WHERE venue_id IN (${v})`;
    // Children before parents, and whatever names one of its accounts
    // before the accounts.
    const steps = [
      `DELETE FROM messages WHERE venue_id IN (${v})`,
      `DELETE FROM waitlist WHERE court_id IN (${courts}) OR class_id IN (SELECT id FROM classes WHERE court_id IN (${courts}))`,
      `DELETE FROM bookings WHERE court_id IN (${courts})`,
      `DELETE FROM classes WHERE court_id IN (${courts})`,
      `DELETE FROM slot_blocks WHERE court_id IN (${courts})`,
      `DELETE FROM courts WHERE venue_id IN (${v})`,
      `DELETE FROM promo_codes WHERE venue_id IN (${v})`,
      `DELETE FROM inductions WHERE venue_id IN (${v})`,
      `DELETE FROM venue_payment_accounts WHERE venue_id IN (${v})`,
      `DELETE FROM storefront_venues WHERE venue_id IN (${v})`,
      `DELETE FROM venue_applications WHERE venue_id IN (${v})`,
      `DELETE FROM venue_photos WHERE venue_id IN (${v})`,
    ];
    for (const sql of steps) {
      // Each list of venues in the statement takes the ids again.
      const lists = (sql.match(/\?/g) ?? []).length / venueIds.length;
      await db.prepare(sql).run(...Array.from({ length: lists }, () => venueIds).flat());
    }
    await db.prepare("DELETE FROM venue_applications WHERE business_id = ?").run(businessId);
    await db.prepare(`DELETE FROM admins WHERE business_id = ? OR venue_id IN (${v})`).run(businessId, ...venueIds);
    await db.prepare(`DELETE FROM venues WHERE id IN (${v})`).run(...venueIds);
    await db.prepare("DELETE FROM businesses WHERE id = ?").run(businessId);
  }
  return due.length;
}
