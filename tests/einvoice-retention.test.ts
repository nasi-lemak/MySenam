import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, type Admin } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { saveCoach } from "../src/lib/coaching";
import { sellAtCounter } from "../src/lib/counter-sales";
import { getDb } from "../src/lib/db";
import { creditReceipt, documentFor, issueReceipt, type Line } from "../src/lib/documents";
import { einvoiceRetention, recordEInvoiceRetentionReview, setEInvoiceRetention } from "../src/lib/einvoice-retention";
import { consolidate, listEInvoices, recheckEInvoice, requestEInvoice, retryEInvoice, saveEInvoiceSettings, submitPending } from "../src/lib/myinvois";
import { forgetTokens } from "../src/lib/myinvois/client";
import { eraseCustomer, exportCustomerData, pruneOldData, retentionDue } from "../src/lib/privacy";
import { policyEvents } from "../src/lib/retention-policy";
import { receiptToken } from "../src/lib/receipts";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as retentionRoute from "../src/app/api/admin/retention/route";

/**
 * The owner's decisions of 28 October 2026 on e-invoices
 * (docs/integrations/myinvois.md#names-in-what-is-sent;
 * docs/architecture/privacy.md#e-invoice-records), against a pretend
 * MyInvois:
 *
 * 1. No document sent from now on names a participant, a child or a coach
 *    in its lines, on any path (court hire with somebody else's places, a
 *    lesson, a class, a family membership, a counter sale, a large sale's
 *    own, the month's consolidated one); the buyer's own details stay.
 * 2. E-invoice records are kept for the install's statutory period
 *    (provisionally 7 years; shorter only with a recorded review); after it,
 *    the retention run clears a sent one to a tombstone through the
 *    trigger's one narrow exception, and deletes a draft never sent;
 *    nothing else may change a sent document.
 * 3. Account erasure removes the profile and keeps the e-invoice and the
 *    buyer details given; nothing copies those into the profile; the
 *    account's export lists them.
 *
 * On PGlite, and on Postgres with TEST_DATABASE_URL.
 */

const ZONE = "Asia/Kuala_Lumpur";
const thisMonth = todayISO(ZONE).slice(0, 7);

let venueId: number;
let courtId: number;
let coachId: number;
let owner: Admin;
let manager: Admin;
let n = 0;

const sent: { codeNumber: string; json: string }[] = [];

function fakeMyInvois() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body?: unknown } = {}) => {
      if (url.endsWith("/connect/token")) return Response.json({ access_token: "tok", expires_in: 3600 });
      if (url.endsWith("/api/v1.0/documentsubmissions/")) {
        const [d] = (JSON.parse(init.body as string) as { documents: { document: string; codeNumber: string }[] }).documents;
        sent.push({ codeNumber: d.codeNumber, json: Buffer.from(d.document, "base64").toString("utf8") });
        return Response.json({ submissionUid: `S-${d.codeNumber}`, acceptedDocuments: [{ uuid: `U-${d.codeNumber}`, invoiceCodeNumber: d.codeNumber }] }, { status: 202 });
      }
      const details = url.match(/\/documents\/([^/]+)\/details$/);
      if (details) return Response.json({ status: "Valid", longId: `LONG-${details[1]}` });
      return new Response("not found", { status: 404 });
    })
  );
}

const SETTINGS = {
  enabled: true,
  sandbox: true,
  mode: "own",
  clientId: "client-123",
  clientSecret: "secret-456",
  tin: "C1234567890",
  brn: "202001000001",
  msicCode: "93119",
  msicName: "Operation of sports facilities",
  legalName: "Retention Arena Sdn Bhd",
  addressLine: "1 Jalan Sukan",
  city: "Petaling Jaya",
  postcode: "46000",
  stateCode: "10",
  phone: "+60312345678",
  email: "finance@retention.my",
};

const BUYER = {
  name: "Syarikat Simpan Sdn Bhd",
  tin: "C2584563201",
  idType: "BRN",
  idNumber: "201901234568",
  email: "accounts@simpan.my",
  phone: "+60123456780",
  addressLine: "Lot 77, Jalan Perdana",
  city: "Kuala Lumpur",
  postcode: "50480",
  stateCode: "14",
};

/** Names that must never reach a line: a child on somebody else's places, a coach, a family's children, a typed-in name. */
const NAMES = ["Hana Iskandar", "Zulkifli Jurulatih", "Alya Rahman", "Bilal Rahman", "Siti Kaunter"];
const docOf = (code: string) => sent.filter((s) => s.codeNumber === code).at(-1)!.json;
const noNames = (json: string) => {
  for (const name of NAMES) expect(json).not.toContain(name);
  for (const part of ["Hana", "Zulkifli", "Alya", "Bilal", "Siti"]) expect(json).not.toContain(part);
};

async function ask(ref: string) {
  const asked = await requestEInvoice(ref, receiptToken(ref), BUYER);
  if (!asked.ok) throw new Error(asked.error);
  return asked.einvoice;
}

/** A booking paid in cash on the 10th of a month, with a child on one of its places. */
async function paidBooking(month: string, amount = 30, extra?: (bookingId: number) => Promise<void>) {
  const made = await createBooking({ courtId, date: addDays(todayISO(), 1 + (n % 10)), hours: [8 + (n % 12)], name: "Puan Iskandar", phone: `01277${String(++n).padStart(5, "0")}` });
  if (!made.ok) throw new Error(made.error);
  const db = getDb();
  await db
    .prepare("UPDATE bookings SET payment_status = 'paid', paid_via = 'cash', paid_at = ?, total_price = ? WHERE id = ?")
    .run(`${month}-10 04:00:00`, amount, made.booking.id);
  await db.prepare("INSERT INTO booking_participants (booking_id, takes_part_as, name) VALUES (?, 'customer', NULL), (?, 'participant', ?)").run(made.booking.id, made.booking.id, "Hana Iskandar");
  if (extra) await extra(made.booking.id);
  return made.booking;
}

async function account(tag: string) {
  const made = await registerUser({ name: `Puan Simpan ${tag}`, email: `ei8-${tag}-${++n}@retention.test`, phone: `01266${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user.id;
}

async function familyReceipt(userId: number | null) {
  const lines: Line[] = [{ description: "Family membership for {who}", amount: 120, who: ["Alya Rahman", "Bilal Rahman"] }];
  const doc = await issueReceipt({ source: `membership:ei8-${++n}`, venueId, userId, name: "Puan Rahman", lines, paidVia: "cash", taxable: false, issuedAt: `${thisMonth}-01 04:00:00` });
  if (!doc) throw new Error("receipt");
  return doc;
}

/** A row as one sent to LHDN this long ago would be: e_invoices takes inserts; the trigger guards updates and deletes. */
async function sentAgo(years: number, opts: { draft?: boolean } = {}) {
  const at = `-${years} years`;
  const code = `EI-OLD-${++n}`;
  const row = opts.draft
    ? ((await getDb()
        .prepare(
          `INSERT INTO e_invoices (venue_id, kind, type_code, code_number, receipt_ref, receipt_number, buyer, total, status, error, created_at)
           VALUES (?, 'individual', '01', ?, 'R0', 'R-0', ?, 50, 'failed', 'MyInvois could not be reached.', datetime('now', ?)) RETURNING id`
        )
        .get(venueId, code, JSON.stringify(BUYER), at)) as { id: number })
    : ((await getDb()
        .prepare(
          `INSERT INTO e_invoices (venue_id, kind, type_code, code_number, receipt_ref, receipt_number, buyer, total, status, error, document,
                                   submission_uid, uuid, long_id, created_at, submitted_at, checked_at, covers)
           VALUES (?, 'individual', '01', ?, 'R0', 'R-0', ?, 50, 'valid', NULL, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?), datetime('now', ?), NULL) RETURNING id`
        )
        .get(venueId, code, JSON.stringify(BUYER), `{"Invoice":[{"AccountingCustomerParty":"${BUYER.tin}"}]}`, `S-${code}`, `U-${code}`, `L-${code}`, at, at, at)) as {
        id: number;
      });
  return row.id;
}

const rowOf = async (id: number) =>
  (await getDb()
    .prepare(
      `SELECT venue_id, kind, type_code, code_number, period, receipt_ref, receipt_number, buyer, total::text AS total, document, submission_uid, uuid,
              long_id, status, error, refers_uuid, refers_code, created_at, submitted_at, checked_at, replaces_id, series_code, covers, cleared_at
         FROM e_invoices WHERE id = ?`
    )
    .get(id)) as Record<string, unknown> | undefined;

/** Run statements as the retention run would, in one transaction, with its permission. */
const asRetention = (fn: () => Promise<unknown>) =>
  getDb().transaction(async () => {
    await getDb().prepare("SELECT set_config('mysenam.einvoice_retention', 'on', true)").get();
    await fn();
  })();

const CLEAR = "UPDATE e_invoices SET cleared_at = datetime('now'), document = NULL, buyer = NULL, error = NULL WHERE id = ?";

const REVIEW = {
  reviewerName: "Aisha Rahman",
  reviewerRole: "Advocate & Solicitor, High Court of Malaya",
  firm: "Rahman & Co",
  reviewedOn: todayISO(),
  adviceReference: "Letter RC/2026/201",
  basis: "Income Tax Act 1967 s82 and LHDN's e-invoice guideline as they stood in October 2026.",
};

beforeAll(async () => {
  const made = await createVenue({ name: "Retention Arena", area: "PJ", address: "x", phone: "0377771299" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 30, peakRate: 30 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  const coach = await saveCoach(venueId, { name: "Zulkifli Jurulatih", sports: ["badminton"], rate: 80, hours: [] });
  if (!coach.ok) throw new Error(coach.error);
  coachId = coach.coach.id;
  const o = await createAdmin({ name: "Owner Ei8", email: "owner@ei8.test", password: "a long enough password", venueId: null });
  const m = await createAdmin({ name: "Manager Ei8", email: "manager@ei8.test", password: "a long enough password", venueId, role: "manager" });
  if (!o.ok || !m.ok) throw new Error("admins");
  owner = o.admin;
  manager = m.admin;
  forgetTokens();
  fakeMyInvois();
  expect((await saveEInvoiceSettings(venueId, SETTINGS)).ok).toBe(true);
  vi.unstubAllGlobals();
});

beforeEach(() => {
  forgetTokens();
  fakeMyInvois();
});
afterEach(() => vi.unstubAllGlobals());

describe("names never go to LHDN in an e-invoice's lines", () => {
  it("on every path: court hire with a child's place, a lesson, a class, a family membership, a counter sale", async () => {
    const hire = await paidBooking(thisMonth);
    const lesson = await paidBooking(thisMonth, 110, async (id) => {
      await getDb().prepare("UPDATE bookings SET coach_id = ?, coach_fee = 80 WHERE id = ?").run(coachId, id);
    });
    const klass = await paidBooking(thisMonth, 25, async (id) => {
      const c = (await getDb()
        .prepare("INSERT INTO classes (court_id, name, instructor, date, start_min, end_min, capacity, price) VALUES (?, 'Junior squad', 'Zulkifli Jurulatih', ?, 540, 600, 8, 25) RETURNING id")
        .get(courtId, addDays(todayISO(), 3))) as { id: number };
      await getDb().prepare("UPDATE bookings SET class_id = ? WHERE id = ?").run(c.id, id);
    });
    const membership = await familyReceipt(null);
    const sale = await sellAtCounter({ venueId, adminId: manager.id, items: [{ name: "Restring for Siti Kaunter", price: 35, quantity: 1 }], via: "cash", customerName: "Siti Kaunter" });
    if (!sale.ok) throw new Error(sale.error);
    const saleDoc = (await documentFor(`sale:${sale.sale.id}`))!;

    const cases: [string, string, string][] = [
      [hire.code, hire.code, "court hire"],
      [lesson.code, lesson.code, "coaching"],
      [klass.code, klass.code, "classes"],
      [membership.ref, membership.number, "memberships"],
      [saleDoc.ref, saleDoc.number, "counter sales"],
    ];
    for (const [ref, number, kind] of cases) {
      const e = await ask(ref);
      expect(e).toMatchObject({ status: "submitted", buyerName: BUYER.name });
      expect(e.sentLines).toEqual([{ description: `Receipt ${number}: ${kind}`, amount: expect.any(Number) }]);
      const json = docOf(e.codeNumber);
      noNames(json);
      // The buyer's own details are legally required, and stay: name, TIN, ID, address, contact.
      for (const v of [BUYER.name, BUYER.tin, BUYER.idNumber, BUYER.addressLine, BUYER.email, BUYER.phone]) expect(json).toContain(v);
      const stored = (await getDb().prepare("SELECT buyer FROM e_invoices WHERE id = ?").get(e.id)) as { buyer: string };
      expect(JSON.parse(stored.buyer)).toMatchObject({ name: BUYER.name, tin: BUYER.tin, idNumber: BUYER.idNumber, email: BUYER.email });
    }
  });

  it("in a large sale's own e-invoice and the month's consolidated one", async () => {
    const month = "2025-02";
    const big = await paidBooking(month, 12_000, async (id) => {
      await getDb().prepare("UPDATE bookings SET coach_id = ?, coach_fee = 500 WHERE id = ?").run(coachId, id);
    });
    await paidBooking(month, 40);
    const made = await consolidate(venueId, month);
    expect(made.map((e) => e.codeNumber).sort()).toEqual([`CON-${month}`, `EI-${big.code}`]);
    await submitPending(venueId);
    const large = docOf(`EI-${big.code}`);
    noNames(large);
    expect(large).toContain(`Receipt ${big.code}: coaching`);
    noNames(docOf(`CON-${month}`));
  });
});

describe("e-invoice records are kept for the statutory period, then cleared to a tombstone", () => {
  it("default 7 years, provisional; the retention run clears only what is past the period, and only payload, buyer and reasons", async () => {
    expect(await einvoiceRetention()).toMatchObject({ years: 7, floor: 7, bounds: [5, 20], provisional: true, review: null });
    const old = await sentAgo(8);
    const recent = await sentAgo(6);
    const oldDraft = await sentAgo(8, { draft: true });
    const recentDraft = await sentAgo(6, { draft: true });
    const before = await rowOf(old);
    const recentBefore = await rowOf(recent);

    const line = (await retentionDue()).find((l) => l.whatPhrase.key === "ei8.ret.einvoices")!;
    expect(line).toMatchObject({ years: 7, action: "anonymised", affected: 2 });

    await pruneOldData();
    const after = (await rowOf(old))!;
    expect(after).toMatchObject({ document: null, buyer: null, error: null, cleared_at: expect.any(String) });
    // What the books need stays exactly as it was.
    for (const k of Object.keys(before!).filter((k) => !["document", "buyer", "error", "cleared_at"].includes(k))) expect(after[k]).toEqual(before![k]);
    expect(await rowOf(recent)).toEqual(recentBefore);
    expect(await rowOf(oldDraft)).toBeUndefined();
    expect(await rowOf(recentDraft)).toBeDefined();
    expect((await retentionDue()).find((l) => l.whatPhrase.key === "ei8.ret.einvoices")!.affected).toBe(0);

    // The tombstone is shown as such, and nothing more is done with it.
    const shown = (await listEInvoices(venueId)).find((e) => e.id === old)!;
    expect(shown).toMatchObject({ clearedAt: expect.any(String), buyerName: null, sentLines: null, uuid: before!.uuid, longId: before!.long_id, actions: [] });
    expect(await recheckEInvoice(old, venueId)).toMatchObject({ ok: false });
    expect(await retryEInvoice(old, venueId)).toMatchObject({ ok: false });
  });

  it("the trigger's exception is narrow: only the retention run, only past the period, only those three columns, once", async () => {
    const db = getDb();
    const old = await sentAgo(9);
    const recent = await sentAgo(3);
    // Not the retention run: refused, whatever its age.
    await expect(db.prepare(CLEAR).run(old)).rejects.toThrow(/only the retention run/);
    // The retention run, but within the period.
    await expect(asRetention(() => db.prepare(CLEAR).run(recent))).rejects.toThrow(/statutory period/);
    // Past the period, but touching anything else, or leaving the buyer.
    await expect(asRetention(() => db.prepare(CLEAR.replace("error = NULL", "error = NULL, total = 1")).run(old))).rejects.toThrow(/nothing else/);
    await expect(asRetention(() => db.prepare(CLEAR.replace("buyer = NULL, ", "")).run(old))).rejects.toThrow(/nothing else/);
    await expect(asRetention(() => db.prepare(CLEAR.replace("error = NULL", "error = NULL, uuid = NULL")).run(old))).rejects.toThrow(/nothing else/);
    expect((await rowOf(old))!.cleared_at).toBeNull();
    // The exception itself.
    await asRetention(() => db.prepare(CLEAR).run(old));
    expect((await rowOf(old))!).toMatchObject({ document: null, buyer: null });
    // A tombstone is never filled in again, cleared again, un-cleared or deleted, even by the retention run.
    for (const sql of [
      "UPDATE e_invoices SET document = '{}' WHERE id = ?",
      "UPDATE e_invoices SET buyer = '{}' WHERE id = ?",
      "UPDATE e_invoices SET cleared_at = NULL WHERE id = ?",
      "UPDATE e_invoices SET cleared_at = datetime('now', '+1 day') WHERE id = ?",
      "UPDATE e_invoices SET error = 'x' WHERE id = ?",
      "DELETE FROM e_invoices WHERE id = ?",
    ]) {
      await expect(db.prepare(sql).run(old)).rejects.toThrow(/sent to LHDN/);
      await expect(asRetention(() => db.prepare(sql).run(old))).rejects.toThrow(/sent to LHDN/);
    }
    // A draft never sent is not a tombstone.
    const draft = await sentAgo(9, { draft: true });
    await expect(asRetention(() => db.prepare(CLEAR).run(draft))).rejects.toThrow(/only an e-invoice sent to LHDN/);
    // The permission ends with the transaction that took it.
    await asRetention(async () => undefined);
    await expect(db.prepare(CLEAR).run(recent)).rejects.toThrow(/only the retention run/);
  });

  it("the period: longer at any time, shorter than 7 years only with a recorded review; the trigger reads the same period", async () => {
    const db = getDb();
    const eight = await sentAgo(8);
    expect(await setEInvoiceRetention(manager, { years: 10 })).toMatchObject({ ok: false, status: 403 });
    expect(await setEInvoiceRetention(owner, { years: 21 })).toMatchObject({ ok: false, error: "E-invoice records are kept 5 to 20 years." });
    expect(await setEInvoiceRetention(owner, { years: 10 })).toMatchObject({ ok: true, retention: { years: 10, provisional: true, changedBy: owner.name } });
    // Eight years is now within the period: the run leaves it, and the trigger refuses it.
    await pruneOldData();
    expect((await rowOf(eight))!.cleared_at).toBeNull();
    await expect(asRetention(() => db.prepare(CLEAR).run(eight))).rejects.toThrow(/statutory period/);

    // Shorter than the floor: refused without a review, or with one missing its provenance.
    const six = await sentAgo(6);
    expect(await setEInvoiceRetention(owner, { years: 6 })).toMatchObject({ ok: false, error: expect.stringContaining("needs a recorded review") });
    expect(await setEInvoiceRetention(owner, { years: 6, review: { ...REVIEW, adviceReference: "" } })).toMatchObject({ ok: false, error: expect.stringContaining("written advice") });
    expect((await einvoiceRetention()).years).toBe(10);
    const shorter = await setEInvoiceRetention(owner, { years: 5, review: REVIEW });
    expect(shorter).toMatchObject({ ok: true, retention: { years: 5, provisional: false, review: { jurisdiction: "MY", reviewerName: REVIEW.reviewerName, firm: REVIEW.firm, recordedBy: owner.name } } });
    await pruneOldData();
    expect((await rowOf(six))!.cleared_at).not.toBeNull();
    expect((await rowOf(eight))!.cleared_at).not.toBeNull();

    // Any change lapses the review; a review may be recorded for the period as it stands.
    expect(await setEInvoiceRetention(owner, { years: 7 })).toMatchObject({ ok: true, retention: { years: 7, provisional: true, review: null } });
    expect(await recordEInvoiceRetentionReview(owner, { ...REVIEW, reviewedOn: addDays(todayISO(), -2) })).toMatchObject({ ok: false, error: expect.stringContaining("before the period was last changed") });
    expect(await recordEInvoiceRetentionReview(manager, REVIEW)).toMatchObject({ ok: false, status: 403 });
    expect(await recordEInvoiceRetentionReview(owner, REVIEW)).toMatchObject({ ok: true, retention: { years: 7, provisional: false } });
    const events = (await policyEvents()).filter((e) => e.detail.startsWith("E-invoice records"));
    expect(events.map((e) => e.kind)).toEqual(["reviewed", "changed", "lapsed", "reviewed", "changed", "changed"]);
    expect(events[0].detail).toContain("not verified by MySenam");
    const logged = (await db.prepare("SELECT action FROM staff_actions WHERE action LIKE 'einvoice.retention%' ORDER BY id").all()) as { action: string }[];
    expect(logged.map((l) => l.action)).toEqual(["einvoice.retention", "einvoice.retention", "einvoice.retention_reviewed", "einvoice.retention", "einvoice.retention_reviewed"]);

    // The owner's screen reads and sets it through the retention route; a manager is refused.
    const cookie = async (a: Admin) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(a.id)).token}`;
    const call = async (a: Admin, method: string, body?: unknown) =>
      (method === "GET" ? retentionRoute.GET : retentionRoute.POST)(
        new NextRequest("http://localhost/api/admin/retention", {
          method,
          headers: { cookie: await cookie(a), "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
      );
    const got = await call(owner, "GET");
    expect((await got.json()).einvoice).toMatchObject({ years: 7, provisional: false });
    expect((await call(manager, "POST", { action: "einvoice-years", years: 8 })).status).toBe(403);
    expect((await call(owner, "POST", { action: "einvoice-years", years: 4 })).status).toBe(400);
    const set = await call(owner, "POST", { action: "einvoice-years", years: 8 });
    expect(set.status).toBe(200);
    expect((await set.json()).einvoice).toMatchObject({ years: 8, provisional: true });
    expect((await call(owner, "POST", { action: "unknown" })).status).toBe(400);
  });
});

describe("the e-invoice and the customer's profile are kept apart", () => {
  it("asking for an e-invoice copies nothing into the profile; erasure removes the profile and keeps the e-invoice; the export lists it", async () => {
    const userId = await account("own");
    const profile = async () => getDb().prepare("SELECT name, email, phone, locale, gender FROM users WHERE id = ?").get(userId);
    const before = await profile();
    const receipt = await familyReceipt(userId);
    const e = await ask(receipt.ref);
    expect(await profile()).toEqual(before);
    const identities = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM user_identities WHERE user_id = ?").get(userId)) as { n: number };
    expect(identities.n).toBe(0);

    // A refund against it: the credit note is the customer's too.
    expect(await creditReceipt(receipt.source, "receipt.why.refunded")).not.toBeNull();
    const ccn = (await consolidate(venueId, thisMonth)).find((x) => x.refersCode === e.codeNumber)!;
    expect(ccn).toBeDefined();

    const exported = (await exportCustomerData(userId))!;
    expect(exported.einvoices).toHaveLength(2);
    expect(exported.einvoices[0]).toMatchObject({
      venue: "Retention Arena",
      number: e.codeNumber,
      receipt: receipt.number,
      kind: "your own e-invoice",
      status: "submitted",
      buyerDetailsGiven: { name: BUYER.name, tin: BUYER.tin, idNumber: BUYER.idNumber, email: BUYER.email, phone: BUYER.phone },
      linesSent: [{ description: `Receipt ${receipt.number}: memberships` }],
      keptBecause: expect.stringContaining("statutory period"),
    });
    expect(exported.einvoices[1]).toMatchObject({ number: ccn.codeNumber, kind: "credit note", corrects: e.codeNumber });
    // Another account's export does not list it.
    expect((await exportCustomerData(await account("other")))!.einvoices).toEqual([]);

    expect((await eraseCustomer(userId)).ok).toBe(true);
    expect(await profile()).toBeUndefined();
    const kept = (await getDb().prepare("SELECT buyer, document, cleared_at FROM e_invoices WHERE id = ?").get(e.id)) as { buyer: string; document: string; cleared_at: string | null };
    expect(JSON.parse(kept.buyer)).toMatchObject({ name: BUYER.name, tin: BUYER.tin });
    expect(kept.document).toContain(BUYER.tin);
    expect(kept.cleared_at).toBeNull();
    // The receipt it was for loses its customer's name, as any erasure does; the e-invoice never named the children.
    const r = (await getDb().prepare("SELECT customer_name, lines FROM receipts WHERE id = ?").get(receipt.id)) as { customer_name: string; lines: string };
    expect(r.customer_name).toBe("(removed)");
    expect(r.lines).not.toContain("Alya");
  });
});
