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
 * sold to a customer, an online payment, an invoice or an e-invoice. A draft holding one of
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
          AND NOT EXISTS (SELECT 1 FROM e_invoices e WHERE e.venue_id IN (SELECT id FROM venues WHERE business_id = b.id))
        GROUP BY b.id ORDER BY b.id`
    )
    .all(`-${STALE_DRAFT_DAYS} days`)) as { business_id: number; venue_ids: number[] }[];
  return rows.map((r) => ({ businessId: r.business_id, venueIds: r.venue_ids.map(Number) }));
}

/** One foreign key from a child table to a column of its parent (single-column ones only). */
export interface ForeignKey {
  child: string;
  column: string;
  parent: string;
  parentColumn: string;
  /** pg_constraint.confdeltype: a no action, r restrict, c cascade, n set null, d set default. */
  onDelete: string;
}

/** Every single-column foreign key in the schema, by the table it points at. */
export async function foreignKeysByParent(): Promise<Map<string, ForeignKey[]>> {
  const rows = (await getDb()
    .prepare(
      `SELECT c.conrelid::regclass::text AS child, quote_ident(ca.attname) AS col,
              c.confrelid::regclass::text AS parent, quote_ident(pa.attname) AS parent_col, c.confdeltype AS on_delete
         FROM pg_constraint c
         JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = c.conkey[1]
         JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
        WHERE c.contype = 'f' AND cardinality(c.conkey) = 1
        ORDER BY 1, 2`
    )
    .all()) as { child: string; col: string; parent: string; parent_col: string; on_delete: string }[];
  const byParent = new Map<string, ForeignKey[]>();
  for (const r of rows) {
    const list = byParent.get(r.parent) ?? [];
    list.push({ child: r.child, column: r.col, parent: r.parent, parentColumn: r.parent_col, onDelete: r.on_delete });
    byParent.set(r.parent, list);
  }
  return byParent;
}

/**
 * The statements that clear whatever would stop `DELETE FROM <root> WHERE <condition>`, deepest first.
 *
 * Found from the foreign keys themselves, not from a list somebody has to keep up to date: a table that
 * references the rows with NO ACTION (or RESTRICT) is emptied of the rows that do, after its own such
 * dependants, and the walk goes on through cascading keys too, since a cascade is stopped by a dependant
 * of the cascaded table. Keys that cascade need no statement of their own, and keys that set null or
 * default none either (the rows stay). A table is not visited twice along one path, so a cycle ends.
 * Keys over more than one column are not followed; tests/drafts.test.ts fails when one that blocks appears.
 */
export function draftDeletionPlan(byParent: Map<string, ForeignKey[]>, root: string, condition: string): string[] {
  const out: string[] = [];
  const walk = (table: string, where: string, path: string[]) => {
    for (const fk of byParent.get(table) ?? []) {
      if (fk.onDelete === "n" || fk.onDelete === "d" || path.includes(fk.child)) continue;
      const children = `${fk.column} IN (SELECT ${fk.parentColumn} FROM ${table} WHERE ${where})`;
      walk(fk.child, children, [...path, fk.child]);
      if (fk.onDelete === "a" || fk.onDelete === "r") out.push(`DELETE FROM ${fk.child} WHERE ${children}`);
    }
  };
  walk(root, condition, [root]);
  return out;
}

/**
 * Delete them. Run inside the retention run's transaction. Their photos'
 * files are not in the database, so their names are added to `photoKeys`
 * for the caller to remove once the transaction has committed.
 *
 * Each business goes in a transaction of its own (a savepoint inside the
 * retention run's), so one that cannot be removed is left, and the owners
 * told, instead of the whole retention run, and with it every personal-data
 * rule, rolling back every day. Returns how many were deleted.
 */
export async function deleteStaleDrafts(photoKeys: string[] = []): Promise<number> {
  const db = getDb();
  const due = await staleDrafts();
  if (due.length === 0) return 0;
  const byParent = await foreignKeysByParent();
  const failed: string[] = [];
  let deleted = 0;
  for (const { businessId, venueIds } of due) {
    const keys: string[] = [];
    try {
      await db.transaction(async () => {
        const v = venueIds.map(() => "?").join(",");
        keys.push(
          ...((await db.prepare(`SELECT key FROM venue_photos WHERE venue_id IN (${v})`).all(...venueIds)) as { key: string }[]).map((r) => r.key)
        );
        // Whatever would block the business's rows, found from the foreign keys; the database cascades the rest.
        for (const sql of draftDeletionPlan(byParent, "businesses", `id = ${Number(businessId)}`)) await db.prepare(sql).run();
        await db.prepare("DELETE FROM businesses WHERE id = ?").run(businessId);
      })();
      photoKeys.push(...keys);
      deleted++;
    } catch (err) {
      console.error(`[mysenam] could not delete the stale draft business ${businessId}:`, err instanceof Error ? err.message : err);
      failed.push(`business ${businessId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed.length > 0) {
    const { raiseAlert } = await import("./alerts");
    await raiseAlert(
      "retention:stale-draft-not-deleted",
      "A stale draft venue could not be deleted and was left in place",
      `${failed.length} of ${due.length} due: ${failed.slice(0, 5).join("; ")}`
    );
  }
  return deleted;
}
