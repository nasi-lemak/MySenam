import { getDb } from "./db";
import { isActivity } from "./activities";
import { accountPhone } from "./access";
import { errorText, translator, type ErrorCode } from "./i18n";
import { inSameBusiness } from "./branches";
import { normalisePhone } from "./store";
import { addDays, todayISO } from "./time";
import { MAX_MEMBERSHIP_COVERS, type BenefitScope, type MembershipBenefits, type Refusal } from "./types";
import { isScope, PLAN_SCOPES } from "./entitlements";
import { money, region, isAmount } from "./region";

/**
 * Memberships a club sells online.
 *
 * A venue lists a few plans (a name, how many months, the fee); a signed-in
 * customer picks one and pays the venue through its own gateway account, and
 * the membership is made when the money is in. Joining starts today; renewing
 * starts the day after the current one ends, and opens in the last weeks of it.
 */

export interface MembershipPlan {
  id: number;
  venueId: number;
  name: string;
  months: number;
  price: number;
  /**
   * A tier's own benefits. `ratePercent`: members on it pay this share of the
   * public price, instead of each court's member rate. `aheadDays`: how far
   * ahead they may book, instead of the venue's members' window. Null: the venue's.
   */
  ratePercent: number | null;
  aheadDays: number | null;
  /**
   * What the member's price covers (ADR 0025, lib/entitlements.ts): the
   * booking its member takes part in (`booking`, every plan before), or the
   * members' own places only on a session priced by the place (`participant`).
   */
  scope: BenefitScope;
  /**
   * Whom a customer may buy it for online (migration 0167;
   * lib/membership-purchases.ts): themself (`account`, every plan before),
   * somebody they are an active guardian of (`participant`), either
   * (`individual`), or themself and dependants they name (`family`).
   */
  offeredFor: OfferedFor;
  /** A family plan's: how many dependants it covers besides its holder. Null for any other plan. */
  familyLimit: number | null;
  /**
   * A family plan's: how many people the account that bought it may put on
   * in one term in place of somebody taken off (migration 0191;
   * lib/membership-purchases.ts). 0, the default: none until the next term.
   */
  coverSwaps: number;
  /**
   * Whether its memberships run on by the days a suspension takes out of
   * their term (migration 0218; lib/membership-suspensions.ts). Off by
   * default: a suspension does not move a membership's end.
   */
  extendOnSuspension: boolean;
  /**
   * Its members are let in with no booking at a resource taking entries
   * (migration 0266; lib/entries.ts), anywhere in the venue's business, or
   * only where it offers `admitsEntrySport`. Off by default.
   */
  admitsEntry: boolean;
  admitsEntrySport: string | null;
  /**
   * The tier's version (migration 0337): 1 until a benefit a membership carries is edited, then one more on each such
   * edit. A membership records the version it was sold at (`MembershipBenefits`), so staff can see which terms it has.
   */
  version: number;
}

/**
 * What a membership carries of its tier, taken when the term is sold (ADR 0071, migration 0337): the benefits a member
 * paid for, which a later edit of the tier does not change. Renewals take the tier as it stands at the renewal.
 */
export type { MembershipBenefits };

/** The benefits a plan gives, in the shape a membership keeps them. */
export function benefitsOf(plan: Pick<MembershipPlan, "ratePercent" | "aheadDays" | "scope" | "admitsEntry" | "admitsEntrySport" | "extendOnSuspension">): MembershipBenefits {
  return {
    ratePercent: plan.ratePercent,
    aheadDays: plan.aheadDays,
    scope: plan.scope,
    admitsEntry: plan.admitsEntry,
    admitsEntrySport: plan.admitsEntry ? plan.admitsEntrySport : null,
    extendOnSuspension: plan.extendOnSuspension,
  };
}

/** The benefits of a membership on no tier: the venue's member rates and window, the booking as its scope, nothing more. */
export const PLAIN_BENEFITS: MembershipBenefits = {
  ratePercent: null,
  aheadDays: null,
  scope: "booking",
  admitsEntry: false,
  admitsEntrySport: null,
  extendOnSuspension: false,
};

export const OFFERED_FOR = ["account", "participant", "individual", "family"] as const;
export type OfferedFor = (typeof OFFERED_FOR)[number];
const isOfferedFor = (v: unknown): v is OfferedFor => typeof v === "string" && (OFFERED_FOR as readonly string[]).includes(v);

export const MAX_PLAN_MONTHS = 12;
export const MAX_PLANS_PER_VENUE = 6;
/** How long before a membership ends it can be renewed online. */
export const RENEW_WINDOW_DAYS = 45;

const ENGLISH = translator("en");
function refuse(code: ErrorCode, vars?: Record<string, string | number>): Refusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, vars };
}

interface PlanRow {
  id: number;
  venue_id: number;
  name: string;
  months: number;
  price: number;
  rate_percent: number | null;
  ahead_days: number | null;
  scope: string | null;
  offered_for?: string | null;
  family_limit?: number | null;
  cover_swaps?: number | null;
  extend_on_suspension?: boolean | number | null;
  admits_entry?: boolean | null;
  admits_entry_sport?: string | null;
  version?: number | null;
}

const toPlan = (r: PlanRow): MembershipPlan => ({
  id: r.id,
  venueId: r.venue_id,
  name: r.name,
  months: r.months,
  price: Number(r.price),
  ratePercent: r.rate_percent ?? null,
  aheadDays: r.ahead_days ?? null,
  scope: isScope(r.scope, PLAN_SCOPES) ? r.scope : "booking",
  offeredFor: isOfferedFor(r.offered_for) ? r.offered_for : "account",
  familyLimit: r.offered_for === "family" ? (r.family_limit ?? null) : null,
  coverSwaps: r.offered_for === "family" ? (r.cover_swaps ?? 0) : 0,
  extendOnSuspension: r.extend_on_suspension === true || r.extend_on_suspension === 1,
  admitsEntry: r.admits_entry === true,
  admitsEntrySport: r.admits_entry === true ? (r.admits_entry_sport ?? null) : null,
  version: r.version ?? 1,
});

const PLAN_COLUMNS = "id, venue_id, name, months, price::float AS price, rate_percent, ahead_days, scope, offered_for, family_limit, cover_swaps, extend_on_suspension, admits_entry, admits_entry_sport, version";

/** The plans a venue has on offer, cheapest first. */
export async function listPlans(venueId: number): Promise<MembershipPlan[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT ${PLAN_COLUMNS} FROM membership_plans WHERE venue_id = ? AND retired_at IS NULL ORDER BY months, price, id`
    )
    .all(venueId)) as PlanRow[];
  return rows.map(toPlan);
}

export async function planById(id: number, opts: { retired?: boolean } = {}): Promise<MembershipPlan | null> {
  const row = (await getDb()
    .prepare(
      `SELECT ${PLAN_COLUMNS} FROM membership_plans WHERE id = ?${opts.retired ? "" : " AND retired_at IS NULL"}`
    )
    .get(id)) as PlanRow | undefined;
  return row ? toPlan(row) : null;
}

export type PlanResult =
  | { ok: true; plan: MembershipPlan }
  // `needsConfirm`: nothing was saved because the tier prices members above the venue's own member rate; saving it anyway
  // is asked for again with `confirmAboveMemberRate` (D19, ADR 0071).
  | { ok: false; error: string; needsConfirm?: "above-member-rate" };

/**
 * D19 (ADR 0071): a tier whose share of the public price comes to more than a court's member rate prices its members above
 * a plain member, which is almost always a slip. The first court (by id) where it does, with both prices at the peak or
 * off-peak rate that shows it; null when it is at or below every member rate, or the tier has no share of its own.
 */
export async function aboveMemberRate(
  venueId: number,
  ratePercent: number | null
): Promise<{ court: string; tier: number; member: number } | null> {
  if (ratePercent === null) return null;
  const courts = (await getDb()
    .prepare(
      "SELECT name, off_peak_rate::float AS off, peak_rate::float AS peak, member_off_peak_rate::float AS m_off, member_peak_rate::float AS m_peak FROM courts WHERE venue_id = ? ORDER BY id"
    )
    .all(venueId)) as { name: string; off: number; peak: number; m_off: number | null; m_peak: number | null }[];
  const minor = 10 ** region().currency.minorUnits;
  for (const c of courts)
    for (const [pub, member] of [[c.off, c.m_off], [c.peak, c.m_peak]] as const) {
      if (member === null || member === undefined) continue;
      const tier = Math.round(Math.round(pub * minor) * ratePercent / 100) / minor;
      if (tier > member) return { court: c.name, tier, member };
    }
  return null;
}

/** The refusal that asks for a tier above a member rate to be confirmed; null when it is fine or confirmed. */
async function aboveRefusal(venueId: number, ratePercent: number | null, confirmed: unknown): Promise<PlanResult | null> {
  if (confirmed === true) return null;
  const above = await aboveMemberRate(venueId, ratePercent);
  if (!above) return null;
  return {
    ok: false,
    needsConfirm: "above-member-rate",
    error: `Members on this plan would pay ${money(above.tier)} an hour on ${above.court}, more than its member rate of ${money(above.member)}: confirm to save it anyway.`,
  };
}

/** A tier's benefits as given: each null for the venue's; what the price covers, the whole booking unless said. */
function readBenefits(input: {
  ratePercent?: unknown;
  aheadDays?: unknown;
  scope?: unknown;
}): { ratePercent: number | null; aheadDays: number | null; scope: BenefitScope } | string {
  const rate = input.ratePercent ?? null;
  if (rate !== null && (!Number.isInteger(rate) || (rate as number) < 10 || (rate as number) > 99))
    return "Members on a plan pay 10–99% of the public price, or each court's member rate.";
  const ahead = input.aheadDays ?? null;
  if (ahead !== null && (!Number.isInteger(ahead) || (ahead as number) < 1 || (ahead as number) > 90))
    return "Members on a plan book 1–90 days ahead, or the venue's members' window.";
  const scope = input.scope ?? "booking";
  if (!isScope(scope, PLAN_SCOPES)) return "A member's price is for the whole booking, or for the members' own places.";
  return { ratePercent: rate as number | null, aheadDays: ahead as number | null, scope };
}

/**
 * Whom a plan is sold to online, as given: `offeredFor` left out keeps what
 * it is (`account` for a new plan); a family plan needs its limit, 1–12.
 */
function readHolders(
  input: { offeredFor?: unknown; familyLimit?: unknown; coverSwaps?: unknown },
  current: { offeredFor: OfferedFor; familyLimit: number | null; coverSwaps: number }
): { offeredFor: OfferedFor; familyLimit: number | null; coverSwaps: number } | string {
  const offeredFor = input.offeredFor ?? current.offeredFor;
  if (!isOfferedFor(offeredFor)) return "A plan is sold to the account holder, somebody they look after, either, or a family.";
  if (offeredFor !== "family") return { offeredFor, familyLimit: null, coverSwaps: 0 };
  const limit = input.familyLimit ?? current.familyLimit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_MEMBERSHIP_COVERS)
    return `A family plan covers 1–${MAX_MEMBERSHIP_COVERS} people besides its holder.`;
  // Not said: as it is (none for a new plan).
  const swaps = input.coverSwaps ?? current.coverSwaps;
  if (!Number.isInteger(swaps) || (swaps as number) < 0 || (swaps as number) > MAX_MEMBERSHIP_COVERS)
    return `A family plan lets 0–${MAX_MEMBERSHIP_COVERS} people be put on in place of others in one term.`;
  return { offeredFor, familyLimit: limit as number, coverSwaps: swaps as number };
}

/** Whether a plan extends by the time suspended, as given: left out, as it is (off for a new plan). */
function readExtends(input: { extendOnSuspension?: unknown }, current: boolean): boolean | string {
  const v = input.extendOnSuspension ?? current;
  return typeof v === "boolean" ? v : "Say whether a suspension extends a membership's end: true or false.";
}

/**
 * Whether a plan's members are let in with no booking (lib/entries.ts), as given: left out, as it is (off for a new
 * plan); `admitsEntrySport` an activity to admit at only, or null for any resource taking entries.
 */
async function readAdmits(
  input: { admitsEntry?: unknown; admitsEntrySport?: unknown },
  current: { admitsEntry: boolean; admitsEntrySport: string | null }
): Promise<{ admitsEntry: boolean; admitsEntrySport: string | null } | string> {
  const admitsEntry = input.admitsEntry ?? current.admitsEntry;
  if (typeof admitsEntry !== "boolean") return "Say whether its members come in with no booking: true or false.";
  const sport = input.admitsEntrySport === undefined ? current.admitsEntrySport : input.admitsEntrySport === "" ? null : input.admitsEntrySport;
  if (sport !== null && !(await isActivity(sport))) return "Unknown sport.";
  return { admitsEntry, admitsEntrySport: admitsEntry ? (sport as string | null) : null };
}

/**
 * Change a plan's benefits, for the memberships sold from now on: a term already sold keeps the benefits it was sold with, and a
 * renewal takes the plan as it is when it is made (ADR 0071). The plan's version goes up when a benefit a membership carries
 * changes. A share of the public price above a court's member rate is refused until `confirmAboveMemberRate: true` (D19).
 */
export async function setPlanBenefits(
  venueId: number,
  planId: number,
  input: {
    ratePercent?: unknown;
    aheadDays?: unknown;
    scope?: unknown;
    offeredFor?: unknown;
    familyLimit?: unknown;
    coverSwaps?: unknown;
    extendOnSuspension?: unknown;
    admitsEntry?: unknown;
    admitsEntrySport?: unknown;
    confirmAboveMemberRate?: unknown;
  }
): Promise<PlanResult> {
  const benefits = readBenefits(input);
  if (typeof benefits === "string") return { ok: false, error: benefits };
  const current = await planById(planId);
  if (!current || current.venueId !== venueId) return { ok: false, error: "That plan is not offered here." };
  // Not said: whom it is sold to stays as it is. Memberships already sold keep whom they cover.
  const holders = readHolders(input, current);
  if (typeof holders === "string") return { ok: false, error: holders };
  // Not said: whether a suspension extends its memberships stays as it is.
  const extendOnSuspension = readExtends(input, current.extendOnSuspension);
  if (typeof extendOnSuspension === "string") return { ok: false, error: extendOnSuspension };
  // Not said: whether its members come in with no booking stays as it is.
  const admits = await readAdmits(input, current);
  if (typeof admits === "string") return { ok: false, error: admits };
  // A share above a member rate is asked about only when this edit moves it up or changes it: a plan already so is not nagged.
  if (benefits.ratePercent !== current.ratePercent) {
    const ask = await aboveRefusal(venueId, benefits.ratePercent, input.confirmAboveMemberRate);
    if (ask) return ask;
  }
  // Not said: what the price covers stays as it is. The version goes up, in the same statement, when a benefit a
  // membership carries changes (every SET expression reads the row as it was).
  const scope = input.scope === undefined || input.scope === null ? null : benefits.scope;
  const done = await getDb()
    .prepare(
      `UPDATE membership_plans SET rate_percent = ?, ahead_days = ?, scope = COALESCE(?, scope), offered_for = ?, family_limit = ?, cover_swaps = ?, extend_on_suspension = ?, admits_entry = ?, admits_entry_sport = ?,
              version = CASE WHEN rate_percent IS DISTINCT FROM ?::int OR ahead_days IS DISTINCT FROM ?::int OR scope IS DISTINCT FROM COALESCE(?::text, scope)
                               OR extend_on_suspension IS DISTINCT FROM ?::boolean OR admits_entry IS DISTINCT FROM ?::boolean
                               OR (?::boolean AND admits_entry_sport IS DISTINCT FROM ?::text) THEN version + 1 ELSE version END
        WHERE id = ? AND venue_id = ? AND retired_at IS NULL`
    )
    .run(
      benefits.ratePercent, benefits.aheadDays, scope, holders.offeredFor, holders.familyLimit, holders.coverSwaps, extendOnSuspension, admits.admitsEntry, admits.admitsEntrySport,
      benefits.ratePercent, benefits.aheadDays, scope, extendOnSuspension, admits.admitsEntry, admits.admitsEntry, admits.admitsEntrySport,
      planId, venueId
    );
  if (done.changes !== 1) return { ok: false, error: "That plan is not offered here." };
  return { ok: true, plan: (await planById(planId))! };
}

/**
 * The furthest ahead any plan's members book here, for the venue's outer window: the plans on offer, and the terms already
 * sold that are still running with the window they were sold with (ADR 0071), so a plan edited down never shuts a member out
 * of what they paid for. A row with no snapshot counts as its plan is.
 */
export async function longestPlanWindow(venueId: number): Promise<number | null> {
  const row = (await getDb()
    .prepare(
      `SELECT GREATEST(
         (SELECT MAX(ahead_days) FROM membership_plans WHERE venue_id = ? AND retired_at IS NULL),
         (SELECT MAX(CASE WHEN m.benefits IS NULL THEN t.ahead_days ELSE (m.benefits->>'aheadDays')::int END)
            FROM memberships m LEFT JOIN membership_plans t ON t.id = m.tier_id
           WHERE ${inSameBusiness("m.venue_id")} AND m.status = 'active' AND m.expires_on >= ?)
       ) AS n`
    )
    .get(venueId, venueId, todayISO())) as { n: number | null } | undefined;
  return row?.n ?? null;
}

export async function createPlan(
  venueId: number,
  input: {
    name: unknown;
    months: unknown;
    price: unknown;
    ratePercent?: unknown;
    aheadDays?: unknown;
    scope?: unknown;
    offeredFor?: unknown;
    familyLimit?: unknown;
    coverSwaps?: unknown;
    extendOnSuspension?: unknown;
    admitsEntry?: unknown;
    admitsEntrySport?: unknown;
    confirmAboveMemberRate?: unknown;
  }
): Promise<PlanResult> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 2 || name.length > 60) return { ok: false, error: "Give the plan a name of 2–60 characters." };
  if (!Number.isInteger(input.months) || (input.months as number) < 1 || (input.months as number) > MAX_PLAN_MONTHS)
    return { ok: false, error: `A plan runs 1–${MAX_PLAN_MONTHS} months.` };
  if (!isAmount(input.price, 1, 100000))
    return { ok: false, error: `The fee is at least ${money(1)}, to the ${region().currency.minor}. Free memberships are given at the counter.` };
  if ((await listPlans(venueId)).length >= MAX_PLANS_PER_VENUE)
    return { ok: false, error: `A venue offers up to ${MAX_PLANS_PER_VENUE} plans. Retire one first.` };
  const benefits = readBenefits(input);
  if (typeof benefits === "string") return { ok: false, error: benefits };
  const holders = readHolders(input, { offeredFor: "account", familyLimit: null, coverSwaps: 0 });
  if (typeof holders === "string") return { ok: false, error: holders };
  const extendOnSuspension = readExtends(input, false);
  if (typeof extendOnSuspension === "string") return { ok: false, error: extendOnSuspension };
  const admits = await readAdmits(input, { admitsEntry: false, admitsEntrySport: null });
  if (typeof admits === "string") return { ok: false, error: admits };
  const ask = await aboveRefusal(venueId, benefits.ratePercent, input.confirmAboveMemberRate);
  if (ask) return ask;
  const info = await getDb()
    .prepare(
      "INSERT INTO membership_plans (venue_id, name, months, price, rate_percent, ahead_days, scope, offered_for, family_limit, cover_swaps, extend_on_suspension, admits_entry, admits_entry_sport) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(venueId, name, input.months, input.price, benefits.ratePercent, benefits.aheadDays, benefits.scope, holders.offeredFor, holders.familyLimit, holders.coverSwaps, extendOnSuspension, admits.admitsEntry, admits.admitsEntrySport);
  return { ok: true, plan: (await planById(Number(info.lastInsertRowid)))! };
}

/** Stop offering a plan. Memberships already bought on it run their course. */
export async function retirePlan(venueId: number, planId: number): Promise<boolean> {
  const done = await getDb()
    .prepare("UPDATE membership_plans SET retired_at = datetime('now') WHERE id = ? AND venue_id = ? AND retired_at IS NULL")
    .run(planId, venueId);
  return done.changes === 1;
}

/** Calendar months on, held to the end of a shorter month: 31 Jan + 1 is 28 Feb. */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

export interface JoinTerms {
  plan: MembershipPlan;
  phone: string;
  startsOn: string;
  expiresOn: string;
  /** Running on from a membership they already hold. */
  renewing: boolean;
}

/**
 * What this account would get on this plan if it paid now: from today, or
 * from the day after the membership it already holds here (or anywhere in the
 * same business, where one membership covers every branch). For a
 * participant it acts for (`holderParticipantId`), the participant's own
 * membership is the one run on from; who may buy for whom is
 * lib/membership-purchases.ts.
 */
export async function joinTerms(
  userId: number,
  planId: number,
  /**
   * `retired`: a plan no longer offered still sells (a fee already paid).
   * `renewal`: a subscription charging for the next period, which runs on
   * from the last whenever its charge comes in.
   */
  opts: { retired?: boolean; renewal?: boolean; holderParticipantId?: number | null } = {}
): Promise<{ ok: true; terms: JoinTerms } | Refusal> {
  const plan = await planById(planId, opts);
  if (!plan) return refuse("JOIN_NO_PLAN");
  const phone = await accountPhone(userId);
  if (!phone) return refuse("JOIN_NO_PHONE");
  const today = todayISO();
  const participant = opts.holderParticipantId ?? null;
  const held = (await getDb()
    .prepare(
      `SELECT m.holder_phone, m.expires_on FROM memberships m
        WHERE ${inSameBusiness("m.venue_id")} AND m.status = 'active' AND m.expires_on >= ?
          AND ${participant === null ? "m.holder_kind = 'customer'" : "m.holder_kind = 'participant' AND m.holder_participant_id = ?"}`
    )
    .all(plan.venueId, today, ...(participant === null ? [] : [participant]))) as { holder_phone: string; expires_on: string }[];
  const digits = normalisePhone(phone);
  const until = held
    .filter((r) => participant !== null || normalisePhone(r.holder_phone) === digits)
    .map((r) => r.expires_on)
    .sort()
    .pop();
  if (until && !opts.renewal) {
    const opens = addDays(until, -RENEW_WINDOW_DAYS);
    if (today < opens) return refuse("JOIN_TOO_EARLY", { until, from: opens });
  }
  const startsOn = until ? addDays(until, 1) : today;
  const expiresOn = addDays(addMonths(startsOn, plan.months), -1);
  return { ok: true, terms: { plan, phone, startsOn, expiresOn, renewing: Boolean(until) } };
}
