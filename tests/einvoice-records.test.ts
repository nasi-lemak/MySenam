import crypto from "crypto";
import fs from "fs";
import path from "path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { creditBooking, creditReceipt, issueReceipt, type Line } from "../src/lib/documents";
import {
  checkSubmitted,
  consolidate,
  einvoiceForReceipt,
  listEInvoices,
  recheckEInvoice,
  requestEInvoice,
  retryEInvoice,
  saveEInvoiceSettings,
  submitPending,
  type EInvoice,
} from "../src/lib/myinvois";
import { forgetTokens } from "../src/lib/myinvois/client";
import { eraseCustomer, pruneOldData } from "../src/lib/privacy";
import { receiptToken } from "../src/lib/receipts";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { staleDrafts } from "../src/lib/drafts";
import * as einvoicing from "../src/app/api/admin/einvoicing/route";
import ReceiptPage from "../src/app/receipt/[code]/page";

/**
 * What happens to an e-invoice once it has reached LHDN, and to one that has
 * not (docs/integrations/myinvois.md#states-and-what-never-changes), against
 * a pretend MyInvois: a document sent keeps what it said and LHDN's
 * identifiers whatever happens afterwards (names cleared, retention, an
 * erasure, a refund, a retry, a check, new settings, straight SQL); a
 * correction is a new document linked to the one it replaces; a draft
 * follows its receipt until it is sent; the staff screen is offered only
 * what the server does. On PGlite, and on Postgres with TEST_DATABASE_URL.
 */

const ZONE = "Asia/Kuala_Lumpur";
const thisMonth = todayISO(ZONE).slice(0, 7);

let venueId: number;
let courtId: number;
let n = 0;

// ---------------------------------------------------------------- a pretend MyInvois

interface Sent {
  codeNumber: string;
  json: string;
}
const sent: Sent[] = [];
/** What LHDN says of each document by UUID; Valid unless set. */
const verdicts = new Map<string, "Valid" | "Invalid" | "Submitted" | "Cancelled">();
let rejectNext: string | null = null;
let downNext = false;

function fakeMyInvois() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body?: unknown } = {}) => {
      if (url.endsWith("/connect/token")) return Response.json({ access_token: "tok", expires_in: 3600 });
      if (url.endsWith("/api/v1.0/documentsubmissions/")) {
        if (downNext) {
          downNext = false;
          throw new Error("connect ECONNREFUSED");
        }
        const [d] = (JSON.parse(init.body as string) as { documents: { document: string; codeNumber: string }[] }).documents;
        const json = Buffer.from(d.document, "base64").toString("utf8");
        sent.push({ codeNumber: d.codeNumber, json });
        if (rejectNext) {
          const why = rejectNext;
          rejectNext = null;
          return Response.json(
            {
              submissionUid: `SR-${d.codeNumber}`,
              acceptedDocuments: [],
              rejectedDocuments: [{ invoiceCodeNumber: d.codeNumber, error: { message: "Validation error", details: [{ message: why }, { message: "Second reason" }] } }],
            },
            { status: 202 }
          );
        }
        return Response.json({ submissionUid: `S-${d.codeNumber}`, acceptedDocuments: [{ uuid: `U-${d.codeNumber}`, invoiceCodeNumber: d.codeNumber }] }, { status: 202 });
      }
      const details = url.match(/\/documents\/([^/]+)\/details$/);
      if (details) {
        const status = verdicts.get(decodeURIComponent(details[1])) ?? "Valid";
        if (status === "Invalid")
          return Response.json({
            status,
            validationResults: { validationSteps: [{ status: "Invalid", error: { innerError: [{ error: "Supplier TIN does not match" }] } }] },
          });
        return Response.json({ status, longId: status === "Valid" || status === "Cancelled" ? `LONG-${details[1]}` : null });
      }
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
  legalName: "Records Arena Sdn Bhd",
  addressLine: "1 Jalan Sukan",
  city: "Petaling Jaya",
  postcode: "46000",
  stateCode: "10",
  phone: "+60312345678",
  email: "finance@records.my",
};

const BUYER = {
  name: "Syarikat Rekod Sdn Bhd",
  tin: "C2584563200",
  idType: "BRN",
  idNumber: "201901234567",
  email: "accounts@rekod.my",
  phone: "+60123456789",
  addressLine: "Lot 66, Jalan Perdana",
  city: "Kuala Lumpur",
  postcode: "50480",
  stateCode: "14",
};

// ---------------------------------------------------------------- helpers

/** Every column that is LHDN's record once a document has reached it. */
async function frozen(id: number) {
  return getDb()
    .prepare(
      `SELECT venue_id, kind, type_code, code_number, period, receipt_ref, receipt_number, buyer, total::text AS total, document,
              submission_uid, uuid, long_id, refers_uuid, refers_code, created_at, submitted_at, replaces_id, series_code, covers
         FROM e_invoices WHERE id = ?`
    )
    .get(id);
}

const byId = async (id: number) => (await listEInvoices(venueId)).find((e) => e.id === id)!;
const docOf = (code: string) => sent.filter((s) => s.codeNumber === code).at(-1)!.json;

/** A booking paid in cash on the 10th of a month. */
async function paidIn(month: string, amount = 30) {
  const made = await createBooking({ courtId, date: addDays(todayISO(), 1 + (n % 10)), hours: [8 + (n % 12)], name: "Walk-in", phone: `01288${String(++n).padStart(5, "0")}` });
  if (!made.ok) throw new Error(made.error);
  await getDb()
    .prepare("UPDATE bookings SET payment_status = 'paid', paid_via = 'cash', paid_at = ?, total_price = ? WHERE id = ?")
    .run(`${month}-10 04:00:00`, amount, made.booking.id);
  return made.booking;
}

/** A family membership's receipt naming two children, for an account. */
async function familyReceipt(userId: number | null, issuedAt: string, names = ["Alya Rahman", "Bilal Rahman"]) {
  const lines: Line[] = [{ description: "Family membership for {who}", amount: 120, who: names }];
  const doc = await issueReceipt({ source: `membership:g7-${++n}`, venueId, userId, name: "Puan Rahman", lines, paidVia: "cash", taxable: false, issuedAt });
  if (!doc) throw new Error("receipt");
  return doc;
}

async function account() {
  const made = await registerUser({ name: `Puan Rahman ${++n}`, email: `g7-${n}@records.test`, phone: `01299${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user.id;
}

async function ask(ref: string) {
  const asked = await requestEInvoice(ref, receiptToken(ref), BUYER);
  if (!asked.ok) throw new Error(asked.error);
  return asked.einvoice;
}

beforeAll(async () => {
  const made = await createVenue({ name: "Records Arena", area: "PJ", address: "x", phone: "0377771234" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 30, peakRate: 30 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
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

// ---------------------------------------------------------------- tests

describe("a draft follows its receipt until it is sent", () => {
  it("a name cleared from the receipt (the account erased) is not sent; the draft is sent as it is, not replaced", async () => {
    const userId = await account();
    const receipt = await familyReceipt(userId, `${thisMonth}-01 04:00:00`);
    downNext = true;
    const draft = await ask(receipt.ref);
    expect(draft).toMatchObject({ status: "failed", uuid: null, submissionUid: null, sentLines: null, actions: ["send"] });
    expect((await eraseCustomer(userId)).ok).toBe(true);

    const again = await retryEInvoice(draft.id, venueId);
    expect(again).toMatchObject({ ok: true, from: draft.codeNumber, einvoice: { id: draft.id, codeNumber: draft.codeNumber, status: "submitted" } });
    const json = docOf(draft.codeNumber);
    expect(json).toContain("Family membership for (removed)");
    expect(json).not.toContain("Alya");
    expect(json).not.toContain("Bilal");
  });

  it("a venue that leaves names out sends the receipt's number and kind of sale; off by default, and nothing sent before changes", async () => {
    const userId = await account();
    const before = await ask((await familyReceipt(userId, `${thisMonth}-01 04:00:00`)).ref);
    expect(docOf(before.codeNumber)).toContain("Alya Rahman");
    const kept = await frozen(before.id);

    expect((await saveEInvoiceSettings(venueId, { ...SETTINGS, leaveNamesOut: true })).ok).toBe(true);
    const receipt = await familyReceipt(userId, `${thisMonth}-01 04:00:00`);
    const after = await ask(receipt.ref);
    expect(after.sentLines).toHaveLength(1);
    expect(after.sentLines![0].description).toMatch(new RegExp(`^Receipt ${receipt.number}: [a-z]`));
    expect(docOf(after.codeNumber)).not.toMatch(/Alya|Bilal|Rahman/);
    expect(await frozen(before.id)).toEqual(kept);

    expect((await saveEInvoiceSettings(venueId, SETTINGS)).ok).toBe(true);
    expect(docOf((await ask((await familyReceipt(userId, `${thisMonth}-01 04:00:00`)).ref)).codeNumber)).toContain("Alya Rahman");
  });
});

describe("a document sent to LHDN is never rewritten", () => {
  it("keeps what it said and LHDN's identifiers through erasure, retention, a refund, retries, checks and new settings", async () => {
    const userId = await account();
    // One paid now, and one paid three years ago (retention clears its names).
    const recent = await familyReceipt(userId, `${thisMonth}-01 04:00:00`);
    const old = await familyReceipt(null, `${Number(thisMonth.slice(0, 4)) - 3}-${thisMonth.slice(5, 7)}-05 04:00:00`, ["Chen Wei Ling"]);
    const a = await ask(recent.ref);
    const b = await ask(old.ref);
    await checkSubmitted(venueId);
    expect(await byId(a.id)).toMatchObject({ status: "valid", longId: `LONG-U-${a.codeNumber}`, actions: ["recheck"] });
    const snapA = await frozen(a.id);
    const snapB = await frozen(b.id);

    expect((await eraseCustomer(userId)).ok).toBe(true);
    await pruneOldData();
    const receipts = (await getDb().prepare("SELECT lines FROM receipts WHERE id IN (?, ?)").all(recent.id, old.id)) as { lines: string }[];
    expect(JSON.stringify(receipts)).not.toMatch(/Alya|Chen Wei Ling/);

    // A refund: the credit note goes against it as a new document.
    expect(await creditReceipt(recent.source, "receipt.why.refunded")).not.toBeNull();
    const made = await consolidate(venueId, thisMonth);
    const ccn = made.find((e) => e.refersCode === a.codeNumber)!;
    expect(ccn).toMatchObject({ kind: "consolidated_credit", typeCode: "02", status: "pending" });
    await submitPending(venueId);
    expect(await byId(ccn.id)).toMatchObject({ status: "submitted" });
    expect(docOf(ccn.codeNumber)).toContain(`U-${a.codeNumber}`);

    expect(await retryEInvoice(a.id, venueId)).toMatchObject({ ok: false });
    expect(await recheckEInvoice(a.id, venueId)).toMatchObject({ ok: true, einvoice: { status: "valid" } });
    await checkSubmitted(venueId);
    await submitPending(venueId);
    expect((await saveEInvoiceSettings(venueId, { ...SETTINGS, legalName: "Renamed Sdn Bhd", leaveNamesOut: true })).ok).toBe(true);
    await submitPending(venueId);
    expect((await saveEInvoiceSettings(venueId, SETTINGS)).ok).toBe(true);

    expect(await frozen(a.id)).toEqual(snapA);
    expect(await frozen(b.id)).toEqual(snapB);
    // What LHDN has keeps the names it was sent with (docs/architecture/privacy.md#receipts-and-credit-notes).
    expect((snapA as { document: string }).document).toContain("Alya Rahman");
  });

  it("the database refuses to change or delete one that reached LHDN, or to move its state back", async () => {
    const e = await ask((await familyReceipt(null, `${thisMonth}-01 04:00:00`)).ref);
    const db = getDb();
    const refused = async (sql: string, ...args: unknown[]) => expect(db.prepare(sql).run(...args, e.id)).rejects.toThrow(/sent to LHDN/);
    await refused("UPDATE e_invoices SET document = ? WHERE id = ?", "{}");
    await refused("UPDATE e_invoices SET uuid = ? WHERE id = ?", "U-OTHER");
    await refused("UPDATE e_invoices SET submission_uid = NULL WHERE id = ?");
    await refused("UPDATE e_invoices SET total = total + 1 WHERE id = ?");
    await refused("UPDATE e_invoices SET buyer = NULL WHERE id = ?");
    await refused("UPDATE e_invoices SET submitted_at = datetime('now', '+1 day') WHERE id = ?");
    await refused("UPDATE e_invoices SET status = 'pending', error = NULL WHERE id = ?");
    await refused("DELETE FROM e_invoices WHERE id = ?");
    // LHDN's verdict may move on, once.
    await db.prepare("UPDATE e_invoices SET status = 'valid', long_id = 'L1' WHERE id = ?").run(e.id);
    await refused("UPDATE e_invoices SET long_id = 'L2' WHERE id = ?");
    await refused("UPDATE e_invoices SET status = 'submitted' WHERE id = ?");
    // A draft is still a draft.
    downNext = true;
    const draft = await ask((await familyReceipt(null, `${thisMonth}-01 04:00:00`)).ref);
    await db.prepare("UPDATE e_invoices SET error = 'x' WHERE id = ?").run(draft.id);
  });

  it("only lib/myinvois.ts writes e_invoices, and a draft venue holding one is not deleted", async () => {
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f.name) && /(INSERT INTO|UPDATE|DELETE FROM)\s+e_invoices\b/.test(fs.readFileSync(p, "utf8"))) writers.push(p);
      }
    };
    walk(path.join(__dirname, "..", "src"));
    expect(writers.map((p) => path.relative(path.join(__dirname, ".."), p))).toEqual([path.join("src", "lib", "myinvois.ts")]);
    expect((await staleDrafts()).flatMap((d) => d.venueIds)).not.toContain(venueId);
  });

  it("the scheduler never sends again one that reached LHDN (a row sent again in place before migration 0220)", async () => {
    const r = (await getDb()
      .prepare(
        `INSERT INTO e_invoices (venue_id, kind, type_code, code_number, total, status, document, submission_uid, uuid, submitted_at, receipt_ref, receipt_number, buyer)
         VALUES (?, 'individual', '01', ?, 10, 'pending', '{"Invoice":[]}', 'S-OLD', 'U-OLD', datetime('now'), NULL, NULL, NULL) RETURNING id`
      )
      .get(venueId, `EI-LEGACY-${++n}`)) as { id: number };
    const before = sent.length;
    await submitPending(venueId);
    expect(sent.length).toBe(before);
    expect(await byId(r.id)).toMatchObject({ status: "pending", uuid: "U-OLD", actions: ["replace"] });
  });
});

describe("a correction is a new document, linked to the one it replaces", () => {
  it("one LHDN refused at once is kept with its submission and every reason, and replaced once", async () => {
    rejectNext = "Buyer TIN is not valid";
    const refused = await ask((await familyReceipt(null, `${thisMonth}-01 04:00:00`)).ref);
    expect(refused).toMatchObject({
      status: "rejected",
      submissionUid: `SR-${refused.codeNumber}`,
      uuid: null,
      error: "Buyer TIN is not valid; Second reason",
      actions: ["replace"],
    });
    const snap = await frozen(refused.id);
    const [one, two] = await Promise.all([retryEInvoice(refused.id, venueId), retryEInvoice(refused.id, venueId)]);
    expect([one.ok, two.ok].sort()).toEqual([false, true]);
    const rows = (await getDb().prepare("SELECT code_number FROM e_invoices WHERE replaces_id = ?").all(refused.id)) as { code_number: string }[];
    expect(rows.map((x) => x.code_number)).toEqual([`${refused.codeNumber}-R2`]);
    expect(await frozen(refused.id)).toEqual(snap);
    expect(await byId(refused.id)).toMatchObject({ replacedByCode: `${refused.codeNumber}-R2`, actions: [] });
    expect((await einvoiceForReceipt(refused.receiptRef!, `${thisMonth}-01 04:00:00`)).einvoice).toMatchObject({ codeNumber: `${refused.codeNumber}-R2` });
  });

  it("a consolidated one found invalid is replaced, and a credit note waits for the replacement and names it", async () => {
    const month = "2025-03";
    const sale = await paidIn(month, 50);
    await paidIn(month, 20);
    const [con] = await consolidate(venueId, month);
    verdicts.set(`U-CON-${month}`, "Invalid");
    await submitPending(venueId);
    await checkSubmitted(venueId);
    expect(await byId(con.id)).toMatchObject({ status: "invalid", error: "Supplier TIN does not match", actions: ["replace"] });
    const conSnap = await frozen(con.id);

    // A refund now, against March: its credit note waits, as March has nothing valid at LHDN.
    await creditBooking(sale.id, "receipt.why.refunded");
    const ccn = (await consolidate(venueId, thisMonth)).find((e) => e.refersCode === `CON-${month}`)!;
    await submitPending(venueId);
    expect(await byId(ccn.id)).toMatchObject({ status: "pending", waitingFor: `CON-${month}` });

    const replaced = await retryEInvoice(con.id, venueId);
    expect(replaced).toMatchObject({ ok: true, einvoice: { codeNumber: `CON-${month}-R2`, status: "submitted", replacesCode: `CON-${month}` } });
    expect(await byId(ccn.id)).toMatchObject({ status: "pending", waitingFor: `CON-${month}-R2` });
    await checkSubmitted(venueId);
    await submitPending(venueId);
    expect(await byId(ccn.id)).toMatchObject({ status: "submitted", waitingFor: null });
    expect(docOf(ccn.codeNumber)).toContain(`"UUID":[{"_":"U-CON-${month}-R2"}]`);
    expect(docOf(ccn.codeNumber)).toContain(`"ID":[{"_":"CON-${month}-R2"}]`);
    expect(await frozen(con.id)).toEqual(conSnap);
    const current = (await listEInvoices(venueId)).find((e) => e.codeNumber === `CON-${month}-R2`)!;
    expect(current.correctedBy).toEqual([ccn.codeNumber]);
    expect(current.sentLines!.reduce((s, l) => s + l.amount, 0)).toBe(70);
  });

  it("a cancellation made in the portal is recorded when LHDN is asked, and the cancelled one may be replaced", async () => {
    const e = await ask((await familyReceipt(null, `${thisMonth}-01 04:00:00`)).ref);
    await checkSubmitted(venueId);
    expect(await byId(e.id)).toMatchObject({ status: "valid" });
    verdicts.set(`U-${e.codeNumber}`, "Cancelled");
    await checkSubmitted(venueId); // only asks about those not yet decided
    expect(await byId(e.id)).toMatchObject({ status: "valid" });
    expect(await recheckEInvoice(e.id, venueId)).toMatchObject({ ok: true, einvoice: { status: "cancelled", actions: ["replace"] } });
    expect(await recheckEInvoice(e.id, venueId)).toMatchObject({ ok: false });
    expect(await retryEInvoice(e.id, venueId)).toMatchObject({ ok: true, einvoice: { codeNumber: `${e.codeNumber}-R2`, status: "submitted" } });
  });

  it("a customer's own LHDN refused is not replaced once its sale has gone in the consolidated one, nor once they asked again", async () => {
    // Refused, then the month consolidated with the sale in it.
    const may = "2025-05";
    const b1 = await paidIn(may, 40);
    const own = await ask(b1.code);
    verdicts.set(`U-${own.codeNumber}`, "Invalid");
    await checkSubmitted(venueId);
    expect(await byId(own.id)).toMatchObject({ status: "invalid", actions: ["replace"] });
    await consolidate(venueId, may);
    await submitPending(venueId);
    const con = (await listEInvoices(venueId)).find((e) => e.codeNumber === `CON-${may}`)!;
    expect(con.sentLines!.map((l) => l.description).join()).toContain(b1.code);
    expect(await byId(own.id)).toMatchObject({ replaceBlocked: "consolidated", actions: [] });
    expect(await retryEInvoice(own.id, venueId)).toMatchObject({ ok: false, error: expect.stringContaining("invoice it twice") });

    // Refused, and the customer asked again with other details.
    const june = "2025-06";
    const b2 = await paidIn(june, 40);
    const first = await ask(b2.code);
    verdicts.set(`U-${first.codeNumber}`, "Invalid");
    await checkSubmitted(venueId);
    expect((await einvoiceForReceipt(b2.code, `${june}-10 04:00:00`)).available).toBe(true);
    // The receipt says LHDN found a problem and offers the form again.
    const page = renderToStaticMarkup(await ReceiptPage({ params: Promise.resolve({ code: b2.code }), searchParams: Promise.resolve({ t: receiptToken(b2.code) }) }));
    expect(page).toContain("LHDN found a problem");
    expect(page).toContain("you can ask again with the right ones below");
    const second = await ask(b2.code);
    expect(second.id).not.toBe(first.id);
    expect(await byId(first.id)).toMatchObject({ replaceBlocked: "newer", actions: [] });
    expect(await retryEInvoice(first.id, venueId)).toMatchObject({ ok: false });
  });
});

describe("the staff screen", () => {
  it("is offered only what the server does with each e-invoice", async () => {
    const made = await createAdmin({ name: "Mgr", email: "g7-mgr@records.test", password: "a long enough password", venueId, role: "manager" });
    if (!made.ok) throw new Error(made.error);
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}`;
    const call = (body: Record<string, unknown>) =>
      einvoicing.POST(new NextRequest("http://localhost/api/admin/einvoicing", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ venueId, ...body }) }));
    const res = await einvoicing.GET(new NextRequest(`http://localhost/api/admin/einvoicing?venueId=${venueId}`, { headers: { cookie } }));
    expect(res.status).toBe(200);
    const list = (await res.json()).einvoices as EInvoice[];
    for (const status of ["pending", "submitted", "valid", "invalid", "rejected", "cancelled"]) expect(list.map((e) => e.status)).toContain(status);
    for (const e of list) {
      if (!e.actions.includes("send") && !e.actions.includes("replace")) expect((await call({ action: "retry", id: e.id })).status).toBe(409);
      if (!e.actions.includes("recheck")) expect((await call({ action: "recheck", id: e.id })).status).toBe(409);
    }
    const valid = list.find((e) => e.status === "valid")!;
    expect((await call({ action: "recheck", id: valid.id })).status).toBe(200);
    // Whatever was refused, the stored payload of every document that reached LHDN is as it was.
    const hashes = async () =>
      ((await getDb().prepare("SELECT id, document FROM e_invoices WHERE document IS NOT NULL ORDER BY id").all()) as { id: number; document: string }[]).map(
        (r) => `${r.id}:${crypto.createHash("sha256").update(r.document).digest("hex")}`
      );
    const before = await hashes();
    for (const e of list) await call({ action: "retry", id: e.id });
    const after = await hashes();
    for (const h of before) expect(after).toContain(h);
  });
});
