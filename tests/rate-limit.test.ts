import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, POLICIES, resetRateLimits } from "../src/lib/rate-limit";

const policy = { limit: 3, windowMs: 60_000 };

beforeEach(() => {
  resetRateLimits();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fixed-window rate limiting", () => {
  it("allows up to the limit then blocks", () => {
    for (let i = 0; i < policy.limit; i++) {
      const result = checkRateLimit("a", policy);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(policy.limit - 1 - i);
    }
    const blocked = checkRateLimit("a", policy);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfter).toBeGreaterThan(0);
  });

  it("keeps separate counters per key", () => {
    for (let i = 0; i < policy.limit; i++) checkRateLimit("a", policy);
    expect(checkRateLimit("a", policy).allowed).toBe(false);
    // a different client is unaffected
    expect(checkRateLimit("b", policy).allowed).toBe(true);
  });

  it("recovers once the window passes", () => {
    for (let i = 0; i < policy.limit; i++) checkRateLimit("a", policy);
    expect(checkRateLimit("a", policy).allowed).toBe(false);

    vi.advanceTimersByTime(policy.windowMs - 1);
    expect(checkRateLimit("a", policy).allowed).toBe(false);

    vi.advanceTimersByTime(2);
    const fresh = checkRateLimit("a", policy);
    expect(fresh.allowed).toBe(true);
    expect(fresh.remaining).toBe(policy.limit - 1);
  });

  it("counts down retryAfter as the window elapses", () => {
    for (let i = 0; i <= policy.limit; i++) checkRateLimit("a", policy);
    const first = checkRateLimit("a", policy).retryAfter;
    vi.advanceTimersByTime(30_000);
    const later = checkRateLimit("a", policy).retryAfter;
    expect(later).toBeLessThan(first);
  });

  it("ships sane policies for every protected endpoint", () => {
    for (const [name, p] of Object.entries(POLICIES)) {
      expect(p.limit, name).toBeGreaterThan(0);
      expect(p.windowMs, name).toBeGreaterThanOrEqual(60_000);
    }
    // password guessing should be the tightest per-minute budget
    const perMinute = (p: { limit: number; windowMs: number }) => p.limit / (p.windowMs / 60_000);
    expect(perMinute(POLICIES.login)).toBeLessThan(perMinute(POLICIES.bookingLookup));
  });
});
