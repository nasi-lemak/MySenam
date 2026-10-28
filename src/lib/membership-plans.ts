import { getDb } from "./db";
import { accountPhone } from "./access";
import { errorText, translator, type ErrorCode } from "./i18n";
import { inSameBusiness } from "./branches";
import { normalisePhone } from "./store";
import { addDays, todayISO } from "./time";
import { MAX_MEMBERSHIP_COVERS, type BenefitScope, type Refusal } from "./types";
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
}

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
});

const PLAN_COLUMNS = "id, venue_id, name, months, price::float AS price, rate_percent, ahead_days, scope, offered_for, family_limit, cover_swaps, extend_on_suspension";

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

export type PlanResult = { ok: true; plan: MembershipPlan } | { ok: false; error: string };

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

/** Change a plan's benefits. Memberships already on it get them from now. */
export async function setPlanBenefits(
  venueId: number,
  planId: number,
  input: { ratePercent?: unknown; aheadDays?: unknown; scope?: unknown; offeredFor?: unknown; familyLimit?: unknown; coverSwaps?: unknown; extendOnSuspension?: unknown }
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
  // Not said: what the price covers stays as it is.
  const done = await getDb()
    .prepare(
      "UPDATE membership_plans SET rate_percent = ?, ahead_days = ?, scope = COALESCE(?, scope), offered_for = ?, family_limit = ?, cover_swaps = ?, extend_on_suspension = ? WHERE id = ? AND venue_id = ? AND retired_at IS NULL"
    )
    .run(benefits.ratePercent, benefits.aheadDays, input.scope === undefined || input.scope === null ? null : benefits.scope, holders.offeredFor, holders.familyLimit, holders.coverSwaps, extendOnSuspension, planId, venueId);
  if (done.changes !== 1) return { ok: false, error: "That plan is not offered here." };
  return { ok: true, plan: (await planById(planId))! };
}

/** The furthest ahead any plan's members book here, for the venue's outer window. */
export async function longestPlanWindow(venueId: number): Promise<number | null> {
  const row = (await getDb()
    .prepare("SELECT MAX(ahead_days) AS n FROM membership_plans WHERE venue_id = ? AND retired_at IS NULL")
    .get(venueId)) as { n: number | null } | undefined;
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
  const info = await getDb()
    .prepare(
      "INSERT INTO membership_plans (venue_id, name, months, price, rate_percent, ahead_days, scope, offered_for, family_limit, cover_swaps, extend_on_suspension) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(venueId, name, input.months, input.price, benefits.ratePercent, benefits.aheadDays, benefits.scope, holders.offeredFor, holders.familyLimit, holders.coverSwaps, extendOnSuspension);
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
