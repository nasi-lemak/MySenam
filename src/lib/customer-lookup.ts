import { NextRequest, NextResponse } from "next/server";
import { getDb } from "./db";
import { isMarketplace } from "./mode";
import { rateLimit, rateLimitSubject } from "./rate-limit";
import { isOwner, type Admin } from "./admin-auth";

/**
 * What staff may find out about a customer's account from an email address or a phone number (ADR 0057).
 *
 * The customer table belongs to the whole marketplace, and anybody can sign up as a venue and be given a
 * staff account. So a lookup from the counter finds only a customer with a relationship to the venues the
 * member of staff works at (a booking, credit, a pass, a membership, a linked entry on an access list, a
 * participant's guardian), never the table as a whole, and every lookup is throttled per account and per
 * address. The platform owner, who runs the install, and an install that is one business's own (not the
 * marketplace) are not narrowed, but are throttled all the same.
 *
 * The flows that link a sale or a record to an account by the email a customer read out (a pass, a
 * membership, a sign-off, a guardian, a coach) need no relationship, since linking is what creates one; they are
 * throttled, are not offered from a venue that has not gone live, and say no more about an account than
 * the staff member typed (`maskedName` for the rest).
 */

/** Venues whose customers this member of staff may find; null when there is no narrowing. */
export function customerScope(admin: Admin): number[] | null {
  if (!isMarketplace() || isOwner(admin)) return null;
  return (admin.venueIds ?? []).map(Number).filter((id) => Number.isInteger(id) && id > 0);
}

/**
 * SQL that is true when users row `alias` has a relationship with one of `venueIds`: its bookings (by account, or by the
 * email or number the venue was given), credit, passes, memberships, an access-list entry linked to it, or a participant
 * it is guardian of. The ids are integers made here, written into the statement.
 */
export function connectedTo(alias: string, venueIds: number[]): string {
  const ids = venueIds.map(Number).filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return "FALSE";
  const v = ids.join(",");
  const u = alias;
  return `(
    EXISTS (SELECT 1 FROM bookings b JOIN courts c ON c.id = b.court_id
             WHERE c.venue_id IN (${v})
               AND (b.user_id = ${u}.id OR lower(b.email) = lower(${u}.email) OR (phone_key(b.phone) <> '' AND phone_key(b.phone) = phone_key(${u}.phone))))
    OR EXISTS (SELECT 1 FROM wallet_entries w WHERE w.user_id = ${u}.id AND w.venue_id IN (${v}))
    OR EXISTS (SELECT 1 FROM passes p WHERE p.user_id = ${u}.id AND p.venue_id IN (${v}))
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = ${u}.id AND m.venue_id IN (${v}))
    OR EXISTS (SELECT 1 FROM venue_access_list a WHERE a.user_id = ${u}.id AND a.venue_id IN (${v}))
    OR EXISTS (SELECT 1 FROM participant_guardians g JOIN participants pt ON pt.id = g.participant_id
                WHERE g.user_id = ${u}.id AND g.revoked_at IS NULL AND pt.venue_id IN (${v}))
  )`;
}

/** 429 when this account or this address has asked too often; counts one lookup. */
export async function lookupThrottle(req: NextRequest, admin: Admin): Promise<NextResponse | null> {
  return (await rateLimitSubject("staffLookup", `admin:${admin.id}`)) ?? (await rateLimit(req, "staffLookupAddress"));
}

/**
 * The linking flows, from a venue not live yet: refused on the marketplace, where a draft is a free sign-up. The platform
 * owner, and any member of staff with a live venue, may. Null when allowed, else the 403 to hand back.
 */
export async function linkingNotYetOpen(admin: Admin): Promise<NextResponse | null> {
  if (!isMarketplace() || isOwner(admin)) return null;
  const ids = (admin.venueIds ?? []).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  const live =
    ids.length > 0 && (await getDb().prepare(`SELECT 1 AS ok FROM venues WHERE id IN (${ids.join(",")}) AND published_at IS NOT NULL LIMIT 1`).get()) !== undefined;
  if (live) return null;
  return NextResponse.json(
    { error: "Linking a sale or a record to a customer's account is open once the venue is live.", code: "LOOKUP_NOT_LIVE" },
    { status: 403 }
  );
}

/** Both guards the linking flows share. */
export async function guardLinking(req: NextRequest, admin: Admin): Promise<NextResponse | null> {
  return (await linkingNotYetOpen(admin)) ?? (await lookupThrottle(req, admin));
}

/** "Siti Aminah" as "S. A.", for an account staff were not given the name of. */
export function maskedName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length === 0 ? "" : parts.map((p) => `${Array.from(p)[0].toUpperCase()}.`).join(" ");
}
