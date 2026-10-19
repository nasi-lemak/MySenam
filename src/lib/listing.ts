import type { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, canAccessVenue, getAdminByToken, getSessionAdmin, type Admin } from "./admin-auth";
import { getDb } from "./db";
import { SESSION_COOKIE, getSessionUser, getUserByToken } from "./auth";
import { eligible } from "./access";

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

/** In SQL, for a venue aliased `v`: live — customers (those it is for) may book it. */
export const OPEN_TO_CUSTOMERS = "v.published_at IS NOT NULL AND v.suspended_at IS NULL";

/**
 * In SQL: live, and in public lists — search, the map, the classes, games,
 * tournaments and leagues pages. A private venue never is; a members-only one
 * is unless it asked not to be (lib/access.ts).
 */
export const LISTED_PUBLICLY = `${OPEN_TO_CUSTOMERS} AND (v.access = 'public' OR (v.access = 'members' AND v.access_listed = 1))`;

/**
 * The rule for a list: the public one, or — on a storefront, which names its
 * own venues — every live one of those but a private one, which is reached
 * from its residents' account pages and its own link, never from a list.
 */
export function listRule(venueIds?: number[]): string {
  return venueIds ? `${OPEN_TO_CUSTOMERS} AND v.access <> 'private'` : LISTED_PUBLICLY;
}

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

/** Who is looking: staff, a signed-in customer, both or neither. */
export interface Viewer {
  admin: Admin | null;
  userId: number | null;
}

/** The staff member and the customer signed in on this page's request. */
export async function pageViewer(): Promise<Viewer> {
  const { cookies } = await import("next/headers");
  const jar = await cookies();
  const adminToken = jar.get(ADMIN_SESSION_COOKIE)?.value;
  const userToken = jar.get(SESSION_COOKIE)?.value;
  return {
    admin: adminToken ? await getAdminByToken(adminToken) : null,
    userId: userToken ? ((await getUserByToken(userToken))?.id ?? null) : null,
  };
}

async function viewerOf(who: Admin | null | NextRequest | Viewer): Promise<Viewer> {
  if (who && "cookies" in who) return { admin: await getSessionAdmin(who), userId: (await getSessionUser(who))?.id ?? null };
  if (who && "userId" in who) return who;
  return { admin: who, userId: null };
}

/**
 * Whether this request may see this venue: anybody, if it is open; its own
 * staff, as a preview, if not. A private venue, open or not, only its staff
 * and the people on its list — and `signIn` says when somebody nobody has
 * signed in as is looking, so a page can ask them to rather than say nothing
 * is there. `who` is whoever is signed in, or a request to find them from.
 */
export async function mayShowVenue(
  venueId: number,
  who: Admin | null | NextRequest | Viewer
): Promise<{ show: boolean; preview: boolean; signIn: boolean }> {
  const row = (await getDb()
    .prepare("SELECT published_at, suspended_at, access FROM venues WHERE id = ?")
    .get(venueId)) as { published_at: string | null; suspended_at: string | null; access: string } | undefined;
  if (!row) return { show: false, preview: false, signIn: false };
  const listing = { publishedAt: row.published_at, suspendedAt: row.suspended_at };
  if (isOpen(listing) && row.access !== "private") return { show: true, preview: false, signIn: false };
  const viewer = await viewerOf(who);
  const staff = viewer.admin !== null && canAccessVenue(viewer.admin, venueId);
  if (!isOpen(listing)) return { show: staff, preview: staff, signIn: false };
  // Open, and private: its staff, and the people on its list.
  if (staff) return { show: true, preview: false, signIn: false };
  if (viewer.userId === null) return { show: false, preview: false, signIn: true };
  return { show: await eligible(venueId, viewer.userId, "private"), preview: false, signIn: false };
}
