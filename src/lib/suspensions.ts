import { getDb } from "./db";
import { afterSuspensions, applyPaymentHolds, giveGraceToOverdueOf } from "./payment-holds";
import { tellVenueStaffEach } from "./owner-alerts";
import { todayISO } from "./time";

/**
 * The platform owner taking a venue, or a whole business, off the
 * marketplace: complaints, a dispute, a venue that has shut.
 *
 * A suspended venue is out of customers' sight exactly as one held for an
 * unpaid invoice is (lib/listing.ts) — not found, not bookable, not paid
 * online — and its staff can still sign in, to see and settle what is
 * booked. Bookings already made stand; cancelling them is a separate,
 * deliberate step. Only the owner lifts it: paying an invoice does not.
 *
 * Customers who hold something there are told once (lib/suspension-notices.ts), nothing new is sold there at the counter or online
 * (`counterSaleRefusal`), and memberships that renew by themselves are paused at the gateway meanwhile (lib/payments.ts
 * `reconcileRenewalPauses`). Passes and memberships are not extended for the time off (an owner's decision, ADR 0063).
 *
 * A business suspended takes every branch with it, and cannot add a branch,
 * or send one live, until it is lifted.
 */

export type SuspendResult = { ok: true; venues: number; upcomingBookings: number } | { ok: false; error: string };

const clean = (reason: string) => reason.trim().slice(0, 500);

async function upcomingBookings(venueIds: number[]): Promise<number> {
  if (venueIds.length === 0) return 0;
  const row = (await getDb()
    .prepare(
      `SELECT COUNT(DISTINCT b.id)::int AS n FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id IN (${venueIds.map(() => "?").join(",")})
          AND b.status = 'confirmed' AND b.date >= ?`
    )
    .get(...venueIds, todayISO())) as { n: number };
  return row.n;
}

export async function suspendVenue(venueId: number, reason: string): Promise<SuspendResult> {
  const why = clean(reason);
  if (why.length < 3) return { ok: false, error: "Say why: their staff are told." };
  const venue = (await getDb()
    .prepare(
      // A venue already held for an invoice keeps the stamp it went off with: one suspension, and its customers are told once.
      `UPDATE venues SET suspended_at = COALESCE(suspended_at, datetime('now')), suspended_by = 'owner', suspended_reason = ?
        WHERE id = ? RETURNING id, name`
    )
    .get(why, venueId)) as { id: number; name: string } | undefined;
  if (!venue) return { ok: false, error: "Venue not found." };
  await tellVenueStaffEach(venue.id, (t) => ({
    subject: t("r9d.susp.venue.s", { venue: venue.name }),
    body: t("r9d.susp.venue.b", { venue: venue.name, why }),
  }));
  await afterSuspensions();
  return { ok: true, venues: 1, upcomingBookings: await upcomingBookings([venue.id]) };
}

export type LiftResult =
  | { ok: true; /** A venue held for an invoice: the invoices it was given time on, until when. */ grace?: { until: string; invoices: { id: number; period: string }[] } }
  | { ok: false; error: string; code?: string };

/**
 * Put a venue back. One suspended by the owner just comes back (a reason, if given, is for the log); one held for an overdue invoice
 * comes back only by being given time (`opts.graceUntil` and a `reason`, the owner's, kept on each invoice and in the activity log: ADR
 * 0063), never by an invoice being marked paid that was not, or voided that is owed. Still owing when the time ends, it is held again.
 */
export async function liftVenue(venueId: number, opts: { reason?: string; graceUntil?: string; by?: string } = {}): Promise<LiftResult> {
  const db = getDb();
  const row = (await db
    .prepare(
      `SELECT v.name, v.suspended_at, v.suspended_by, b.suspended_at AS business_suspended
         FROM venues v LEFT JOIN businesses b ON b.id = v.business_id WHERE v.id = ?`
    )
    .get(venueId)) as { name: string; suspended_at: string | null; suspended_by: string | null; business_suspended: string | null } | undefined;
  if (!row) return { ok: false, error: "Venue not found." };
  if (row.business_suspended) return { ok: false, error: "Its whole business is suspended. Lift that instead." };
  if (row.suspended_at === null) return { ok: false, error: "That venue is not suspended." };
  if (row.suspended_by === "payment") {
    if (!opts.graceUntil)
      return {
        ok: false,
        error: "That venue is held for an unpaid invoice. Give it time until a date, with a reason, or record the invoice as paid.",
        code: "FX11_GRACE_NEEDED",
      };
    const given = await giveGraceToOverdueOf(venueId, { until: opts.graceUntil, reason: opts.reason ?? "", by: opts.by ?? "the platform owner" });
    if (!given.ok) return given;
    // Nothing owing past its time any more (the invoice was settled meanwhile): the hold goes with this check all the same.
    await applyPaymentHolds();
    return { ok: true, grace: { until: opts.graceUntil, invoices: given.invoices.map((i) => ({ id: i.id, period: i.period })) } };
  }
  await db
    .prepare("UPDATE venues SET suspended_at = NULL, suspended_by = NULL, suspended_reason = NULL WHERE id = ?")
    .run(venueId);
  // Still owing? Then it is held for that instead, and says so.
  await applyPaymentHolds();
  await afterSuspensions();
  await tellVenueStaffEach(venueId, (t) => ({ subject: t("r9d.back.s", { name: row.name }), body: t("r9d.susp.lifted.b", { name: row.name }) }));
  return { ok: true };
}

/**
 * Why nothing new is sold at this venue's counter, or null: a pass, membership or credit sale while it is suspended or held would take
 * a customer's money for what cannot be used (ADR 0063). A venue that has not gone live is not suspended and may try its counter.
 */
export async function counterSaleRefusal(venueId: number | null): Promise<{ error: string; code: string } | null> {
  if (venueId === null) return null;
  const row = (await getDb().prepare("SELECT suspended_at FROM venues WHERE id = ?").get(venueId)) as { suspended_at: string | null } | undefined;
  return row?.suspended_at
    ? { error: "This venue is suspended or held for an unpaid invoice: passes, memberships and credit are not sold until it is back.", code: "FX11_SALES_SUSPENDED" }
    : null;
}

export async function suspendBusiness(businessId: number, reason: string): Promise<SuspendResult> {
  const why = clean(reason);
  if (why.length < 3) return { ok: false, error: "Say why: their staff are told." };
  const db = getDb();
  let venueIds: number[] = [];
  let name = "";
  await db.transaction(async () => {
    const business = (await db
      .prepare("UPDATE businesses SET suspended_at = datetime('now'), suspended_reason = ? WHERE id = ? RETURNING name")
      .get(why, businessId)) as { name: string } | undefined;
    if (!business) return;
    name = business.name;
    venueIds = (
      (await db
        .prepare(
          `UPDATE venues SET suspended_at = COALESCE(suspended_at, datetime('now')), suspended_by = 'owner', suspended_reason = ?
            WHERE business_id = ? RETURNING id`
        )
        .all(why, businessId)) as { id: number }[]
    ).map((v) => v.id);
  })();
  if (!name) return { ok: false, error: "Business not found." };
  if (venueIds.length > 0)
    await tellVenueStaffEach(venueIds[0], (t) => ({
      subject: t("r9d.susp.business.s", { business: name }),
      body: t("r9d.susp.business.b", { business: name, why }),
    }));
  await afterSuspensions();
  return { ok: true, venues: venueIds.length, upcomingBookings: await upcomingBookings(venueIds) };
}

export async function liftBusiness(businessId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getDb();
  const business = (await db
    .prepare("UPDATE businesses SET suspended_at = NULL, suspended_reason = NULL WHERE id = ? AND suspended_at IS NOT NULL RETURNING name")
    .get(businessId)) as { name: string } | undefined;
  if (!business) return { ok: false, error: "That business is not suspended." };
  const venues = (await db
    .prepare(
      `UPDATE venues SET suspended_at = NULL, suspended_by = NULL, suspended_reason = NULL
        WHERE business_id = ? AND suspended_by = 'owner' RETURNING id`
    )
    .all(businessId)) as { id: number }[];
  await applyPaymentHolds();
  await afterSuspensions();
  if (venues.length > 0)
    await tellVenueStaffEach(venues[0].id, (t) => ({
      subject: t("r9d.back.s", { name: business.name }),
      body: t("r9d.susp.lifted.b", { name: business.name }),
    }));
  return { ok: true };
}

/** Why a business may not add a branch or send one live, or null. */
export async function businessSuspension(businessId: number | null): Promise<string | null> {
  if (businessId === null) return null;
  const row = (await getDb()
    .prepare("SELECT suspended_reason FROM businesses WHERE id = ? AND suspended_at IS NOT NULL")
    .get(businessId)) as { suspended_reason: string | null } | undefined;
  return row ? `Your business is suspended: ${row.suspended_reason ?? "ask the platform owner"}.` : null;
}
