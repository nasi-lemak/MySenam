import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { forgiveStrikes, setCancelPolicy, strikesFor } from "../src/lib/cancel-policy";
import { saveCoach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { setHouseRules } from "../src/lib/house-rules";
import { createBooking, createCourt, createVenue, searchAvailability } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { pendingVoucher, activateVoucher, sendVoucher } from "../src/lib/vouchers";
import { GET as lookup, POST as book } from "../src/app/api/bookings/route";
import { POST as cancelRoute } from "../src/app/api/bookings/cancel/route";

/**
 * The ends tied off after the last round: a forgiven number, search that
 * follows each venue's window, messages that say what happened to the money
 * and who is coaching, and vouchers emailed in the language they were bought in.
 */

let venueId: number;
let courtId: number;
let n = 0;

const post = (body: Record<string, unknown>) =>
  book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.${++n}` },
      body: JSON.stringify({ name: "Customer", email: `c${n}@example.my`, phone: `01288800${String(n).padStart(2, "0")}`, ...body }),
    })
  );

const messagesFor = async (bookingId: number) =>
  (await getDb().prepare("SELECT kind, body FROM messages WHERE booking_id = ? ORDER BY id").all(bookingId)) as { kind: string; body: string }[];

beforeAll(async () => {
  const made = await createVenue({ name: "Ends Arena", area: "Cheras", address: "x", phone: "0391110000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(venueId);
  const court = await createCourt({ venueId, name: "Court 1", sport: "tennis", offPeakRate: 20, peakRate: 20 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
});

describe("strikes", () => {
  it("stop counting once the venue forgives them", async () => {
    await setCancelPolicy(venueId, { strikeLimit: 2, strikeDays: 90 });
    const made = await createBooking({ courtId, date: addDays(todayISO(), 1), hours: [8], name: "Late", phone: "0128880999" });
    if (!made.ok) throw new Error(made.error);
    await getDb().prepare("UPDATE bookings SET no_show = 1, date = ? WHERE id = ?").run(addDays(todayISO(), -3), made.booking.id);
    expect(await strikesFor(venueId, "0128880999")).toBe(1);
    await forgiveStrikes(venueId, "+60 12-888 0999", null);
    expect(await strikesFor(venueId, "0128880999")).toBe(0);
    await setCancelPolicy(venueId, {});
  });
});

describe("search", () => {
  it("offers a venue only on days inside its own window, up to 90", async () => {
    const day = addDays(todayISO(), 20);
    const search = () => searchAvailability({ sport: "tennis", date: day, venueIds: [venueId] });
    expect(await search()).toEqual([]);
    await setHouseRules(venueId, { aheadDays: 30 });
    expect((await search()).length).toBeGreaterThan(0);
  });
});

describe("messages", () => {
  it("name the coach on a lesson's confirmation", async () => {
    const saved = await saveCoach(venueId, {
      name: "Ana Lim", sports: ["tennis"], rate: 50, hours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: 8 * 60, until: 20 * 60 })),
    });
    if (!saved.ok) throw new Error(saved.error);
    const res = await post({ venueId, sport: "tennis", date: addDays(todayISO(), 3), hours: [10], coachId: saved.coach.id });
    const { booking } = await res.json();
    const [confirmed] = await messagesFor(booking.id);
    expect(confirmed.body).toContain("Court 1, lesson with Ana Lim");
  });

  it("say what a late cancellation kept, and that nothing is owed otherwise", async () => {
    const free = await (await post({ courtId, date: addDays(todayISO(), 5), hours: [11] })).json();
    await cancelRoute(new NextRequest("http://localhost/api/bookings/cancel", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: free.booking.code, phone: free.booking.phone }),
    }));
    expect((await messagesFor(free.booking.id)).find((m) => m.kind === "booking_cancelled")!.body).toContain("Nothing is owed for it.");

    await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 72 WHERE id = ?").run(venueId);
    await setCancelPolicy(venueId, { lateKeep: 50 });
    const late = await (await post({ courtId, date: addDays(todayISO(), 1), hours: [12] })).json();
    await getDb().prepare("UPDATE bookings SET payment_status = 'paid', paid_via = 'cash' WHERE id = ?").run(late.booking.id);
    await cancelRoute(new NextRequest("http://localhost/api/bookings/cancel", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: late.booking.code, phone: late.booking.phone }),
    }));
    expect((await messagesFor(late.booking.id)).find((m) => m.kind === "booking_cancelled")!.body).toContain("The venue kept RM10 as its late-cancellation fee.");
  });

  it("send a gift voucher in the language it was bought in", async () => {
    const made = await pendingVoucher({ venueId, amount: 20, buyerName: "Siti", buyerEmail: "siti.ms@example.my", locale: "ms" });
    if (!made.ok) throw new Error(made.error);
    const v = (await activateVoucher(made.voucher.id, "Online"))!;
    expect(v.locale).toBe("ms");
    await sendVoucher(v);
    const sent = (await getDb().prepare("SELECT locale, subject FROM messages WHERE kind = 'gift_voucher' AND recipient = ?").get("siti.ms@example.my")) as {
      locale: string;
      subject: string;
    };
    expect(sent.locale).toBe("ms");
    expect(sent.subject).toContain("Baucar hadiah");
  });
});

describe("moving a booking", () => {
  it("can go as far as the venue's window", async () => {
    const { booking } = await (await post({ courtId, date: addDays(todayISO(), 4), hours: [9] })).json();
    const res = await lookup(new NextRequest(`http://localhost/api/bookings?code=${booking.code}&phone=${booking.phone}`));
    expect((await res.json()).venue.lastDate).toBe(addDays(todayISO(), 30));
  });
});
