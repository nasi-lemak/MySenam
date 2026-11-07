import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { coachesWithoutEmail, coachPayouts, coachPayoutsCsv, notifyCoaches, setCoachEmail } from "../src/lib/coach-schedule";
import { saveCoach, type Coach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";

/**
 * E16 (hardening, ADR 0072): a coach is told of every lesson still to come that they have not heard of, however long ago it was booked
 * (it used to be only those booked in the last two days, so a coach whose address was set later never heard of the rest, and a backlog
 * was written off by the day's limit); coaches with no address are on staff's worklist; and the coach report counts only lessons that have
 * ended as owed, with those still to come apart.
 */

let venueId: number;
let otherVenueId: number;
let n = 0;
const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: 8 * 60, until: 20 * 60 }));

const post = (coachId: number, date: string, hour: number) =>
  book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${(++n % 250) + 1}` },
      // A number of its own for each, so the limit on unpaid bookings coming up for one number is not met.
      body: JSON.stringify({ venueId, sport: "tennis", name: "Pupil Tan", phone: `01234${String(n).padStart(5, "0")}`, date, hours: [hour], coachId }),
    })
  );

async function lesson(coach: Coach, daysAhead: number, hour: number, bookedDaysAgo = 0): Promise<number> {
  const res = await post(coach.id, addDays(todayISO(), daysAhead), hour);
  const body = (await res.json()) as { booking?: { id: number }; error?: string };
  if (!body.booking) throw new Error(body.error ?? "lesson");
  if (bookedDaysAgo > 0) await getDb().prepare("UPDATE bookings SET created_at = datetime('now', ?) WHERE id = ?").run(`-${bookedDaysAgo} days`, body.booking.id);
  return body.booking.id;
}

async function newCoach(name: string, venue = venueId): Promise<Coach> {
  const made = await saveCoach(venue, { name, sports: ["tennis"], rate: 80, hours });
  if (!made.ok) throw new Error(made.error);
  return made.coach;
}

const mails = async (email: string) =>
  (await getDb().prepare("SELECT dedupe_key, status, subject FROM messages WHERE kind = 'coach_lesson' AND recipient = ? ORDER BY id").all(email)) as { dedupe_key: string; status: string; subject: string }[];

beforeAll(async () => {
  const made = await createVenue({ name: "Coach Hall Two", area: "PJ", address: "1 Jalan Ajar", phone: "0311110000" });
  const elsewhere = await createVenue({ name: "Elsewhere Two", area: "PJ", address: "x", phone: "0311110001" });
  if (!made.ok || !elsewhere.ok) throw new Error("venue");
  venueId = made.venue.id;
  otherVenueId = elsewhere.venue.id;
  for (const name of ["Court 1", "Court 2", "Court 3"]) await createCourt({ venueId, name, sport: "tennis", offPeakRate: 20, peakRate: 20 });
  await createCourt({ venueId: otherVenueId, name: "C", sport: "tennis", offPeakRate: 20, peakRate: 20 });
});

describe("telling a coach of every lesson still to come", () => {
  it("covers lessons booked long ago once an address is set, once each, and not written off by the day's limit", async () => {
    const coach = await newCoach("Tala Backlog");
    const ids: number[] = [];
    // Ten lessons, the older ones booked a week and more ago, before the coach had an address.
    for (let i = 0; i < 10; i++) ids.push(await lesson(coach, 3 + i, 9, i < 6 ? 10 + i : 0));
    expect(await notifyCoaches()).toBe(0);
    expect(await coachesWithoutEmail([venueId])).toMatchObject([{ coachId: coach.id, coach: "Tala Backlog", lessons: 10, venueId, firstDate: addDays(todayISO(), 3), hasLink: false }]);

    expect(await setCoachEmail(coach.id, venueId, "tala@coach.my")).toEqual({ ok: true });
    expect(await coachesWithoutEmail([venueId])).toEqual([]);
    expect(await notifyCoaches()).toBe(10);
    const sent = await mails("tala@coach.my");
    expect(sent.map((m) => m.dedupe_key).sort()).toEqual(ids.map((id) => `coach-new:${id}`).sort());
    // Ten is more than the eight a day an address is otherwise sent: none was written off.
    expect(sent.every((m) => m.status === "queued")).toBe(true);
    expect(await notifyCoaches()).toBe(0);

    // A cancelled lesson the coach was told of is told too, once.
    await getDb().prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(ids[0]);
    expect(await notifyCoaches()).toBe(1);
    expect(await notifyCoaches()).toBe(0);
    // One cancelled before they ever heard of it is not told at all.
    const never = await lesson(coach, 5, 10, 12);
    await getDb().prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(never);
    expect(await notifyCoaches()).toBe(0);
  });

  it("does not tell of lessons already past, nor of a demo lesson", async () => {
    const coach = await newCoach("Pia Past");
    const gone = await lesson(coach, 5, 11, 20);
    await getDb().prepare("UPDATE bookings SET date = ? WHERE id = ?").run(addDays(todayISO(), -2), gone);
    const demo = await lesson(coach, 6, 11, 20);
    await getDb().prepare("UPDATE bookings SET demo = 1 WHERE id = ?").run(demo);
    await setCoachEmail(coach.id, venueId, "pia@coach.my");
    expect(await notifyCoaches()).toBe(0);
    expect(await mails("pia@coach.my")).toEqual([]);
    // Nor are they on the worklist of coaches nobody can tell (no address is the only thing that puts a coach there).
    expect((await coachesWithoutEmail([venueId])).some((c) => c.coachId === coach.id)).toBe(false);
  });

  it("puts a coach with no address on staff's worklist, by venue, with the coach's own link noted", async () => {
    const coach = await newCoach("Lia NoMail");
    await lesson(coach, 4, 14);
    await lesson(coach, 9, 14);
    expect((await coachesWithoutEmail([venueId])).find((c) => c.coachId === coach.id)).toMatchObject({ lessons: 2, firstDate: addDays(todayISO(), 4) });
    // Another venue's staff do not see it; the platform owner (null) does.
    expect((await coachesWithoutEmail([otherVenueId])).some((c) => c.coachId === coach.id)).toBe(false);
    expect(await coachesWithoutEmail([])).toEqual([]);
    expect((await coachesWithoutEmail(null)).some((c) => c.coachId === coach.id)).toBe(true);
    await getDb().prepare("UPDATE coaches SET link_hash = 'h', link_expires_at = now() + interval '30 days' WHERE id = ?").run(coach.id);
    expect((await coachesWithoutEmail([venueId])).find((c) => c.coachId === coach.id)!.hasLink).toBe(true);
    // Once every lesson is cancelled there is nothing to tell.
    await getDb().prepare("UPDATE bookings SET status = 'cancelled' WHERE coach_id = ?").run(coach.id);
    expect((await coachesWithoutEmail([venueId])).some((c) => c.coachId === coach.id)).toBe(false);
  });
});

describe("what a coach is owed", () => {
  it("counts only lessons that have ended; lessons still to come are apart, as scheduled", async () => {
    const coach = await newCoach("Pay Ana");
    const past = await lesson(coach, 3, 15);
    const future1 = await lesson(coach, 4, 15);
    const future2 = await lesson(coach, 5, 15);
    // One has been and gone (yesterday), and was paid for; one still to come was paid for too.
    await getDb().prepare("UPDATE bookings SET date = ?, payment_status = 'paid' WHERE id = ?").run(addDays(todayISO(), -1), past);
    await getDb().prepare("UPDATE bookings SET payment_status = 'paid' WHERE id = ?").run(future1);
    const from = addDays(todayISO(), -3);
    const to = addDays(todayISO(), 30);
    const row = async () => (await coachPayouts(venueId, from, to)).find((p) => p.coachId === coach.id)!;
    expect(await row()).toMatchObject({
      lessons: 1, hours: 1, paidFees: 80, unpaidFees: 0,
      scheduledLessons: 2, scheduledHours: 2, scheduledPaidFees: 80, scheduledUnpaidFees: 80,
    });
    // A lesson marked a no-show is apart as before, whether or not it has happened.
    await getDb().prepare("UPDATE bookings SET no_show = 1 WHERE id = ?").run(future2);
    expect(await row()).toMatchObject({ noShows: 1, noShowFees: 80, scheduledLessons: 1, scheduledUnpaidFees: 0 });

    const csv = await coachPayoutsCsv(venueId, from, to, coach.id);
    const lines = csv.split("\n").filter((l) => l.includes("Pay Ana"));
    expect(lines).toHaveLength(3);
    expect(lines.filter((l) => l.includes('"Went ahead"'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('"Scheduled"'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('"No-show"'))).toHaveLength(1);

    // Once the lesson's end has passed it is owed: move the second one to yesterday.
    await getDb().prepare("UPDATE bookings SET date = ? WHERE id = ?").run(addDays(todayISO(), -1), future1);
    expect(await row()).toMatchObject({ lessons: 2, paidFees: 160, scheduledLessons: 0 });
  });

  it("is read on the venue's own clock: a lesson that ended earlier today is owed, one yet to start today is not", async () => {
    const coach = await newCoach("Clock Cho");
    const early = await lesson(coach, 2, 9);
    const late = await lesson(coach, 2, 18);
    // Only the date is faked, to 14:00 on the venue's clock (06:00 UTC), so the test reads the same at any hour it is run.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T06:00:00Z") });
    try {
      await getDb().prepare("UPDATE bookings SET date = '2026-11-10', start_min = 540, end_min = 600 WHERE id = ?").run(early);
      await getDb().prepare("UPDATE bookings SET date = '2026-11-10', start_min = 1080, end_min = 1140 WHERE id = ?").run(late);
      const row = (await coachPayouts(venueId, "2026-11-10", "2026-11-10")).find((p) => p.coachId === coach.id)!;
      expect(row).toMatchObject({ lessons: 1, unpaidFees: 80, scheduledLessons: 1, scheduledUnpaidFees: 80 });
      const csv = await coachPayoutsCsv(venueId, "2026-11-10", "2026-11-10", coach.id);
      expect(csv.match(/"Went ahead"/g)).toHaveLength(1);
      expect(csv.match(/"Scheduled"/g)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
