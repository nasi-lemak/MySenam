import type { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, canAccessVenue, getAdminByToken, getSessionAdmin, type Admin } from "./admin-auth";
import { getDb } from "./db";

/**
 * Who may reach a venue.
 *
 * A business signs itself up and sets up straight away, but nobody else sees
 * it until the platform owner has let it go live (lib/applications.ts), and a
 * live venue whose invoice is long overdue drops out of sight again until it
 * is paid (lib/payment-holds.ts). Until then it is a draft its own staff can
 * look at — its booking page, as a preview — and the public cannot find,
 * open, book, pay or be messaged by.
 *
 * Every customer-facing path asks here, so there is one rule and one place
 * it is written: `OPEN_TO_CUSTOMERS` inside SQL, `isOpen` on a venue already
 * read, `mayShowVenue` for a page or route that a venue's staff may preview.
 */

/** In SQL, for a venue aliased `v`: customers may find and book it. */
export const OPEN_TO_CUSTOMERS = "v.published_at IS NOT NULL AND v.suspended_at IS NULL";

export interface Listing {
  publishedAt: string | null;
  suspendedAt: string | null;
}

export function isOpen(v: Listing): boolean {
  return v.publishedAt !== null && v.suspendedAt === null;
}

/** Has it ever been live — so its customers may be messaged about bookings they made. */
export function hasBeenLive(v: Listing): boolean {
  return v.publishedAt !== null;
}

export type ListingState = "draft" | "live" | "unlisted";

export function listingState(v: Listing): ListingState {
  return v.publishedAt === null ? "draft" : v.suspendedAt === null ? "live" : "unlisted";
}

export async function venueListing(venueId: number): Promise<Listing | null> {
  const row = (await getDb()
    .prepare("SELECT published_at, suspended_at FROM venues WHERE id = ?")
    .get(venueId)) as { published_at: string | null; suspended_at: string | null } | undefined;
  return row ? { publishedAt: row.published_at, suspendedAt: row.suspended_at } : null;
}

/** Customers may find and book this venue. */
export async function venueIsOpen(venueId: number): Promise<boolean> {
  const listing = await venueListing(venueId);
  return listing !== null && isOpen(listing);
}

/** The admin signed in on this page's request, if any. */
export async function pageAdmin(): Promise<Admin | null> {
  const { cookies } = await import("next/headers");
  const token = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
  return token ? await getAdminByToken(token) : null;
}

/**
 * Whether this request may see this venue: anybody, if it is open; its own
 * staff, as a preview, if not. `admin` is whoever is signed in, or a request
 * to find them from.
 */
export async function mayShowVenue(
  venueId: number,
  admin: Admin | null | NextRequest
): Promise<{ show: boolean; preview: boolean }> {
  const listing = await venueListing(venueId);
  if (!listing) return { show: false, preview: false };
  if (isOpen(listing)) return { show: true, preview: false };
  const who = admin && "cookies" in admin ? await getSessionAdmin(admin) : admin;
  const staff = who !== null && canAccessVenue(who, venueId);
  return { show: staff, preview: staff };
}
