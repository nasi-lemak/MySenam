import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { feedToken, feedUrl, setFeed } from "../src/lib/staff-calendar";
import {
  adminCancelBooking,
  createBooking,
  createClassSessions,
  createCourt,
  createVenue,
  enrolInClass,
  setPaymentStatus,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { GET } from "../src/app/api/calendar/[token]/route";

/**
 * A venue's bookings and classes as a calendar its staff subscribe to, at a
 * secret address a manager can replace or withdraw.
 */

let venueId: number;
let otherVenueId: number;
let courtId: number;
let otherCourtId: number;
const date = addDays(todayISO(), 2);

const fetchFeed = async (token: string) => {
  const res = await GET(new NextRequest(`http://localhost/api/calendar/${token}.ics`), {
    params: Promise.resolve({ token: `${token}.ics` }),
  });
  return { status: res.status, type: res.headers.get("content-type"), body: await res.text() };
};

/** The file's lines, with long ones unfolded. */
const unfold = (ics: string) => ics.replace(/\r\n /g, "").split("\r\n");

beforeAll(async () => {
  const a = await createVenue({ name: "Feed Arena, PJ", area: "PJ", address: "1 Jalan Kalendar", phone: "0377770000" });
  const b = await createVenue({ name: "Other Hall", area: "KL", address: "2 Jalan Lain", phone: "0377770001" });
  if (!a.ok || !b.ok) throw new Error("venue");
  venueId = a.venue.id;
  otherVenueId = b.venue.id;
  const c = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  const d = await createCourt({ venueId: otherVenueId, name: "Court A", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok || !d.ok) throw new Error("court");
  courtId = c.court.id;
  otherCourtId = d.court.id;
});

describe("the staff calendar feed", () => {
  it("is off until a manager turns it on", async () => {
    expect(await feedToken(venueId)).toBeNull();
    expect((await fetchFeed("a".repeat(32))).status).toBe(404);
  });

  it("lists the venue's bookings and classes, and nobody else's", async () => {
    const token = (await setFeed(venueId, true))!;
    expect(await feedUrl(venueId, token)).toBe(`https://book.example.my/api/calendar/${token}.ics`);
    const unpaid = await createBooking({ courtId, date, hours: [9, 10], name: "Lim, Wei", phone: "0121110001" });
    const paid = await createBooking({ courtId, date, hours: [12], name: "Aisyah", phone: "0121110002" });
    const gone = await createBooking({ courtId, date, hours: [14], name: "Gone Person", phone: "0121110003" });
    const elsewhere = await createBooking({ courtId: otherCourtId, date, hours: [9], name: "Elsewhere", phone: "0121110004" });
    if (!unpaid.ok || !paid.ok || !gone.ok || !elsewhere.ok) throw new Error("booking");
    await setPaymentStatus(paid.booking.code, true, "cash");
    await adminCancelBooking(gone.booking.code);
    const yoga = await createClassSessions({ courtId, name: "Yoga Flow", instructor: "Mei Ling", date, startHour: 19, endHour: 20, capacity: 1, price: 25 });
    if (!yoga.ok) throw new Error(yoga.error);
    await enrolInClass({ classId: yoga.classes[0].id, name: "Student", phone: "0121110005" });

    const feed = await fetchFeed(token);
    expect(feed.status).toBe(200);
    expect(feed.type).toContain("text/calendar");
    const lines = unfold(feed.body);
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("X-WR-CALNAME:Feed Arena\\, PJ bookings");
    expect(lines).toContain("SUMMARY:Court 1: Lim\\, Wei (unpaid)");
    expect(lines).toContain("SUMMARY:Court 1: Aisyah");
    expect(lines).toContain("SUMMARY:Yoga Flow (1/1)");
    expect(lines).toContain(`UID:booking-${unpaid.booking.code}@book.example.my`);
    expect(lines.some((l) => l.startsWith("DESCRIPTION:") && l.includes("0121110001"))).toBe(true);
    expect(feed.body).not.toContain("Gone Person");
    expect(feed.body).not.toContain("Elsewhere");
    // 09:00–11:00 Malaysia time is 01:00–03:00 UTC.
    expect(lines).toContain(`DTSTART:${date.replace(/-/g, "")}T010000Z`);
    expect(lines).toContain(`DTEND:${date.replace(/-/g, "")}T030000Z`);
    // Folded as the format wants: no raw line over 75 octets.
    expect(feed.body.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
  });

  it("stops answering at the old address when a new one is made, and at all when turned off", async () => {
    const old = (await feedToken(venueId))!;
    const fresh = (await setFeed(venueId, true))!;
    expect(fresh).not.toBe(old);
    expect((await fetchFeed(old)).status).toBe(404);
    expect((await fetchFeed(fresh)).status).toBe(200);
    expect(await setFeed(venueId, false)).toBeNull();
    expect((await fetchFeed(fresh)).status).toBe(404);
  });

  it("does not look up a token that cannot be one", async () => {
    expect((await fetchFeed("short")).status).toBe(404);
    expect((await fetchFeed("' OR 1=1 --")).status).toBe(404);
  });
});
