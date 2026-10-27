import { getDb, withTransaction } from "./db";
import { inSameBusiness } from "./branches";
import { errorText, translator } from "./i18n";
import { joinTerms, planById, type JoinTerms } from "./membership-plans";
import { guardianshipOf, participantEvent, refused, type ParticipantRefusal } from "./participants";
import type { Named } from "./participant-bookings";
import { membershipById, sellMembership } from "./store";
import { todayISO } from "./time";
import { MAX_MEMBERSHIP_COVERS, type Membership } from "./types";

/**
 * Memberships bought online for somebody (docs/features/pricing.md#joining-online;
 * ADR 0025): for the account holder themself, for a participant the account
 * is an active guardian of (a child's own membership, with no account of the
 * child's), or a family membership naming the dependants it covers.
 *
 * It adds no membership model of its own. What is sold is a membership as
 * the counter sells it (lib/store.ts `sellMembership`: `holder_participant_id`,
 * `membership_participants`), paid through the venue's gateway as every
 * online membership is (lib/payments.ts). This module says who may be named,
 * and keeps what was chosen with the payment until it settles
 * (`membership_purchases`, migration 0168):
 *
 * - **Whom a plan is for** is the plan's (`offered_for`, migration 0167):
 *   the account, a participant, either, or a family (the account and up to
 *   `family_limit` dependants, at most 12).
 * - **Only people the account acts for now**: an active relationship, not
 *   paused for a review, archived or revoked. Somebody whose guardian request
 *   is still waiting is nobody's dependant yet. Nothing is inferred from a
 *   shared number or surname. Ages and categories are as declared; plans
 *   have no rule of their own about them.
 * - **Nobody covered twice**: a person who already holds, or is covered by,
 *   a membership for any of those days is refused with the date it ends.
 * - **Price and dates before paying**, and **never active unpaid**: the
 *   membership is made when the money is in, its dates worked out then; a
 *   purchase waits `pending`, holding the people it names for
 *   `HOLD_MINUTES`, and is `released` when the payment fails or the hold
 *   lapses. Settling twice makes one membership.
 * - **Renewing by itself** names the same holder and dependants again, as the
 *   membership it runs on from names them then, less anybody the account no
 *   longer acts for.
 * - **Dependants changed** on a family membership: added within the plan's
 *   limit, or removed, by the account that bought it. A family plan's price
 *   is the same however many it covers, and nothing is prorated: no charge
 *   for adding, nothing back for removing.
 */

/** How long a purchase waiting on its payment holds the people it names. */
export const HOLD_MINUTES = 60;

export type PurchaseStatus = "pending" | "made" | "released" | "owed_back";

export interface PurchaseRequest {
  planId: number;
  /** A participant's own membership; null or absent: the account holder's (or, on a family plan, the family's). */
  participantId?: number | null;
  /** The dependants a family membership covers besides the account holder. */
  covers?: number[];
}

export interface PurchaseTerms extends JoinTerms {
  /** Whose it is: the account holder (null) or this participant. */
  holder: Named | null;
  covers: Named[];
  price: number;
}

const ENGLISH = translator("en");
type Result<T> = ({ ok: true } & T) | ParticipantRefusal;

/** `{ planId, participantId?, covers? }` as a request gives it. */
export function readPurchaseRequest(body: Record<string, unknown> | null): PurchaseRequest | ParticipantRefusal {
  if (!body || !Number.isInteger(body.planId)) return refused("MBO_REQUEST", "planId is required.");
  const pid = body.participantId;
  if (pid !== undefined && pid !== null && !(Number.isInteger(pid) && (pid as number) > 0))
    return refused("MBO_REQUEST", "participantId is a participant's id.");
  const covers = body.covers ?? [];
  if (!Array.isArray(covers) || !covers.every((x) => Number.isInteger(x) && x > 0))
    return refused("MBO_REQUEST", "covers is a list of participant ids.");
  if (new Set(covers).size !== covers.length) return refused("MBO_REQUEST", "Name each person once.");
  if (covers.length > MAX_MEMBERSHIP_COVERS)
    return refused("MBO_FAMILY_LIMIT", `This plan covers up to ${MAX_MEMBERSHIP_COVERS} people besides you.`, 409, { n: MAX_MEMBERSHIP_COVERS });
  return { planId: body.planId as number, participantId: (pid as number | null | undefined) ?? null, covers: covers as number[] };
}

/**
 * The account acts for this participant now: an active relationship, not
 * paused, archived or revoked. Said apart when it is paused for a review.
 */
async function actsFor(userId: number, participantId: number): Promise<Named | ParticipantRefusal> {
  const mine = await guardianshipOf(userId, participantId, { live: true });
  if (mine) return { id: mine.participant.id, name: mine.participant.displayName };
  const paused = (await getDb()
    .prepare(
      `SELECT p.display_name FROM participant_guardians g JOIN participants p ON p.id = g.participant_id
        WHERE g.user_id = ? AND g.participant_id = ? AND g.revoked_at IS NULL AND g.archived_at IS NULL AND g.suspended_at IS NOT NULL LIMIT 1`
    )
    .get(userId, participantId)) as { display_name: string } | undefined;
  if (paused)
    return refused(
      "MBO_PAUSED",
      `Your relationship with ${paused.display_name} is paused for a review, so you cannot buy them a membership now.`,
      409,
      { name: paused.display_name }
    );
  return refused("MBO_NOT_GUARDIAN", "You can buy a membership only for somebody you look after.", 404);
}

/**
 * A membership this participant holds or is covered by for any day of
 * `from`–`to`, here or anywhere in the same business: the day it ends.
 * `except`: a membership whose own cover is being changed.
 */
export async function coveredUntil(venueId: number, participantId: number, from: string, to: string, except: number | null = null): Promise<string | null> {
  const row = (await getDb()
    .prepare(
      `SELECT MAX(m.expires_on) AS until FROM memberships m
        WHERE ${inSameBusiness("m.venue_id")} AND m.status = 'active' AND m.starts_on <= ? AND m.expires_on >= ? AND m.id <> ?
          AND (m.holder_participant_id = ? OR EXISTS (SELECT 1 FROM membership_participants mp WHERE mp.membership_id = m.id AND mp.participant_id = ?))`
    )
    .get(venueId, to, from, except ?? 0, participantId, participantId)) as { until: string | null } | undefined;
  return row?.until ?? null;
}

/**
 * What this account would buy, for whom, from when to when and for how much,
 * if it paid now; or why it cannot. Settling a payment asks again (`paid`):
 * the plan as it was sold (retired since, or its holders or limit changed,
 * still gives what was paid for), the people checked again, the dates
 * worked out afresh. On a renewal (`dropLapsed`) a dependant the account no
 * longer acts for is left off rather than refusing the others.
 */
export async function purchaseTerms(
  userId: number,
  request: PurchaseRequest,
  opts: { paid?: boolean; renewal?: boolean; dropLapsed?: boolean } = {}
): Promise<Result<{ terms: PurchaseTerms }>> {
  const plan = await planById(request.planId, { retired: opts.paid });
  if (!plan) return refused("JOIN_NO_PLAN", errorText(ENGLISH, "JOIN_NO_PLAN"), 409);
  const covers = [...new Set(request.covers ?? [])];
  const pid = request.participantId ?? null;
  if (!opts.paid) {
    if (pid !== null && plan.offeredFor !== "participant" && plan.offeredFor !== "individual")
      return refused("MBO_NOT_FOR_PARTICIPANT", "This plan is not sold for somebody you look after.", 409);
    if (pid === null && plan.offeredFor === "participant")
      return refused("MBO_NOT_FOR_ACCOUNT", "This plan is for somebody you look after. Choose who it is for.", 409);
    if (covers.length > 0 && plan.offeredFor !== "family") return refused("MBO_NOT_FAMILY", "This plan is for one person.", 409);
    if (plan.offeredFor === "family" && covers.length === 0)
      return refused("MBO_FAMILY_EMPTY", "Choose who the family membership covers besides you.", 409);
    if (plan.familyLimit !== null && covers.length > plan.familyLimit)
      return refused("MBO_FAMILY_LIMIT", `This plan covers up to ${plan.familyLimit} people besides you.`, 409, { n: plan.familyLimit });
  }
  if (covers.length > MAX_MEMBERSHIP_COVERS)
    return refused("MBO_FAMILY_LIMIT", `This plan covers up to ${MAX_MEMBERSHIP_COVERS} people besides you.`, 409, { n: MAX_MEMBERSHIP_COVERS });

  let holder: Named | null = null;
  if (pid !== null) {
    const who = await actsFor(userId, pid);
    if ("ok" in who) return who;
    holder = who;
  }
  const covered: Named[] = [];
  for (const id of covers) {
    const who = await actsFor(userId, id);
    if ("ok" in who) {
      if (opts.dropLapsed) continue;
      return who;
    }
    covered.push(who);
  }

  const joining = await joinTerms(userId, plan.id, { retired: opts.paid, renewal: opts.renewal, holderParticipantId: pid });
  if (!joining.ok) {
    // A participant's own membership runs on from theirs, said with their name.
    if (holder && joining.code === "JOIN_TOO_EARLY")
      return refused(
        "MBO_TOO_EARLY",
        `${holder.name}'s membership here runs until ${joining.vars?.until}. You can renew it online from ${joining.vars?.from}.`,
        409,
        { name: holder.name, until: String(joining.vars?.until), from: String(joining.vars?.from) }
      );
    return refused(joining.code ?? "JOIN_NO_PLAN", joining.error, 409, joining.vars);
  }
  const { startsOn, expiresOn } = joining.terms;
  for (const p of [...(holder ? [holder] : []), ...covered]) {
    const until = await coveredUntil(plan.venueId, p.id, startsOn, expiresOn);
    if (until)
      return refused("MBO_ALREADY_COVERED", `${p.name} is already a member here until ${until}.`, 409, { name: p.name, until });
  }
  return { ok: true, terms: { ...joining.terms, holder, covers: covered, price: plan.price } };
}

interface PurchaseRow {
  id: number;
  payment_id: number | null;
  venue_id: number;
  plan_id: number | null;
  user_id: number | null;
  holder_kind: "customer" | "participant";
  holder_participant_id: number | null;
  auto_renew: boolean | number;
  status: PurchaseStatus;
  hold_until: unknown;
  url?: string | null;
  covers?: string | null;
  minutes_left?: number | null;
}

const coversKey = (ids: number[]) => [...ids].sort((a, b) => a - b).join(",");

/**
 * Keep a purchase waiting on its payment, holding the people it names, before
 * the payment page is opened. The same purchase already waiting (the same
 * plan, holder, dependants and renewal) is sent back to its page; another
 * naming any of the same people is refused until it settles, fails or lapses.
 */
export async function holdPurchase(
  userId: number,
  terms: PurchaseTerms,
  autoRenew: boolean
): Promise<Result<{ reuse: string } | { purchaseId: number }>> {
  return withTransaction(async () => {
    const db = getDb();
    await db
      .prepare("UPDATE membership_purchases SET status = 'released', why = 'expired', settled_at = now() WHERE status = 'pending' AND hold_until <= now()")
      .run();
    const people = [...(terms.holder ? [terms.holder.id] : []), ...terms.covers.map((c) => c.id)];
    const marks = people.map(() => "?").join(", ");
    const clash = (await db
      .prepare(
        `SELECT pu.*, op.url,
                (SELECT string_agg(x.participant_id::text, ',' ORDER BY x.participant_id) FROM membership_purchase_participants x WHERE x.purchase_id = pu.id) AS covers,
                CEIL(EXTRACT(EPOCH FROM (pu.hold_until - now())) / 60)::int AS minutes_left
           FROM membership_purchases pu LEFT JOIN online_payments op ON op.id = pu.payment_id
          WHERE pu.status = 'pending' AND ${inSameBusiness("pu.venue_id")}
            AND ((pu.holder_kind = 'customer' AND ? = 1 AND pu.user_id = ?)
                 ${people.length > 0 ? `OR pu.holder_participant_id IN (${marks})
                 OR EXISTS (SELECT 1 FROM membership_purchase_participants x WHERE x.purchase_id = pu.id AND x.participant_id IN (${marks}))` : ""})
          ORDER BY pu.id DESC LIMIT 1`
      )
      .get(terms.plan.venueId, terms.holder ? 0 : 1, userId, ...people, ...people)) as PurchaseRow | undefined;
    if (clash) {
      const same =
        clash.user_id === userId &&
        clash.plan_id === terms.plan.id &&
        (clash.holder_participant_id ?? null) === (terms.holder?.id ?? null) &&
        (clash.covers ?? "") === coversKey(terms.covers.map((c) => c.id)) &&
        Boolean(clash.auto_renew) === autoRenew &&
        Boolean(clash.url);
      if (same) return { ok: true, reuse: clash.url! };
      const n = Math.max(1, clash.minutes_left ?? HOLD_MINUTES);
      return refused("MBO_PENDING", `A payment for a membership naming the same people is still open. Finish it, or try again in ${n} minutes.`, 409, { n });
    }
    const made = (await db
      .prepare(
        `INSERT INTO membership_purchases (venue_id, plan_id, user_id, holder_kind, holder_participant_id, quoted_starts_on, quoted_expires_on, price, auto_renew, hold_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, now() + interval '${HOLD_MINUTES} minutes') RETURNING id`
      )
      .get(
        terms.plan.venueId,
        terms.plan.id,
        userId,
        terms.holder ? "participant" : "customer",
        terms.holder?.id ?? null,
        terms.startsOn,
        terms.expiresOn,
        terms.price,
        autoRenew
      )) as { id: number };
    for (const c of terms.covers)
      await db.prepare("INSERT INTO membership_purchase_participants (purchase_id, participant_id) VALUES (?, ?)").run(made.id, c.id);
    return { ok: true, purchaseId: made.id };
  });
}

/** The payment page a purchase is paid on, once it is open. */
export async function attachPayment(purchaseId: number, paymentId: number): Promise<void> {
  await getDb().prepare("UPDATE membership_purchases SET payment_id = ? WHERE id = ?").run(paymentId, purchaseId);
}

/** A purchase that holds nobody any more: its page could not be opened, or its payment failed or lapsed. */
export async function releasePurchase(purchaseId: number, why: string): Promise<void> {
  await getDb()
    .prepare("UPDATE membership_purchases SET status = 'released', why = ?, settled_at = now() WHERE id = ? AND status = 'pending'")
    .run(why, purchaseId);
}

/** The gateway said a payment was not made: its purchase holds nobody now. Money that comes in later still settles it. */
export async function releaseForPayment(paymentId: number, why = "not_paid"): Promise<void> {
  await getDb()
    .prepare("UPDATE membership_purchases SET status = 'released', why = ?, settled_at = now() WHERE payment_id = ? AND status = 'pending'")
    .run(why, paymentId);
}

/**
 * Who a renewal charge is for: the holder and dependants of the membership
 * its subscription made last, as that membership names them now. Null when
 * there is nobody it can be for (the participant's record was erased).
 */
async function renewalRequest(subscriptionId: string): Promise<{ participantId: number | null; covers: number[] } | null> {
  const row = (await getDb()
    .prepare(
      `SELECT m.id, m.holder_kind, m.holder_participant_id FROM membership_subscriptions s JOIN memberships m ON m.id = s.membership_id
        WHERE s.subscription_id = ?`
    )
    .get(subscriptionId)) as { id: number; holder_kind: string; holder_participant_id: number | null } | undefined;
  // Every subscription before memberships named anybody: the account holder's own.
  if (!row) return { participantId: null, covers: [] };
  if (row.holder_kind === "participant" && row.holder_participant_id === null) return null;
  const covers = (await getDb()
    .prepare("SELECT participant_id FROM membership_participants WHERE membership_id = ? ORDER BY participant_id")
    .all(row.id)) as { participant_id: number }[];
  return { participantId: row.holder_kind === "participant" ? row.holder_participant_id : null, covers: covers.map((c) => c.participant_id) };
}

/**
 * The membership a settled payment buys, made now, in the paying transaction:
 * for whom its purchase names (or, for a renewal charge, whom the membership
 * it runs on from names), its dates worked out now. Null, and the purchase
 * marked owed back with the reason, when it can buy nothing any more.
 */
export async function membershipForPayment(
  payment: { id: number; member_user_id?: number | null; membership_plan_id?: number | null; amount: number; subscription_id?: string | null },
  paidVia: string | undefined
): Promise<number | null> {
  if (!payment.member_user_id || !payment.membership_plan_id) return null;
  const db = getDb();
  const purchase = (await db.prepare("SELECT * FROM membership_purchases WHERE payment_id = ?").get(payment.id)) as PurchaseRow | undefined;
  const owed = async (why: string) => {
    if (purchase)
      await db
        .prepare("UPDATE membership_purchases SET status = 'owed_back', why = ?, settled_at = now() WHERE id = ? AND status IN ('pending', 'released')")
        .run(why, purchase.id);
    return null;
  };
  const renewal = Boolean(payment.subscription_id);
  let request: { participantId: number | null; covers: number[] } | null;
  if (purchase) {
    if (purchase.holder_kind === "participant" && purchase.holder_participant_id === null) return owed("MBO_GONE");
    const covers = (await db
      .prepare("SELECT participant_id FROM membership_purchase_participants WHERE purchase_id = ? ORDER BY participant_id")
      .all(purchase.id)) as { participant_id: number }[];
    request = { participantId: purchase.holder_participant_id, covers: covers.map((c) => c.participant_id) };
  } else if (renewal) request = await renewalRequest(payment.subscription_id!);
  else request = { participantId: null, covers: [] };
  if (!request) return owed("MBO_GONE");

  const userId = payment.member_user_id;
  const bought = await purchaseTerms(userId, { planId: payment.membership_plan_id, ...request }, { paid: true, renewal, dropLapsed: renewal });
  if (!bought.ok) return owed(bought.code);
  const { plan, phone, startsOn, expiresOn, holder, covers } = bought.terms;
  const user = (await db.prepare("SELECT name FROM users WHERE id = ?").get(userId)) as { name: string } | undefined;
  if (!user) return owed("MBO_GONE");
  const sold = await sellMembership({
    venueId: plan.venueId,
    holderName: user.name,
    holderPhone: phone,
    startsOn,
    expiresOn,
    // What they paid, which a plan's later price change does not rewrite.
    price: Math.round(Number(payment.amount) * 100) / 100,
    userId,
    planId: plan.id,
    paidVia,
    holderParticipantId: holder?.id ?? null,
    covers: covers.map((c) => c.id),
  });
  if (!sold.ok) return owed(sold.code ?? sold.error.slice(0, 200));
  const membership = sold.membership;
  if (purchase)
    await db
      .prepare("UPDATE membership_purchases SET status = 'made', why = NULL, membership_id = ?, settled_at = now() WHERE id = ?")
      .run(membership.id, purchase.id);
  // In each person's own history: who bought it for them, where, and which membership.
  for (const p of [...(holder ? [holder] : []), ...covers])
    await participantEvent(p.id, renewal ? "membership.renewed" : "membership.bought", { userId, name: user.name }, {
      venueId: plan.venueId,
      detail: `online: ${membership.code}, ${startsOn} to ${expiresOn}${holder?.id === p.id ? "" : ", covered by a family membership"}`,
    });
  return membership.id;
}

/**
 * Change whom a family membership covers, by the account that bought it:
 * the dependants it should name from now (added within its plan's limit,
 * each somebody the account acts for now and not covered elsewhere for the
 * days left; removed, whoever they are). The price stays as it was sold:
 * nothing is charged for adding, and nothing goes back for removing.
 */
export async function changeCovers(userId: number, membershipId: number, wanted: unknown): Promise<Result<{ membership: Membership }>> {
  if (!Array.isArray(wanted) || !wanted.every((x) => Number.isInteger(x) && x > 0) || new Set(wanted).size !== wanted.length)
    return refused("MBO_REQUEST", "covers is a list of participant ids, each once.");
  const ids = wanted as number[];
  return withTransaction(async () => {
    const db = getDb();
    // One change to a membership's cover at a time: two at once would each count the others out.
    const m = (await db
      .prepare(
        `SELECT id, venue_id, user_id, holder_kind, status, expires_on, COALESCE(plan_id, tier_id) AS plan FROM memberships
          WHERE id = ? AND user_id = ? FOR UPDATE`
      )
      .get(membershipId, userId)) as
      | { id: number; venue_id: number; user_id: number; holder_kind: string; status: string; expires_on: string; plan: number | null }
      | undefined;
    if (!m) return refused("MBO_NOT_YOURS", "That is not one of your memberships.", 404);
    const plan = m.plan ? await planById(m.plan, { retired: true }) : null;
    if (m.holder_kind !== "customer" || !plan || plan.offeredFor !== "family" || plan.familyLimit === null)
      return refused("MBO_NOT_CHANGEABLE", "Only a family membership bought online names people you can change. Ask the venue.", 409);
    const today = todayISO();
    if (m.status !== "active" || m.expires_on < today) return refused("MBO_ENDED", "This membership has ended.", 409);
    if (ids.length > Math.min(plan.familyLimit, MAX_MEMBERSHIP_COVERS))
      return refused("MBO_FAMILY_LIMIT", `This plan covers up to ${plan.familyLimit} people besides you.`, 409, { n: plan.familyLimit });
    const now = ((await db.prepare("SELECT participant_id FROM membership_participants WHERE membership_id = ?").all(m.id)) as { participant_id: number }[]).map(
      (r) => r.participant_id
    );
    const added = ids.filter((id) => !now.includes(id));
    const removed = now.filter((id) => !ids.includes(id));
    const user = (await db.prepare("SELECT name FROM users WHERE id = ?").get(userId)) as { name: string };
    const named: Named[] = [];
    for (const id of added) {
      const who = await actsFor(userId, id);
      if ("ok" in who) return who;
      const until = await coveredUntil(m.venue_id, id, today, m.expires_on, m.id);
      if (until) return refused("MBO_ALREADY_COVERED", `${who.name} is already a member here until ${until}.`, 409, { name: who.name, until });
      named.push(who);
    }
    for (const id of removed) {
      await db.prepare("DELETE FROM membership_participants WHERE membership_id = ? AND participant_id = ?").run(m.id, id);
      await participantEvent(id, "membership.uncovered", { userId, name: user.name }, { venueId: m.venue_id, detail: `membership ${m.id}` });
    }
    for (const p of named) {
      await db.prepare("INSERT INTO membership_participants (membership_id, participant_id) VALUES (?, ?)").run(m.id, p.id);
      await participantEvent(p.id, "membership.covered", { userId, name: user.name }, { venueId: m.venue_id, detail: `membership ${m.id}, until ${m.expires_on}` });
    }
    // Somebody taken off it: their members' places from today on it no longer covers are flagged for staff (lib/membership-flags.ts).
    if (removed.length > 0) {
      const { flagAfterMembershipLoss } = await import("./membership-flags");
      await flagAfterMembershipLoss(m.id, "uncovered", removed);
    }
    return { ok: true, membership: (await membershipById(m.id))! };
  });
}

export interface Purchase {
  id: number;
  venueId: number;
  venueName: string;
  planName: string | null;
  /** The participant it is for; null: the account holder's own (or the family's). */
  holderName: string | null;
  covers: string[];
  price: number;
  startsOn: string;
  expiresOn: string;
  status: PurchaseStatus;
  /** Why it was released or owed back: a refusal's code, `expired`, `not_paid`, `checkout_failed`. */
  why: string | null;
  createdAt: string;
}

const PURCHASE_SELECT = `
  SELECT pu.id, pu.venue_id, v.name AS venue_name, pl.name AS plan_name, hp.display_name AS holder_name,
         (SELECT string_agg(cp.display_name, '|' ORDER BY cp.id) FROM membership_purchase_participants x JOIN participants cp ON cp.id = x.participant_id WHERE x.purchase_id = pu.id) AS covers,
         pu.price::float AS price, pu.quoted_starts_on, pu.quoted_expires_on,
         CASE WHEN pu.status = 'pending' AND pu.hold_until <= now() THEN 'released' ELSE pu.status END AS status,
         CASE WHEN pu.status = 'pending' AND pu.hold_until <= now() THEN 'expired' ELSE pu.why END AS why, pu.created_at
    FROM membership_purchases pu JOIN venues v ON v.id = pu.venue_id
    LEFT JOIN membership_plans pl ON pl.id = pu.plan_id
    LEFT JOIN participants hp ON hp.id = pu.holder_participant_id`;

/** This account's purchases still waiting on their payment. */
export async function pendingPurchasesFor(userId: number): Promise<Purchase[]> {
  const rows = (await getDb()
    .prepare(`${PURCHASE_SELECT} WHERE pu.user_id = ? AND pu.status = 'pending' AND pu.hold_until > now() ORDER BY pu.id DESC`)
    .all(userId)) as {
    id: number;
    venue_id: number;
    venue_name: string;
    plan_name: string | null;
    holder_name: string | null;
    covers: string | null;
    price: number;
    quoted_starts_on: string;
    quoted_expires_on: string;
    status: PurchaseStatus;
    why: string | null;
    created_at: unknown;
  }[];
  return rows.map((r) => ({
    id: r.id,
    venueId: r.venue_id,
    venueName: r.venue_name,
    planName: r.plan_name,
    holderName: r.holder_name,
    covers: r.covers ? r.covers.split("|") : [],
    price: Number(r.price),
    startsOn: r.quoted_starts_on,
    expiresOn: r.quoted_expires_on,
    status: r.status,
    why: r.why,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

/** Every membership purchase this account made, for its data export: structured records only. */
export async function purchasesExport(userId: number): Promise<unknown[]> {
  return (await getDb()
    .prepare(
      `SELECT v.name AS venue, pl.name AS plan, hp.display_name AS for_participant,
              (SELECT string_agg(cp.display_name, ', ' ORDER BY cp.id) FROM membership_purchase_participants x JOIN participants cp ON cp.id = x.participant_id WHERE x.purchase_id = pu.id) AS covers,
              pu.price, pu.quoted_starts_on, pu.quoted_expires_on, pu.auto_renew, pu.status, pu.why, pu.created_at, pu.settled_at
         FROM membership_purchases pu JOIN venues v ON v.id = pu.venue_id
         LEFT JOIN membership_plans pl ON pl.id = pu.plan_id
         LEFT JOIN participants hp ON hp.id = pu.holder_participant_id
        WHERE pu.user_id = ? ORDER BY pu.id`
    )
    .all(userId)) as unknown[];
}
