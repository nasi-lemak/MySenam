import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { createHash } from "crypto";
import { getDb } from "../src/lib/db";
import { notifyPendingOffers } from "../src/lib/notify";
import { createResources } from "../src/lib/resources";
import { shortDate } from "../src/lib/region";
import {
  cancelBooking,
  claimWaitlistOffer,
  createBookingSeries,
  createClassSessions,
  createVenue,
  declineWaitlistOffer,
  enrolPeople,
  joinSlotWaitlist,
  leaveWaitlist,
  leaveWaitlistByToken,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as waitlistRoute from "../src/app/api/waitlist/route";
import * as leaveRoute from "../src/app/api/waitlist/leave/route";

/**
 * Leaving a waiting list without an account, and turning an offer down
 * (audit R8 X2-9; docs/features/booking.md#waiting-lists): whoever joins is
 * given a private link to leave (on the joined screen, and in an email where
 * they gave an address), kept only as its hash; an offer's own link can turn
 * it down. Either way the entry leaves the list and the place goes at once to
 * the next person waiting, through the offer path every other leaving uses.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0178${String(++n).padStart(6, "0")}`;

let venue: number;
let hall: number;
let studio: number;

const req = (url: string, method: string, body?: unknown) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.67.${++n % 250}.${n % 200}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const row = async (id: number) =>
  (await getDb().prepare("SELECT status, offer_token, leave_hash FROM waitlist WHERE id = ?").get(id)) as {
    status: string;
    offer_token: string | null;
    leave_hash: string | null;
  };

/** The court taken from `start` for an hour by somebody else, who may cancel. */
async function take(date: string, start: number) {
  const ph = phone();
  const made = await createBookingSeries({ courtId: hall, date, start, end: start + 60, weeks: 1, name: "Taken By", phone: ph, by: "staff" });
  if (!made.ok) throw new Error(made.error);
  return { booking: made.bookings[0], phone: ph };
}

async function join(date: string, start: number, name = "Queue Person", email?: string) {
  const joined = await joinSlotWaitlist({ courtId: hall, date, start, end: start + 60, name, phone: phone(), ...(email ? { email } : {}) });
  if (!joined.ok) throw new Error(joined.error);
  return joined;
}

beforeAll(async () => {
  const v = await createVenue({ name: "Leave Lane Courts", area: "Bangsar", address: "1 Jalan Ujian", phone: "0312350999", openMin: at(7), closeMin: at(23) });
  if (!v.ok) throw new Error("venue");
  venue = v.venue.id;
  // Live, so its customers hear from it.
  await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(venue);
  const r = await createResources({ venueId: venue, sport: "badminton", name: "Hall 1", offPeakRate: 20, peakRate: 20 });
  if (!r.ok) throw new Error(r.error);
  hall = r.courts[0].id;
  const g = await createResources({ venueId: venue, sport: "gym", name: "Studio", offPeakRate: 10, peakRate: 10, capacity: 4, maxPlayers: 4 });
  if (!g.ok) throw new Error(g.error);
  studio = g.courts[0].id;
});

describe("joining gives a private link to leave", () => {
  it("is returned once, and kept only as its hash", async () => {
    const date = day(3);
    await take(date, at(18));
    const joined = await join(date, at(18));
    expect(joined.leaveToken).toMatch(/^[0-9a-f]{32}$/);
    const kept = await row(joined.entry.id);
    expect(kept.leave_hash).toBe(createHash("sha256").update(joined.leaveToken).digest("hex"));
    expect(kept.leave_hash).not.toContain(joined.leaveToken);
  });

  it("online: the answer carries it, and an email with the link and the day's weekday is written for whoever gave an address", async () => {
    const date = day(4);
    await take(date, at(19));
    const res = await waitlistRoute.POST(
      req("http://localhost/api/waitlist", "POST", { courtId: hall, date, start: at(19), end: at(20), name: "Aina Guest", phone: phone(), email: "aina@guest.test" })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.leaveToken).toBe("string");
    const mail = (await getDb()
      .prepare("SELECT kind, channel, body, subject FROM messages WHERE dedupe_key = ?")
      .get(`joined:${body.entry.id}`)) as { kind: string; channel: string; body: string; subject: string } | undefined;
    expect(mail?.kind).toBe("waitlist_joined");
    // By email only: a receipt of what they did, not news worth a WhatsApp message.
    expect(mail?.channel).toBe("email");
    expect(mail?.body).toContain(`/waitlist/leave/${body.leaveToken}`);
    expect(mail?.body).toContain(shortDate(date, "en", true));
    expect(mail?.subject).toContain("Leave Lane Courts");
  });

  it("nobody without an address gets an email; the joined screen's link is theirs", async () => {
    const date = day(4);
    await take(date, at(20));
    const res = await waitlistRoute.POST(req("http://localhost/api/waitlist", "POST", { courtId: hall, date, start: at(20), end: at(21), name: "Phone Only", phone: phone() }));
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.leaveToken).toBeTruthy();
    expect(await getDb().prepare("SELECT 1 FROM messages WHERE dedupe_key = ?").get(`joined:${body.entry.id}`)).toBeFalsy();
  });
});

describe("leaving by the link", () => {
  it("takes the entry off, and the place goes to the next person waiting", async () => {
    const date = day(5);
    const taken = await take(date, at(17));
    const first = await join(date, at(17), "First Waiting");
    const second = await join(date, at(17), "Second Waiting", "second@guest.test");
    // The court comes free: the first person is offered it.
    expect((await cancelBooking(taken.booking.code, taken.phone)).ok).toBe(true);
    expect((await row(first.entry.id)).status).toBe("offered");
    expect((await row(second.entry.id)).status).toBe("waiting");

    // The first leaves by their link (POST /api/waitlist/leave): the offer passes on at once.
    const res = await leaveRoute.POST(req("http://localhost/api/waitlist/leave", "POST", { token: first.leaveToken }));
    expect(res.status).toBe(200);
    expect((await row(first.entry.id)).status).toBe("cancelled");
    expect((await row(first.entry.id)).offer_token).toBeNull();
    expect((await row(second.entry.id)).status).toBe("offered");
    // No hold is left behind for the one who left.
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE waitlist_id = ? AND active").get(first.entry.id)) as { n: number }).n).toBe(0);
    // And the next person is told at once, by the leave itself (the outbox's sweep, run by the route).
    expect(await getDb().prepare("SELECT 1 FROM messages WHERE dedupe_key = ?").get(`offer:${(await row(second.entry.id)).offer_token}`)).toBeTruthy();
    expect(await notifyPendingOffers()).toEqual([]);
  });

  it("asked twice, or with a link that is not one, changes nothing and says so", async () => {
    const date = day(6);
    await take(date, at(16));
    const joined = await join(date, at(16));
    expect((await leaveWaitlistByToken(joined.leaveToken)).ok).toBe(true);
    const again = await leaveWaitlistByToken(joined.leaveToken);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("WAITLIST_NOT_FOUND");
    const unknown = await leaveRoute.POST(req("http://localhost/api/waitlist/leave", "POST", { token: "0".repeat(32) }));
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    expect((await unknown.json()).code).toBe("WAITLIST_NOT_FOUND");
  });

  it("the page reads what the entry waits for, never who joined", async () => {
    const date = day(7);
    await take(date, at(15));
    const joined = await join(date, at(15), "Private Name");
    const res = await leaveRoute.GET(req(`http://localhost/api/waitlist/leave?token=${joined.leaveToken}`, "GET"));
    expect(res.status).toBe(200);
    const { entry } = await res.json();
    expect(entry).toMatchObject({ what: "Hall 1", venueName: "Leave Lane Courts", date, startMin: at(15), endMin: at(16), waiting: true });
    expect(JSON.stringify(entry)).not.toContain("Private Name");
    expect(JSON.stringify(entry)).not.toContain(joined.entry.phone);
    // Opening the link changes nothing: only the button does.
    expect((await row(joined.entry.id)).status).toBe("waiting");
    expect((await leaveRoute.GET(req("http://localhost/api/waitlist/leave?token=nope", "GET"))).status).toBe(404);
  });

  it("works for a class's list too", async () => {
    const date = day(5);
    const made = await createClassSessions({ courtId: studio, name: "Circuit", instructor: "Coach", date, start: at(9), end: at(10), capacity: 1, price: 12 });
    if (!made.ok) throw new Error(made.error);
    const filled = await enrolPeople({ classId: made.classes[0].id, name: "Filler", phone: phone(), people: [null] });
    if (!filled.ok) throw new Error(filled.error);
    const res = await waitlistRoute.POST(req("http://localhost/api/waitlist", "POST", { classId: made.classes[0].id, name: "Class Guest", phone: phone() }));
    expect(res.status).toBe(201);
    const body = await res.json();
    const page = await (await leaveRoute.GET(req(`http://localhost/api/waitlist/leave?token=${body.leaveToken}`, "GET"))).json();
    expect(page.entry).toMatchObject({ what: "Circuit", date, startMin: at(9) });
    expect((await leaveWaitlistByToken(body.leaveToken)).ok).toBe(true);
    expect((await row(body.entry.id)).status).toBe("cancelled");
  });

  it("the account's way out, by entry and number, still works", async () => {
    const date = day(8);
    await take(date, at(14));
    const joined = await join(date, at(14));
    expect((await leaveWaitlist(joined.entry.id, joined.entry.phone)).ok).toBe(true);
    expect((await row(joined.entry.id)).status).toBe("cancelled");
  });
});

describe("turning an offer down", () => {
  it("passes the place to the next person at once, not when the offer would have run out", async () => {
    const date = day(9);
    const taken = await take(date, at(18));
    const first = await join(date, at(18), "Not Wanted");
    const second = await join(date, at(18), "Next In Line");
    expect((await cancelBooking(taken.booking.code, taken.phone)).ok).toBe(true);
    const offer = (await row(first.entry.id)).offer_token!;
    expect(offer).toBeTruthy();

    const res = await leaveRoute.POST(req("http://localhost/api/waitlist/leave", "POST", { offerToken: offer }));
    expect(res.status).toBe(200);
    expect((await row(first.entry.id)).status).toBe("cancelled");
    expect((await row(second.entry.id)).status).toBe("offered");
    // The declined offer cannot be claimed afterwards.
    const late = await claimWaitlistOffer(offer);
    expect(late.ok).toBe(false);
    // Nor turned down twice.
    const twice = await declineWaitlistOffer(offer);
    expect(twice.ok).toBe(false);
  });

  it("a claimed place cannot be turned down", async () => {
    const date = day(10);
    const taken = await take(date, at(12));
    const first = await join(date, at(12));
    expect((await cancelBooking(taken.booking.code, taken.phone)).ok).toBe(true);
    const offer = (await row(first.entry.id)).offer_token!;
    const claimed = await claimWaitlistOffer(offer);
    expect(claimed.ok).toBe(true);
    const declined = await declineWaitlistOffer(offer);
    expect(declined.ok).toBe(false);
    expect((await row(first.entry.id)).status).toBe("claimed");
    // Nor left by the link once claimed.
    const left = await leaveWaitlistByToken(first.leaveToken);
    expect(left.ok).toBe(false);
    if (!left.ok) expect(left.code).toBe("PLACE_ALREADY_CLAIMED");
  });

  it("a decline racing a claim: exactly one of them happens", async () => {
    const date = day(11);
    const taken = await take(date, at(10));
    const first = await join(date, at(10));
    await join(date, at(10), "Behind");
    expect((await cancelBooking(taken.booking.code, taken.phone)).ok).toBe(true);
    const offer = (await row(first.entry.id)).offer_token!;
    const [claimed, declined] = await Promise.all([claimWaitlistOffer(offer), declineWaitlistOffer(offer)]);
    expect([claimed.ok, declined.ok].filter(Boolean)).toHaveLength(1);
    const status = (await row(first.entry.id)).status;
    expect(status).toBe(claimed.ok ? "claimed" : "cancelled");
    // Never two bookings on the court at that time.
    const live = (await getDb()
      .prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE court_id = ? AND date = ? AND start_min = ? AND status = 'confirmed'")
      .get(hall, date, at(10))) as { n: number };
    expect(live.n).toBeLessThanOrEqual(1);
  });

  it("refuses a request naming neither link, or both", async () => {
    expect((await leaveRoute.POST(req("http://localhost/api/waitlist/leave", "POST", {}))).status).toBe(400);
    expect((await leaveRoute.POST(req("http://localhost/api/waitlist/leave", "POST", { token: "a", offerToken: "b" }))).status).toBe(400);
  });
});
