import { sellAtCounter } from "./counter-sales";
import { getDb } from "./db";
import { peakRules } from "./peak";
import { phoneKey } from "./phone";
import { roundMoney } from "./region";
import { getBookingById as bookingById, getCourt } from "./store";
import { addDays, forSport, isValidDateString, todayISO } from "./time";
import { touchesPeak } from "./pricing";
import { SPORTS, type Booking, type Refusal, type Sport } from "./types";
import { errorText, translator, type ErrorCode } from "./i18n";

/**
 * Concession prices: a student, senior, child or OKU price, as a share off.
 *
 * The customer says which at booking and gets the lower price at once; the
 * booking says what to bring. Staff look at it at the counter and say so: proof
 * seen, or none, and then the full price is charged (added to what is owed, or
 * sold at the counter for the difference when it was paid already).
 *
 * No proof is ever kept. A card's photo or an IC number would make the venue
 * hold sensitive personal data, to check what a person can see in two seconds.
 * What is kept is the fact: this number was seen to be a student by this member
 * of staff, and it counts until a date the staff chose, so a regular is not
 * asked every visit. That record goes out with the customer's data and is
 * erased with it (lib/privacy.ts).
 */

export interface Concession {
  id: number;
  venueId: number;
  name: string;
  percent: number;
  /** What to show at the counter, as the customer would say it: "your student card". */
  proof: string;
  /** One sport, or null for every sport here. */
  sport: Sport | null;
  offPeakOnly: boolean;
}

export type ConcessionCheck = "due" | "seen" | "refused";

interface Row {
  id: number;
  venue_id: number;
  name: string;
  percent: number;
  proof: string;
  sport: Sport | null;
  off_peak_only: number;
}

const toConcession = (r: Row): Concession => ({
  id: r.id,
  venueId: r.venue_id,
  name: r.name,
  percent: Number(r.percent),
  proof: r.proof,
  sport: r.sport,
  offPeakOnly: r.off_peak_only === 1,
});

const ENGLISH = translator("en");
function refuse(code: ErrorCode, vars: Record<string, string | number> = {}): Refusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, vars };
}

/** The concessions a venue offers now. */
export async function listConcessions(venueId: number): Promise<Concession[]> {
  const rows = (await getDb()
    .prepare("SELECT * FROM concessions WHERE venue_id = ? AND retired_at IS NULL ORDER BY percent DESC, id")
    .all(venueId)) as Row[];
  return rows.map(toConcession);
}

export async function concessionById(id: number): Promise<Concession | null> {
  const row = (await getDb().prepare("SELECT * FROM concessions WHERE id = ? AND retired_at IS NULL").get(id)) as Row | undefined;
  return row ? toConcession(row) : null;
}

/** Offer one, or change one: `id` to change. */
export async function saveConcession(
  venueId: number,
  input: { id?: unknown; name?: unknown; percent?: unknown; proof?: unknown; sport?: unknown; offPeakOnly?: unknown }
): Promise<{ ok: true; concession: Concession } | { ok: false; error: string }> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 2 || name.length > 40) return { ok: false, error: "Name it, as customers will see it: Student, Senior (60+)." };
  const percent = Number(input.percent);
  if (!Number.isInteger(percent) || percent < 5 || percent > 100) return { ok: false, error: "Take 5 to 100 percent off." };
  const proof = typeof input.proof === "string" ? input.proof.trim() : "";
  if (proof.length < 3 || proof.length > 80) return { ok: false, error: "Say what to show at the counter: your student card, your IC." };
  const sport = input.sport === null || input.sport === undefined || input.sport === "" ? null : (input.sport as Sport);
  if (sport !== null && !SPORTS.includes(sport)) return { ok: false, error: "Unknown sport." };
  const offPeak = input.offPeakOnly === true ? 1 : 0;
  const db = getDb();
  if (input.id !== undefined && input.id !== null) {
    const done = await db
      .prepare(
        "UPDATE concessions SET name = ?, percent = ?, proof = ?, sport = ?, off_peak_only = ? WHERE id = ? AND venue_id = ? AND retired_at IS NULL RETURNING *"
      )
      .get(name, percent, proof, sport, offPeak, input.id, venueId);
    if (!done) return { ok: false, error: "That concession is not offered here." };
    return { ok: true, concession: toConcession(done as Row) };
  }
  const row = (await db
    .prepare("INSERT INTO concessions (venue_id, name, percent, proof, sport, off_peak_only) VALUES (?, ?, ?, ?, ?, ?) RETURNING *")
    .get(venueId, name, percent, proof, sport, offPeak)) as Row;
  return { ok: true, concession: toConcession(row) };
}

/** No longer offered. Bookings already made at it keep their price. */
export async function retireConcession(venueId: number, id: number): Promise<boolean> {
  const done = await getDb()
    .prepare("UPDATE concessions SET retired_at = datetime('now') WHERE id = ? AND venue_id = ? AND retired_at IS NULL")
    .run(id, venueId);
  return done.changes === 1;
}

/** Is proof of this on file for this number, counting on this date? */
async function proofOnFile(venueId: number, phone: string, concessionId: number, date: string): Promise<boolean> {
  return !!(await getDb()
    .prepare("SELECT 1 FROM concession_proofs WHERE venue_id = ? AND phone_key = ? AND concession_id = ? AND valid_until >= ?")
    .get(venueId, phoneKey(phone), concessionId, date));
}

/**
 * The concession price on a booking just made: that share off the court's
 * price (a coach's fee is the coach's). One discount at a time, so not on a
 * last-minute price; off-peak only where the venue said so.
 */
export async function applyConcession(
  bookingId: number,
  concessionId: number
): Promise<{ ok: true; off: number; check: ConcessionCheck } | Refusal> {
  const booking = await bookingById(bookingId);
  if (!booking || booking.status !== "confirmed") return refuse("BOOKING_NOT_FOUND");
  const court = await getCourt(booking.courtId);
  const concession = await concessionById(concessionId);
  if (!court || !concession || concession.venueId !== court.venueId) return refuse("CONCESSION_NOT_HERE");
  if (concession.sport !== null && concession.sport !== court.sport) return refuse("CONCESSION_NOT_HERE");
  if (booking.paymentStatus === "paid") return refuse("PROMO_TOO_LATE");
  const db = getDb();
  const flags = (await db.prepare("SELECT last_minute, concession_id FROM bookings WHERE id = ?").get(bookingId)) as {
    last_minute: number;
    concession_id: number | null;
  };
  if (flags.last_minute === 1 || flags.concession_id !== null) return refuse("ONE_DISCOUNT");
  if (concession.offPeakOnly) {
    const rules = forSport(await peakRules(court.venueId), court.sport);
    if (touchesPeak(booking.date, { start: booking.startMin, end: booking.endMin }, rules))
      return refuse("CONCESSION_OFF_PEAK", { name: concession.name });
  }
  // Off the court time only: not a coach's fee, nor a setup or cleanup fee.
  const off = roundMoney(((booking.totalPrice - (booking.coachFee ?? 0) - (booking.feeAmount ?? 0)) * concession.percent) / 100);
  const check: ConcessionCheck = (await proofOnFile(court.venueId, booking.phone, concession.id, booking.date)) ? "seen" : "due";
  await db
    .prepare(
      `UPDATE bookings SET total_price = total_price - ?, concession_id = ?, concession_name = ?, concession_off = ?, concession_check = ?
        WHERE id = ? AND concession_id IS NULL`
    )
    .run(off, concession.id, concession.name, off, check, bookingId);
  return { ok: true, off, check };
}

/** How long a proof seen counts for, as staff choose it. */
export const REMEMBER = ["visit", "month", "year", "twelve"] as const;
export type Remember = (typeof REMEMBER)[number];

export function rememberUntil(choice: Remember, today = todayISO()): string | null {
  if (choice === "visit") return null;
  if (choice === "twelve") return addDays(today, 365);
  const [y, m] = today.split("-").map(Number);
  if (choice === "year") return `${y}-12-31`;
  // The last day of this month.
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return addDays(next, -1);
}

/**
 * Staff have looked. Seen: it stands, and is remembered for the time chosen.
 * Not shown: the full price, added to what is owed, or, already paid, sold at
 * the counter for the difference (`via` says how it was paid then).
 */
export async function checkConcession(input: {
  bookingId: number;
  venueIds: number[] | null;
  adminId: number | null;
  outcome: unknown;
  remember?: unknown;
  via?: unknown;
}): Promise<{ ok: true; booking: Booking; charged: number } | { ok: false; error: string }> {
  const booking = await bookingById(input.bookingId);
  const court = booking ? await getCourt(booking.courtId) : null;
  if (!booking || !court || (input.venueIds && !input.venueIds.includes(court.venueId))) return { ok: false, error: "Booking not found." };
  const row = (await getDb().prepare("SELECT concession_id, concession_off, concession_check FROM bookings WHERE id = ?").get(booking.id)) as {
    concession_id: number | null;
    concession_off: number | string;
    concession_check: ConcessionCheck | null;
  };
  if (row.concession_check === null) return { ok: false, error: "This booking has no concession price." };
  if (row.concession_check === "refused") return { ok: false, error: "The full price is already charged on this one." };
  const db = getDb();
  if (input.outcome === "seen") {
    const remember = (REMEMBER as readonly string[]).includes(input.remember as string) ? (input.remember as Remember) : "visit";
    const until = rememberUntil(remember);
    await db.prepare("UPDATE bookings SET concession_check = 'seen' WHERE id = ?").run(booking.id);
    if (until && row.concession_id !== null && isValidDateString(until))
      await db
        .prepare(
          `INSERT INTO concession_proofs (venue_id, phone_key, concession_id, seen_by, seen_on, valid_until) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (venue_id, phone_key, concession_id) DO UPDATE SET seen_by = excluded.seen_by, seen_on = excluded.seen_on, valid_until = excluded.valid_until`
        )
        .run(court.venueId, phoneKey(booking.phone), row.concession_id, input.adminId, todayISO(), until);
    return { ok: true, booking: (await bookingById(booking.id))!, charged: 0 };
  }
  if (input.outcome !== "refused") return { ok: false, error: "Say whether the proof was seen." };
  const off = Number(row.concession_off);
  if (booking.status === "confirmed" && booking.paymentStatus === "unpaid") {
    await db
      .prepare("UPDATE bookings SET total_price = total_price + ?, concession_check = 'refused' WHERE id = ?")
      .run(off, booking.id);
  } else {
    // Paid already: the difference is a sale of its own, receipted like any other.
    const sold = await sellAtCounter({
      venueId: court.venueId,
      adminId: input.adminId,
      items: [{ name: `Full price, ${booking.code} (no proof)`.slice(0, 60), price: off, quantity: 1 }],
      via: input.via,
      customerName: booking.name,
      customerPhone: booking.phone,
    });
    if (!sold.ok) return sold;
    await db.prepare("UPDATE bookings SET concession_check = 'refused' WHERE id = ?").run(booking.id);
  }
  return { ok: true, booking: (await bookingById(booking.id))!, charged: off };
}

/** What a number has on file here, for the desk and for the customer's own data. */
export async function proofsFor(phone: string): Promise<{ venueId: number; concession: string; seenOn: string; validUntil: string }[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT p.venue_id, c.name, p.seen_on, p.valid_until FROM concession_proofs p JOIN concessions c ON c.id = p.concession_id
        WHERE p.phone_key = ? ORDER BY p.seen_on DESC`
    )
    .all(phoneKey(phone))) as { venue_id: number; name: string; seen_on: string; valid_until: string }[];
  return rows.map((r) => ({ venueId: r.venue_id, concession: r.name, seenOn: r.seen_on, validUntil: r.valid_until }));
}
