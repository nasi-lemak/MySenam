/**
 * Who is on which court of a booking of several courts, as the booking page
 * sends it (docs/features/booking.md#booking-for-somebody-else): the same
 * shape and rules as `POST /api/bookings` reads (`participantIds` and
 * `customerTakesPart` for the court picked first, `moreCourts[]` for the
 * others; lib/participant-bookings.ts). Each person named is on exactly one
 * court, the court picked first unless moved; the customer, where they take
 * part, is on one court too. A court nobody is named on is the customer's
 * party, a count of places with nobody assigned, so it sends no people.
 */

/** The customer's own key beside participants' ids. */
export const CUSTOMER = "customer";

/** Which court each person is on: a participant's id (as a string) or `CUSTOMER`, to a court id. */
export type CourtOf = Record<string, number>;

export interface CourtPeople {
  courtId: number;
  participantIds: number[];
  /** The customer takes a place here alongside the people named. */
  customerTakesPart: boolean;
}

/** Each court of the group with who is on it (nobody named: the customer's party). */
export function splitByCourt(input: { courtIds: number[]; named: number[]; customerTakesPart: boolean; courtOf: CourtOf }): CourtPeople[] {
  const [first] = input.courtIds;
  const where = (key: string) => (input.courtIds.includes(input.courtOf[key]) ? input.courtOf[key] : first);
  return input.courtIds.map((courtId) => {
    const participantIds = input.named.filter((id) => where(String(id)) === courtId);
    return { courtId, participantIds, customerTakesPart: input.customerTakesPart && participantIds.length > 0 && where(CUSTOMER) === courtId };
  });
}

/** How many people a court takes for who is on it: those named and the customer with them; nobody named, none said. */
export const namedOn = (c: CourtPeople): number => c.participantIds.length + (c.customerTakesPart ? 1 : 0);

/**
 * The request's people for a group: top-level `participantIds` and
 * `customerTakesPart` for the court picked first, and `moreCourts` with each
 * other court's own (and its places on a shared resource, where said).
 */
export function groupRequest(input: {
  courtIds: number[];
  named: number[];
  customerTakesPart: boolean;
  courtOf: CourtOf;
  places?: Record<number, number>;
}): { participantIds?: number[]; customerTakesPart?: boolean; moreCourts: (number | { courtId: number; places?: number; participantIds?: number[]; customerTakesPart?: boolean })[] } {
  const [first, ...rest] = splitByCourt(input);
  const people = (c: CourtPeople) => (c.participantIds.length > 0 ? { participantIds: c.participantIds, customerTakesPart: c.customerTakesPart } : {});
  return {
    ...people(first),
    moreCourts: rest.map((c) => {
      const places = input.places?.[c.courtId];
      return places === undefined && c.participantIds.length === 0 ? c.courtId : { courtId: c.courtId, ...(places !== undefined ? { places } : {}), ...people(c) };
    }),
  };
}

/** Does the customer take a place anywhere: beside people named, or on a court of their own party. */
export const customerAnywhere = (courts: CourtPeople[]): boolean => courts.some((c) => c.participantIds.length === 0 || c.customerTakesPart);
