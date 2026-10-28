import { logAction } from "./activity";
import { asStaff } from "./acting-staff";
import { getDb } from "./db";
import { refundCancelled } from "./payments";
import { adminCancelBooking } from "./store";
import { localDateOf } from "./time";
import { venueZoneOf } from "./zones";

/**
 * Test bookings (audit R8 X1-16; docs/product/marketplace.md#test-bookings-before-going-live).
 *
 * A booking made while its venue was a draft, not yet live, is a test: the
 * set-up checklist asks for one, and staff try the counter, take a payment
 * and print a receipt on them. The database marks each as it is written
 * (`bookings.test`, migration 0254), whichever path wrote it.
 *
 * A test booking stays a booking: it holds its court, and whatever was
 * written for it is kept as it was. A receipt is never deleted or numbered
 * again; one given in a test is reversed by a credit note, as any cancelled
 * booking's is. What a test is not is the venue's trade, so it is left out of
 * the period and customer reports, the bookings export, the cash-up and the
 * month's consolidated e-invoice, as demonstration bookings are left out of
 * what they would distort; the sales journal still lists its receipt and
 * credit notes, marked. Nor does a test count as anybody's strike, earn a
 * free hour, or ask for a review.
 *
 * Staff see each marked as a test. A manager clears them, on the go-live
 * banner or when sending the venue to go live: each still standing is
 * cancelled with all of it given back the way it was paid (credit to credit,
 * a pass's entry to the pass, a receipt by a credit note), played or not,
 * with no message to anybody and no strike. Or a manager keeps one as a real
 * booking (an advance booking entered while setting up): it is then in the
 * figures like any other, unless its receipt's month has already gone to
 * LHDN without it.
 */

export interface TestBooking {
  code: string;
  date: string;
  startHour: number;
  endHour: number;
  courtName: string;
  name: string;
  totalPrice: number;
  paymentStatus: string;
  paidVia: string | null;
}

/** Who clears or keeps them: written with every credit note and in the log. */
export interface TestStaff {
  id: number;
  name: string;
}

export interface TestBookingsAnswer {
  /** The venue has gone live (they are then left over from setting up). */
  live: boolean;
  /** Test bookings still standing, soonest first. */
  bookings: TestBooking[];
}

/** The venue's test bookings still standing. */
export async function standingTestBookings(venueId: number): Promise<TestBookingsAnswer> {
  const db = getDb();
  const venue = (await db.prepare("SELECT published_at FROM venues WHERE id = ?").get(venueId)) as { published_at: string | null } | undefined;
  const rows = (await db
    .prepare(
      `SELECT b.code, b.date, b.start_min, b.end_min, c.name AS court, b.name, b.total_price::float AS total, b.payment_status, b.paid_via
         FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND b.test AND b.status = 'confirmed'
        ORDER BY b.date, b.start_min, b.id LIMIT 500`
    )
    .all(venueId)) as {
    code: string;
    date: string;
    start_min: number;
    end_min: number;
    court: string;
    name: string;
    total: number;
    payment_status: string;
    paid_via: string | null;
  }[];
  return {
    live: venue?.published_at !== null && venue?.published_at !== undefined,
    bookings: rows.map((r) => ({
      code: r.code,
      date: r.date,
      startHour: r.start_min / 60,
      endHour: r.end_min / 60,
      courtName: r.court,
      name: r.name,
      totalPrice: Number(r.total),
      paymentStatus: r.payment_status,
      paidVia: r.paid_via,
    })),
  };
}

/** Codes asked for that are this venue's test bookings still standing; all of them when none are named. */
async function chosen(venueId: number, codes: string[] | undefined): Promise<{ code: string; id: number }[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT b.code, b.id FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND b.test AND b.status = 'confirmed' ORDER BY b.date, b.start_min, b.id`
    )
    .all(venueId)) as { code: string; id: number }[];
  if (codes === undefined) return rows;
  const asked = new Set(codes.map((c) => c.trim().toUpperCase()));
  return rows.filter((r) => asked.has(r.code.toUpperCase()));
}

export interface TestOutcome {
  /** Codes done. */
  done: string[];
  /** Codes that could not be, and why (in English; a staff screen shows the code with it). */
  refused: { code: string; error: string }[];
}

/**
 * Cancel the venue's test bookings still standing (those named, or all):
 * everything paid goes back the way it was paid, a receipt by its credit
 * note, as any staff cancellation does (lib/store.ts `adminCancelBooking`),
 * played or not; nobody is messaged, and no strike is counted. One with
 * kit still out on hire is left, and said.
 */
export async function clearTestBookings(staff: TestStaff, venueId: number, codes?: string[]): Promise<TestOutcome> {
  const out: TestOutcome = { done: [], refused: [] };
  for (const b of await chosen(venueId, codes)) {
    // As the member of staff, so each credit note says who gave it back (lib/acting-staff.ts).
    const result = await asStaff(staff, () => adminCancelBooking(b.code, undefined, { test: true }));
    if (!result.ok) {
      out.refused.push({ code: b.code, error: "error" in result ? result.error : "Could not cancel it." });
      continue;
    }
    // Paid online (a deposit, a share): owed back on the payment, as for any cancellation by the venue.
    await refundCancelled([b.id], { byVenue: true });
    await logAction(staff, { venueId, bookingCode: b.code, action: "booking.test_cleared", detail: "Cleared a test booking from before going live" });
    out.done.push(b.code);
  }
  return out;
}

/**
 * Keep test bookings as real ones: they are in the venue's figures from now
 * on, on the days they were played and paid. Not one whose receipt's month
 * has gone to LHDN consolidated already, without it.
 */
export async function keepTestBookings(staff: TestStaff, venueId: number, codes: string[]): Promise<TestOutcome> {
  const out: TestOutcome = { done: [], refused: [] };
  const db = getDb();
  const venue = (await db.prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(venueId)) as
    | { time_zone: string | null; lat: number | null; lng: number | null }
    | undefined;
  const zone = venueZoneOf(venue ?? {});
  const asked = await chosen(venueId, codes);
  for (const code of codes.filter((c) => !asked.some((b) => b.code.toUpperCase() === c.trim().toUpperCase())))
    out.refused.push({ code, error: "That is not a test booking still standing at this venue." });
  for (const b of asked) {
    const paid = (await db.prepare("SELECT paid_at FROM bookings WHERE id = ? AND payment_status = 'paid'").get(b.id)) as
      | { paid_at: string | null }
      | undefined;
    if (paid?.paid_at) {
      const month = localDateOf(String(paid.paid_at), zone).slice(0, 7);
      if (await db.prepare("SELECT 1 FROM e_invoices WHERE venue_id = ? AND code_number = ?").get(venueId, `CON-${month}`)) {
        out.refused.push({ code: b.code, error: "Its receipt's month has gone to LHDN without it, so it stays a test." });
        continue;
      }
    }
    const kept = await db.prepare("UPDATE bookings SET test = false WHERE id = ? AND test").run(b.id);
    if (kept.changes !== 1) continue;
    await logAction(staff, { venueId, bookingCode: b.code, action: "booking.test_kept", detail: "Kept a booking made before going live as a real one" });
    out.done.push(b.code);
  }
  return out;
}
