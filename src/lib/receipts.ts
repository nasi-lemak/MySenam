import crypto from "crypto";
import { getDb } from "./db";
import { keyedHash } from "./secrets";
import { findBookingByCode, getCourt, getVenue } from "./store";
import { taxIncluded, venueTax } from "./tax";
import { formatHour } from "./time";
import { PAID_VIA_LABELS, SPORT_LABELS, type PaidVia } from "./types";

/**
 * A paid booking's receipt: a page to keep or print, and — when the venue is
 * registered for SST or GST — its tax invoice, with the tax inside the price
 * and the venue's registration number.
 *
 * Its address carries a token signed with the install's secret rather than
 * the customer's phone number, so it can go in an email and a browser's
 * history without giving anybody else a way in.
 */

export function receiptToken(code: string): string {
  return keyedHash("receipt", code.toUpperCase()).slice(0, 24);
}

/** The receipt's path, to put after the venue's own address. */
export function receiptPath(code: string): string {
  return `/receipt/${encodeURIComponent(code)}?t=${receiptToken(code)}`;
}

export interface Receipt {
  code: string;
  venue: { name: string; address: string; phone: string };
  customer: string;
  /** When it was paid; the booking's date for one paid as it was made. */
  paidAt: string | null;
  paidVia: string | null;
  lines: { description: string; amount: number }[];
  total: number;
  /** The tax inside the total, with what the venue is registered as. Null with none. */
  tax: { name: string; rate: number; amount: number; regNo: string | null } | null;
  cancelled: boolean;
}

/** The receipt behind a signed link, or null: a wrong token, no such booking, or nothing paid. */
export async function receiptFor(code: string, token: string): Promise<Receipt | null> {
  const expected = receiptToken(code);
  if (token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return null;
  const booking = await findBookingByCode(code);
  if (!booking || booking.paymentStatus !== "paid" || booking.totalPrice <= 0) return null;
  const court = await getCourt(booking.courtId);
  const venue = court ? await getVenue(court.venueId) : null;
  if (!court || !venue) return null;

  const db = getDb();
  const extras = (await db
    .prepare("SELECT name, quantity, unit_price::float AS unit_price FROM booking_addons WHERE booking_id = ? ORDER BY id")
    .all(booking.id)) as { name: string; quantity: number; unit_price: number }[];
  const promo = (await db
    .prepare("SELECT u.discount::float AS discount, p.code FROM promo_uses u JOIN promo_codes p ON p.id = u.promo_id WHERE u.booking_id = ?")
    .get(booking.id)) as { discount: number; code: string } | undefined;

  const extrasTotal = extras.reduce((sum, e) => sum + e.quantity * e.unit_price, 0);
  const discount = promo?.discount ?? 0;
  const lines: Receipt["lines"] = [
    {
      description: `${court.name} (${SPORT_LABELS[court.sport] ?? court.sport}), ${booking.date} ${formatHour(booking.startHour)}–${formatHour(booking.endHour)}`,
      amount: Math.round((booking.totalPrice - extrasTotal + discount) * 100) / 100,
    },
    ...extras.map((e) => ({ description: `${e.quantity} × ${e.name}`, amount: Math.round(e.quantity * e.unit_price * 100) / 100 })),
    ...(promo ? [{ description: `Promo ${promo.code}`, amount: -discount }] : []),
  ];

  const registered = await venueTax(venue.id);
  const rate = booking.taxRate ?? null;
  return {
    code: booking.code,
    venue: { name: venue.name, address: venue.address, phone: venue.phone },
    customer: booking.name,
    paidAt: booking.paidAt,
    paidVia: booking.paidVia ? PAID_VIA_LABELS[booking.paidVia as PaidVia] ?? null : null,
    lines,
    total: booking.totalPrice,
    tax: rate ? { name: registered.name, rate, amount: taxIncluded(booking.totalPrice, rate), regNo: registered.regNo } : null,
    cancelled: booking.status === "cancelled",
  };
}
