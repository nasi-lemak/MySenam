import { NextRequest, NextResponse } from "next/server";

/**
 * Fixed-window rate limiting, kept in process memory.
 *
 * This is single-node state: behind several instances each one keeps its own
 * counters, so a horizontally scaled deploy wants a shared store (Redis) with
 * the same policies. It is still worth having — it is what stops a single host
 * brute-forcing passwords or booking codes.
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

/** Test helper — clears all counters. */
export function resetRateLimits(): void {
  windows.clear();
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
 *   const limited = rateLimit(req, "login");
 *   if (limited) return limited;
 *
 * `scope` further narrows the bucket (e.g. the email being tried), so one
 * noisy client cannot exhaust another's allowance.
 */
export function rateLimit(
  req: NextRequest,
  name: PolicyName,
  scope?: string
): NextResponse | null {
  const policy = POLICIES[name];
  const key = `${name}:${clientKey(req)}${scope ? `:${scope.toLowerCase()}` : ""}`;
  const result = checkRateLimit(key, policy);
  if (result.allowed) return null;

  return NextResponse.json(
    { error: "Too many attempts. Please wait a moment and try again." },
    { status: 429, headers: { "Retry-After": String(result.retryAfter) } }
  );
}
