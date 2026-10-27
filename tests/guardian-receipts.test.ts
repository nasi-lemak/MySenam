import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { POST as book } from "../src/app/api/bookings/route";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { saveConcession } from "../src/lib/concessions";
import { getDb } from "../src/lib/db";
import { translator } from "../src/lib/i18n";
import { addManaged } from "../src/lib/managed-people";
import { notifyPaid, rememberLocale } from "../src/lib/notify";
import { messagesForBooking } from "../src/lib/outbox";
import { receiptFor, receiptLineText, receiptToken } from "../src/lib/receipts";
import { createResources } from "../src/lib/resources";
import { createVenue, findBookingByCode, setPaymentStatus } from "../src/lib/store";
import { addDays, dayOfWeek, todayISO } from "../src/lib/time";

/**
 * A guardian paying for two children (ADR 0023; docs/features/payments-and-credit.md#receipts-for-a-guardian):
 * the receipt and its email name which place is whose, the payer (the
 * account) is the purchaser, each child's own price is on their own line and
 * the lines add up; sent to the payer only; no birth year or anything else
 * about the children beyond their names; in the reader's language.
 */

let n = 0;
let pool: number;
let hall: number;
let child: number;
let date = addDays(todayISO(), 2);
while ([0, 6].includes(dayOfWeek(date))) date = addDays(date, 1);
const BORN = 2017;

async function guardian() {
  const phone = `0178${String(++n).padStart(6, "0")}`;
  const made = await registerUser({ name: `Puan Rohana ${n}`, email: `mum${n}@receipts.test`, phone, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  const kid = async (displayName: string) => {
    const k = await addManaged(made.user.id, { displayName, birthYear: BORN, relationship: "parent", authority: true }, made.user.name);
    if (!k.ok) throw new Error(k.error);
    return k.person.id;
  };
  return { ...made.user, phone, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}`, alya: await kid("Alya"), bilal: await kid("Bilal") };
}

async function booked(mum: Awaited<ReturnType<typeof guardian>>, courtId: number, hour: number, body: Record<string, unknown>) {
  const res = await book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: mum.cookie, "x-forwarded-for": `10.66.${n % 250}.${hour}` },
      body: JSON.stringify({ courtId, date, start: hour * 60, end: (hour + 1) * 60, name: mum.name, phone: mum.phone, email: mum.email, ...body }),
    })
  );
  const json = (await res.json()) as { booking: { id: number; code: string; totalPrice: number }; error?: string };
  expect(res.status, json.error).toBe(201);
  return json.booking;
}

/** Paid at the counter, the receipt emailed in `locale`, as staff marking it paid do. */
async function paid(code: string, locale: "en" | "ms" | "zh" | "ta") {
  const booking = (await findBookingByCode(code))!;
  await rememberLocale([booking.id], locale);
  expect((await setPaymentStatus(code, true, "cash")).ok).toBe(true);
  await notifyPaid([(await findBookingByCode(code))!], "counter");
  return { receipt: (await receiptFor(code, receiptToken(code)))!, mail: (await messagesForBooking(booking.id)).filter((m) => m.kind === "payment_received") };
}

beforeAll(async () => {
  const v = await createVenue({ name: "Kolam Keluarga", area: "Ampang", address: "x", phone: "0342221111" });
  if (!v.ok) throw new Error(v.error);
  const r = await createResources({ venueId: v.venue.id, sport: "swimming", name: "Pool", offPeakRate: 10, peakRate: 10, capacity: 8, maxPlayers: 8 });
  const h = await createResources({ venueId: v.venue.id, sport: "badminton", name: "Hall", offPeakRate: 20, peakRate: 20 });
  if (!r.ok || !h.ok) throw new Error("resources");
  pool = r.courts[0].id;
  hall = h.courts[0].id;
  const c = await saveConcession(v.venue.id, { name: "Child (under 12)", percent: 50, proof: "your child's MyKid", preset: "child", scope: "participant" });
  if (!c.ok) throw new Error(c.error);
  child = c.concession.id;
});

describe("one booking for two children", () => {
  it("names whose places they are, the payer as the purchaser, each child's own price on their line, and adds up", async () => {
    const mum = await guardian();
    const b = await booked(mum, pool, 9, { participantIds: [mum.alya, mum.bilal], placeConcessions: [{ participantId: mum.bilal, concessionId: child }] });
    // RM10 a place: Alya's in full, Bilal's at the child price.
    expect(b.totalPrice).toBe(15);
    const { receipt, mail } = await paid(b.code, "en");

    expect(receipt.customer).toBe(mum.name);
    const court = receipt.lines[0];
    expect(court.slot?.for).toEqual(["Alya", "Bilal"]);
    expect(receiptLineText(translator("en"), court)).toBe(`Pool (Swimming), ${date} 9:00 AM–10:00 AM, 2 players, for Alya, Bilal`);
    // The books keep the line as written.
    expect(court.description).toBe(`Pool (Swimming), ${date} 9:00 AM–10:00 AM, 2 players`);
    const bilals = receipt.lines.find((l) => l.place?.name === "Bilal")!;
    expect(bilals).toMatchObject({ amount: -5, place: { kind: "concession", name: "Bilal" } });
    expect(receipt.lines.some((l) => l.place?.name === "Alya")).toBe(false);
    expect(receipt.lines.reduce((sum, l) => sum + l.amount, 0)).toBe(receipt.total);
    expect(receipt.total).toBe(15);

    // Emailed to the payer only, naming whom it is for, with nothing else about the children.
    expect(mail.map((m) => m.recipient)).toEqual([mum.email]);
    expect(mail[0].body).toContain("for Alya, Bilal");
    for (const text of [mail[0].body, JSON.stringify(receipt)]) {
      expect(text).not.toContain(String(BORN));
      expect(text).not.toMatch(/birth/i);
    }
  });

  it("reads in the reader's language: the names as written, the hours and words theirs", async () => {
    const mum = await guardian();
    const b = await booked(mum, pool, 10, { participantIds: [mum.alya, mum.bilal] });
    const { receipt, mail } = await paid(b.code, "ms");
    const court = receipt.lines[0];
    const ms = receiptLineText(translator("ms"), court);
    expect(ms).toContain(`${date}, 10:00 PG–11:00 PG, 2 pemain, untuk Alya, Bilal`);
    expect(receiptLineText(translator("zh"), court)).toContain(`${date} 上午10:00–上午11:00，2 人（为 Alya, Bilal）`);
    expect(receiptLineText(translator("ta"), court)).toContain(`${date} அன்று 10:00–11:00, 2 பேர், Alya, Bilal க்காக`);
    // The Malay receipt email: whom it is for, the hours the Malay way, the receipt opening in Malay.
    expect(mail[0].locale).toBe("ms");
    expect(mail[0].body).toContain("untuk Alya, Bilal");
    expect(mail[0].body).toContain("10:00 PG");
    expect(mail[0].body).not.toMatch(/\d:\d\d (AM|PM)/);
    expect(mail[0].body).toMatch(/\/receipt\/[^?\s]+\?t=[0-9a-f]+&lang=ms\b/);
  });
});

describe("a booking each", () => {
  it("each receipt names its own child, never the other", async () => {
    const mum = await guardian();
    const forAlya = await booked(mum, hall, 14, { participantIds: [mum.alya] });
    const forBilal = await booked(mum, hall, 15, { participantIds: [mum.bilal] });
    const a = (await paid(forAlya.code, "en")).receipt;
    const b = (await paid(forBilal.code, "en")).receipt;
    expect(receiptLineText(translator("en"), a.lines[0])).toBe(`Hall (Badminton), ${date} 2:00 PM–3:00 PM, for Alya`);
    expect(receiptLineText(translator("en"), b.lines[0])).toBe(`Hall (Badminton), ${date} 3:00 PM–4:00 PM, for Bilal`);
    expect(JSON.stringify(a)).not.toContain("Bilal");
    expect(JSON.stringify(b)).not.toContain("Alya");
    expect([a.customer, b.customer]).toEqual([mum.name, mum.name]);
  });

  it("an adult's own booking reads as it always did, naming nobody", async () => {
    const mum = await guardian();
    const own = await booked(mum, hall, 16, {});
    const { receipt } = await paid(own.code, "en");
    expect(receipt.lines[0].slot?.for).toEqual([]);
    expect(receiptLineText(translator("en"), receipt.lines[0])).toBe(receipt.lines[0].description);
  });
});
