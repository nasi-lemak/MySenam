import { NextRequest, NextResponse } from "next/server";
import { getDb } from "./db";

/**
 * Fixed-window rate limiting: what stops a single host brute-forcing
 * passwords or booking codes, or filling a venue with junk bookings.
 *
 * Kept in process memory by default, which is right for one instance. Behind
 * several, each would keep its own counters and the limits would multiply, so
 * `MYSENAM_RATE_LIMITS=shared` keeps them in Postgres instead (`rate_limits`),
 * one atomic upsert per limited request, the same policies either way.
 */

export interface Policy {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

const MINUTE = 60_000;

export const POLICIES = {
  /** Password endpoints: slow guessing without locking out a shared office IP. */
  login: { limit: 10, windowMs: 10 * MINUTE },
  register: { limit: 5, windowMs: 60 * MINUTE },
  /** Each photo is drawn three times over; plenty for a venue, too few to keep a server busy. */
  photoUpload: { limit: 30, windowMs: 60 * MINUTE },
  /** Sending or trying a code to check a phone number: a person needs a few, a script many. */
  phoneCode: { limit: 10, windowMs: 10 * MINUTE },
  /** Booking codes are short, so lookup/cancel are guessable without this. */
  bookingLookup: { limit: 20, windowMs: 10 * MINUTE },
  /** Stops a script filling a venue's day with junk bookings. */
  booking: { limit: 20, windowMs: 60 * MINUTE },
  /**
   * A door code plus a booking code is the door, so this is tighter than an
   * ordinary lookup: enough for a customer who reopens the page a few times,
   * not enough to walk the code space.
   */
  accessCode: { limit: 10, windowMs: 10 * MINUTE },
  /**
   * Opening a payment page checks a code and a phone number like a lookup, and
   * makes a bill at the gateway, which limits us in turn.
   */
  payment: { limit: 10, windowMs: 10 * MINUTE },
  /**
   * Looking an address up on the map, as somebody fills in where their venue
   * is. Every lookup is a request to OpenStreetMap's server, which allows us
   * one a second in all.
   */
  geocode: { limit: 20, windowMs: 10 * MINUTE },
  /** A resident putting guests on a venue's list: a few a day, not a list import. */
  guestInvite: { limit: 20, windowMs: 60 * MINUTE },
  /** A browser reporting its errors: a broken page sends a few, a script flooding the log many. */
  clientError: { limit: 20, windowMs: 10 * MINUTE },
  /** A venue's own systems on the public API, per key: plenty for a front-desk screen polling, not a scrape. */
  api: { limit: 120, windowMs: MINUTE },
} satisfies Record<string, Policy>;

export type PolicyName = keyof typeof POLICIES;

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();
const MAX_TRACKED = 10_000;

/** Drop windows that have expired; called when the map grows. */
function sweep(now: number): void {
  for (const [key, win] of windows) {
    if (win.resetAt <= now) windows.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets. */
  retryAfter: number;
}

export function checkRateLimit(key: string, policy: Policy): RateLimitResult {
  const now = Date.now();
  if (windows.size > MAX_TRACKED) sweep(now);

  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + policy.windowMs });
    return { allowed: true, remaining: policy.limit - 1, retryAfter: 0 };
  }

  existing.count++;
  const retryAfter = Math.ceil((existing.resetAt - now) / 1000);
  if (existing.count > policy.limit) {
    return { allowed: false, remaining: 0, retryAfter };
  }
  return { allowed: true, remaining: policy.limit - existing.count, retryAfter };
}

/** Test helper — clears all counters, in memory and shared. */
export async function resetRateLimits(): Promise<void> {
  windows.clear();
  if (sharedLimits()) await getDb().prepare("DELETE FROM rate_limits").run();
}

/** Counters kept in Postgres, for an app running as more than one instance. */
export function sharedLimits(): boolean {
  return process.env.MYSENAM_RATE_LIMITS === "shared";
}

/**
 * The same window as `checkRateLimit`, counted in Postgres so every instance
 * sees one count: a window that has passed starts again at 1.
 */
export async function checkSharedRateLimit(key: string, policy: Policy, now = Date.now()): Promise<RateLimitResult> {
  const row = (await getDb()
    .prepare(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= ? THEN excluded.reset_at ELSE rate_limits.reset_at END
       RETURNING count, reset_at`
    )
    .get(key, now + policy.windowMs, now, now)) as { count: number; reset_at: number | string };
  const count = Number(row.count);
  const retryAfter = Math.max(0, Math.ceil((Number(row.reset_at) - now) / 1000));
  if (count > policy.limit) return { allowed: false, remaining: 0, retryAfter };
  return { allowed: true, remaining: policy.limit - count, retryAfter: count === 1 ? 0 : retryAfter };
}

/** Shared windows that have passed: nothing to keep. */
export async function pruneRateLimits(now = Date.now()): Promise<void> {
  await getDb().prepare("DELETE FROM rate_limits WHERE reset_at <= ?").run(now);
}

/**
 * Best-effort client identity. x-forwarded-for is only trustworthy behind a
 * proxy that sets it; a direct-to-internet deploy should not rely on it alone.
 */
function clientKey(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * Returns a 429 to hand straight back, or null to continue:
 *   const limited = await rateLimit(req, "login");
 *   if (limited) return limited;
 *
 * `scope` further narrows the bucket (e.g. the email being tried), so one
 * noisy client cannot exhaust another's allowance.
 */
export async function rateLimit(
  req: NextRequest,
  name: PolicyName,
  scope?: string
): Promise<NextResponse | null> {
  const policy = POLICIES[name];
  const key = `${name}:${clientKey(req)}${scope ? `:${scope.toLowerCase()}` : ""}`;
  const result = sharedLimits() ? await checkSharedRateLimit(key, policy) : checkRateLimit(key, policy);
  if (result.allowed) return null;

  return NextResponse.json(
    { error: "Too many attempts. Please wait a moment and try again." },
    { status: 429, headers: { "Retry-After": String(result.retryAfter) } }
  );
}
