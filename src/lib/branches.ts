import { getDb } from "./db";

/**
 * Businesses and their branches: which venues count as one for credit and
 * passes. A venue in a business shares with every branch of it; a venue on
 * its own shares with nothing but itself.
 */

/**
 * `venue_id` is one of the venues whose credit is spendable at this one: every
 * branch of its business, or, for a venue on its own, just itself. Bought at
 * one branch, spent at another and refunded to a third, it stays in the one
 * pot, because each entry keeps the branch it happened at and the pot is
 * whatever business that branch belongs to.
 */
export const SAME_CREDIT = `venue_id IN (
  SELECT id FROM venues WHERE COALESCE(business_id, -id) = (SELECT COALESCE(business_id, -id) FROM venues WHERE id = ?)
)`;

/** Are these two venues branches of the same business? */
export async function sameBusiness(a: number, b: number): Promise<boolean> {
  const row = (await getDb()
    .prepare("SELECT COUNT(DISTINCT business_id) AS n, COUNT(business_id) AS with_business FROM venues WHERE id IN (?, ?)")
    .get(a, b)) as { n: number; with_business: number };
  return row.with_business === 2 && row.n === 1;
}

export interface Business {
  id: number;
  name: string;
  branches: { id: number; name: string; area: string }[];
  managers: { id: number; name: string; email: string }[];
}

/** Every business, with its branches and managers: what the platform owner sees. */
export async function listBusinesses(): Promise<Business[]> {
  const db = getDb();
  const businesses = (await db.prepare("SELECT id, name FROM businesses ORDER BY name, id").all()) as {
    id: number;
    name: string;
  }[];
  const branches = (await db
    .prepare("SELECT id, name, area, business_id FROM venues WHERE business_id IS NOT NULL ORDER BY name")
    .all()) as { id: number; name: string; area: string; business_id: number }[];
  const managers = (await db
    .prepare("SELECT id, name, email, business_id FROM admins WHERE business_id IS NOT NULL ORDER BY id")
    .all()) as { id: number; name: string; email: string; business_id: number }[];
  return businesses.map((b) => ({
    ...b,
    branches: branches.filter((v) => v.business_id === b.id).map(({ id, name, area }) => ({ id, name, area })),
    managers: managers.filter((m) => m.business_id === b.id).map(({ id, name, email }) => ({ id, name, email })),
  }));
}

export type GroupResult = { ok: true; businessId: number } | { ok: false; error: string };

/**
 * Put venues together as one business — new, or one that exists — and make
 * some of their staff its managers.
 *
 * For venues that joined before businesses existed: one owner with three
 * branches, three logins. Their staff keep their accounts; the ones named
 * become managers of the whole business, the rest stay at their branch.
 * A venue already in another business is left where it is.
 */
export async function groupIntoBusiness(input: {
  name?: string;
  businessId?: number;
  venueIds: number[];
  managerIds?: number[];
}): Promise<GroupResult> {
  const db = getDb();
  if (input.venueIds.length === 0 && input.businessId === undefined)
    return { ok: false, error: "Choose at least one venue." };
  // Every refusal throws, so nothing done before it (a new business row) is
  // kept: a refused request leaves no trace.
  class Refused extends Error {}
  try {
    return await db.transaction(async (): Promise<GroupResult> => {
      let businessId = input.businessId;
      if (businessId === undefined) {
        const name = input.name?.trim() ?? "";
        if (name.length < 2) throw new Refused("Give the business a name.");
        businessId = (await db.prepare("INSERT INTO businesses (name) VALUES (?)").run(name)).lastInsertRowid as number;
      } else if (!(await db.prepare("SELECT id FROM businesses WHERE id = ?").get(businessId))) {
        throw new Refused("Business not found.");
      }
      const list = (ids: number[]) => ids.map(() => "?").join(",") || "NULL";
      const taken = (await db
        .prepare(`SELECT name FROM venues WHERE id IN (${list(input.venueIds)}) AND business_id IS NOT NULL AND business_id <> ?`)
        .all(...input.venueIds, businessId)) as { name: string }[];
      if (taken.length > 0) throw new Refused(`${taken.map((t) => t.name).join(", ")} already belong to another business.`);
      await db.prepare(`UPDATE venues SET business_id = ? WHERE id IN (${list(input.venueIds)})`).run(businessId, ...input.venueIds);

      // Only staff of this business's branches can be made its managers.
      const managers = input.managerIds ?? [];
      if (managers.length > 0) {
        const promoted = await db
          .prepare(
            `UPDATE admins SET business_id = ?, venue_id = NULL
              WHERE id IN (${list(managers)}) AND venue_id IN (SELECT id FROM venues WHERE business_id = ?)`
          )
          .run(businessId, ...managers, businessId);
        if (promoted.changes !== managers.length) throw new Refused("Only staff of this business's branches can manage it.");
      }
      return { ok: true, businessId };
    })();
  } catch (err) {
    if (err instanceof Refused) return { ok: false, error: err.message };
    throw err;
  }
}
