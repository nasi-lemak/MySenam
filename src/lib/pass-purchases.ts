import { accessSettings, accountPhone, onAccessList } from "./access";
import { getDb } from "./db";
import { guardianshipOf, participantEvent, refused, type ParticipantRefusal } from "./participants";
import type { Named } from "./participant-bookings";
import { onlineRefusal, passProductAt, passProductById, productExpiry, type PassProduct } from "./pass-products";
import { issuePass } from "./store";
import { todayISO } from "./time";
import type { Sport } from "./types";

/**
 * Multi-visit passes bought online (docs/features/pricing.md#buying-a-pass-online;
 * migration 0264). It adds no pass model of its own: what is sold is a pass
 * as the counter sells it from the venue's list (lib/pass-products.ts,
 * lib/store.ts `issuePass`), with the product's terms and the price paid,
 * paid through the venue's own gateway as memberships are (lib/payments.ts
 * `startPassPayment`). This module says what may be bought, by whom and for
 * whom, and issues the pass once the money is in:
 *
 * - **Only what a manager offers online**: a product on the venue's list
 *   marked *sold online* (off by default), at least `MIN_ONLINE_PASS_PRICE`;
 *   another venue's product, a retired one or one not sold online is refused.
 * - **For whom, as the pass's rules allow** (lib/store.ts `issuePass`): only a
 *   pass for one person's place (`participant` scope) is held for somebody
 *   else, and online only for a participant the account acts for now (an
 *   active relationship, not paused for a review, archived or revoked), as a
 *   membership bought for somebody is (lib/membership-purchases.ts). It is
 *   held on the account's number, which spends it, as at the counter.
 * - **Never a pass unpaid**: the pass is issued when the payment settles, in
 *   the transaction that claims it, its last day worked out from the day it is
 *   paid; settled twice, once. Checked again then: an account that no longer
 *   acts for the person, or has gone, gets nothing, and the money is owed back.
 *   A product retired while the customer paid still gives what was paid for.
 */

type Result<T> = ({ ok: true } & T) | ParticipantRefusal;

export interface PassPurchaseRequest {
  productId: number;
  /** A pass for one person's place held for this participant; null: the account holder's own. */
  participantId: number | null;
}

export interface PassPurchaseTerms {
  product: PassProduct;
  /** Whose place it pays for: the account holder (null) or this participant. */
  holder: Named | null;
  /** The account's number, which holds and spends it. */
  phone: string;
  price: number;
  /** Its last day, were it paid today (worked out again when it is). */
  expiresOn: string;
}

/** `{ productId, participantId? }` as a request gives it. */
export function readPassPurchase(body: Record<string, unknown> | null): PassPurchaseRequest | ParticipantRefusal {
  if (!body || !Number.isInteger(body.productId) || (body.productId as number) <= 0) return refused("PSO_REQUEST", "productId is required.");
  const pid = body.participantId;
  if (pid !== undefined && pid !== null && !(Number.isInteger(pid) && (pid as number) > 0)) return refused("PSO_REQUEST", "participantId is a participant's id.");
  return { productId: body.productId as number, participantId: (pid as number | null | undefined) ?? null };
}

/** The account acts for this participant now; said apart when the relationship is paused for a review. */
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
    return refused("PSO_PAUSED", `Your relationship with ${paused.display_name} is paused for a review, so you cannot buy them a pass now.`, 409, {
      name: paused.display_name,
    });
  return refused("PSO_NOT_GUARDIAN", "You can buy a pass only for somebody you look after.", 404);
}

/**
 * What this account would buy at this venue, for whom and for how much, if
 * it paid now; or why it cannot. Settling a payment asks again (`paid`) about
 * the people and the account, and takes the product as it was sold.
 */
export async function passPurchaseTerms(
  userId: number,
  venueId: number,
  request: PassPurchaseRequest,
  opts: { paid?: boolean } = {}
): Promise<Result<{ terms: PassPurchaseTerms }>> {
  const product = opts.paid ? await passProductById(request.productId) : await passProductAt(venueId, request.productId);
  if (!product || product.venueId !== venueId || (!opts.paid && !product.soldOnline))
    return refused("PSO_NOT_SOLD", "That pass is not sold online here.", 404);
  if (!opts.paid) {
    const why = onlineRefusal(product);
    if (why) return refused("PSO_NOT_SOLD", "That pass is not sold online here.", 404);
    // Only a pass for one person's place is somebody else's to use (lib/store.ts issuePass).
    if (request.participantId !== null && product.scope !== "participant")
      return refused("PSO_NOT_FOR_PARTICIPANT", "This pass is not held for somebody else: it pays for your own bookings.", 409);
  }
  const phone = await accountPhone(userId);
  if (!phone) return refused("PSO_NO_PHONE", "Add your phone number to your account first: your pass is held on it.", 409);
  let holder: Named | null = null;
  if (request.participantId !== null) {
    const who = await actsFor(userId, request.participantId);
    if ("ok" in who) return who;
    holder = who;
  }
  return { ok: true, terms: { product, holder, phone, price: product.price, expiresOn: productExpiry(product, todayISO()) } };
}

/** May this account buy passes online at this venue at all: a private venue sells only to the people on its list. */
export async function mayBuyAt(venueId: number, userId: number): Promise<boolean> {
  if ((await accessSettings(venueId)).access !== "private") return true;
  return onAccessList(venueId, userId);
}

/** What a settled pass payment carries (lib/payments.ts `PaymentRow`). */
export interface PassPaymentRow {
  id: number;
  venue_id: number | null;
  amount: number | string;
  pass_product_id?: number | null;
  pass_user_id?: number | null;
  pass_holder_kind?: string | null;
  pass_participant_id?: number | null;
}

/**
 * The pass a settled payment buys, issued now, in the paying transaction:
 * from its product, at the price paid, for whom the customer chose, its last
 * day counted from today. Null, with the reason, when it can buy nothing any
 * more (the product, the account or the person gone, or the account no
 * longer acting for them): the money is then owed back.
 */
export async function passForPayment(payment: PassPaymentRow, paidVia: string | undefined): Promise<{ passId: number } | { passId: null; why: string }> {
  if (!payment.pass_product_id || !payment.pass_user_id || payment.venue_id === null) return { passId: null, why: "PSO_GONE" };
  if (payment.pass_holder_kind === "participant" && !payment.pass_participant_id) return { passId: null, why: "PSO_GONE" };
  const userId = payment.pass_user_id;
  const bought = await passPurchaseTerms(
    userId,
    payment.venue_id,
    { productId: payment.pass_product_id, participantId: payment.pass_holder_kind === "participant" ? payment.pass_participant_id! : null },
    { paid: true }
  );
  if (!bought.ok) return { passId: null, why: bought.code };
  const { product, holder, phone, expiresOn } = bought.terms;
  const user = (await getDb().prepare("SELECT name FROM users WHERE id = ?").get(userId)) as { name: string } | undefined;
  if (!user) return { passId: null, why: "PSO_GONE" };
  const sold = await issuePass({
    venueId: product.venueId,
    sport: product.sport as Sport | null,
    name: product.name,
    kind: product.kind,
    entries: product.entries,
    entryMinutes: product.entryMinutes,
    maxMinutes: product.maxMinutes,
    // What they paid, which nothing later rewrites.
    price: Math.round(Number(payment.amount) * 100) / 100,
    holderName: user.name,
    holderPhone: phone,
    expiresOn,
    adminId: null,
    userId,
    coachId: product.coachId,
    scope: product.scope,
    holderParticipantId: holder?.id ?? null,
    paidVia: paidVia ?? null,
    productId: product.id,
    dayPass: product.dayPass,
  });
  if (!sold.ok) return { passId: null, why: (sold.code ?? sold.error).slice(0, 200) };
  if (holder)
    await participantEvent(holder.id, "pass.bought", { userId, name: user.name }, { venueId: product.venueId, detail: `online: ${sold.pass.code}, until ${expiresOn}` });
  return { passId: sold.pass.id };
}
