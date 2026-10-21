import crypto from "crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

import { NextRequest } from "next/server";
import { creditBooking } from "../src/lib/documents";
import { getDb } from "../src/lib/db";
import {
  checkSubmitted,
  consolidate,
  einvoiceForReceipt,
  einvoiceSettings,
  listEInvoices,
  previousPeriod,
  requestEInvoice,
  retryEInvoice,
  saveEInvoiceSettings,
} from "../src/lib/myinvois";
import { forgetTokens } from "../src/lib/myinvois/client";
import { GENERAL_PUBLIC_TIN } from "../src/lib/myinvois/ubl";
import { receiptToken } from "../src/lib/receipts";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as ask } from "../src/app/api/receipts/einvoice/route";

/**
 * LHDN e-invoicing, against a MyInvois that is pretended here: the month
 * consolidated for the general public, credit notes against what they
 * correct, a customer's own e-invoice asked for from their receipt, and the
 * answers LHDN gives. The real API must still be tried in LHDN's sandbox.
 */

let venueId: number;
let courtId: number;
let n = 0;
const thisMonth = todayISO("Asia/Kuala_Lumpur").slice(0, 7);
const lastMonth = previousPeriod(todayISO("Asia/Kuala_Lumpur"));
// A month nothing has been consolidated for yet, for the tests after this month's credit notes went.
const laterMonth = previousPeriod(`${Number(thisMonth.slice(0, 4)) + 1}-${thisMonth.slice(5, 7)}-01`);

interface Sent {
  codeNumber: string;
  doc: Record<string, unknown> & { Invoice: Record<string, unknown>[] };
  hashOk: boolean;
  onbehalfof: string | null;
}
let sent: Sent[] = [];
let verdict: "Valid" | "Invalid" | "Submitted" = "Valid";
let rejectNext: string | null = null;

function fakeMyInvois() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
      if (url.endsWith("/connect/token")) return Response.json({ access_token: "tok", expires_in: 3600 });
      if (url.endsWith("/api/v1.0/documentsubmissions/")) {
        const { documents } = JSON.parse(init.body as string) as { documents: { document: string; documentHash: string; codeNumber: string }[] };
        const [d] = documents;
        const json = Buffer.from(d.document, "base64").toString("utf8");
        sent.push({
          codeNumber: d.codeNumber,
          doc: JSON.parse(json),
          hashOk: crypto.createHash("sha256").update(json).digest("hex") === d.documentHash,
          onbehalfof: init.headers?.onbehalfof ?? null,
        });
        if (rejectNext) {
          const why = rejectNext;
          rejectNext = null;
          return Response.json(
            { submissionUid: "S1", acceptedDocuments: [], rejectedDocuments: [{ invoiceCodeNumber: d.codeNumber, error: { message: why } }] },
            { status: 202 }
          );
        }
        return Response.json({ submissionUid: `S-${d.codeNumber}`, acceptedDocuments: [{ uuid: `U-${d.codeNumber}`, invoiceCodeNumber: d.codeNumber }] }, { status: 202 });
      }
      const details = url.match(/\/documents\/([^/]+)\/details$/);
      if (details) {
        if (verdict === "Invalid")
          return Response.json({
            status: "Invalid",
            validationResults: { validationSteps: [{ status: "Invalid", error: { innerError: [{ error: "Buyer TIN is not valid" }] } }] },
          });
        return Response.json({ status: verdict, longId: verdict === "Valid" ? "LONG123" : null });
      }
      return new Response("not found", { status: 404 });
    })
  );
}

const field = (doc: Sent["doc"], key: string) => (doc.Invoice[0][key] as { _: unknown }[])[0]._;

/** A booking paid in cash on a day of the given month. */
async function paidIn(month: string, amount = 30) {
  const made = await createBooking({ courtId, date: addDays(todayISO(), 3 + (n % 20)), hours: [8 + (n % 12)], name: "Ahmad", phone: `01277${String(++n).padStart(5, "0")}` });
  if (!made.ok) throw new Error(made.error);
  await getDb()
    .prepare("UPDATE bookings SET payment_status = 'paid', paid_via = 'cash', paid_at = ?, total_price = ? WHERE id = ?")
    .run(`${month}-10 04:00:00`, amount, made.booking.id);
  return made.booking;
}

const BUYER = {
  name: "Syarikat Badminton Sdn Bhd",
  tin: "C2584563200",
  idType: "BRN",
  idNumber: "201901234567",
  email: "accounts@syarikat.my",
  phone: "+60123456789",
  addressLine: "Lot 66, Jalan Perdana",
  city: "Kuala Lumpur",
  postcode: "50480",
  stateCode: "14",
};

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
  legalName: "Courts Sdn Bhd",
  addressLine: "1 Jalan Sukan",
  city: "Petaling Jaya",
  postcode: "46000",
  stateCode: "10",
  phone: "+60312345678",
  email: "finance@courts.my",
};

beforeAll(async () => {
  const made = await createVenue({ name: "Invoice Arena", area: "PJ", address: "x", phone: "0377770000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 30, peakRate: 30 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
});

beforeEach(() => {
  forgetTokens();
  fakeMyInvois();
});
afterEach(() => vi.unstubAllGlobals());

describe("settings", () => {
  it("cannot be turned on until everything LHDN needs is there", async () => {
    const half = await saveEInvoiceSettings(venueId, { enabled: true, tin: "C1234567890" });
    expect(half).toMatchObject({ ok: false });
    expect(!half.ok && half.error).toContain("MSIC code");
    expect(await saveEInvoiceSettings(venueId, { ...SETTINGS, tin: "12345" })).toMatchObject({ ok: false });
    const saved = await saveEInvoiceSettings(venueId, SETTINGS);
    expect(saved).toMatchObject({ ok: true, settings: { enabled: true, sandbox: true, hasSecret: true, missing: [] } });
  });

  it("keep the stored secret when it is left blank, and never give it back", async () => {
    const saved = await saveEInvoiceSettings(venueId, { ...SETTINGS, clientSecret: "" });
    expect(saved.ok && saved.settings.hasSecret).toBe(true);
    expect(JSON.stringify(await einvoiceSettings(venueId))).not.toContain("secret-456");
  });
});

describe("a customer's own e-invoice", () => {
  it("is sent at once in their name, and the receipt shows it", async () => {
    const b = await paidIn(lastMonth);
    expect((await einvoiceForReceipt(b.code, `${lastMonth}-10 04:00:00`)).available).toBe(true);
    const res = await ask(
      new NextRequest("http://localhost/api/receipts/einvoice", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
        body: JSON.stringify({ ref: b.code, t: receiptToken(b.code), ...BUYER }),
      })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).einvoice).toMatchObject({ kind: "individual", status: "submitted", buyerName: BUYER.name, total: 30 });
    const doc = sent.at(-1)!;
    expect(doc.hashOk).toBe(true);
    expect(field(doc.doc, "InvoiceTypeCode")).toBe("01");
    expect(JSON.stringify(doc.doc)).toContain("C2584563200");
    expect(JSON.stringify(doc.doc)).toContain('"_":"022"');
    expect((await einvoiceForReceipt(b.code, `${lastMonth}-10 04:00:00`)).einvoice).toMatchObject({ status: "submitted" });
  });

  it("is asked for once, with a proper tax number, and only with the receipt's link", async () => {
    const b = await paidIn(lastMonth);
    expect(await requestEInvoice(b.code, "wrong", BUYER)).toMatchObject({ ok: false, code: "EINVOICE_NO_RECEIPT" });
    expect(await requestEInvoice(b.code, receiptToken(b.code), { ...BUYER, tin: "123" })).toMatchObject({ ok: false });
    expect(await requestEInvoice(b.code, receiptToken(b.code), BUYER)).toMatchObject({ ok: true });
    expect(await requestEInvoice(b.code, receiptToken(b.code), BUYER)).toMatchObject({ ok: false, code: "EINVOICE_ALREADY" });
  });

  it("is not offered where the venue does not e-invoice", async () => {
    const other = await createVenue({ name: "Plain Hall", area: "PJ", address: "x", phone: "0377770001" });
    if (!other.ok) throw new Error("venue");
    const court = await createCourt({ venueId: other.venue.id, name: "C", sport: "badminton", offPeakRate: 10, peakRate: 10 });
    if (!court.ok) throw new Error("court");
    const made = await createBooking({ courtId: court.court.id, date: addDays(todayISO(), 2), hours: [9], name: "X", phone: "0127000999" });
    if (!made.ok) throw new Error(made.error);
    await getDb().prepare("UPDATE bookings SET payment_status = 'paid', paid_at = datetime('now') WHERE id = ?").run(made.booking.id);
    expect(await requestEInvoice(made.booking.code, receiptToken(made.booking.code), BUYER)).toMatchObject({ ok: false, code: "EINVOICE_OFF" });
    expect((await einvoiceForReceipt(made.booking.code, null)).available).toBe(false);
  });
});

describe("the month, consolidated", () => {
  let first: { code: string; id: number };

  it("goes to the general public, without the receipts e-invoiced on their own, and once", async () => {
    first = await paidIn(lastMonth, 40);
    await paidIn(lastMonth, 20);
    await paidIn(thisMonth, 99); // not this one: it belongs to this month
    const before = sent.length;
    const made = await consolidate(venueId, lastMonth);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ kind: "consolidated", codeNumber: `CON-${lastMonth}`, total: 60, status: "pending" });
    expect(await consolidate(venueId, lastMonth)).toEqual([]);

    const { submitPending } = await import("../src/lib/myinvois");
    await submitPending(venueId);
    const doc = sent.slice(before).find((s) => s.codeNumber === `CON-${lastMonth}`)!;
    expect(doc.hashOk).toBe(true);
    expect(JSON.stringify(doc.doc)).toContain(GENERAL_PUBLIC_TIN);
    expect(JSON.stringify(doc.doc)).toContain('"_":"004"');
    const total = (doc.doc.Invoice[0].LegalMonetaryTotal as { PayableAmount: { _: number }[] }[])[0].PayableAmount[0]._;
    expect(total).toBe(60);
  });

  it("closes the month to customers asking for their own", async () => {
    const late = await paidIn(lastMonth);
    // Paid after consolidation, but dated in a month LHDN already has.
    expect(await requestEInvoice(late.code, receiptToken(late.code), BUYER)).toMatchObject({ ok: false, code: "EINVOICE_TOO_LATE" });
    expect((await einvoiceForReceipt(late.code, `${lastMonth}-10 04:00:00`)).available).toBe(false);
  });

  it("is checked with LHDN until it is valid, then links to LHDN's page", async () => {
    verdict = "Valid";
    await checkSubmitted(venueId);
    const con = (await listEInvoices(venueId)).find((e) => e.codeNumber === `CON-${lastMonth}`)!;
    expect(con).toMatchObject({ status: "valid", link: `https://preprod.myinvois.hasil.gov.my/U-CON-${lastMonth}/share/LONG123` });
  });

  it("is corrected by a credit note that names it", async () => {
    await creditBooking(first.id, "receipt.why.refunded");
    const made = await consolidate(venueId, thisMonth);
    const credit = made.find((e) => e.kind === "consolidated_credit")!;
    expect(credit).toMatchObject({ typeCode: "02", refersCode: `CON-${lastMonth}`, total: 40 });
    const { submitPending } = await import("../src/lib/myinvois");
    await submitPending(venueId);
    const doc = sent.find((s) => s.codeNumber === credit.codeNumber)!;
    expect(field(doc.doc, "InvoiceTypeCode")).toBe("02");
    expect(JSON.stringify(doc.doc.Invoice[0].BillingReference)).toContain(`U-CON-${lastMonth}`);
  });
});

describe("when LHDN says no", () => {
  it("an invalid one says why, and is sent again once put right", async () => {
    const b = await paidIn(laterMonth);
    verdict = "Invalid";
    const asked = await requestEInvoice(b.code, receiptToken(b.code), BUYER);
    if (!asked.ok) throw new Error(asked.error);
    await checkSubmitted(venueId);
    const bad = (await listEInvoices(venueId)).find((e) => e.id === asked.einvoice.id)!;
    expect(bad).toMatchObject({ status: "invalid", error: "Buyer TIN is not valid" });
    verdict = "Valid";
    expect(await retryEInvoice(bad.id, venueId)).toMatchObject({ status: "submitted" });
    expect(await retryEInvoice(bad.id, venueId)).toBeNull();
  });

  it("one refused at once is marked not sent, with the reason", async () => {
    const b = await paidIn(laterMonth);
    rejectNext = "Document hash mismatch";
    const asked = await requestEInvoice(b.code, receiptToken(b.code), BUYER);
    expect(asked).toMatchObject({ ok: true, einvoice: { status: "failed", error: "Document hash mismatch" } });
  });

  it("acts for the venue as an intermediary with the platform's credentials", async () => {
    process.env.MYINVOIS_CLIENT_ID = "platform";
    process.env.MYINVOIS_CLIENT_SECRET = "platform-secret";
    try {
      expect((await saveEInvoiceSettings(venueId, { ...SETTINGS, mode: "intermediary" })).ok).toBe(true);
      const b = await paidIn(laterMonth);
      await requestEInvoice(b.code, receiptToken(b.code), BUYER);
      expect(sent.at(-1)!.onbehalfof).toBe("C1234567890");
    } finally {
      delete process.env.MYINVOIS_CLIENT_ID;
      delete process.env.MYINVOIS_CLIENT_SECRET;
    }
  });
});

describe("periods", () => {
  it("the month before, across a new year", () => {
    expect(previousPeriod("2027-01-03")).toBe("2026-12");
    expect(previousPeriod("2026-11-30")).toBe("2026-10");
  });
});
