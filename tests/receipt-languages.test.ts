import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

// The customer's language, as the switch in the header sets it.
let cookieLang: string | undefined;
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: (name: string) => (name === "ms_lang" && cookieLang ? { value: cookieLang } : undefined) }),
}));

import { NextRequest } from "next/server";
import { journalCsv } from "../src/lib/accounting";
import { applyConcession, saveConcession } from "../src/lib/concessions";
import { getDb } from "../src/lib/db";
import { documentFor } from "../src/lib/documents";
import { bookingsCsv } from "../src/lib/export";
import { DICTIONARIES, translateError, translator, type Phrase } from "../src/lib/i18n";
import { serverT } from "../src/lib/locale";
import { receiptFor, receiptLineText, receiptToken } from "../src/lib/receipts";
import { adminCancelBooking, createBooking, createCourt, createVenue, setPaymentStatus } from "../src/lib/store";
import { addDays, dayOfWeek, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { addManaged } from "../src/lib/managed-people";
import { createPlan } from "../src/lib/membership-plans";
import { createResources } from "../src/lib/resources";
import { sellMembership } from "../src/lib/store";

/**
 * A built-in concession (student, senior, child, OKU) on a receipt and in
 * the refusal that names it reads in the customer's language; the venue's
 * own words, the amounts and the books stay exactly as written.
 */

let venueId: number;
let courtId: number;
let student: number; // saved by staff reading Malay: "Pelajar", kept by its key
let typed: number; // the venue's own: "Senior (65+)"
let n = 0;
const phone = () => `0177000${String(++n).padStart(3, "0")}`;
const open = (ref: string) => receiptFor(ref, receiptToken(ref));

/** The next weekday from tomorrow: 9 AM off-peak, 7 PM peak. */
let date = addDays(todayISO(), 1);
while ([0, 6].includes(dayOfWeek(date))) date = addDays(date, 1);

/** A paid booking at this concession, and its concession line. */
async function paidAt(concessionId: number, hour: number) {
  const made = await createBooking({ courtId, date, hours: [hour], name: "Kavitha", phone: phone() });
  if (!made.ok) throw new Error(made.error);
  const applied = await applyConcession(made.booking.id, concessionId);
  if (!applied.ok) throw new Error(applied.error);
  expect((await setPaymentStatus(made.booking.code, true, "cash")).ok).toBe(true);
  const receipt = (await open(made.booking.code))!;
  return { booking: made.booking, receipt, line: receipt.lines.find((l) => l.amount < 0)! };
}

beforeAll(async () => {
  const made = await createVenue({ name: "Dewan Bahasa", area: "Brickfields", address: "x", phone: "0322223333" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const c = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 30 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  const s = await saveConcession(venueId, { name: "Pelajar", percent: 50, proof: "kad pelajar anda", preset: "student", offPeakOnly: true });
  const o = await saveConcession(venueId, { name: "Senior (65+)", percent: 25, proof: "your IC", preset: "senior", offPeakOnly: true });
  if (!s.ok || !o.ok) throw new Error("concessions");
  expect(s.concession.preset).toBe("student");
  expect(o.concession.preset).toBeNull();
  student = s.concession.id;
  typed = o.concession.id;
});

afterEach(() => {
  cookieLang = undefined;
  delete process.env.MYSENAM_COUNTRY;
});

describe("a booking's receipt with a built-in concession", () => {
  it("names it in each customer's language, from its key; the line itself and the money are as written", async () => {
    const { receipt, line } = await paidAt(student, 9);
    expect(line).toEqual({ description: "Pelajar price", amount: -10, concessionPreset: "student" });
    expect(receipt.total).toBe(10);
    expect(receiptLineText(translator("en"), line)).toBe("Student price");
    expect(receiptLineText(translator("ms"), line)).toBe("Harga Pelajar");
    expect(receiptLineText(translator("zh"), line)).toBe("学生优惠价");
    expect(receiptLineText(translator("ta"), line)).toBe("மாணவர் விலை");
    // The court line, written by MySenam, is unchanged in every language.
    for (const locale of ["en", "ms", "zh", "ta"] as const) expect(receiptLineText(translator(locale), receipt.lines[0])).toBe(receipt.lines[0].description);
  });

  it("reads in the language the customer chose (Tamil), and in the install's own where that language is not offered", async () => {
    const { line } = await paidAt(student, 10);
    cookieLang = "ta";
    expect(receiptLineText(await serverT(), line)).toBe("மாணவர் விலை");
    // Singapore offers English, Chinese and Tamil: a Malay cookie reads in English.
    process.env.MYSENAM_COUNTRY = "SG";
    cookieLang = "ms";
    expect((await serverT()).locale).toBe("en");
    expect(receiptLineText(await serverT(), line)).toBe("Student price");
  });

  it("with no words for it in a language, says the line as written", async () => {
    const { line } = await paidAt(student, 11);
    const ta = DICTIONARIES.ta as Record<Phrase, string>;
    for (const key of ["rcpt.concessionPrice", "pre.con.student"] as Phrase[]) {
      const kept = ta[key];
      delete (ta as Partial<Record<Phrase, string>>)[key];
      try {
        expect(receiptLineText(translator("ta"), line)).toBe("Pelajar price");
      } finally {
        ta[key] = kept;
      }
    }
    // A key this build does not know is shown as written too.
    expect(receiptLineText(translator("ms"), { description: "Veteran price", concessionPreset: "veteran" as never })).toBe("Veteran price");
  });

  it("leaves one the venue named itself as typed, in every language", async () => {
    const { line } = await paidAt(typed, 12);
    expect(line).toEqual({ description: "Senior (65+) price", amount: -5 });
    for (const locale of ["en", "ms", "zh", "ta"] as const) expect(receiptLineText(translator(locale), line)).toBe("Senior (65+) price");
  });
});

describe("receipts from before the key was kept", () => {
  it("a booking whose concession is still the built-in one, word for word, reads in the customer's language", async () => {
    const { booking } = await paidAt(student, 13);
    // As a booking made before migration 0122 kept the key.
    await getDb().prepare("UPDATE bookings SET concession_preset = NULL WHERE id = ?").run(booking.id);
    const line = (await open(booking.code))!.lines.find((l) => l.amount < 0)!;
    expect(line.concessionPreset).toBe("student");
    expect(receiptLineText(translator("ms"), line)).toBe("Harga Pelajar");
  });

  it("one whose concession has since been renamed, or was the venue's own, stays as stored", async () => {
    const own = await saveConcession(venueId, { name: "Student", percent: 50, proof: "your matric card" });
    if (!own.ok) throw new Error(own.error);
    expect(own.concession.preset).toBeNull();
    const { booking } = await paidAt(own.concession.id, 14);
    await getDb().prepare("UPDATE bookings SET concession_preset = NULL WHERE id = ?").run(booking.id);
    // Its words are the preset's name, but its proof is the venue's own: not the built-in one.
    expect((await open(booking.code))!.lines.find((l) => l.amount < 0)!.concessionPreset).toBeUndefined();

    const renamed = await paidAt(student, 15);
    await getDb().prepare("UPDATE bookings SET concession_preset = NULL WHERE id = ?").run(renamed.booking.id);
    await getDb().prepare("UPDATE concessions SET name = 'Pelajar IPT', preset = NULL WHERE id = ?").run(student);
    try {
      const line = (await open(renamed.booking.code))!.lines.find((l) => l.amount < 0)!;
      expect(line).toEqual({ description: "Pelajar price", amount: -10 });
    } finally {
      await getDb().prepare("UPDATE concessions SET name = 'Pelajar', preset = 'student' WHERE id = ?").run(student);
    }
  });

  it("a credit note written without the key gets it from its booking, with its amounts and number untouched", async () => {
    const { booking } = await paidAt(student, 16);
    await adminCancelBooking(booking.code);
    const credit = (await documentFor(`booking:${booking.id}`))!;
    expect(credit.lines.find((l) => l.amount < 0)).toMatchObject({ description: "Pelajar price", concessionPreset: "student" });
    // As one written before lines kept the key.
    const bare = credit.lines.map(({ concessionPreset: _drop, ...rest }) => rest);
    await getDb().prepare("UPDATE receipts SET lines = ? WHERE id = ?").run(JSON.stringify(bare), credit.id);
    const shown = (await open(credit.ref))!;
    expect(shown).toMatchObject({ kind: "credit_note", number: credit.number, total: credit.total });
    const line = shown.lines.find((l) => l.amount < 0)!;
    expect(line).toEqual({ description: "Pelajar price", amount: -10, concessionPreset: "student" });
    expect(receiptLineText(translator("zh"), line)).toBe("学生优惠价");
    // What is stored is as it was: nothing rewritten to change a label.
    expect((await documentFor(`booking:${booking.id}`))!.lines).toEqual(bare);
  });

  it("a credit note for the venue's own concession stays as stored", async () => {
    const { booking } = await paidAt(typed, 17);
    await adminCancelBooking(booking.code);
    const credit = (await documentFor(`booking:${booking.id}`))!;
    const line = (await open(credit.ref))!.lines.find((l) => l.amount < 0)!;
    expect(line).toEqual({ description: "Senior (65+) price", amount: -5 });
  });
});

describe("the books", () => {
  it("export the same whatever language the reader has, with the lines as written", async () => {
    const from = addDays(todayISO(), -1);
    const to = addDays(todayISO(), 1);
    const read = async () => ({ journal: await journalCsv(venueId, from, to), bookings: await bookingsCsv(venueId, date, date) });
    cookieLang = "en";
    const english = await read();
    cookieLang = "zh";
    expect(await read()).toEqual(english);
    for (const word of ["Harga", "学生", "மாணவர்"]) {
      expect(english.journal).not.toContain(word);
      expect(english.bookings).not.toContain(word);
    }
    // The credit notes are in the journal at what they were written for.
    const credits = (await getDb().prepare("SELECT number, total::float AS total FROM receipts WHERE venue_id = ? AND kind = 'credit_note'").all(venueId)) as {
      number: string;
      total: number;
    }[];
    expect(credits.length).toBeGreaterThan(0);
    for (const c of credits) expect(english.journal).toContain(c.number);
  });
});

describe("the off-peak refusal", () => {
  const post = async (concessionId: number, hour: number) => {
    const res = await book(
      new NextRequest("http://localhost/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ courtId, date, name: "Arun", phone: phone(), hours: [hour], concessionId }),
      })
    );
    return (await res.json()).concessionError;
  };

  it("names a built-in concession in each customer's language, by its key", async () => {
    const err = await post(student, 19);
    expect(err).toMatchObject({ code: "CONCESSION_OFF_PEAK", vars: { name: "Student", nameKey: "pre.con.student" } });
    // English, whatever language staff saved it in.
    expect(translateError(translator("en"), err)).toBe("The Student price is for off-peak hours only.");
    expect(translateError(translator("ms"), err)).toBe("Harga Pelajar hanya untuk waktu luar puncak.");
    expect(translateError(translator("zh"), err)).toBe("学生优惠价仅限非高峰时段。");
    expect(translateError(translator("ta"), err)).toBe("மாணவர் விலை நெரிசல் இல்லாத நேரங்களுக்கு மட்டுமே.");
  });

  it("names the venue's own as typed", async () => {
    const err = await post(typed, 20);
    expect(err).toMatchObject({ code: "CONCESSION_OFF_PEAK", vars: { name: "Senior (65+)" } });
    expect(err.vars.nameKey).toBeUndefined();
    expect(translateError(translator("ms"), err)).toBe("Harga Senior (65+) hanya untuk waktu luar puncak.");
  });
});

describe("one person's own price on their place", () => {
  /**
   * A guardian's booking of three children's places on a pool sold by the
   * place: Alya's at her own membership's price, Badrul's at the built-in
   * child price, Chen's at a concession the venue named itself
   * (lib/entitlements.ts). Each line names whose place it was.
   */
  let placeVenue: number;
  let pool: number;
  let child: number; // built-in, for one person's place
  let squad: number; // the venue's own words, for one person's place

  async function placesBooked(hour: number) {
    const ph = phone();
    const made = await registerUser({ name: `Mak ${n}`, email: `fin5-${n}@receipts.test`, phone: ph, password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
    const cookie = `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}`;
    const kid = async (displayName: string) => {
      const k = await addManaged(made.user.id, { displayName, relationship: "parent", authority: true }, made.user.name);
      if (!k.ok) throw new Error(k.error);
      return k.person.id;
    };
    const [alya, badrul, chen] = [await kid("Alya"), await kid("Badrul"), await kid("Chen")];
    const plan = await createPlan(placeVenue, { name: `Swim member ${n}`, months: 12, price: 50, ratePercent: 50, scope: "participant" });
    if (!plan.ok) throw new Error(plan.error);
    const sold = await sellMembership({
      venueId: placeVenue,
      holderName: made.user.name,
      holderPhone: ph,
      userId: made.user.id,
      startsOn: todayISO(),
      expiresOn: addDays(todayISO(), 60),
      price: 50,
      holderParticipantId: alya,
      tierId: plan.plan.id,
    });
    if (!sold.ok) throw new Error(sold.error);
    const res = await book(
      new NextRequest("http://localhost/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, "x-forwarded-for": `10.55.${n % 250}.${hour}` },
        body: JSON.stringify({
          courtId: pool,
          date,
          start: hour * 60,
          end: (hour + 1) * 60,
          name: made.user.name,
          phone: ph,
          participantIds: [alya, badrul, chen],
          placeConcessions: [
            { participantId: badrul, concessionId: child },
            { participantId: chen, concessionId: squad },
          ],
        }),
      })
    );
    const body = (await res.json()) as { booking: { id: number; code: string; totalPrice: number } };
    expect(res.status).toBe(201);
    // RM10 a place: Alya's at half, Badrul's at half, Chen's 20% off.
    expect(body.booking.totalPrice).toBe(5 + 5 + 8);
    expect((await setPaymentStatus(body.booking.code, true, "cash")).ok).toBe(true);
    return body.booking;
  }

  beforeAll(async () => {
    const v = await createVenue({ name: "Kolam Bahasa", area: "Brickfields", address: "x", phone: "0322224444" });
    if (!v.ok) throw new Error("venue");
    placeVenue = v.venue.id;
    const r = await createResources({ venueId: placeVenue, sport: "swimming", name: "Pool", offPeakRate: 10, peakRate: 10, capacity: 8, maxPlayers: 8 });
    if (!r.ok) throw new Error(r.error);
    pool = r.courts[0].id;
    const c = await saveConcession(placeVenue, { name: "Child (under 12)", percent: 50, proof: "your child's MyKid or birth certificate", preset: "child", scope: "participant" });
    const s = await saveConcession(placeVenue, { name: "Junior squad", percent: 20, proof: "your squad card", scope: "participant" });
    if (!c.ok || !s.ok) throw new Error("concessions");
    expect(c.concession.preset).toBe("child");
    child = c.concession.id;
    squad = s.concession.id;
  });

  it("reads in each customer's language with the person's name; the line as written, the venue's own words and the money unchanged", async () => {
    const booking = await placesBooked(9);
    const receipt = (await open(booking.code))!;
    const member = receipt.lines.find((l) => l.place?.kind === "membership")!;
    const kids = receipt.lines.find((l) => l.concessionPreset === "child")!;
    const own = receipt.lines.find((l) => l.place?.kind === "concession" && !l.concessionPreset)!;
    expect(member).toEqual({ description: "Member price, Alya", amount: -5, place: { kind: "membership", name: "Alya" } });
    expect(kids).toEqual({ description: "Child (under 12) price, Badrul", amount: -5, concessionPreset: "child", place: { kind: "concession", name: "Badrul" } });
    expect(own).toEqual({ description: "Junior squad price, Chen", amount: -2, place: { kind: "concession", name: "Chen" } });
    expect(receipt.total).toBe(18);

    const read = (locale: "en" | "ms" | "zh" | "ta") => [member, kids, own].map((l) => receiptLineText(translator(locale), l));
    expect(read("en")).toEqual(["Member price, Alya", "Child (under 12) price, Badrul", "Junior squad price, Chen"]);
    expect(read("ms")).toEqual(["Harga ahli, Alya", "Harga Kanak-kanak (bawah 12), Badrul", "Junior squad price, Chen"]);
    expect(read("zh")).toEqual(["会员价（Alya）", "儿童（12岁以下）优惠价（Badrul）", "Junior squad price, Chen"]);
    expect(read("ta")).toEqual(["உறுப்பினர் விலை, Alya", "குழந்தை (12 வயதுக்குட்பட்டோர்) விலை, Badrul", "Junior squad price, Chen"]);

    // The customer's own place (no name on it) says the price alone.
    expect(receiptLineText(translator("ms"), { description: "Member price", place: { kind: "membership", name: null } })).toBe("Harga ahli");
    // A language with no words for it says the line as written.
    const ms = DICTIONARIES.ms as Record<Phrase, string>;
    for (const key of ["fin5.memberPrice", "fin5.placeFor"] as Phrase[]) {
      const kept = ms[key];
      delete (ms as Partial<Record<Phrase, string>>)[key];
      try {
        expect(receiptLineText(translator("ms"), member)).toBe("Member price, Alya");
      } finally {
        ms[key] = kept;
      }
    }
  });

  it("a credit note keeps whose place it was and reads the same; one written before lines kept it stays as stored", async () => {
    const booking = await placesBooked(10);
    await adminCancelBooking(booking.code);
    const credit = (await documentFor(`booking:${booking.id}`))!;
    const shown = (await open(credit.ref))!;
    expect(receiptLineText(translator("zh"), shown.lines.find((l) => l.concessionPreset === "child")!)).toBe("儿童（12岁以下）优惠价（Badrul）");
    expect(receiptLineText(translator("ta"), shown.lines.find((l) => l.place?.kind === "membership")!)).toBe("உறுப்பினர் விலை, Alya");

    // As one written before lines kept it: no key and no place. It is shown, and stays, as stored.
    const bare = credit.lines.map(({ concessionPreset: _k, place: _p, ...rest }) => rest);
    await getDb().prepare("UPDATE receipts SET lines = ? WHERE id = ?").run(JSON.stringify(bare), credit.id);
    const old = (await open(credit.ref))!;
    expect(old).toMatchObject({ number: credit.number, total: credit.total });
    for (const locale of ["ms", "zh", "ta"] as const)
      expect(old.lines.filter((l) => l.amount < 0).map((l) => receiptLineText(translator(locale), l))).toEqual([
        "Member price, Alya",
        "Child (under 12) price, Badrul",
        "Junior squad price, Chen",
      ]);
    expect((await documentFor(`booking:${booking.id}`))!.lines).toEqual(bare);
  });
});
