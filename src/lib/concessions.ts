import { isActivity } from "./activities";
import { sellAtCounter } from "./counter-sales";
import { getDb, withTransaction } from "./db";
import { peakRules } from "./peak";
import { phoneKey } from "./phone";
import { roundMoney } from "./region";
import { getBookingById as bookingById, getCourt } from "./store";
import { addDays, forSport, isValidDateString, todayISO } from "./time";
import { touchesPeak } from "./pricing";
import { type Booking, type Refusal, type Sport } from "./types";
import { errorText, translator, type ErrorCode, type Phrase } from "./i18n";
import { isConcessionPreset, type ConcessionPreset } from "./concessions-shared";
import { unchangedPreset } from "./concession-presets";
import { CONCESSION_SCOPES, isDuplicateRedemption, isScope, placeFor, placeShares, placesOf, soldByPlace, type BenefitScope } from "./entitlements";
import { keepPaidWithinPrice } from "./paid-within-price";
import { allocatePromo, courtBeforePromo, stackRefusal } from "./discounts";

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
  /**
   * A built-in one used unchanged (lib/concessions-shared.ts): customers read
   * its name and proof in their own language. null: the venue's own words,
   * which `name` and `proof` are, shown as typed.
   */
  preset: ConcessionPreset | null;
  /**
   * What one use covers (lib/entitlements.ts): the booking as a whole
   * (`booking`, as every concession before), or one person's place on a
   * booking priced by the place (`participant`: a child's admission price).
   */
  scope: BenefitScope;
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
  preset: string | null;
  scope?: string | null;
}

const toConcession = (r: Row): Concession => ({
  id: r.id,
  venueId: r.venue_id,
  name: r.name,
  percent: Number(r.percent),
  proof: r.proof,
  sport: r.sport,
  offPeakOnly: r.off_peak_only === 1,
  preset: isConcessionPreset(r.preset) ? r.preset : null,
  scope: isScope(r.scope, CONCESSION_SCOPES) ? r.scope : "booking",
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

/**
 * Offer one, or change one: `id` to change. `preset` names the built-in one
 * it was started from; it is kept only while the name and proof are still
 * that preset's own words.
 */
export async function saveConcession(
  venueId: number,
  input: { id?: unknown; name?: unknown; percent?: unknown; proof?: unknown; sport?: unknown; offPeakOnly?: unknown; preset?: unknown; scope?: unknown }
): Promise<{ ok: true; concession: Concession } | { ok: false; error: string }> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 2 || name.length > 40) return { ok: false, error: "Name it, as customers will see it: Student, Senior (60+)." };
  const percent = Number(input.percent);
  if (!Number.isInteger(percent) || percent < 5 || percent > 100) return { ok: false, error: "Take 5 to 100 percent off." };
  const proof = typeof input.proof === "string" ? input.proof.trim() : "";
  if (proof.length < 3 || proof.length > 80) return { ok: false, error: "Say what to show at the counter: your student card, your IC." };
  const sport = input.sport === null || input.sport === undefined || input.sport === "" ? null : (input.sport as Sport);
  if (sport !== null && !(await isActivity(sport))) return { ok: false, error: "Unknown sport." };
  const offPeak = input.offPeakOnly === true ? 1 : 0;
  const preset = unchangedPreset(input.preset, name, proof);
  // The whole booking (as every concession was), or one person's place: said by staff, never guessed.
  if (input.scope !== undefined && input.scope !== null && !isScope(input.scope, CONCESSION_SCOPES))
    return { ok: false, error: "A concession is for the whole booking, or for one person's place." };
  const scope: BenefitScope = isScope(input.scope, CONCESSION_SCOPES) ? input.scope : "booking";
  const db = getDb();
  if (input.id !== undefined && input.id !== null) {
    const done = await db
      .prepare(
        "UPDATE concessions SET name = ?, percent = ?, proof = ?, sport = ?, off_peak_only = ?, preset = ?, scope = ? WHERE id = ? AND venue_id = ? AND retired_at IS NULL RETURNING *"
      )
      .get(name, percent, proof, sport, offPeak, preset, scope, input.id, venueId);
    if (!done) return { ok: false, error: "That concession is not offered here." };
    return { ok: true, concession: toConcession(done as Row) };
  }
  const row = (await db
    .prepare("INSERT INTO concessions (venue_id, name, percent, proof, sport, off_peak_only, preset, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *")
    .get(venueId, name, percent, proof, sport, offPeak, preset, scope)) as Row;
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
  if (concession.sport !== null && concession.sport !== booking.sport) return refuse("CONCESSION_NOT_HERE");
  // One person's: on a booking with one place it is that person's; with several, whose must be said.
  if (concession.scope === "participant") {
    const places = await placesOf(bookingId);
    if (places.length !== 1 || (booking.players ?? 1) > 1) return refuse("ENT_CONCESSION_WHOSE");
    return applyPlaceConcession(bookingId, concessionId, places[0].participantId);
  }
  if (booking.paymentStatus === "paid") return refuse("PROMO_TOO_LATE");
  const db = getDb();
  // The venue's rule on discounts together, asked first to say why at once; asked again under the lock below.
  if (booking.concessionName) return refuse("ONE_DISCOUNT");
  const stackedNow = await stackRefusal(bookingId, { kind: "concession" });
  if (stackedNow) return stackedNow;
  const peak = await offPeakRefusal(concession, court.venueId, booking);
  if (peak) return peak;
  const check: ConcessionCheck = (await proofOnFile(court.venueId, booking.phone, concession.id, booking.date)) ? "seen" : "due";
  try {
    const off = await withTransaction(async () => {
      // Under the booking's row lock: whatever else is being put on it at the same moment is seen (lib/discounts.ts).
      const live = (await db.prepare("SELECT status, payment_status, concession_id FROM bookings WHERE id = ? FOR UPDATE").get(bookingId)) as {
        status: string;
        payment_status: string;
        concession_id: number | null;
      };
      if (live.status !== "confirmed" || live.payment_status !== "unpaid") throw new ConcessionRefused(refuse("PROMO_TOO_LATE"));
      if (live.concession_id !== null) throw new ConcessionRefused(refuse("ONE_DISCOUNT"));
      // With a code or a person's own concession already on it: the venue's rule on discounts together.
      const stacked = await stackRefusal(bookingId, { kind: "concession" });
      if (stacked) throw new ConcessionRefused(stacked);
      // Off the court time only, after member prices and before any code: not a coach's fee, nor a setup or cleanup fee, nor extras.
      const amount = roundMoney(((await courtBeforePromo(bookingId)) * concession.percent) / 100);
      const done = await db
        .prepare(
          `UPDATE bookings SET total_price = total_price - ?, concession_id = ?, concession_name = ?, concession_preset = ?, concession_off = ?, concession_check = ?
            WHERE id = ? AND concession_id IS NULL`
        )
        .run(amount, concession.id, concession.name, concession.preset, amount, check, bookingId);
      if (done.changes !== 1) throw new ConcessionRefused(refuse("ONE_DISCOUNT"));
      // A code on it is worked out again on the lower price, so the order is the same whichever came first.
      await allocatePromo(bookingId);
      // Below what a deposit or shares paid on it: that part owed back, or the concession refused (lib/paid-within-price.ts).
      const kept = await keepPaidWithinPrice(bookingId);
      if (!kept.ok) throw new ConcessionRefused(kept);
      return amount;
    });
    return { ok: true, off, check };
  } catch (err) {
    if (err instanceof ConcessionRefused) return err.refusal;
    throw err;
  }
}

/** Refused where the venue gives it off-peak only and the booking touches peak time. */
async function offPeakRefusal(concession: Concession, venueId: number, booking: Booking): Promise<Refusal | null> {
  if (!concession.offPeakOnly) return null;
  const rules = forSport(await peakRules(venueId), booking.sport);
  if (!touchesPeak(booking.date, { start: booking.startMin, end: booking.endMin }, rules)) return null;
  // A built-in one is named by its key too, so each customer reads it in their own language.
  return refuse(
    "CONCESSION_OFF_PEAK",
    concession.preset ? { name: ENGLISH(`pre.con.${concession.preset}` as Phrase), nameKey: `pre.con.${concession.preset}` } : { name: concession.name }
  );
}

/** Is proof of this on file for this participant, counting on this date? */
async function participantProofOnFile(venueId: number, participantId: number, concessionId: number, date: string): Promise<boolean> {
  return !!(await getDb()
    .prepare("SELECT 1 FROM participant_concession_proofs WHERE venue_id = ? AND participant_id = ? AND concession_id = ? AND valid_until >= ?")
    .get(venueId, participantId, concessionId, date));
}

/**
 * A concession for one person's place (`scope = 'participant'`): that share
 * off their place's share of the court time, on a booking priced by the
 * place, and nobody else's (ADR 0025). A guardian booking three children of
 * whom one is a child for the venue's child price gets it on that one place.
 * `participantId` null is the customer's own place. Recorded per place
 * (`place_benefits`), where the database refuses a second concession for one
 * place however the requests arrive; one discount at a time, as a booking's
 * own concession is.
 */
export async function applyPlaceConcession(
  bookingId: number,
  concessionId: number,
  participantId: number | null
): Promise<{ ok: true; off: number; check: ConcessionCheck; placeId: number | null } | Refusal> {
  const booking = await bookingById(bookingId);
  if (!booking || booking.status !== "confirmed") return refuse("BOOKING_NOT_FOUND");
  const court = await getCourt(booking.courtId);
  const concession = await concessionById(concessionId);
  if (!court || !concession || concession.venueId !== court.venueId) return refuse("CONCESSION_NOT_HERE");
  if (concession.sport !== null && concession.sport !== booking.sport) return refuse("CONCESSION_NOT_HERE");
  if (concession.scope !== "participant") return refuse("ENT_CONCESSION_BOOKING");
  // Nothing on a resource hired whole is priced per person: the court is the court, whoever plays.
  if (!soldByPlace(court)) return refuse("ENT_PLACE_ONLY");
  if (booking.paymentStatus === "paid") return refuse("PROMO_TOO_LATE");
  const db = getDb();
  // The venue's rule on discounts together, asked first to say why at once; asked again under the lock below.
  const stackedNow = await stackRefusal(bookingId, { kind: "placeConcession" });
  if (stackedNow) return stackedNow;
  const peak = await offPeakRefusal(concession, court.venueId, booking);
  if (peak) return peak;
  const place = await placeFor(bookingId, participantId);
  if (!place) return refuse("ENT_NOT_ON_BOOKING");
  const check: ConcessionCheck = (
    participantId === null
      ? await proofOnFile(court.venueId, booking.phone, concession.id, booking.date)
      : await participantProofOnFile(court.venueId, participantId, concession.id, booking.date)
  )
    ? "seen"
    : "due";
  try {
    const off = await withTransaction(async () => {
      // The booking's price is read and changed under its row lock, so two places' concessions at once each see the other.
      const live = (await db.prepare("SELECT status, payment_status FROM bookings WHERE id = ? FOR UPDATE").get(bookingId)) as { status: string; payment_status: string };
      if (live.status !== "confirmed" || live.payment_status !== "unpaid") throw new ConcessionRefused(refuse("PROMO_TOO_LATE"));
      const stacked = await stackRefusal(bookingId, { kind: "placeConcession" });
      if (stacked) throw new ConcessionRefused(stacked);
      // That place's share of the court time after its own member price, before any code (lib/discounts.ts: the order).
      const line = (await placeShares(bookingId)).lines.find((l) => l.placeId === place.placeId);
      const amount = roundMoney((Math.max(0, (line?.gross ?? 0) - (line?.member ?? 0)) * concession.percent) / 100);
      await db
        .prepare(
          `INSERT INTO place_benefits (booking_id, place_id, participant_id, kind, concession_id, concession_name, concession_preset, amount, proof_check)
           VALUES (?, ?, ?, 'concession', ?, ?, ?, ?, ?)`
        )
        .run(bookingId, place.placeId, participantId, concession.id, concession.name, concession.preset, amount, check);
      await db.prepare("UPDATE bookings SET total_price = total_price - ? WHERE id = ?").run(amount, bookingId);
      // A code on it is worked out again on the lower price, so the order is the same whichever came first.
      await allocatePromo(bookingId);
      // Below what a deposit or shares paid on it: that part owed back, or the concession refused (lib/paid-within-price.ts).
      const kept = await keepPaidWithinPrice(bookingId);
      if (!kept.ok) throw new ConcessionRefused(kept);
      return amount;
    });
    return { ok: true, off, check, placeId: place.placeId };
  } catch (err) {
    if (err instanceof ConcessionRefused) return err.refusal;
    if (isDuplicateRedemption(err)) return refuse("ENT_ALREADY_REDEEMED");
    throw err;
  }
}

class ConcessionRefused extends Error {
  constructor(readonly refusal: Refusal) {
    super("CONCESSION_REFUSED");
  }
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
 *
 * The outcome is decided once, under the booking's row lock (ADR 0062): a
 * double click, a second desk or a retry reads what the first one left. The
 * full price is charged back once, never twice; and a proof marked seen stays
 * seen (a later "no proof" is refused: a manager reverses it by hand).
 */
export async function checkConcession(input: {
  bookingId: number;
  venueIds: number[] | null;
  adminId: number | null;
  outcome: unknown;
  remember?: unknown;
  via?: unknown;
  /** One person's concession on the booking (`place_benefits`), checked for that person alone. */
  placeBenefitId?: unknown;
}): Promise<{ ok: true; booking: Booking; charged: number } | { ok: false; error: string }> {
  const booking = await bookingById(input.bookingId);
  const court = booking ? await getCourt(booking.courtId) : null;
  if (!booking || !court || (input.venueIds && !input.venueIds.includes(court.venueId))) return { ok: false, error: "Booking not found." };
  if (input.placeBenefitId !== undefined && input.placeBenefitId !== null) return checkPlaceConcession(booking, court.venueId, input);
  if (input.outcome !== "seen" && input.outcome !== "refused") return { ok: false, error: "Say whether the proof was seen." };
  const db = getDb();
  return withTransaction(async () => {
    // Read under the booking's row lock, as the concession was put on it: what is decided here is decided once.
    const row = (await db
      .prepare("SELECT status, payment_status, concession_id, concession_off, concession_check FROM bookings WHERE id = ? FOR UPDATE")
      .get(booking.id)) as {
      status: string;
      payment_status: string;
      concession_id: number | null;
      concession_off: number | string;
      concession_check: ConcessionCheck | null;
    };
    if (row.concession_check === null) return { ok: false as const, error: "This booking has no concession price." };
    if (row.concession_check === "refused") return { ok: false as const, error: "The full price is already charged on this one." };
    if (input.outcome === "seen") {
      const remember = (REMEMBER as readonly string[]).includes(input.remember as string) ? (input.remember as Remember) : "visit";
      const until = rememberUntil(remember);
      await db.prepare("UPDATE bookings SET concession_check = 'seen' WHERE id = ? AND concession_check <> 'refused'").run(booking.id);
      if (until && row.concession_id !== null && isValidDateString(until))
        await db
          .prepare(
            `INSERT INTO concession_proofs (venue_id, phone_key, concession_id, seen_by, seen_on, valid_until) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (venue_id, phone_key, concession_id) DO UPDATE SET seen_by = excluded.seen_by, seen_on = excluded.seen_on, valid_until = excluded.valid_until`
          )
          .run(court.venueId, phoneKey(booking.phone), row.concession_id, input.adminId, todayISO(), until);
      return { ok: true as const, booking: (await bookingById(booking.id))!, charged: 0 };
    }
    // Once staff have said the proof was seen, a later click does not silently charge the full price.
    if (row.concession_check === "seen") return { ok: false as const, error: "The proof was already marked as seen." };
    const off = Number(row.concession_off);
    if (row.status === "confirmed" && row.payment_status === "unpaid") {
      await db.prepare("UPDATE bookings SET total_price = total_price + ?, concession_check = 'refused' WHERE id = ? AND concession_check = 'due'").run(off, booking.id);
      // A code on it is worked out again on the full price (lib/discounts.ts).
      await allocatePromo(booking.id);
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
      await db.prepare("UPDATE bookings SET concession_check = 'refused' WHERE id = ? AND concession_check = 'due'").run(booking.id);
    }
    return { ok: true as const, booking: (await bookingById(booking.id))!, charged: off };
  });
}

/**
 * One person's concession checked at the counter: their proof, not the
 * guardian's. Seen: it stands, and is remembered for that participant (or the
 * customer's number, for their own place). Not shown: that place's full
 * price, added to what is owed, or sold at the counter once paid.
 */
async function checkPlaceConcession(
  booking: Booking,
  venueId: number,
  input: { adminId: number | null; outcome: unknown; remember?: unknown; via?: unknown; placeBenefitId?: unknown }
): Promise<{ ok: true; booking: Booking; charged: number } | { ok: false; error: string }> {
  const db = getDb();
  if (input.outcome !== "seen" && input.outcome !== "refused") return { ok: false, error: "Say whether the proof was seen." };
  return withTransaction(async () => {
    // Under the booking's row lock, as the concession was put on it: what is decided here is decided once (ADR 0062).
    const live = (await db.prepare("SELECT status, payment_status FROM bookings WHERE id = ? FOR UPDATE").get(booking.id)) as { status: string; payment_status: string };
    const pb = Number.isInteger(input.placeBenefitId)
      ? ((await db
          .prepare(
            "SELECT id, participant_id, concession_id, amount::float AS amount, proof_check, reversed_at FROM place_benefits WHERE id = ? AND booking_id = ? AND kind = 'concession'"
          )
          .get(input.placeBenefitId, booking.id)) as
          | { id: number; participant_id: number | null; concession_id: number | null; amount: number; proof_check: ConcessionCheck | null; reversed_at: unknown }
          | undefined)
      : undefined;
    if (pb?.proof_check === "refused") return { ok: false as const, error: "The full price is already charged on this one." };
    if (!pb || pb.proof_check === null || pb.reversed_at !== null) return { ok: false as const, error: "This booking has no concession price." };
    if (input.outcome === "seen") {
      const remember = (REMEMBER as readonly string[]).includes(input.remember as string) ? (input.remember as Remember) : "visit";
      const until = rememberUntil(remember);
      await db.prepare("UPDATE place_benefits SET proof_check = 'seen' WHERE id = ? AND proof_check <> 'refused'").run(pb.id);
      if (until && pb.concession_id !== null && isValidDateString(until)) {
        if (pb.participant_id !== null)
          await db
            .prepare(
              `INSERT INTO participant_concession_proofs (venue_id, participant_id, concession_id, seen_by, seen_on, valid_until) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (venue_id, participant_id, concession_id) DO UPDATE SET seen_by = excluded.seen_by, seen_on = excluded.seen_on, valid_until = excluded.valid_until`
            )
            .run(venueId, pb.participant_id, pb.concession_id, input.adminId, todayISO(), until);
        else
          await db
            .prepare(
              `INSERT INTO concession_proofs (venue_id, phone_key, concession_id, seen_by, seen_on, valid_until) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (venue_id, phone_key, concession_id) DO UPDATE SET seen_by = excluded.seen_by, seen_on = excluded.seen_on, valid_until = excluded.valid_until`
            )
            .run(venueId, phoneKey(booking.phone), pb.concession_id, input.adminId, todayISO(), until);
      }
      return { ok: true as const, booking: (await bookingById(booking.id))!, charged: 0 };
    }
    // Once staff have said the proof was seen, a later click does not silently charge the full price.
    if (pb.proof_check === "seen") return { ok: false as const, error: "The proof was already marked as seen." };
    const off = Number(pb.amount);
    if (live.status === "confirmed" && live.payment_status === "unpaid") {
      // The benefit stays on record as refused and given back; its amount goes back on what is owed, once.
      const done = await db
        .prepare("UPDATE place_benefits SET proof_check = 'refused', reversed_at = now(), reversed_why = 'no proof' WHERE id = ? AND reversed_at IS NULL")
        .run(pb.id);
      if (done.changes !== 1) return { ok: false as const, error: "The full price is already charged on this one." };
      await db.prepare("UPDATE bookings SET total_price = total_price + ? WHERE id = ?").run(off, booking.id);
      // A code on it is worked out again on the full price (lib/discounts.ts).
      await allocatePromo(booking.id);
    } else {
      const sold = await sellAtCounter({
        venueId,
        adminId: input.adminId,
        items: [{ name: `Full price, ${booking.code} (no proof)`.slice(0, 60), price: off, quantity: 1 }],
        via: input.via,
        customerName: booking.name,
        customerPhone: booking.phone,
      });
      if (!sold.ok) return sold;
      await db.prepare("UPDATE place_benefits SET proof_check = 'refused' WHERE id = ?").run(pb.id);
    }
    return { ok: true as const, booking: (await bookingById(booking.id))!, charged: off };
  });
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
