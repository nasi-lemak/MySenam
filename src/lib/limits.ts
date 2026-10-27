import { getDb } from "./db";
import { accessRefusal, accessSettings } from "./access";
import { houseRuleRefusal } from "./house-rules";
import { venueIsOpen } from "./listing";
import { errorText, translator } from "./i18n";
import type { ErrorCode } from "./i18n";
import type { Refusal } from "./types";
import { todayISO } from "./time";
import { struckOut } from "./cancel-policy";

/**
 * What stops one person holding a venue's evenings with bookings that will
 * never be played.
 *
 * A booking needs a name and a phone number, nothing checks either, and at
 * the counter nothing is paid until the day. A rate limit per address slows a
 * script down, but a phone on mobile data has a new address whenever it
 * likes. So the number itself is limited: only so many unpaid bookings coming
 * up at once, at one venue and across the platform. Paying for one, playing
 * it, or cancelling it frees the place. A weekly series counts as one, but
 * takes an account; and a venue can refuse a number outright. A booking
 * charged to a company or school account is the account's, not the number's,
 * and is not counted (lib/accounts.ts).
 *
 * These are a brake, checked before the booking is made rather than inside
 * its transaction, so two requests in the same instant could each get the
 * last place. That costs a spammer one booking; it costs nothing to anybody
 * else.
 */
export const PHONE_LIMITS = {
  /** Unpaid bookings coming up at one venue. */
  venue: 3,
  /** Unpaid bookings coming up anywhere on the platform. */
  platform: 6,
} as const;

/**
 * Unpaid bookings made without an account at one venue in an hour, past
 * which the next guest pays online to hold theirs (or signs in, where the
 * venue takes nothing online). Each number is held to three, but numbers
 * can be made up: this is the venue's evening being filled from a script.
 */
export const GUEST_SURGE_PER_HOUR = 30;

export async function guestSurge(venueId: number): Promise<boolean> {
  const r = (await getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND b.user_id IS NULL AND b.status = 'confirmed' AND b.payment_status = 'unpaid'
          AND b.demo = 0 AND b.created_at > datetime('now', '-1 hour')`
    )
    .get(venueId)) as { n: number | string };
  return Number(r.n) >= GUEST_SURGE_PER_HOUR;
}

const ENGLISH = translator("en");
function refuse(code: ErrorCode, vars?: Record<string, string | number>): Refusal {
  const refusal: Refusal = { ok: false, error: errorText(ENGLISH, code, vars), code };
  if (vars) refusal.vars = vars;
  return refusal;
}

/** Commitments, not rows: a weekly series is one, however many weeks. */
const UNPAID_AHEAD = `
  SELECT COUNT(DISTINCT COALESCE(b.series_code, b.code)) AS n
    FROM bookings b JOIN courts c ON c.id = b.court_id
   WHERE b.phone_key = phone_key(?) AND b.date >= ?
     AND b.status = 'confirmed' AND b.payment_status = 'unpaid' AND b.total_price > 0
     AND b.account_id IS NULL`;

/**
 * May this number book here, online, now? null when it may; the reason when
 * it may not. For customers only: staff booking at the counter are not asked.
 */
export async function customerMayBook(input: {
  venueId: number;
  phone: string;
  weeks?: number;
  signedIn: boolean;
  /** The account booking, for a members-only or private venue (lib/access.ts). */
  userId?: number | null;
  /** The dates being booked, for the venue's house rules (lib/house-rules.ts). */
  dates?: string[];
  /** Its own staff, trying out a venue customers cannot reach yet (lib/listing.ts). */
  preview?: boolean;
  /** The venue takes payment online, so a struck-out number can pay to book rather than be refused. */
  canPayOnline?: boolean;
  /**
   * Places on a shared-capacity session taken only by people the account books
   * for, not by the account itself. At a members-only venue each of them must
   * be a member (lib/entitlements.ts `membersOnlyRefusal`, asked by the
   * booking engine), so the account need not be one itself: a parent who is
   * not a member books their member child's swim session.
   */
  placesForOthers?: boolean;
  /**
   * The venue's own staff booking at its counter: who may book a members-only
   * or private venue is not asked of them (staff book anyone, as
   * docs/features/booking.md says); each participant's own membership for a
   * members' session still is, by the booking engine.
   */
  atCounter?: boolean;
}): Promise<Refusal | null> {
  if (!input.preview && !(await venueIsOpen(input.venueId))) return venueNotOpen();
  if (!input.preview) {
    const notHere = input.atCounter ? null : await accessRefusal(input.venueId, input.userId ?? null);
    const theirsToHold =
      notHere !== null && input.placesForOthers === true && (input.userId ?? null) !== null && (await accessSettings(input.venueId)).access === "members";
    if (notHere && !theirsToHold) return notHere;
    if (input.dates) {
      const tooMany = await houseRuleRefusal({ venueId: input.venueId, phone: input.phone, userId: input.userId, dates: input.dates, online: true });
      if (tooMany) return tooMany;
    }
  }
  if ((input.weeks ?? 1) > 1 && !input.signedIn) return refuse("SERIES_NEEDS_ACCOUNT");
  // A flood of guest bookings here: where the venue takes payment online the booking is held until
  // paid instead (app/api/bookings); where it does not, an account is needed for now.
  if (!input.signedIn && !input.preview && !input.canPayOnline && (await guestSurge(input.venueId))) return refuse("GUEST_SURGE");
  if (await isBlocked(input.venueId, input.phone)) return phoneBlocked();
  // Too many no-shows here: where the venue takes nothing online, the counter only.
  // (Where it does, the booking is held until paid instead: app/api/bookings.)
  const strikes = await struckOut(input.venueId, input.phone);
  if (strikes.out && !input.canPayOnline) return refuse("STRIKES_COUNTER", { n: strikes.strikes });
  const db = getDb();
  const today = todayISO();
  const here = (await db.prepare(`${UNPAID_AHEAD} AND c.venue_id = ?`).get(input.phone, today, input.venueId)) as {
    n: number;
  };
  if (here.n >= PHONE_LIMITS.venue) return refuse("PHONE_LIMIT_VENUE", { n: here.n });
  const everywhere = (await db.prepare(UNPAID_AHEAD).get(input.phone, today)) as { n: number };
  if (everywhere.n >= PHONE_LIMITS.platform) return refuse("PHONE_LIMIT_ALL", { n: everywhere.n });
  return null;
}

/** What a customer is told about a draft, or a venue off the marketplace. */
export function venueNotOpen(): Refusal {
  return refuse("VENUE_NOT_OPEN");
}

// ------------------------------------------------------------ blocked numbers

/** What a refused number is told. */
export function phoneBlocked(): Refusal {
  return refuse("PHONE_BLOCKED");
}

export interface BlockedPhone {
  phone: string;
  reason: string | null;
  createdAt: string;
}

export async function isBlocked(venueId: number, phone: string): Promise<boolean> {
  return (
    (await getDb()
      .prepare("SELECT 1 FROM venue_blocked_phones WHERE venue_id = ? AND phone_key = phone_key(?)")
      .get(venueId, phone)) !== undefined
  );
}

export async function listBlockedPhones(venueId: number): Promise<BlockedPhone[]> {
  const rows = (await getDb()
    .prepare("SELECT phone, reason, created_at FROM venue_blocked_phones WHERE venue_id = ? ORDER BY created_at DESC")
    .all(venueId)) as { phone: string; reason: string | null; created_at: string }[];
  return rows.map((r) => ({ phone: r.phone, reason: r.reason, createdAt: r.created_at }));
}

export async function blockPhone(input: {
  venueId: number;
  phone: string;
  reason?: string;
  adminId: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const phone = input.phone.trim();
  if (!/^\+?[0-9 -]{7,20}$/.test(phone)) return { ok: false, error: "That is not a phone number." };
  const reason = input.reason?.trim().slice(0, 200) || null;
  await getDb()
    .prepare(
      `INSERT INTO venue_blocked_phones (venue_id, phone_key, phone, reason, blocked_by)
       VALUES (?, phone_key(?), ?, ?, ?)
       ON CONFLICT (venue_id, phone_key) DO UPDATE SET reason = EXCLUDED.reason`
    )
    .run(input.venueId, phone, phone, reason, input.adminId);
  return { ok: true };
}

export async function unblockPhone(venueId: number, phone: string): Promise<boolean> {
  const r = await getDb()
    .prepare("DELETE FROM venue_blocked_phones WHERE venue_id = ? AND phone_key = phone_key(?)")
    .run(venueId, phone);
  return r.changes > 0;
}

// ------------------------------------------------------------ what one venue can create

/**
 * How much one venue's own staff can add.
 *
 * A venue gets one place in search per time however many courts it has, so
 * courts no longer buy a better position. But each court is still a row every
 * search in its area works through, and classes fill the classes page, so a
 * venue's operator can add up to this many and no more. The platform owner is
 * not limited, and adds the rest for a venue that genuinely has more.
 */
export const VENUE_CAPS = {
  courts: 50,
  /** Class sessions scheduled from today on: about 25 a week, twelve weeks out. */
  upcomingClassSessions: 300,
  /** Branches a business may have in draft at once: room to plan, not to flood. */
  draftBranches: 5,
} as const;

/** Every so many, the platform owner hears how big a venue has got. */
export const ALERT_EVERY = { courts: 10, upcomingClassSessions: 50 } as const;

export async function courtCount(venueId: number): Promise<number> {
  return ((await getDb().prepare("SELECT COUNT(*) AS n FROM courts WHERE venue_id = ?").get(venueId)) as { n: number })
    .n;
}

export async function upcomingClassSessions(venueId: number): Promise<number> {
  return (
    (await getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM classes cl JOIN courts c ON c.id = cl.court_id
          WHERE c.venue_id = ? AND cl.date >= ? AND cl.status = 'scheduled'`
      )
      .get(venueId, todayISO())) as { n: number }
  ).n;
}

/** Did going from `before` to `after` pass a multiple of `every`? */
export function crossed(before: number, after: number, every: number): boolean {
  return Math.floor(after / every) > Math.floor(before / every);
}
