import { afterEach, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { checkSharedRateLimit, POLICIES, rateLimit, resetRateLimits } from "../src/lib/rate-limit";
import { holdSchedulerLease, LEASE_MS } from "../src/lib/scheduler";

/**
 * Running as more than one instance: rate limits counted once for all of
 * them, and the scheduled work done by one at a time.
 */

const req = () => new NextRequest("http://localhost/api/x", { headers: { "x-forwarded-for": "203.0.113.50" } });

afterEach(async () => {
  await resetRateLimits();
  delete process.env.MYSENAM_RATE_LIMITS;
});

describe("shared rate limits", () => {
  it("count every instance's requests in one window", async () => {
    const policy = { limit: 3, windowMs: 60_000 };
    // Four requests at once, as if from four instances: one too many.
    const results = await Promise.all([1, 2, 3, 4].map(() => checkSharedRateLimit("shared:a", policy, 1_000)));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    expect(results.find((r) => !r.allowed)).toMatchObject({ remaining: 0, retryAfter: 60 });
  });

  it("start again when the window has passed", async () => {
    const policy = { limit: 1, windowMs: 10_000 };
    expect((await checkSharedRateLimit("shared:b", policy, 0)).allowed).toBe(true);
    expect((await checkSharedRateLimit("shared:b", policy, 5_000)).allowed).toBe(false);
    expect((await checkSharedRateLimit("shared:b", policy, 10_001)).allowed).toBe(true);
  });

  it("are what rateLimit uses when told to", async () => {
    process.env.MYSENAM_RATE_LIMITS = "shared";
    for (let i = 0; i < POLICIES.accessCode.limit; i++) expect(await rateLimit(req(), "accessCode")).toBeNull();
    const refused = await rateLimit(req(), "accessCode");
    expect(refused?.status).toBe(429);
    await resetRateLimits();
    expect(await rateLimit(req(), "accessCode")).toBeNull();
  });
});

describe("the scheduler's lease", () => {
  it("lets one instance work at a time, and another take over when it stops", async () => {
    expect(await holdSchedulerLease("a", 0)).toBe(true);
    expect(await holdSchedulerLease("b", 1_000)).toBe(false);
    // The holder renews it each tick.
    expect(await holdSchedulerLease("a", 60_000)).toBe(true);
    expect(await holdSchedulerLease("b", 60_000 + LEASE_MS - 1)).toBe(false);
    // It stopped renewing: the lease runs out and the other takes it.
    expect(await holdSchedulerLease("b", 60_000 + LEASE_MS + 1)).toBe(true);
    expect(await holdSchedulerLease("a", 60_000 + LEASE_MS + 2)).toBe(false);
  });
});
