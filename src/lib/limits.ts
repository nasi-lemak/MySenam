import { getDb } from "./db";
import { accessRefusal, accessSettings, numberAccessRefusal } from "./access";
import { houseRuleRefusal } from "./house-rules";
import { venueIsOpen } from "./listing";
import { errorText, translator } from "./i18n";
import type { ErrorCode } from "./i18n";
import type { Refusal } from "./types";
import { todayISO } from "./time";
import { struckOut } from "./cancel-policy";
import { overridablePolicy, type OverriddenPolicy, type OverridePolicy } from "./policy-overrides";
import type { GuestHost } from "./guest-invites";

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
 *
 * "Guest" here is guest checkout, somebody booking without an account, never
 * a member's or resident's guest (lib/guest-invites.ts). Only what was made
 * online or through the venue's API key counts (`bookings.made_on`, migration
 * 0229): the counter's own bookings, an ordinary walk-in customer or a
 * member's guest, are made by staff in front of the person and are not the
 * flood this brakes (the owner's decision of 28 October 2026). Bookings made
 * before the path was recorded count as they always did.
 */
export const GUEST_SURGE_PER_HOUR = 30;

export async function guestSurge(venueId: number): Promise<boolean> {
  const r = (await getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND b.user_id IS NULL AND b.status = 'confirmed' AND b.payment_status = 'unpaid'
          AND b.demo = 0 AND b.created_at > datetime('now', '-1 hour') AND b.made_on IS DISTINCT FROM 'staff'`
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
 * it may not. The customer's path of `policyCheck` (below), as the booking
 * form, a class, joining a waiting list online and an application's slot ask
 * it: `canPayOnline` where the booking made would be held until paid online
 * rather than refused (none given: refused).
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
}): Promise<Refusal | null> {
  return (
    await policyCheck("customer", {
      ...input,
      userId: input.signedIn ? (input.userId ?? null) : null,
      signedIn: input.signedIn,
      canPayOnline: input.canPayOnline === true,
    })
  ).refusal;
}

/** Who makes a booking: its customer online, the venue's staff at its counter, or the venue's own system through its API key. */
export type BookingPath = "customer" | "staff" | "api";

/**
 * How the booking being asked for can be paid as it is made, where a policy
 * (no-show strikes, the guest limit) asks payment rather than refusing:
 * online, held until paid (the booking form, and a waiting-list claim
 * through its link, whoever made the entry); at the counter, then and there
 * (`paidNow`); or not at all (the venue's API key, which takes no money).
 */
export type Settle = "online" | "counter" | "none";

export interface PolicyInput {
  venueId: number;
  phone: string;
  /** The account booking (online), or null. */
  userId?: number | null;
  /** Online: signed in (the account); defaults to `userId` being given. Never at the counter or through the API. */
  signedIn?: boolean;
  /** The dates booked, for the house rules (every week of a series, every session of a term). */
  dates?: string[];
  weeks?: number;
  preview?: boolean;
  placesForOthers?: boolean;
  /**
   * At the counter and through the API, who takes part, for a members-only or
   * private venue: the number on the venue's word, or, where only people
   * named take places, each of them (lib/access.ts `numberAccessRefusal`).
   */
  participants?: { id: number; name: string }[];
  customerTakesPart?: boolean;
  /** How it can be paid as it is made; by the path where not said (customer online, staff at the counter, the API none). */
  settle?: Settle;
  /** Online: the venue takes payment online (worked out where not said). */
  canPayOnline?: boolean;
  /** At the counter: paid then and there, the counter's "pay to hold". */
  paidNow?: boolean;
  /** Policies a manager overrides for this booking, already authorised (lib/policy-overrides.ts `overrideRefusal`). */
  overrides?: OverridePolicy[];
  /**
   * At the counter and through the API: the person booked is this member's
   * or resident's guest, not a walk-in customer (lib/guest-invites.ts
   * `guestHostAt`). Who may book here is then asked of the host, the guest
   * allowance of the guest, and the house rules count the host's household.
   */
  guestOf?: GuestHost;
}

/** The answer: the refusal, or null; and the refusals an override went past, to be recorded with the booking. */
export interface PolicyAnswer {
  refusal: Refusal | null;
  overridden: OverriddenPolicy[];
}

/**
 * The venue's booking policies, the same on every path (the owner's decision
 * of 28 October 2026; ADR 0026; docs/features/booking.md#the-same-policies-on-every-path):
 * the one check the booking form, the counter, the venue's API key, a class,
 * a waiting list (joining it, the offer and its claim) ask before a booking
 * is made. In order:
 *
 * - the venue open to customers (not asked of its own staff trying it out);
 * - who may book a members-only or private venue: online, the account
 *   (lib/access.ts `accessRefusal`); at the counter and through the API, the
 *   number on the venue's word, or each person named where only they take
 *   places (`numberAccessRefusal`). Staff are not asked to be signed in as
 *   the member (B20);
 * - the house rules (lib/house-rules.ts): how far ahead, and bookings at once,
 *   a week and a day, counted as booking online counts them; at the counter
 *   and through the API the number is taken on the venue's word for the
 *   members' window;
 * - a weekly booking needs an account;
 * - the guest limit: past `GUEST_SURGE_PER_HOUR` unpaid bookings without an
 *   account in the hour, a booking without one is paid as it is made (held
 *   until paid online, or paid at the counter) or refused;
 * - a refused number;
 * - no-show strikes: likewise paid as it is made, or refused;
 * - the unpaid-bookings limit, here and across the platform.
 *
 * A manager's override (`overrides`) lets through only the refusals its
 * policy answers for (lib/policy-overrides.ts), and says which it went past.
 * The refusal is said as the customer is told; `saidOn` words it for the
 * counter or the API.
 */
export async function policyCheck(path: BookingPath, input: PolicyInput): Promise<PolicyAnswer> {
  const overridden: OverriddenPolicy[] = [];
  const done = (refusal: Refusal | null): PolicyAnswer => ({ refusal, overridden });
  // Gone past by a manager, where the refusal is one an override they were allowed answers for.
  const passed = (r: Refusal): boolean => {
    const policy = overridablePolicy(r.code);
    if (!policy || !input.overrides?.includes(policy)) return false;
    overridden.push({ policy, code: r.code! });
    return true;
  };
  const userId = path === "customer" ? (input.userId ?? null) : null;
  const signedIn = path === "customer" && (input.signedIn ?? userId !== null);
  if (!input.preview && !(await venueIsOpen(input.venueId))) return done(venueNotOpen());
  if (!input.preview) {
    if (path === "customer") {
      const notHere = await accessRefusal(input.venueId, userId);
      const theirsToHold =
        notHere !== null && input.placesForOthers === true && userId !== null && (await accessSettings(input.venueId)).access === "members";
      if (notHere && !theirsToHold) return done(notHere);
    } else if (input.guestOf) {
      // A member's or resident's guest: the host is on the list for the dates (`guestHostAt`); the guest goes on it
      // under the host's allowance, which a manager may go past where the venue permits it; nothing else may.
      const { guestRefusals } = await import("./guest-invites");
      for (const r of await guestRefusals(input.guestOf, input.phone, input.dates ?? [])) if (!passed(r)) return done(r);
    } else {
      const notHere = await numberAccessRefusal(
        input.venueId,
        { phone: input.phone, by: path, participants: input.participants ?? [], customerTakesPart: input.customerTakesPart !== false },
        input.dates ?? []
      );
      if (notHere) return done(notHere);
    }
    if (input.dates) {
      const tooMany = await houseRuleRefusal({
        venueId: input.venueId,
        phone: input.phone,
        userId,
        dates: input.dates,
        online: path === "customer",
        ...(input.guestOf && path !== "customer" ? { host: input.guestOf.phone } : {}),
      });
      if (tooMany && !passed(tooMany)) return done(tooMany);
    }
  }
  if ((input.weeks ?? 1) > 1 && !signedIn) {
    const series = refuse("SERIES_NEEDS_ACCOUNT");
    if (!passed(series)) return done(series);
  }
  const settle = input.settle ?? (path === "customer" ? "online" : path === "staff" ? "counter" : "none");
  // Imported here, not at the top: lib/payments.ts reads lib/store.ts, which reads this module.
  const paysAsMade =
    settle === "online"
      ? (input.canPayOnline ?? (await (await import("./payments")).takesPaymentOnline(input.venueId)))
      : settle === "counter" && input.paidNow === true;
  // A flood of guest bookings here: paid as it is made (held until paid online, or at the counter), or refused.
  if (!signedIn && !input.preview && !paysAsMade && (await guestSurge(input.venueId))) {
    const surge = refuse("GUEST_SURGE");
    if (!passed(surge)) return done(surge);
  }
  if (await isBlocked(input.venueId, input.phone)) return done(phoneBlocked());
  // Too many no-shows here: likewise paid as it is made, or refused.
  const strikes = await struckOut(input.venueId, input.phone);
  if (strikes.out && !paysAsMade) {
    const struck = refuse("STRIKES_COUNTER", { n: strikes.strikes });
    if (!passed(struck)) return done(struck);
  }
  const db = getDb();
  const today = todayISO();
  const here = (await db.prepare(`${UNPAID_AHEAD} AND c.venue_id = ?`).get(input.phone, today, input.venueId)) as {
    n: number;
  };
  if (here.n >= PHONE_LIMITS.venue) return done(refuse("PHONE_LIMIT_VENUE", { n: here.n }));
  const everywhere = (await db.prepare(UNPAID_AHEAD).get(input.phone, today)) as { n: number };
  if (everywhere.n >= PHONE_LIMITS.platform) return done(refuse("PHONE_LIMIT_ALL", { n: everywhere.n }));
  return done(null);
}

/**
 * What a booking made on this path asks before it is made: `policyCheck`'s
 * refusal, said as the customer is told. A waiting-list offer and its claim
 * ask it on the path the entry was made, paid as the claim is (online,
 * through its link: lib/store.ts `entryRefused`), so a queue is never a way
 * round what the booking would have asked.
 */
export async function mayBookOn(path: BookingPath, input: PolicyInput): Promise<Refusal | null> {
  return (await policyCheck(path, input)).refusal;
}

/** Each refusal's own words at the counter: what staff can do about it (`saidOn`). */
const AT_COUNTER: Partial<Record<string, ErrorCode>> = {
  PHONE_BLOCKED: "R9_DESK_PHONE_BLOCKED",
  PHONE_LIMIT_VENUE: "R9_DESK_UNPAID_VENUE",
  PHONE_LIMIT_ALL: "R9_DESK_UNPAID_ALL",
  STRIKES_COUNTER: "R9_DESK_STRIKES",
  GUEST_SURGE: "R9_DESK_GUEST_SURGE",
  SERIES_NEEDS_ACCOUNT: "R9_DESK_SERIES",
  LIMIT_UPCOMING: "R9_DESK_LIMIT_UPCOMING",
  LIMIT_WEEK: "R9_DESK_LIMIT_WEEK",
  LIMIT_DAY: "R9_DESK_LIMIT_DAY",
  R9_NOT_MEMBER: "R9_DESK_NOT_MEMBER",
  R9_NOT_LISTED: "R9_DESK_NOT_LISTED",
};

/**
 * Through the API, the refusal keeps its code (what a venue's system reads)
 * and is said for a system that takes no money and asks nobody to sign in.
 */
const THROUGH_API: Partial<Record<string, string>> = {
  PHONE_BLOCKED: "The venue has refused this number. It cannot be booked until the venue takes it off its refused list.",
  PHONE_LIMIT_VENUE: "This number already has {n} unpaid bookings coming up here. One must be paid or cancelled first.",
  PHONE_LIMIT_ALL: "This number already has {n} unpaid bookings coming up. One must be paid or cancelled first.",
  STRIKES_COUNTER: "This number has {n} no-shows or late cancellations here. Book it at the venue's counter, where it is paid as it is booked.",
  GUEST_SURGE:
    "Many unpaid bookings without an account have been made here in the last hour. Book it at the venue's counter, where it is paid as it is booked.",
  SERIES_NEEDS_ACCOUNT: "A weekly booking needs the customer's own account.",
  GC8_GUESTS_OFF: "This venue does not let its members or residents have guests on its list. Book it at the venue's counter.",
  GC8_GUEST_ALLOWANCE: "The host already has as many guests on the venue's list as the venue allows at a time ({n}). One must come off the list first.",
  GC8_GUEST_DAYS: "A guest's visit here may run until {until} at the latest, and this booking is later than that.",
};

/**
 * A refusal of `policyCheck`, said on the path that asked: as the customer is
 * told online; at the counter, what staff can do (take payment now, take
 * payment for one already booked, review a refused number, or ask a manager
 * to override where the venue permits it), under a code of its own; through
 * the API, the same code with words for the venue's system. `policy` names
 * the overridable policy the refusal belongs to, where it is one.
 */
export function saidOn(path: BookingPath, r: Refusal): Refusal & { policy?: OverridePolicy } {
  const policy = overridablePolicy(r.code);
  const withPolicy = <T extends Refusal>(x: T) => (policy ? { ...x, policy } : x);
  if (path === "customer" || !r.code) return withPolicy(r);
  if (path === "staff") {
    const code = AT_COUNTER[r.code];
    return withPolicy(code ? { ok: false, error: errorText(ENGLISH, code, r.vars), code, ...(r.vars ? { vars: r.vars } : {}) } : r);
  }
  const words = THROUGH_API[r.code];
  return withPolicy(words ? { ...r, error: words.replace(/\{(\w+)\}/g, (whole, k: string) => String(r.vars?.[k] ?? whole)) } : r);
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
  /** Who is refusing it, by name, for the list of bookings left for a decision. */
  adminName?: string;
}): Promise<{ ok: true; flagged: number } | { ok: false; error: string }> {
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
  // A place already offered to the number from a waiting list: its messages still waiting to go are taken
  // back, and an offer nobody has been told of passes to the next (lib/store.ts `withdrawOffersTo`).
  await (await import("./store")).withdrawOffersTo(input.venueId, phone);
  // Its confirmed bookings that remain: no door code, QR check-in or unstaffed access for them from now on, and listed for the
  // manager to cancel with a refund or leave (ADR 0058). The count is shown to whoever blocked it. None is cancelled here.
  const flagged = await (await import("./safety-flags")).flagBlockedNumber(input.venueId, phone, input.adminName ?? "Staff");
  return { ok: true, flagged };
}

export async function unblockPhone(venueId: number, phone: string, by = "Staff"): Promise<boolean> {
  const r = await getDb()
    .prepare("DELETE FROM venue_blocked_phones WHERE venue_id = ? AND phone_key = phone_key(?)")
    .run(venueId, phone);
  if (r.changes > 0) await (await import("./safety-flags")).clearBlockedFlags(venueId, phone, by);
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
