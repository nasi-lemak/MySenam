import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { BUILTIN_ACTIVITIES } from "../src/lib/activity-catalogue";
import { registerUser } from "../src/lib/auth";
import { policiesFor } from "../src/lib/booking-policy";
import { usualMinutes } from "../src/lib/booking-rules";
import { getDb } from "../src/lib/db";
import { createResources } from "../src/lib/resources";
import { addSignOff } from "../src/lib/sign-offs";
import {
  createBooking,
  createClassSessions,
  createVenue,
  enrolInClass,
  getAvailability,
  searchAvailability,
  sportsOfferedAt,
  updateCourt,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { GET as classesGet } from "../src/app/api/classes/route";

/**
 * Every built-in activity, set up from its template the way the dashboard
 * does it, then found and booked the way a customer of that activity would:
 * a court, lane or place through search and the venue's grid, a studio
 * through its classes. And the combinations that cannot work are refused.
 */

const ZONE = "Asia/Kuala_Lumpur";
const date = addDays(todayISO(ZONE), 3);
let venueId: number;
let n = 0;

beforeAll(async () => {
  const v = await createVenue({ name: "Everything Centre", area: "Subang", address: "x", phone: "0312347777", openMin: 7 * 60, closeMin: 23 * 60 });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
});

describe("every built-in activity", () => {
  for (const a of BUILTIN_ACTIVITIES) {
    it(`${a.key}: set up from its template, found and booked as it is sold`, async () => {
      const t = a.template;
      const made = await createResources({
        venueId,
        sport: a.key,
        offPeakRate: 20,
        peakRate: 20,
        capacity: t.capacity,
        perPlayer: t.perPlayer,
        maxPlayers: t.maxPlayers,
      });
      if (!made.ok) throw new Error(`${a.key}: ${made.error}`);
      const court = made.courts[0];
      // What the template says, nothing contradictory: per player only on a court booked whole.
      expect(court.perPlayer && court.capacity > 1, a.key).toBe(false);
      const start = 10 * 60;
      const minutes = usualMinutes(a.key);

      if (t.model === "class") {
        // A studio is booked through its classes: not on the grid, not in court search.
        expect(court.classesOnly, a.key).toBe(true);
        expect((await getAvailability(venueId, date, a.key)).map((g) => g.court.id)).not.toContain(court.id);
        expect(await sportsOfferedAt([venueId], { courtsOnly: true })).not.toContain(a.key);
        expect(await createBooking({ courtId: court.id, date, start, end: start + 60, name: "Walk", phone: `0166${String(++n).padStart(6, "0")}` })).toMatchObject({
          ok: false,
          code: "CLASSES_ONLY",
        });
        const session = await createClassSessions({ courtId: court.id, name: `${a.names.en} basics`, instructor: "Coach", date, startHour: 18, endHour: 19, capacity: 8, price: 25 });
        if (!session.ok) throw new Error(session.error);
        const listed = (await (await classesGet(new NextRequest(`http://localhost/api/classes?sport=${a.key}`))).json()) as { classes: { id: number }[] };
        expect(listed.classes.map((c) => c.id), a.key).toContain(session.classes[0].id);
        expect((await enrolInClass({ classId: session.classes[0].id, name: "Pupil", phone: `0166${String(++n).padStart(6, "0")}` })).ok, a.key).toBe(true);
        return;
      }

      // A court, lane, fleet or floor: on the grid and in search under its activity.
      expect((await getAvailability(venueId, date, a.key)).map((g) => g.court.id), a.key).toContain(court.id);
      const found = await searchAvailability({ sport: a.key, date, fromMin: start, toMin: start, minutes, venueIds: [venueId] });
      expect(found.map((r) => r.court.id), a.key).toContain(court.id);
      // Booked by a customer: one who has the sign-off where the activity asks for one.
      const policy = (await policiesFor([{ id: court.id, venueId, sport: a.key }])).get(court.id)!;
      const phone = `0166${String(++n).padStart(6, "0")}`;
      const user = await registerUser({ name: "Customer", email: `c${n}@cover.test`, phone, password: "a long enough password" });
      if (!user.ok) throw new Error(user.error);
      if (policy.signOff) {
        expect(await createBooking({ courtId: court.id, date, start, end: start + minutes, name: "C", phone, userId: user.user.id }), a.key).toMatchObject({ ok: false });
        await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now') WHERE id = ?").run(user.user.id);
        await addSignOff({ venueId, sport: a.key, phone, name: "Customer", adminId: null });
      }
      const booked = await createBooking({ courtId: court.id, date, start, end: start + minutes, name: "C", phone, userId: user.user.id });
      expect(booked.ok ? booked.booking.totalPrice : booked.error, a.key).toBeGreaterThan(0);
    });
  }
});

describe("combinations that cannot work", () => {
  it("are refused, whatever the catalogue says", async () => {
    // Supervised activities are never left unmanned.
    const pool = await createResources({ venueId, sport: "swimming", name: "Pool lane 9", offPeakRate: 5, peakRate: 5, capacity: 4 });
    if (!pool.ok) throw new Error(pool.error);
    expect(await updateCourt(pool.courts[0].id, { accessCode: "1234#", unmanned: true })).toMatchObject({ ok: false });
    // Per player is only for a court booked whole; one price for the booking only where there are places.
    expect(await updateCourt(pool.courts[0].id, { perPlayer: true })).toMatchObject({ ok: false });
    const piste = await createResources({ venueId, sport: "fencing", name: "Piste 9", offPeakRate: 30, peakRate: 30 });
    if (!piste.ok) throw new Error(piste.error);
    expect(await updateCourt(piste.courts[0].id, { flatRate: true })).toMatchObject({ ok: false });
    // Something hired against a deposit is not left unmanned either.
    const boats = await createResources({ venueId, sport: "kayak", name: "Kayaks 9", offPeakRate: 25, peakRate: 25, capacity: 6, deposit: 50 });
    if (!boats.ok) throw new Error(boats.error);
    expect(await updateCourt(boats.courts[0].id, { accessCode: "1234#", unmanned: true })).toMatchObject({ ok: false });
  });
});
