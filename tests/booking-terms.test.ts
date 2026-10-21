import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { registerUser } from "../src/lib/auth";
import { bookingTerms, dismissedVersion, dismissTerms, standing } from "../src/lib/booking-terms";
import { setCancelPolicy } from "../src/lib/cancel-policy";
import { getDb } from "../src/lib/db";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { GET } from "../src/app/api/venues/[id]/terms/route";

/**
 * "Before you book": a venue's cancellation, no-show and payment rules, put
 * away per venue until they change; a customer's own strikes told regardless.
 */

let venueId: number;
let courtId: number;

beforeAll(async () => {
  const made = await createVenue({ name: "Rules Hall", area: "PJ", address: "x", phone: "0300001111" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
});

describe("the rules shown before booking", () => {
  it("say what the venue's policy is", async () => {
    expect(await bookingTerms(venueId)).toMatchObject({ cutoffHours: 2, lateKeep: null, strikeLimit: null, holdMinutes: null });
    await setCancelPolicy(venueId, { lateKeep: 50, strikeLimit: 3, strikeDays: 60 });
    expect(await bookingTerms(venueId)).toMatchObject({ lateKeep: 50, strikeLimit: 3, strikeDays: 60, struckOutPays: false });
  });

  it("change version when the rules do, so a dismissed box comes back", async () => {
    const before = (await bookingTerms(venueId))!.version;
    expect((await bookingTerms(venueId))!.version).toBe(before);
    await setCancelPolicy(venueId, { lateKeep: 25, strikeLimit: 3, strikeDays: 60 });
    expect((await bookingTerms(venueId))!.version).not.toBe(before);
  });

  it("are put away for an account, until they change", async () => {
    const user = await registerUser({ name: "Reader", email: "reader@example.my", phone: "0129990001", password: "a long enough password" });
    if (!user.ok) throw new Error(user.error);
    const terms = (await bookingTerms(venueId))!;
    await dismissTerms(user.user.id, venueId, terms.version);
    expect(await dismissedVersion(user.user.id, venueId)).toBe(terms.version);
    await setCancelPolicy(venueId, { lateKeep: 10, strikeLimit: 3, strikeDays: 60 });
    expect(await dismissedVersion(user.user.id, venueId)).not.toBe((await bookingTerms(venueId))!.version);
  });

  it("tell a number its strikes, but only once it has some", async () => {
    expect(await standing(venueId, "0129990002")).toBeNull();
    const made = await createBooking({ courtId, date: addDays(todayISO(), 2), hours: [9], name: "Missed", phone: "0129990002" });
    if (!made.ok) throw new Error(made.error);
    await getDb().prepare("UPDATE bookings SET no_show = 1 WHERE id = ?").run(made.booking.id);
    expect(await standing(venueId, "0129990002")).toEqual({ strikes: 1, limit: 3, out: false });
  });

  it("are public, without anybody's strikes or dismissals for a guest", async () => {
    const res = await GET(new NextRequest(`http://localhost/api/venues/${venueId}/terms`), { params: Promise.resolve({ id: String(venueId) }) });
    expect(await res.json()).toMatchObject({ terms: { venueId, strikeLimit: 3 }, dismissed: null, you: null });
  });
});
