import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { venueSetup } from "../src/lib/setup";
import { createBooking, createCourt, createVenue, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * A newly approved venue's first steps, ticked off from what it has done.
 */

let venueId: number;
let cookie: string;

const call = async (method: "GET" | "POST", body?: object, query = "") => {
  const route = await import("../src/app/api/admin/setup/route");
  const req = new NextRequest(`http://localhost/api/admin/setup${query}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return method === "GET" ? route.GET(req) : route.POST(req);
};

beforeAll(async () => {
  const made = await createVenue({ name: "Fresh Hall", area: "Klang", address: "Jalan 1, Klang", phone: "0330000000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const operator = await createAdmin({ name: "Farid", email: "farid@example.my", password: "farid-password-1", venueId });
  if (!operator.ok) throw new Error(operator.error);
  cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(operator.admin.id)).token}`;
});

describe("setting up a new venue", () => {
  it("starts with every step to do", async () => {
    const setup = await venueSetup(venueId);
    expect(setup).toMatchObject({ courts: 0, detailsChecked: false, testBooking: false, onlinePayment: false, complete: false });
  });

  it("ticks each step off from what the venue has done", async () => {
    const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 15, peakRate: 20 });
    if (!court.ok) throw new Error("court");
    expect((await venueSetup(venueId)).courts).toBe(1);

    // Saving the venue's details counts as having looked at the hours.
    const { PATCH } = await import("../src/app/api/admin/venues/[id]/route");
    const saved = await PATCH(
      new NextRequest(`http://localhost/api/admin/venues/${venueId}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ openHour: 7 }),
      }),
      { params: Promise.resolve({ id: String(venueId) }) }
    );
    expect(saved.status).toBe(200);
    expect((await venueSetup(venueId)).detailsChecked).toBe(true);

    const booked = await createBooking({ courtId: court.court.id, date: addDays(todayISO(), 2), hours: [10], name: "Test", phone: "0123456789" });
    expect(booked.ok).toBe(true);
    // Online payment is optional, so it is complete without it.
    expect(await venueSetup(venueId)).toMatchObject({ testBooking: true, onlinePayment: false, complete: true });
  });

  it("is not ticked off by saving only the cancellation cutoff, which is not looking at the hours (S34)", async () => {
    const made = await createVenue({ name: "Cutoff Hall", area: "Klang", address: "Jalan 2, Klang", phone: "0330000001" });
    if (!made.ok) throw new Error("venue");
    const operator = await createAdmin({ name: "Hana", email: "hana@example.my", password: "hana-password-1", venueId: made.venue.id });
    if (!operator.ok) throw new Error(operator.error);
    const mine = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(operator.admin.id)).token}`;
    const { PATCH } = await import("../src/app/api/admin/venues/[id]/route");
    const patch = (body: object) =>
      PATCH(
        new NextRequest(`http://localhost/api/admin/venues/${made.venue.id}`, {
          method: "PATCH",
          headers: { cookie: mine, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: String(made.venue.id) }) }
      );
    expect((await patch({ cancelCutoffHours: 4 })).status).toBe(200);
    expect((await venueSetup(made.venue.id)).detailsChecked).toBe(false);
    expect((await patch({ openHour: 7 })).status).toBe(200);
    expect((await venueSetup(made.venue.id)).detailsChecked).toBe(true);
  });

  it("answers the venue's own operator, and goes when dismissed", async () => {
    const res = await call("GET");
    expect(res.status).toBe(200);
    expect((await res.json()).venueId).toBe(venueId);
    const dismissed = await (await call("POST", { action: "dismiss" })).json();
    expect(dismissed.dismissed).toBe(true);
    expect((await call("POST", { action: "nonsense" })).status).toBe(400);
  });

  it("is not another venue's to read", async () => {
    const other = (await listVenues()).find((v) => v.id !== venueId)!;
    expect((await call("GET", undefined, `?venueId=${other.id}`)).status).toBe(403);
    expect((await call("POST", { venueId: other.id, action: "dismiss" })).status).toBe(403);
  });
});
