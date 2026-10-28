import crypto from "crypto";
import { getDb } from "./db";
import { keyedHash } from "./secrets";

/**
 * A link that opens one booking on My Booking without the code and phone
 * being typed again (docs/features/booking.md#links-that-open-a-booking): put in
 * every message that sends a customer there, in the payment return page,
 * and in the address once a booking has been looked up.
 *
 * As the receipt's link (lib/receipts.ts), it is signed with the install's
 * key (lib/secrets.ts `keyedHash`), so it cannot be made up from a booking
 * code; unlike it, it runs out: 30 days after the booking's day, and never
 * sooner than 14 days after it was made. The phone number is never in it.
 * Whoever holds the link may do what the code and phone allow, as the
 * person the message was sent to.
 */

/** Days after the booking's day the link keeps working. */
export const LINK_DAYS_AFTER = 30;
/** Days after it is made, at least, whatever the booking's day. */
export const LINK_MIN_DAYS = 14;

const sign = (code: string, expires: number) => keyedHash("my-booking-link", `${code.trim().toUpperCase()}:${expires}`).slice(0, 32);

/** When a link to a booking on this date, made now, runs out (seconds since 1970). */
export function linkExpiry(date: string, now = Date.now()): number {
  const afterDay = Date.parse(`${date}T23:59:59Z`) + LINK_DAYS_AFTER * 86_400_000;
  const least = now + LINK_MIN_DAYS * 86_400_000;
  return Math.floor(Math.max(Number.isFinite(afterDay) ? afterDay : 0, least) / 1000);
}

/** The token for a booking's link: when it runs out, and the signature. */
export function bookingLinkToken(code: string, date: string, now = Date.now()): string {
  const expires = linkExpiry(date, now);
  return `${expires.toString(36)}.${sign(code, expires)}`;
}

/** The path that opens the booking on My Booking, to put after the site's (or the venue's storefront's) address. */
export function bookingLinkPath(code: string, date: string, now = Date.now()): string {
  return `/my-booking?code=${encodeURIComponent(code.trim().toUpperCase())}&t=${bookingLinkToken(code, date, now)}`;
}

export type LinkCheck = "ok" | "expired" | "invalid";

/** Is this the booking's own link, still working? */
export function checkBookingLink(code: string, token: string, now = Date.now()): LinkCheck {
  const [stamp, signature] = token.split(".");
  if (!stamp || !signature || !/^[0-9a-z]{1,12}$/.test(stamp)) return "invalid";
  const expires = parseInt(stamp, 36);
  const expected = sign(code, expires);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return "invalid";
  return expires * 1000 < now ? "expired" : "ok";
}

/**
 * The booking's phone, for a link that opens it: what the code-and-phone
 * routes take as proof, so a link does whatever typing them would; or why
 * not (run out, or not the booking's own link, or no such booking).
 */
export async function phoneForLink(code: string, token: string, now = Date.now()): Promise<{ phone: string } | { refused: LinkCheck }> {
  const check = checkBookingLink(code, token, now);
  if (check !== "ok") return { refused: check };
  const row = (await getDb().prepare("SELECT phone FROM bookings WHERE UPPER(code) = UPPER(?)").get(code.trim())) as { phone: string } | undefined;
  return row ? { phone: row.phone } : { refused: "invalid" };
}
