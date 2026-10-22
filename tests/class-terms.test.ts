import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { getDb } from "../src/lib/db";
import { classTerm, createClassSessions, createCourt, createVenue, enrolInClass, enrolInTerm } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as enrol } from "../src/app/api/classes/enrol/route";

/** Joining a weekly class for every session left at once: one code, one bill, a term's share off. */

let venueId: number;
let courtId: number;
let first: number;
let classIds: number[] = [];
let n = 0;
const phone = () => `0111110${String(++n).padStart(3, "0")}`;
const start = addDays(todayISO(), 2);

beforeAll(async () => {
  const v = await createVenue({ name: "Junior Academy", area: "Subang", address: "x", phone: "0377771111" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(venueId);
  const c = await createCourt({ venueId, name: "Hall", sport: "badminton", offPeakRate: 20, peakRate: 20, capacity: 10 });
  if (!c.ok) throw new Error(c.error);
  courtId = c.court.id;
  const made = await createClassSessions({
    courtId, name: "Kids' badminton", instructor: "Coach Lee", date: start, startHour: 10, endHour: 11,
    capacity: 2, price: 30, weeks: 4, termOffPercent: 10,
  });
  if (!made.ok) throw new Error(made.error);
  classIds = made.classes.map((c) => c.id);
  first = classIds[0];
  // The third week fills up.
  for (const who of [phone(), phone()]) {
    const r = await enrolInClass({ classId: classIds[2], name: "Other", phone: who });
    if (!r.ok) throw new Error(r.error);
  }
});

describe("a class term", () => {
  it("is every session left with a place, at the term's share off", async () => {
    const term = await classTerm(first);
    expect(term).toMatchObject({ offPercent: 10, total: 81 });
    expect(term!.sessions.map((s) => s.id)).toEqual([classIds[0], classIds[1], classIds[3]]);
    // From the second week on, only what is left from there.
    expect((await classTerm(classIds[1]))!.sessions).toHaveLength(2);
  });

  it("enrols in each, sharing one code, the full one skipped", async () => {
    const who = phone();
    // Already in week two: that one is said, the rest go ahead.
    expect((await enrolInClass({ classId: classIds[1], name: "Kid", phone: who })).ok).toBe(true);
    const joined = await enrolInTerm({ classId: first, name: "Kid", phone: who });
    if (!joined.ok) throw new Error(joined.error);
    expect(joined.bookings.map((b) => b.classId)).toEqual([classIds[0], classIds[3]]);
    expect(joined.bookings.every((b) => b.seriesCode === joined.seriesCode && b.totalPrice === 27)).toBe(true);
    expect(joined.skipped.map((s) => s.date)).toEqual([addDays(start, 7)]);
  });

  it("is only for a weekly class", async () => {
    const once = await createClassSessions({ courtId, name: "One-off", instructor: "Coach Lee", date: start, startHour: 15, endHour: 16, capacity: 5, price: 30 });
    if (!once.ok) throw new Error(once.error);
    expect(await enrolInTerm({ classId: once.classes[0].id, name: "Kid", phone: phone() })).toMatchObject({ ok: false, code: "CLASS_NO_TERM" });
  });

  it("is joined from the classes page in one go", async () => {
    const res = await enrol(
      new NextRequest("http://localhost/api/classes/enrol", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ classId: first, name: "Aiman", phone: phone(), term: true }),
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.bookings).toHaveLength(3);
    expect(body.seriesCode).toMatch(/^SR-/);
  });
});
