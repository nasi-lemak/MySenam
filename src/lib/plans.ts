import { getDb } from "./db";
import { money as shown, region } from "./region";

/**
 * What a venue pays by its size: tiers by the number of bookable resources
 * (courts, pitches, rooms) it has, set by the platform owner.
 *
 * Every tier has every feature — a small venue is not denied recurring
 * bookings or reports to make it upgrade. Only the count decides the price.
 *
 * The count is taken when the month is invoiced. A court out of service for
 * the whole of that month is not counted, so a venue is not charged for a
 * court it closed for repairs. With no tiers set, every venue pays the flat
 * default, as before; and a venue's own agreed fee beats both.
 */

export interface PlanTier {
  name: string;
  /** The most resources it covers; null on a last tier with no limit. */
  upTo: number | null;
  monthlyFee: number;
}

export interface PlanTiers {
  tiers: PlanTier[];
  /** What each resource past the last tier's limit adds. */
  extraEach: number;
}

export const MAX_TIERS = 8;

/**
 * A starting point the owner can adopt and change: the tiers the pricing
 * analysis settled on (README, "Plans by size"), in ringgit.
 */
export const SUGGESTED_TIERS: PlanTiers = {
  tiers: [
    { name: "Starter", upTo: 5, monthlyFee: 19.9 },
    { name: "Growth", upTo: 15, monthlyFee: 39.9 },
    { name: "Large", upTo: 30, monthlyFee: 69.9 },
    { name: "Arena", upTo: 50, monthlyFee: 99.9 },
  ],
  extraEach: 2,
};

/**
 * The same tiers for a Singapore install, in Singapore dollars: what it costs
 * to run a venue is much the same, but rents, wages and the booking software
 * venues already pay for are priced in dollars, not ringgit. A starting point
 * for the owner to set, not a researched price.
 */
const SUGGESTED_TIERS_SG: PlanTiers = {
  tiers: [
    { name: "Starter", upTo: 5, monthlyFee: 29 },
    { name: "Growth", upTo: 15, monthlyFee: 59 },
    { name: "Large", upTo: 30, monthlyFee: 99 },
    { name: "Arena", upTo: 50, monthlyFee: 149 },
  ],
  extraEach: 3,
};

/** The suggestion for this install's country. */
export function suggestedTiers(): PlanTiers {
  return region().country === "SG" ? SUGGESTED_TIERS_SG : SUGGESTED_TIERS;
}

export async function planTiers(): Promise<PlanTiers> {
  const rows = (await getDb()
    .prepare("SELECT name, up_to, monthly_fee, extra_each FROM plan_tiers ORDER BY up_to IS NULL, up_to")
    .all()) as { name: string; up_to: number | null; monthly_fee: number; extra_each: number }[];
  return {
    tiers: rows.map((r) => ({ name: r.name, upTo: r.up_to, monthlyFee: Number(r.monthly_fee) })),
    extraEach: rows.length > 0 ? Number(rows[rows.length - 1].extra_each) : 0,
  };
}

const money = (n: number) => Math.round(n * 100) / 100;

/** The tier a venue of this size is on, and what it pays; null with no tiers. */
export function priceFor(count: number, plan: PlanTiers): { name: string; fee: number } | null {
  if (plan.tiers.length === 0) return null;
  const tier = plan.tiers.find((t) => t.upTo === null || count <= t.upTo);
  if (tier) return { name: tier.name, fee: tier.monthlyFee };
  const last = plan.tiers[plan.tiers.length - 1];
  return { name: last.name, fee: money(last.monthlyFee + plan.extraEach * (count - (last.upTo ?? count))) };
}

/** Replace the tiers. An empty list goes back to one flat default fee. */
export async function setPlanTiers(input: PlanTiers): Promise<{ ok: true; plan: PlanTiers } | { ok: false; error: string }> {
  const { tiers } = input;
  if (!Array.isArray(tiers) || tiers.length > MAX_TIERS) return { ok: false, error: `Up to ${MAX_TIERS} tiers.` };
  const names = new Set<string>();
  let previous = 0;
  for (const [i, t] of tiers.entries()) {
    const name = typeof t.name === "string" ? t.name.trim() : "";
    if (name === "" || name.length > 40) return { ok: false, error: "Each tier needs a name of up to 40 characters." };
    if (names.has(name.toLowerCase())) return { ok: false, error: `Two tiers are called ${name}.` };
    names.add(name.toLowerCase());
    if (!Number.isFinite(t.monthlyFee) || t.monthlyFee < 0 || t.monthlyFee > 100_000)
      return { ok: false, error: `${name}: the monthly fee must be ${shown(0)}–100,000.` };
    const last = i === tiers.length - 1;
    if (t.upTo === null) {
      if (!last) return { ok: false, error: `${name}: only the last tier can have no limit.` };
    } else if (!Number.isInteger(t.upTo) || t.upTo <= previous || t.upTo > 10_000) {
      return { ok: false, error: `${name}: "up to" must be a whole number above the tier before (${previous}).` };
    } else previous = t.upTo;
  }
  const extraEach = Number(input.extraEach ?? 0);
  if (!Number.isFinite(extraEach) || extraEach < 0 || extraEach > 10_000)
    return { ok: false, error: `The fee for each extra resource must be ${shown(0)}–10,000.` };
  if (extraEach > 0 && tiers.length > 0 && tiers[tiers.length - 1].upTo === null)
    return { ok: false, error: "The last tier has no limit, so nothing is extra: give it a limit, or set the extra fee to 0." };
  const db = getDb();
  await db.transaction(async () => {
    await db.prepare("DELETE FROM plan_tiers").run();
    for (const [i, t] of tiers.entries())
      await db
        .prepare("INSERT INTO plan_tiers (name, up_to, monthly_fee, extra_each) VALUES (?, ?, ?, ?)")
        .run(t.name.trim(), t.upTo, money(t.monthlyFee), i === tiers.length - 1 ? money(extraEach) : 0);
  })();
  return { ok: true, plan: await planTiers() };
}

/**
 * How many resources each venue is billed for in a month (YYYY-MM): its
 * courts, less any out of service from the first of the month to the last.
 */
export async function billableResources(venueIds: number[], period: string): Promise<Map<number, number>> {
  const counts = new Map<number, number>(venueIds.map((id) => [id, 0]));
  if (venueIds.length === 0) return counts;
  const first = `${period}-01`;
  const end = new Date(`${first}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  const last = end.toISOString().slice(0, 10);
  const rows = (await getDb()
    .prepare(
      `SELECT c.venue_id, COUNT(*)::int AS n FROM courts c
        WHERE c.venue_id IN (${venueIds.map(() => "?").join(",")})
          AND NOT EXISTS (
            SELECT 1 FROM court_outages o
             WHERE o.court_id = c.id AND o.starts_on <= ? AND (o.ends_on IS NULL OR o.ends_on >= ?)
          )
        GROUP BY c.venue_id`
    )
    .all(...venueIds, first, last)) as { venue_id: number; n: number }[];
  for (const r of rows) counts.set(r.venue_id, r.n);
  return counts;
}
