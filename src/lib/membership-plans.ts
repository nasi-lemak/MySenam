import { getDb } from "./db";
import { accountPhone } from "./access";
import { errorText, translator, type ErrorCode } from "./i18n";
import { inSameBusiness } from "./branches";
import { normalisePhone } from "./store";
import { addDays, todayISO } from "./time";
import type { Refusal } from "./types";

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
}

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
}

const toPlan = (r: PlanRow): MembershipPlan => ({
  id: r.id,
  venueId: r.venue_id,
  name: r.name,
  months: r.months,
  price: Number(r.price),
});

/** The plans a venue has on offer, cheapest first. */
export async function listPlans(venueId: number): Promise<MembershipPlan[]> {
  const rows = (await getDb()
    .prepare(
      "SELECT id, venue_id, name, months, price::float AS price FROM membership_plans WHERE venue_id = ? AND retired_at IS NULL ORDER BY months, price, id"
    )
    .all(venueId)) as PlanRow[];
  return rows.map(toPlan);
}

export async function planById(id: number, opts: { retired?: boolean } = {}): Promise<MembershipPlan | null> {
  const row = (await getDb()
    .prepare(
      `SELECT id, venue_id, name, months, price::float AS price FROM membership_plans WHERE id = ?${opts.retired ? "" : " AND retired_at IS NULL"}`
    )
    .get(id)) as PlanRow | undefined;
  return row ? toPlan(row) : null;
}

export type PlanResult = { ok: true; plan: MembershipPlan } | { ok: false; error: string };

export async function createPlan(venueId: number, input: { name: unknown; months: unknown; price: unknown }): Promise<PlanResult> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 2 || name.length > 60) return { ok: false, error: "Give the plan a name of 2–60 characters." };
  if (!Number.isInteger(input.months) || (input.months as number) < 1 || (input.months as number) > MAX_PLAN_MONTHS)
    return { ok: false, error: `A plan runs 1–${MAX_PLAN_MONTHS} months.` };
  if (!Number.isInteger(input.price) || (input.price as number) < 1 || (input.price as number) > 100000)
    return { ok: false, error: "The fee is a whole number of ringgit, at least RM1. Free memberships are given at the counter." };
  if ((await listPlans(venueId)).length >= MAX_PLANS_PER_VENUE)
    return { ok: false, error: `A venue offers up to ${MAX_PLANS_PER_VENUE} plans. Retire one first.` };
  const info = await getDb()
    .prepare("INSERT INTO membership_plans (venue_id, name, months, price) VALUES (?, ?, ?, ?)")
    .run(venueId, name, input.months, input.price);
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
 * same business, where one membership covers every branch).
 */
export async function joinTerms(
  userId: number,
  planId: number,
  opts: { retired?: boolean } = {}
): Promise<{ ok: true; terms: JoinTerms } | Refusal> {
  const plan = await planById(planId, opts);
  if (!plan) return refuse("JOIN_NO_PLAN");
  const phone = await accountPhone(userId);
  if (!phone) return refuse("JOIN_NO_PHONE");
  const today = todayISO();
  const held = (await getDb()
    .prepare(
      `SELECT m.holder_phone, m.expires_on FROM memberships m
        WHERE ${inSameBusiness("m.venue_id")} AND m.status = 'active' AND m.expires_on >= ?`
    )
    .all(plan.venueId, today)) as { holder_phone: string; expires_on: string }[];
  const digits = normalisePhone(phone);
  const until = held
    .filter((r) => normalisePhone(r.holder_phone) === digits)
    .map((r) => r.expires_on)
    .sort()
    .pop();
  if (until) {
    const opens = addDays(until, -RENEW_WINDOW_DAYS);
    if (today < opens) return refuse("JOIN_TOO_EARLY", { until, from: opens });
  }
  const startsOn = until ? addDays(until, 1) : today;
  const expiresOn = addDays(addMonths(startsOn, plan.months), -1);
  return { ok: true, terms: { plan, phone, startsOn, expiresOn, renewing: Boolean(until) } };
}
