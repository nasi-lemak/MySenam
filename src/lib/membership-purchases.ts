import { getDb, withTransaction } from "./db";
import { inSameBusiness } from "./branches";
import { errorText, translator } from "./i18n";
import { addMonths, joinTerms, planById, type JoinTerms, type MembershipPlan } from "./membership-plans";
import { guardianshipOf, isRefusal, participantEvent, refused, type ParticipantRefusal } from "./participants";
import { selectionAtVenue, type Named } from "./participant-bookings";
import { membershipById, sellMembership } from "./store";
import { addDays, todayISO } from "./time";
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
 *   `HOLD_MINUTES` (or until the gateway's page closes by itself, where it
 *   can only close later: `attachPayment`), and is `released` when the
 *   payment fails or the hold lapses (`releaseLapsedPurchases`, on the
 *   scheduler's tick). A page that stays payable after that (Billplz) can
 *   still be paid: the money makes the membership if it still can, and is
 *   owed back otherwise. Settling twice makes one membership.
 * - **No scarce places are held**: plans have no cap on how many members
 *   they take, so a hold reserves nothing anybody else could buy; it only
 *   keeps a second purchase from naming the same people while the first is
 *   paid.
 * - **Renewing by itself** names the same holder and dependants again, as the
 *   membership it runs on from names them then, less anybody the account no
 *   longer acts for.
 * - **Dependants changed** on a family membership, by the plan's policy
 *   (the owner's decision of 27 October 2026; `changeCovers`): within one
 *   term the account that bought it may add people while the term has places
 *   left (its limit, plus the plan's `coverSwaps` for people put on in place
 *   of others, none by default), and take people off at any time; every
 *   person added uses a place for the rest of the term, so removing and
 *   re-adding cannot rotate more people through it. Anything else waits for
 *   the next term: named for it now where it renews by itself
 *   (`setNextCovers`), or chosen when it is renewed. A family plan's price is
 *   the same however many it covers, so adding within the places is free and
 *   nothing goes back for removing. A manager corrects a wrongly entered
 *   person with a reason (`correctCover`), using no place. Every change is a
 *   record of its own (`membership_cover_changes`), never an overwrite.
 * - **Another plan** (a tier change) takes effect at renewal: bought in the
 *   renewal window, it starts the day after the current one ends, at the new
 *   plan's price; nothing is prorated mid-term. One that renews by itself is
 *   stopped first, so the next term is not bought twice.
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
async function coveredUntil(venueId: number, participantId: number, from: string, to: string, except: number | null = null): Promise<string | null> {
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
  // Another plan, or the same one again, for somebody whose membership renews by itself: its
  // next term is already being bought, so a second would be bought twice. A change of plan
  // takes effect at renewal: stop it renewing, then buy the new plan, which starts when it ends.
  if (!opts.paid && (await renewsItself(userId, plan.venueId, pid)))
    return refused(
      "MBO_RENEWS",
      "That membership renews by itself. To change its plan, stop it renewing first: the new plan then starts the day after it ends.",
      409
    );

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

/** The membership this account bought for this holder here (the account's own: null) renews by itself. */
async function renewsItself(userId: number, venueId: number, participantId: number | null): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `SELECT 1 FROM membership_subscriptions s JOIN memberships m ON m.id = s.membership_id
        WHERE s.status = 'active' AND s.user_id = ? AND m.status = 'active' AND ${inSameBusiness("m.venue_id")}
          AND ${participantId === null ? "m.holder_kind = 'customer'" : "m.holder_kind = 'participant' AND m.holder_participant_id = ?"}
        LIMIT 1`
    )
    .get(userId, venueId, ...(participantId === null ? [] : [participantId]));
  return Boolean(row);
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
    await releaseLapsedPurchases();
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

/**
 * The payment page a purchase is paid on, once it is open. `pageMinutes`:
 * the gateway was asked to close the page that long after it opened it
 * (lib/payments.ts `startMembershipPayment`); the hold is kept at least until
 * then, so the page cannot be paid after the hold has let the people it
 * names go. Null: the page stays payable until it is paid (Billplz), and the
 * hold lapses after `HOLD_MINUTES` all the same: it reserves nothing scarce,
 * and money that still comes in is settled as late money (`membershipForPayment`).
 */
export async function attachPayment(purchaseId: number, paymentId: number, pageMinutes: number | null = null): Promise<void> {
  if (pageMinutes === null) {
    await getDb().prepare("UPDATE membership_purchases SET payment_id = ? WHERE id = ?").run(paymentId, purchaseId);
    return;
  }
  const minutes = Math.max(1, Math.round(pageMinutes));
  await getDb()
    .prepare(
      `UPDATE membership_purchases SET payment_id = ?, page_closes_at = now() + interval '${minutes} minutes',
              hold_until = GREATEST(hold_until, now() + interval '${minutes} minutes')
        WHERE id = ?`
    )
    .run(paymentId, purchaseId);
}

/**
 * Purchases whose hold has lapsed with no word from the gateway: released,
 * holding nobody. Never a membership: one is made only when money comes in,
 * which can still happen on a page that stays payable (it is then settled as
 * late money). On the scheduler's tick, and before any new hold.
 */
export async function releaseLapsedPurchases(): Promise<number> {
  const done = await getDb()
    .prepare("UPDATE membership_purchases SET status = 'released', why = 'expired', settled_at = now() WHERE status = 'pending' AND hold_until <= now()")
    .run();
  return done.changes;
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
 * its subscription made last, as that membership names them now, or as its
 * buyer chose for the next term (`setNextCovers`). Null when there is nobody
 * it can be for (the participant's record was erased).
 */
async function renewalRequest(subscriptionId: string): Promise<{ participantId: number | null; covers: number[] } | null> {
  const row = (await getDb()
    .prepare(
      `SELECT m.id, m.holder_kind, m.holder_participant_id, m.next_covers_at FROM membership_subscriptions s JOIN memberships m ON m.id = s.membership_id
        WHERE s.subscription_id = ?`
    )
    .get(subscriptionId)) as { id: number; holder_kind: string; holder_participant_id: number | null; next_covers_at: unknown } | undefined;
  // Every subscription before memberships named anybody: the account holder's own.
  if (!row) return { participantId: null, covers: [] };
  if (row.holder_kind === "participant" && row.holder_participant_id === null) return null;
  const covers = (await getDb()
    .prepare(
      `SELECT participant_id FROM ${row.next_covers_at ? "membership_next_covers" : "membership_participants"} WHERE membership_id = ? ORDER BY participant_id`
    )
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
  // A family membership keeps its plan's limit and replacements as sold, for the term it paid for.
  if (plan.offeredFor === "family" && plan.familyLimit !== null)
    await db.prepare("UPDATE memberships SET cover_limit = ?, cover_swaps = ? WHERE id = ?").run(plan.familyLimit, plan.coverSwaps, membership.id);
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

/** A membership as a change to whom it covers needs it, locked for the change. */
interface TermRow {
  id: number;
  code: string;
  venue_id: number;
  user_id: number | null;
  holder_kind: string;
  holder_phone: string;
  holder_participant_id: number | null;
  status: string;
  expires_on: string;
  plan: number | null;
  cover_limit: number | null;
  cover_swaps: number | null;
}
const TERM_COLUMNS =
  "id, code, venue_id, user_id, holder_kind, holder_phone, holder_participant_id, status, expires_on, COALESCE(plan_id, tier_id) AS plan, cover_limit, cover_swaps";

/**
 * The places a family membership's term has for the people it covers: its
 * limit, plus the plan's replacements (`coverSwaps`) as it was sold, less
 * every person named or put on in the term so far. Taking somebody off gives
 * no place back; a manager's correction uses none.
 */
export interface CoverPlaces {
  limit: number;
  swaps: number;
  used: number;
  left: number;
}

async function placesOf(term: Pick<TermRow, "id" | "cover_limit" | "cover_swaps">, planLimit: number): Promise<CoverPlaces> {
  const limit = term.cover_limit ?? planLimit;
  // Sold before plans had replacements: none.
  const swaps = term.cover_swaps ?? 0;
  const row = (await getDb()
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN change IN ('named', 'added', 'corrected_in') THEN 1 WHEN change = 'corrected_out' THEN -1 ELSE 0 END), 0)::int AS used
         FROM membership_cover_changes WHERE membership_id = ?`
    )
    .get(term.id)) as { used: number };
  const used = Number(row.used);
  return { limit, swaps, used, left: Math.max(0, limit + swaps - used) };
}

type CoverChange = "named" | "added" | "removed" | "corrected_out" | "corrected_in";

/** One change to whom a membership covers, as a record of its own (`membership_cover_changes`). */
async function recordCover(
  membershipId: number,
  participantId: number,
  change: CoverChange,
  by: { userId?: number | null; adminId?: number | null },
  reason: string | null = null
): Promise<void> {
  await getDb()
    .prepare("INSERT INTO membership_cover_changes (membership_id, participant_id, change, by_user_id, by_admin_id, reason) VALUES (?, ?, ?, ?, ?, ?)")
    .run(membershipId, participantId, change, by.userId ?? null, by.adminId ?? null, reason);
}

const coveredNow = async (membershipId: number): Promise<number[]> =>
  ((await getDb().prepare("SELECT participant_id FROM membership_participants WHERE membership_id = ?").all(membershipId)) as { participant_id: number }[]).map(
    (r) => r.participant_id
  );

type FamilyPlan = MembershipPlan & { familyLimit: number };

/** A family membership bought online by this account, locked for a change: or why it cannot be changed here. */
async function familyTerm(userId: number, membershipId: number): Promise<Result<{ term: TermRow; plan: FamilyPlan }>> {
  // One change to a membership's cover at a time: two at once would each count the others out.
  const m = (await getDb().prepare(`SELECT ${TERM_COLUMNS} FROM memberships WHERE id = ? AND user_id = ? FOR UPDATE`).get(membershipId, userId)) as
    | TermRow
    | undefined;
  if (!m) return refused("MBO_NOT_YOURS", "That is not one of your memberships.", 404);
  const plan = m.plan ? await planById(m.plan, { retired: true }) : null;
  if (m.holder_kind !== "customer" || !plan || plan.offeredFor !== "family" || plan.familyLimit === null)
    return refused("MBO_NOT_CHANGEABLE", "Only a family membership bought online names people you can change. Ask the venue.", 409);
  if (m.status !== "active" || m.expires_on < todayISO()) return refused("MBO_ENDED", "This membership has ended.", 409);
  return { ok: true, term: m, plan: { ...plan, familyLimit: plan.familyLimit } };
}

/** Where a family membership stands for changes: its places this term, whether it renews by itself, and whom its next term names if chosen. */
export interface CoverStanding extends CoverPlaces {
  renews: boolean;
  /** Whom the next term covers, where its buyer chose for it (`setNextCovers`); null: whom it covers then. */
  nextCovers: Named[] | null;
}

export async function coverStanding(membershipId: number): Promise<CoverStanding | null> {
  const db = getDb();
  const m = (await db.prepare(`SELECT ${TERM_COLUMNS}, next_covers_at FROM memberships WHERE id = ?`).get(membershipId)) as
    | (TermRow & { next_covers_at: unknown })
    | undefined;
  const plan = m?.plan ? await planById(m.plan, { retired: true }) : null;
  if (!m || !plan || plan.offeredFor !== "family" || plan.familyLimit === null) return null;
  const places = await placesOf(m, plan.familyLimit);
  const renews = Boolean(await db.prepare("SELECT 1 FROM membership_subscriptions WHERE membership_id = ? AND status = 'active'").get(m.id));
  const next = m.next_covers_at
    ? ((await db
        .prepare("SELECT p.id, p.display_name AS name FROM membership_next_covers n JOIN participants p ON p.id = n.participant_id WHERE n.membership_id = ? ORDER BY p.id")
        .all(m.id)) as Named[])
    : null;
  return { ...places, renews, nextCovers: next };
}

/** A list of participant ids, each once: or why not. */
function readCovers(wanted: unknown): number[] | ParticipantRefusal {
  if (!Array.isArray(wanted) || !wanted.every((x) => Number.isInteger(x) && x > 0) || new Set(wanted).size !== wanted.length)
    return refused("MBO_REQUEST", "covers is a list of participant ids, each once.");
  return wanted as number[];
}

/**
 * Change whom a family membership covers from now, by the account that
 * bought it (the owner's decision of 27 October 2026): `wanted` is the list
 * it should name. People taken off go at once, with nothing back. People put
 * on must be somebody the account acts for now, not covered elsewhere for the
 * days left, within the plan's limit, and within the term's places: each
 * person put on uses one for the rest of the term, and taking somebody off
 * gives none back, so a family covering four cannot be rotated through many
 * people, nor the same person taken off and put back without limit. Past the
 * places, refused whole: they are named for the next term instead
 * (`setNextCovers`, or when it is renewed). The price stays as sold: a family
 * plan's price does not depend on how many it covers, so adding within the
 * places is free.
 */
export async function changeCovers(
  userId: number,
  membershipId: number,
  wanted: unknown
): Promise<Result<{ membership: Membership; standing: CoverStanding }>> {
  const ids = readCovers(wanted);
  if (!Array.isArray(ids)) return ids;
  return withTransaction(async () => {
    const db = getDb();
    const found = await familyTerm(userId, membershipId);
    if (!found.ok) return found;
    const { term: m, plan } = found;
    const places = await placesOf(m, plan.familyLimit);
    if (ids.length > Math.min(places.limit, MAX_MEMBERSHIP_COVERS))
      return refused("MBO_FAMILY_LIMIT", `This plan covers up to ${places.limit} people besides you.`, 409, { n: places.limit });
    const today = todayISO();
    const now = await coveredNow(m.id);
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
    if (added.length > places.left)
      return refused(
        "MBO_NO_PLACES_LEFT",
        "Nobody new can be put on this membership this term: its places are used, and taking somebody off does not give one back. You can name them for its next term.",
        409,
        { n: places.limit + places.swaps }
      );
    for (const id of removed) {
      await db.prepare("DELETE FROM membership_participants WHERE membership_id = ? AND participant_id = ?").run(m.id, id);
      await recordCover(m.id, id, "removed", { userId });
      await participantEvent(id, "membership.uncovered", { userId, name: user.name }, { venueId: m.venue_id, detail: `membership ${m.id}` });
    }
    for (const p of named) {
      await db.prepare("INSERT INTO membership_participants (membership_id, participant_id) VALUES (?, ?)").run(m.id, p.id);
      await recordCover(m.id, p.id, "added", { userId });
      await participantEvent(p.id, "membership.covered", { userId, name: user.name }, { venueId: m.venue_id, detail: `membership ${m.id}, until ${m.expires_on}` });
    }
    return { ok: true, membership: (await membershipById(m.id))!, standing: (await coverStanding(m.id))! };
  });
}

/**
 * Whom a family membership that renews by itself covers from its next term,
 * as its buyer chooses now (the owner's decision: a different list at
 * renewal, within the limit). The charge for that term makes the next
 * membership naming them, less anybody the account no longer acts for by
 * then (`renewalRequest`); this term is unchanged. One that does not renew by
 * itself is renewed by buying it again, naming whom it should cover then.
 */
export async function setNextCovers(userId: number, membershipId: number, wanted: unknown): Promise<Result<{ membership: Membership; standing: CoverStanding }>> {
  const ids = readCovers(wanted);
  if (!Array.isArray(ids)) return ids;
  return withTransaction(async () => {
    const db = getDb();
    const found = await familyTerm(userId, membershipId);
    if (!found.ok) return found;
    const { term: m, plan } = found;
    if (!(await db.prepare("SELECT 1 FROM membership_subscriptions WHERE membership_id = ? AND status = 'active'").get(m.id)))
      return refused("MBO_NOT_RENEWING", "This membership does not renew by itself: choose whom it covers when you renew it.", 409);
    // The next term is sold as the plan is then.
    if (ids.length > Math.min(plan.familyLimit, MAX_MEMBERSHIP_COVERS))
      return refused("MBO_FAMILY_LIMIT", `This plan covers up to ${plan.familyLimit} people besides you.`, 409, { n: plan.familyLimit });
    const from = addDays(m.expires_on, 1);
    const to = addDays(addMonths(from, plan.months), -1);
    for (const id of ids) {
      const who = await actsFor(userId, id);
      if ("ok" in who) return who;
      const until = await coveredUntil(m.venue_id, id, from, to, m.id);
      if (until) return refused("MBO_ALREADY_COVERED", `${who.name} is already a member here until ${until}.`, 409, { name: who.name, until });
    }
    await db.prepare("DELETE FROM membership_next_covers WHERE membership_id = ?").run(m.id);
    for (const id of ids) await db.prepare("INSERT INTO membership_next_covers (membership_id, participant_id) VALUES (?, ?)").run(m.id, id);
    await db.prepare("UPDATE memberships SET next_covers_at = now() WHERE id = ?").run(m.id);
    return { ok: true, membership: (await membershipById(m.id))!, standing: (await coverStanding(m.id))! };
  });
}

/**
 * A manager correcting a person entered wrongly on a membership (the
 * owner's decision: a correction, authorised, with a reason): `remove` comes
 * off, and `add`, where given, goes on in their place. It uses none of the
 * term's places, and gives back the place of the person taken off. The
 * person put on is somebody the buying account acts for now, or one the
 * venue knows with a guardian on the holder's number (as at the counter),
 * not covered elsewhere for the days left; the plan's limit holds, since one
 * goes off for each who goes on. Each person's history records it, and the
 * route the activity log, with the reason.
 */
export async function correctCover(
  admin: { id: number | null; name: string },
  membershipId: number,
  input: { remove?: unknown; add?: unknown; reason?: unknown }
): Promise<Result<{ membership: Membership; removed: Named; added: Named | null }>> {
  const remove = input.remove;
  if (!Number.isInteger(remove) || (remove as number) <= 0) return refused("MBO_REQUEST", "remove is the participant to take off.");
  const add = input.add === undefined || input.add === null ? null : input.add;
  if (add !== null && (!Number.isInteger(add) || (add as number) <= 0)) return refused("MBO_REQUEST", "add is the participant to put on in their place.");
  const reason = typeof input.reason === "string" ? input.reason.trim().replace(/\s+/g, " ").slice(0, 300) : "";
  if (reason.length < 3) return refused("MBO_REASON", "Say why: who was entered wrongly, and how it was found.");
  return withTransaction(async () => {
    const db = getDb();
    const m = (await db.prepare(`SELECT ${TERM_COLUMNS} FROM memberships WHERE id = ? FOR UPDATE`).get(membershipId)) as TermRow | undefined;
    if (!m) return refused("MBO_NOT_FOUND", "Membership not found.", 404);
    if (m.status !== "active" || m.expires_on < todayISO()) return refused("MBO_ENDED", "This membership has ended.", 409);
    const now = await coveredNow(m.id);
    if (!now.includes(remove as number)) return refused("MBO_NOT_COVERED", "That person is not covered by this membership.", 409);
    const off = (await db.prepare("SELECT id, display_name AS name FROM participants WHERE id = ?").get(remove)) as Named;
    let on: Named | null = null;
    if (add !== null) {
      if (now.includes(add as number) || m.holder_participant_id === add)
        return refused("MBO_ALREADY_ON", "That person is covered by this membership already.", 409);
      const byAccount = m.user_id !== null ? await actsFor(m.user_id, add as number) : null;
      if (byAccount && !("ok" in byAccount)) on = byAccount;
      else {
        const known = await selectionAtVenue(m.venue_id, m.holder_phone, [add as number], false);
        // Bought by an account: refused as the account would be; sold at the counter, as the counter would be.
        if (isRefusal(known)) return byAccount ?? known;
        on = known.participants[0];
      }
      const until = await coveredUntil(m.venue_id, on.id, todayISO(), m.expires_on, m.id);
      if (until) return refused("MBO_ALREADY_COVERED", `${on.name} is already a member here until ${until}.`, 409, { name: on.name, until });
    }
    const actor = { adminId: admin.id, name: admin.name };
    await db.prepare("DELETE FROM membership_participants WHERE membership_id = ? AND participant_id = ?").run(m.id, off.id);
    await recordCover(m.id, off.id, "corrected_out", { adminId: admin.id }, reason);
    await participantEvent(off.id, "membership.uncovered", actor, { venueId: m.venue_id, detail: `membership ${m.code}: corrected (${reason})` });
    if (on) {
      await db.prepare("INSERT INTO membership_participants (membership_id, participant_id, added_by_admin_id) VALUES (?, ?, ?)").run(m.id, on.id, admin.id);
      await recordCover(m.id, on.id, "corrected_in", { adminId: admin.id }, reason);
      await participantEvent(on.id, "membership.covered", actor, { venueId: m.venue_id, detail: `membership ${m.code}, until ${m.expires_on}: corrected (${reason})` });
    }
    return { ok: true, membership: (await membershipById(m.id))!, removed: off, added: on };
  });
}

/** One change to whom a membership covers, for staff: who, what, when, by whom, and why. */
export interface CoverChangeView {
  change: CoverChange;
  name: string | null;
  at: string;
  by: string | null;
  byStaff: boolean;
  reason: string | null;
}

/** Who a membership covered when: every change, oldest first, and its places this term where it is a family plan's. */
export async function coverHistory(membershipId: number): Promise<{ changes: CoverChangeView[]; places: CoverPlaces | null }> {
  const rows = (await getDb()
    .prepare(
      `SELECT c.change, c.at, c.reason, p.display_name AS name, COALESCE(a.name, u.name) AS by_name, c.by_admin_id IS NOT NULL AS by_staff
         FROM membership_cover_changes c
         LEFT JOIN participants p ON p.id = c.participant_id
         LEFT JOIN admins a ON a.id = c.by_admin_id
         LEFT JOIN users u ON u.id = c.by_user_id
        WHERE c.membership_id = ? ORDER BY c.id`
    )
    .all(membershipId)) as { change: CoverChange; at: unknown; reason: string | null; name: string | null; by_name: string | null; by_staff: boolean | number }[];
  const standing = await coverStanding(membershipId);
  return {
    changes: rows.map((r) => ({
      change: r.change,
      name: r.name,
      at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
      by: r.by_name,
      byStaff: Boolean(r.by_staff),
      reason: r.reason,
    })),
    places: standing ? { limit: standing.limit, swaps: standing.swaps, used: standing.used, left: standing.left } : null,
  };
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
