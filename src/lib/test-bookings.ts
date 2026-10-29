import { logAction } from "./activity";
import { asStaff } from "./acting-staff";
import { getDb } from "./db";
import { counterPaymentOn, oweCounter } from "./counter-refunds";
import { refundCancelled } from "./payments";
import { money } from "./region";
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
 * the performance figures (the occupancy measures, the customer report,
 * loyalty, strikes, review requests) and of the month's consolidated
 * e-invoice, as demonstration bookings are. It is never out of the money
 * records: the sales journal lists its receipt and credit notes marked, the
 * cash-up shows them in a block of their own beside the real totals, the
 * period report and the bookings export carry them marked, and every payment,
 * refund owed, payout and credit it caused is where staff look for them.
 *
 * Real money is never a test (migration 0259): a payment arriving on a test
 * booking once its venue is live makes it a real sale at once, and a venue
 * cannot go live while a test booking with a payment on it stands.
 *
 * Staff see each marked as a test. A manager clears them, on the go-live
 * banner or when sending the venue to go live, and says whether real money
 * was taken at the counter on them: each still standing is cancelled with all
 * of it given back (credit to credit, a pass's entry to the pass, money paid
 * online owed back on the payment), played or not, with no message to anybody
 * and no strike. A counter payment on one the manager declares synthetic is
 * reversed by its credit note, nothing handed back; one the manager says was
 * real money is owed back at the counter, as the venue's own cancellations
 * owe it, until a named person settles it from the day list. Or a manager
 * keeps one as a real booking (an advance booking entered while setting up):
 * it is then in the figures like any other, unless its receipt's month has
 * already gone to LHDN without it.
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
  /** A counter payment is on it: clearing it asks whether real money was taken. */
  counterPaid: boolean;
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
      `SELECT b.id, b.code, b.date, b.start_min, b.end_min, c.name AS court, b.name, b.total_price::float AS total, b.payment_status, b.paid_via
         FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND b.test AND b.status = 'confirmed'
        ORDER BY b.date, b.start_min, b.id LIMIT 500`
    )
    .all(venueId)) as {
    id: number;
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
  const bookings: TestBooking[] = [];
  for (const r of rows)
    bookings.push({
      code: r.code,
      date: r.date,
      startHour: r.start_min / 60,
      endHour: r.end_min / 60,
      courtName: r.court,
      name: r.name,
      totalPrice: Number(r.total),
      paymentStatus: r.payment_status,
      paidVia: r.paid_via,
      counterPaid: r.payment_status === "paid" && (await counterPaymentOn(r.id)) !== null,
    });
  return { live: venue?.published_at !== null && venue?.published_at !== undefined, bookings };
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
 * Whether real money was taken on the test bookings being cleared: the manager's own declaration, recorded with
 * each. `none`: they were a try-out, nothing real changed hands. `real`: money really was taken at the counter,
 * so what was paid there is owed back.
 */
export const MONEY_TAKEN = ["none", "real"] as const;
export type MoneyTaken = (typeof MONEY_TAKEN)[number];
export const isMoneyTaken = (v: unknown): v is MoneyTaken => typeof v === "string" && (MONEY_TAKEN as readonly string[]).includes(v);

/** Refusals, in English as sent; staff screens say them in their language (lib/staff-i18n/refusals-2.ts). */
export const TEST_REFUSALS = {
  moneyTaken: "Say whether real money was taken on these test bookings: moneyTaken is none or real.",
  moneyTakenValue: "moneyTaken must be none or real.",
} as const;

/** Up to ten codes, then how many more. */
function codesText(codes: string[]): string {
  return codes.length <= 10 ? codes.join(", ") : `${codes.slice(0, 10).join(", ")}, +${codes.length - 10}`;
}

/** The venue's own refusal to ask to go live with these standing (a pattern in lib/staff-i18n/refusals-2.ts). */
export const paidTestsBlockRequest = (codes: string[]): string =>
  `Test bookings with a payment recorded stand at this venue: ${codesText(codes)}. Clear them, or keep them as real, before going live.`;

/** The platform owner's refusal to approve with these standing (a pattern in lib/staff-i18n/refusals-2.ts). */
export const paidTestsBlockApproval = (count: number): string =>
  `Test bookings with a payment recorded stand at this venue (${count}). The venue must clear them or keep them as real before it goes live.`;

/** Codes, of those chosen, with a counter payment on them: clearing these asks whether real money was taken. */
export async function counterPaidTests(venueId: number, codes?: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const b of await chosen(venueId, codes)) if ((await counterPaymentOn(b.id)) !== null) out.push(b.code);
  return out;
}

/**
 * Cancel the venue's test bookings still standing (those named, or all):
 * everything paid goes back the way it was paid, a receipt by its credit
 * note, as any staff cancellation does (lib/store.ts `adminCancelBooking`),
 * played or not; nobody is messaged, and no strike is counted. One with
 * kit still out on hire is left, and said.
 *
 * A counter payment on one needs the manager's word (`moneyTaken`): `none`,
 * and it is reversed by its credit note with nothing handed back, the log
 * saying it was declared synthetic and by whom; `real`, and it is written
 * down as owed back exactly as a venue's bulk cancellation's is
 * (lib/counter-refunds.ts `oweCounter`, cause `test`): no credit note until
 * staff hand it back or give it as credit from the day list. Money paid
 * online, with credit or with a pass goes back as it was paid, whichever is
 * said.
 */
export async function clearTestBookings(staff: TestStaff, venueId: number, codes?: string[], moneyTaken?: MoneyTaken): Promise<TestOutcome> {
  const out: TestOutcome = { done: [], refused: [] };
  for (const b of await chosen(venueId, codes)) {
    const counter = await counterPaymentOn(b.id);
    if (counter !== null && moneyTaken === undefined) {
      out.refused.push({ code: b.code, error: TEST_REFUSALS.moneyTaken });
      continue;
    }
    const owe = counter !== null && moneyTaken === "real";
    // As the member of staff, so each credit note says who gave it back (lib/acting-staff.ts).
    const result = await asStaff(staff, () =>
      adminCancelBooking(b.code, owe ? async () => ({ share: 1, owe: (bookingId) => oweCounter(bookingId, "test") }) : undefined, { test: true })
    );
    if (!result.ok) {
      out.refused.push({ code: b.code, error: "error" in result ? result.error : "Could not cancel it." });
      continue;
    }
    // Paid online (a deposit, a share): owed back on the payment, as for any cancellation by the venue.
    await refundCancelled([b.id], { byVenue: true });
    await logAction(staff, {
      venueId,
      bookingCode: b.code,
      action: "booking.test_cleared",
      detail:
        counter === null
          ? "Cleared a test booking from before going live"
          : owe
            ? `Cleared a test booking from before going live; ${staff.name} said real money was taken: ${money(counter)} paid at the counter is owed back until staff hand it back or give it as credit`
            : `Cleared a test booking from before going live; ${staff.name} declared it synthetic: ${money(counter)} recorded at the counter was reversed by a credit note, nothing handed back`,
    });
    out.done.push(b.code);
  }
  return out;
}

/**
 * Codes of the venue's test bookings still standing with a payment recorded on them (paid, or money paid online
 * towards it): real money until a manager says otherwise, so the venue may not go live with these standing
 * (lib/applications.ts `requestGoLive`, `approveApplication`).
 */
export async function paidStandingTests(venueId: number): Promise<string[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT b.code FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND b.test AND b.status = 'confirmed'
          AND (b.payment_status = 'paid' OR b.shares_paid > 0 OR b.deposit_paid > 0
               OR EXISTS (SELECT 1 FROM online_payment_bookings pb JOIN online_payments p ON p.id = pb.payment_id
                           WHERE pb.booking_id = b.id AND p.status = 'paid'))
        ORDER BY b.date, b.start_min, b.id`
    )
    .all(venueId)) as { code: string }[];
  return rows.map((r) => r.code);
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
    await logAction(staff, {
      venueId,
      bookingCode: b.code,
      action: "booking.test_kept",
      detail: `Kept a booking made before going live as a real one; ${staff.name} said it is real${paid?.paid_at ? ", so what was paid on it is in the figures now" : ""}`,
    });
    out.done.push(b.code);
  }
  return out;
}
