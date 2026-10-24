import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { POST as cancelSeriesRoute } from "../src/app/api/bookings/cancel-series/route";
import { setCancelPolicy } from "../src/lib/cancel-policy";
import { getDb } from "../src/lib/db";
import {
  cancelSeries,
  createBookingSeries,
  createCourt,
  createVenue,
  seriesCancelPlan,
  setPaymentStatus,
  updateVenue,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Cancelling a weekly series says what happens to each week before it is
 * done: weeks inside the free window go back in full, weeks past it go only
 * on the venue's late terms the customer accepted, and weeks that cannot go
 * are named as staying, never silently kept.
 */

let venueId: number;
let courtId: number;
let n = 0;
const phone = () => `0178800${String(++n).padStart(3, "0")}`;

async function series(weeks = 3, hour = 21, paid = true) {
  const who = phone();
  // The first week tomorrow, inside a 48-hour cutoff; the rest a week apart, outside it.
  const made = await createBookingSeries({ courtId, date: addDays(todayISO(), 1), hours: [hour], weeks, name: "Liga", phone: who });
  if (!made.ok) throw new Error(made.error);
  const codes = (await getDb()
    .prepare("SELECT code FROM bookings WHERE series_code = ? ORDER BY date")
    .all(made.seriesCode)) as { code: string }[];
  if (paid) for (const { code } of codes) await setPaymentStatus(code, true);
  return { seriesCode: made.seriesCode!, phone: who, codes: codes.map((c) => c.code) };
}

const row = async (code: string) =>
  (await getDb().prepare("SELECT status, late_cancelled, late_kept_percent FROM bookings WHERE code = ?").get(code)) as {
    status: string;
    late_cancelled: number;
    late_kept_percent: number | null;
  };

const route = (body: object) =>
  cancelSeriesRoute(
    new NextRequest("http://localhost/api/bookings/cancel-series", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );

beforeAll(async () => {
  const made = await createVenue({ name: "Series Hall", area: "Ipoh", address: "x", phone: "0355553333", openHour: 8, closeHour: 23 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  await updateVenue(venueId, { cancelCutoffHours: 48 });
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20, capacity: 1 });
  if (!court.ok) throw new Error(court.error);
  courtId = court.court.id;
});

describe("cancelling a weekly series", () => {
  it("shows the week inside the cutoff staying booked, and still owed, where the venue allows no late cancels", async () => {
    await setCancelPolicy(venueId, { lateKeep: null });
    const s = await series(3, 18, false);
    const plan = await seriesCancelPlan(s.seriesCode, s.phone);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.weeks.map((w) => w.outcome)).toEqual(["stays", "free", "free"]);
    expect(plan.weeks[0]).toMatchObject({ reason: "cutoff", owed: 20, refund: 0 });

    // Without a choice only the free weeks go, and the one left is named.
    const done = await cancelSeries(s.seriesCode, s.phone);
    if (!done.ok) throw new Error(done.error);
    expect(done.cancelled).toBe(2);
    expect(done.left.map((w) => w.code)).toEqual([s.codes[0]]);
    expect((await row(s.codes[0])).status).toBe("confirmed");
  });

  it("cancels a late week only on the late terms the customer accepted, each week on its own terms", async () => {
    await setCancelPolicy(venueId, { lateKeep: 50 });
    const s = await series(3, 19);
    const plan = await seriesCancelPlan(s.seriesCode, s.phone);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.weeks[0]).toMatchObject({ outcome: "late", keptPercent: 50, paid: 20, kept: 10, refund: 10 });
    expect(plan.weeks[1]).toMatchObject({ outcome: "free", refund: 20, kept: 0 });

    // Asked for the late week without accepting its terms: nothing is cancelled.
    const refused = await cancelSeries(s.seriesCode, s.phone, { codes: [s.codes[0], s.codes[1]] });
    expect(refused).toMatchObject({ ok: false });
    expect((await row(s.codes[1])).status).toBe("confirmed");

    const res = await route({ seriesCode: s.seriesCode, phone: s.phone, codes: [s.codes[0], s.codes[1]], acceptLate: [s.codes[0]] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cancelled).toBe(2);
    // Paid at the counter, so staff give it back: half of the late week and all of the free one, on credit notes.
    const credited = async (code: string) =>
      Number(
        ((await getDb()
          .prepare("SELECT total FROM receipts WHERE kind = 'credit_note' AND source = (SELECT 'booking:' || id FROM bookings WHERE code = ?)")
          .get(code)) as { total: string }).total
      );
    expect(Math.abs(await credited(s.codes[0]))).toBe(10);
    expect(Math.abs(await credited(s.codes[1]))).toBe(20);
    expect(await row(s.codes[0])).toMatchObject({ status: "cancelled", late_cancelled: 1, late_kept_percent: 50 });
    expect(await row(s.codes[1])).toMatchObject({ status: "cancelled", late_cancelled: 0 });
    expect((await row(s.codes[2])).status).toBe("confirmed");
  });

  it("previews over the route without cancelling anything", async () => {
    const s = await series(2, 20);
    const res = await route({ seriesCode: s.seriesCode, phone: s.phone, preview: true });
    expect(res.status).toBe(200);
    expect((await res.json()).weeks).toHaveLength(2);
    expect((await row(s.codes[0])).status).toBe("confirmed");
    expect((await route({ seriesCode: s.seriesCode, phone: s.phone, codes: "all" })).status).toBe(400);
  });

  it("refuses a week whose terms changed since the customer looked", async () => {
    await setCancelPolicy(venueId, { lateKeep: 50 });
    const s = await series(2, 17);
    const plan = await seriesCancelPlan(s.seriesCode, s.phone);
    if (!plan.ok) throw new Error(plan.error);
    await setCancelPolicy(venueId, { lateKeep: null });
    // The first week was shown late at half; now the venue allows no late cancels at all.
    expect(plan.weeks[0].outcome).toBe("late");
    const refused = await cancelSeries(s.seriesCode, s.phone, { codes: [s.codes[0]], acceptLate: [s.codes[0]] });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("changed") });
    expect((await row(s.codes[0])).status).toBe("confirmed");
  });

  it("cancels and refunds each week once when asked twice at the same moment", async () => {
    await setCancelPolicy(venueId, { lateKeep: null });
    const s = await series(3, 16);
    const [a, b] = await Promise.all([cancelSeries(s.seriesCode, s.phone), cancelSeries(s.seriesCode, s.phone)]);
    const total = [a, b].reduce((sum, r) => sum + (r.ok ? r.cancelled : 0), 0);
    expect(total).toBe(2);
    const notes = (await getDb()
      .prepare("SELECT COUNT(*)::int AS n FROM receipts WHERE kind = 'credit_note' AND source IN (SELECT 'booking:' || id FROM bookings WHERE series_code = ?)")
      .get(s.seriesCode)) as { n: number };
    expect(notes.n).toBe(2);
  });
});
