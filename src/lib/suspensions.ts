import { getDb } from "./db";
import { applyPaymentHolds } from "./payment-holds";
import { siteName } from "./site";
import { tellVenueStaff } from "./owner-alerts";
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
      `UPDATE venues SET suspended_at = datetime('now'), suspended_by = 'owner', suspended_reason = ?
        WHERE id = ? RETURNING id, name`
    )
    .get(why, venueId)) as { id: number; name: string } | undefined;
  if (!venue) return { ok: false, error: "Venue not found." };
  await tellVenueStaff(
    venue.id,
    `${venue.name} has been suspended on ${siteName()}`,
    `${venue.name} has been taken off ${siteName()}: ${why}\n\nCustomers cannot find, book or pay it online ` +
      `until this is lifted. You can still sign in, and bookings already made stand. Reply to this email to talk to us.`
  );
  return { ok: true, venues: 1, upcomingBookings: await upcomingBookings([venue.id]) };
}

export async function liftVenue(venueId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getDb();
  const row = (await db
    .prepare(
      `SELECT v.name, v.suspended_by, b.suspended_at AS business_suspended
         FROM venues v LEFT JOIN businesses b ON b.id = v.business_id WHERE v.id = ?`
    )
    .get(venueId)) as { name: string; suspended_by: string | null; business_suspended: string | null } | undefined;
  if (!row) return { ok: false, error: "Venue not found." };
  if (row.business_suspended) return { ok: false, error: "Its whole business is suspended. Lift that instead." };
  if (row.suspended_by !== "owner") return { ok: false, error: "That venue is not suspended." };
  await db
    .prepare("UPDATE venues SET suspended_at = NULL, suspended_by = NULL, suspended_reason = NULL WHERE id = ?")
    .run(venueId);
  // Still owing? Then it is held for that instead, and says so.
  await applyPaymentHolds();
  await tellVenueStaff(venueId, `${row.name} is back on ${siteName()}`, `The suspension of ${row.name} has been lifted.`);
  return { ok: true };
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
          `UPDATE venues SET suspended_at = datetime('now'), suspended_by = 'owner', suspended_reason = ?
            WHERE business_id = ? RETURNING id`
        )
        .all(why, businessId)) as { id: number }[]
    ).map((v) => v.id);
  })();
  if (!name) return { ok: false, error: "Business not found." };
  if (venueIds.length > 0)
    await tellVenueStaff(
      venueIds[0],
      `${name} has been suspended on ${siteName()}`,
      `${name} and all its branches have been taken off ${siteName()}: ${why}\n\nCustomers cannot find, book or ` +
        `pay them online until this is lifted. You can still sign in, and bookings already made stand. ` +
        `Reply to this email to talk to us.`
    );
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
  if (venues.length > 0)
    await tellVenueStaff(venues[0].id, `${business.name} is back on ${siteName()}`, `The suspension of ${business.name} has been lifted.`);
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
