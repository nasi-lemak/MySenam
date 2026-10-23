import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { attachCoach, coachById, coachWorks, saveCoach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, dayOfWeek, todayISO } from "../src/lib/time";
import { setCoachLink } from "../src/lib/coach-schedule";
import { POST as setHours } from "../src/app/api/coach/[token]/hours/route";
import { DELETE as backOn, POST as takeOff } from "../src/app/api/coach/[token]/time-off/route";

/** A coach sets their own week and time off at the private link the venue gave them. */

let venueId: number;
let courtId: number;
let coachId: number;
let token: string;
let monday = addDays(todayISO(), 1);
while (dayOfWeek(monday) !== 1) monday = addDays(monday, 1);

const call = async (handler: (req: NextRequest, ctx: { params: Promise<{ token: string }> }) => Promise<Response>, method: string, body?: unknown, query = "", t = token) => {
  const res = await handler(
    new NextRequest(`http://localhost/api/coach/${t}/x${query}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve({ token: t }) }
  );
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  const v = await createVenue({ name: "Tennis Academy", area: "Cheras", address: "x", phone: "0355556666" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "Court 1", sport: "tennis", offPeakRate: 40, peakRate: 40 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  const coach = await saveCoach(venueId, { name: "Ana Lim", sports: ["tennis"], rate: 80, hours: [{ weekday: 1, from: 9 * 60, until: 12 * 60 }] });
  if (!coach.ok) throw new Error(coach.error);
  coachId = coach.coach.id;
  expect(await setCoachLink(coachId, venueId, true)).toBe(true);
  token = ((await getDb().prepare("SELECT calendar_token FROM coaches WHERE id = ?").get(coachId)) as { calendar_token: string }).calendar_token;
});

describe("a coach's own week", () => {
  it("is set at their link, and only there", async () => {
    const set = await call(setHours, "POST", { hours: [{ weekday: 1, from: 9 * 60, until: 12 * 60 }, { weekday: 1, from: 17 * 60, until: 21 * 60 }, { weekday: 3, from: 18 * 60, until: 20 * 60 + 30 }] });
    expect(set.status).toBe(200);
    expect(set.body.coach.hours).toHaveLength(3);
    const coach = (await coachById(coachId))!;
    expect(coachWorks(coach, monday, { start: 18 * 60, end: 19 * 60 })).toBe(true);
    expect(coachWorks(coach, monday, { start: 14 * 60, end: 15 * 60 })).toBe(false);
    expect((await call(setHours, "POST", { hours: [{ weekday: 9, from: 1, until: 2 }] })).status).toBe(400);
    expect((await call(setHours, "POST", { hours: [] }, "", "x".repeat(30))).status).toBe(404);
  });

  it("time off: nobody can book them then, and what is already booked is said", async () => {
    const lesson = await createBooking({ courtId, date: monday, hours: [9], name: "Student", phone: "0123334444" });
    if (!lesson.ok) throw new Error(lesson.error);
    expect(await attachCoach(lesson.booking.id, (await coachById(coachId))!)).toMatchObject({ ok: true });
    const off = await call(takeOff, "POST", { from: monday, until: addDays(monday, 2), reason: "Tournament" });
    expect(off.status).toBe(200);
    expect(off.body.clashes).toBe(1);
    const coach = (await coachById(coachId))!;
    expect(coachWorks(coach, monday, { start: 18 * 60, end: 19 * 60 })).toBe(false);
    // Not in the past, and the last day not before the first.
    expect((await call(takeOff, "POST", { from: addDays(todayISO(), -1) })).status).toBe(400);
    expect((await call(takeOff, "POST", { from: monday, until: addDays(monday, -1) })).status).toBe(400);
    // Back on.
    const id = off.body.timeOff[0].id;
    expect((await call(backOn, "DELETE", undefined, `?id=${id}`)).status).toBe(200);
    expect(coachWorks((await coachById(coachId))!, monday, { start: 18 * 60, end: 19 * 60 })).toBe(true);
  });

  it("stops working when the venue withdraws the link", async () => {
    await setCoachLink(coachId, venueId, false);
    expect((await call(setHours, "POST", { hours: [] })).status).toBe(404);
  });
});
