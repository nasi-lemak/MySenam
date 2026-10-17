import { getDb } from "./db";

/**
 * How far a newly approved venue has got with setting itself up.
 *
 * An approved venue starts with a name, an address and nothing to book, and
 * its owner's first sight of the dashboard was an empty day list with eight
 * tabs and no word on where to start. The checklist built on this says where:
 * courts and rates, then opening hours, then a booking of their own to see
 * what a customer sees — with taking payment online, photos and facilities
 * as optional extras.
 *
 * Each step is read from what the venue has actually done, not ticked by
 * hand, except the hours: whether they are right is the owner's call, so
 * saving the venue's details, or saying they are right as they are, counts.
 */
export interface VenueSetup {
  venueId: number;
  courts: number;
  detailsChecked: boolean;
  testBooking: boolean;
  onlinePayment: boolean;
  /** Optional, like payment online: a cover photo and some facilities ticked. */
  photos: boolean;
  facilities: boolean;
  dismissed: boolean;
  /** Everything but the optional step is done. */
  complete: boolean;
}

const key = (what: "details_checked" | "dismissed", venueId: number) => `setup.${what}.${venueId}`;

async function flag(name: string): Promise<boolean> {
  return (await getDb().prepare("SELECT 1 AS yes FROM settings WHERE key = ?").get(name)) !== undefined;
}

async function setFlag(name: string): Promise<void> {
  await getDb()
    .prepare("INSERT INTO settings (key, value) VALUES (?, datetime('now')) ON CONFLICT (key) DO NOTHING")
    .run(name);
}

export async function venueSetup(venueId: number): Promise<VenueSetup> {
  const db = getDb();
  const { courts } = (await db.prepare("SELECT COUNT(*) AS courts FROM courts WHERE venue_id = ?").get(venueId)) as {
    courts: number;
  };
  const testBooking =
    (await db
      .prepare("SELECT 1 FROM bookings b JOIN courts c ON c.id = b.court_id WHERE c.venue_id = ? LIMIT 1")
      .get(venueId)) !== undefined;
  const onlinePayment =
    (await db.prepare("SELECT 1 FROM venue_payment_accounts WHERE venue_id = ? AND enabled = 1").get(venueId)) !==
    undefined;
  const detailsChecked = await flag(key("details_checked", venueId));
  const photos = (await db.prepare("SELECT 1 FROM venue_photos WHERE venue_id = ? LIMIT 1").get(venueId)) !== undefined;
  const facilities =
    (await db.prepare("SELECT 1 FROM venues WHERE id = ? AND cardinality(amenities) > 0").get(venueId)) !== undefined;
  return {
    venueId,
    courts,
    detailsChecked,
    testBooking,
    onlinePayment,
    photos,
    facilities,
    dismissed: await flag(key("dismissed", venueId)),
    complete: courts > 0 && detailsChecked && testBooking,
  };
}

/** The owner has looked at their hours and details: saved them, or said they are right. */
export async function markDetailsChecked(venueId: number): Promise<void> {
  await setFlag(key("details_checked", venueId));
}

/** "I know my way round": no checklist for this venue again. */
export async function dismissSetup(venueId: number): Promise<void> {
  await setFlag(key("dismissed", venueId));
}
