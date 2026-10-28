import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { createAdmin } from "../src/lib/admin-auth";
import { createApiKey } from "../src/lib/api-keys";
import { EMAIL_MAX, NAME_MAX } from "../src/lib/contact-fields";
import { translateError, translator } from "../src/lib/i18n";
import { completeRegistration } from "../src/lib/registration";
import { createResources } from "../src/lib/resources";
import { createBooking, createBookingSeries, createClassSessions, createVenue, joinSlotWaitlist } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { joinAtVenue } from "../src/lib/waitlist-venue";
import * as apiBookings from "../src/app/api/v1/bookings/route";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as enrolRoute from "../src/app/api/classes/enrol/route";
import * as waitlistRoute from "../src/app/api/waitlist/route";

/**
 * The name and email a booking, enrolment, waiting list or new account keeps
 * are bounded on every path (lib/contact-fields.ts): the booking form, the
 * counter, the venue's API, both waiting lists and sign-up, and the store
 * under them all. A name is trimmed and kept to NAME_MAX characters, an email
 * to EMAIL_MAX; past that the request is refused with NAME_TOO_LONG, or as an
 * email that is not one, before anything is kept.
 */

const ZONE = "Asia/Kuala_Lumpur";
const at = (h: number) => h * 60;
const longest = "N".repeat(NAME_MAX);
const tooLong = "N".repeat(NAME_MAX + 1);
const longEmail = `${"a".repeat(EMAIL_MAX - 5)}@b.co`; // EMAIL_MAX
const tooLongEmail = `${"a".repeat(EMAIL_MAX - 4)}@b.co`; // one over
let n = 0;
const phone = () => `0166${String(++n).padStart(6, "0")}`;

let venueId: number;
let hall: number;
let classId: number;
let writeKey: string;

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.66.${++n % 250}.${n % 200}`, ...headers },
    body: JSON.stringify(body),
  });
const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as { code?: string; error?: string; booking?: { name: string } } });

beforeAll(async () => {
  const v = await createVenue({ name: "Length Courts", area: "Ampang", address: "x", phone: "0312977001", openMin: at(7), closeMin: at(23) });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const r = await createResources({ venueId, sport: "badminton", name: "Court 1", offPeakRate: 20, peakRate: 20 });
  const s = await createResources({ venueId, sport: "gym", name: "Studio", offPeakRate: 20, peakRate: 20, capacity: 6, maxPlayers: 6 });
  if (!r.ok || !s.ok) throw new Error("resource");
  hall = r.courts[0].id;
  const made = await createClassSessions({ courtId: s.courts[0].id, name: "Circuit", instructor: "Coach", date: addDays(todayISO(ZONE), 6), start: at(18), end: at(19), capacity: 1, price: 15 });
  if (!made.ok) throw new Error(made.error);
  classId = made.classes[0].id;
  const a = await createAdmin({ name: "Keys", email: "keys@lengths.test", password: "a long enough password", venueId });
  if (!a.ok) throw new Error(a.error);
  const key = await createApiKey(venueId, { name: "Venue system", scope: "write" }, a.admin.id);
  if (!key.ok) throw new Error(key.error);
  writeKey = key.key;
});

describe("the store, under every path that books", () => {
  it("keeps a name of NAME_MAX characters and an email of EMAIL_MAX, and refuses one more", async () => {
    const ok = await createBooking({ courtId: hall, date: addDays(todayISO(ZONE), 3), hours: [8], name: longest, phone: phone(), email: longEmail });
    if (!ok.ok) throw new Error(ok.error);
    expect(ok.booking.name).toBe(longest);
    expect(ok.booking.email).toBe(longEmail);

    const name = await createBookingSeries({ courtId: hall, date: addDays(todayISO(ZONE), 3), start: at(9), end: at(10), weeks: 1, name: tooLong, phone: phone() });
    expect(name).toMatchObject({ ok: false, code: "NAME_TOO_LONG", vars: { max: NAME_MAX } });
    const email = await createBooking({ courtId: hall, date: addDays(todayISO(ZONE), 3), hours: [10], name: "Long Email", phone: phone(), email: tooLongEmail });
    expect(email).toMatchObject({ ok: false, error: "Please provide a valid email address." });
    // The audit's case: 20,000 characters.
    expect(await createBooking({ courtId: hall, date: addDays(todayISO(ZONE), 3), hours: [11], name: "N".repeat(20_000), phone: phone() })).toMatchObject({ ok: false, code: "NAME_TOO_LONG" });
  });

  it("refuses the same on a waiting list", async () => {
    const queued = await joinSlotWaitlist({ courtId: hall, date: addDays(todayISO(ZONE), 3), start: at(8), end: at(9), name: tooLong, phone: phone() });
    expect(queued).toMatchObject({ ok: false, code: "NAME_TOO_LONG" });
  });
});

describe("each route that takes a name without an account", () => {
  it("the booking form", async () => {
    const res = await answer(await bookingsRoute.POST(post("http://localhost/api/bookings", { courtId: hall, date: addDays(todayISO(ZONE), 4), start: at(9), end: at(10), name: tooLong, phone: phone() })));
    expect(res).toMatchObject({ status: 400, body: { code: "NAME_TOO_LONG" } });
    const email = await answer(await bookingsRoute.POST(post("http://localhost/api/bookings", { courtId: hall, date: addDays(todayISO(ZONE), 4), start: at(9), end: at(10), name: "Ok Name", phone: phone(), email: tooLongEmail })));
    expect(email).toMatchObject({ status: 400, body: { error: "Please provide a valid email address." } });
    const trimmed = await answer(await bookingsRoute.POST(post("http://localhost/api/bookings", { courtId: hall, date: addDays(todayISO(ZONE), 4), start: at(9), end: at(10), name: `  ${longest}  `, phone: phone() })));
    expect(trimmed.status).toBe(201);
    expect(trimmed.body.booking!.name).toBe(longest);
  });

  it("enrolling in a class", async () => {
    const res = await answer(await enrolRoute.POST(post("http://localhost/api/classes/enrol", { classId, name: tooLong, phone: phone() })));
    expect(res).toMatchObject({ status: 400, body: { code: "NAME_TOO_LONG" } });
  });

  it("the waiting list", async () => {
    const res = await answer(await waitlistRoute.POST(post("http://localhost/api/waitlist", { classId, name: tooLong, phone: phone() })));
    expect(res).toMatchObject({ status: 400, body: { code: "NAME_TOO_LONG" } });
    const email = await answer(await waitlistRoute.POST(post("http://localhost/api/waitlist", { classId, name: "Ok Name", phone: phone(), email: tooLongEmail })));
    expect(email.status).toBe(400);
  });

  it("the venue's API and the counter's waiting list", async () => {
    const res = await answer(
      await apiBookings.POST(post("http://localhost/api/v1/bookings", { courtId: hall, date: addDays(todayISO(ZONE), 5), start: at(9), end: at(10), name: tooLong, phone: phone() }, { authorization: `Bearer ${writeKey}` }))
    );
    expect(res).toMatchObject({ status: 400, body: { code: "NAME_TOO_LONG" } });
    const queued = await joinAtVenue(venueId, { channel: "api", apiKeyId: 1, name: "Venue system" }, { classId, name: tooLong, phone: phone() });
    expect(queued).toMatchObject({ ok: false, status: 400, code: "NAME_TOO_LONG" });
  });

  it("signing up", async () => {
    expect(await completeRegistration("x".repeat(43), { name: tooLong, phone: phone(), password: "a long enough password" })).toMatchObject({ ok: false, code: "NAME_TOO_LONG" });
  });

  it("is said in each customer language", () => {
    const body = { error: "Please keep the name to 100 characters.", code: "NAME_TOO_LONG", vars: { max: NAME_MAX } };
    expect(translateError(translator("ms"), body)).toBe(`Sila hadkan nama kepada ${NAME_MAX} aksara.`);
    expect(translateError(translator("zh"), body)).toContain(String(NAME_MAX));
    expect(translateError(translator("ta"), body)).toContain(String(NAME_MAX));
  });
});
