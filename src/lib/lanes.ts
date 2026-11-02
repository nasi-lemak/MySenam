import { translator, type Locale } from "./i18n";
import type { Booking } from "./types";

/**
 * A lane given on arrival (lib/booking-rules.ts `laneOnArrival`;
 * docs/features/booking.md#by-the-game-and-a-lane-given-on-arrival).
 *
 * The booking holds one lane like any other, so the database refuses an
 * overlap as it always does; but that lane is provisional. Until the booking
 * is checked in the customer is told only that a lane is given when they
 * arrive: never the lane's name, on any page, message, calendar entry or
 * receipt made for them. Staff see the lane, marked provisional, and at
 * check-in may put the booking on any lane free for its time
 * (lib/store.ts `checkInOnLane`, which moves it as any booking is moved).
 * Once checked in, the lane is theirs and is shown.
 *
 * Browser-safe: no database.
 */

/** Is this booking's lane still to be given (provisional, and not to be named to the customer)? */
export function laneHidden(b: Pick<Booking, "laneOnArrival" | "checkedInAt"> | null | undefined): boolean {
  return !!b && b.laneOnArrival === true && !b.checkedInAt;
}

/** What the customer is told in place of the lane's name. */
export function laneWords(locale: Locale): string {
  return translator(locale)("bowl.laneOnArrival");
}

/** The court's name as the customer may be told it: the lane, or that a lane is given on arrival. */
export function customerCourtName(name: string, booking: Pick<Booking, "laneOnArrival" | "checkedInAt"> | null | undefined, locale: Locale): string {
  return laneHidden(booking) ? laneWords(locale) : name;
}

/** A court as a customer's page is given it, its name hidden where its lane is still to be given. */
export function customerCourt<C extends { name: string }>(court: C, booking: Pick<Booking, "laneOnArrival" | "checkedInAt"> | null | undefined, locale: Locale): C {
  return laneHidden(booking) ? { ...court, name: laneWords(locale) } : court;
}
