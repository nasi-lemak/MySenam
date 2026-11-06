import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

/** The venue whose sales journal breaks while it is being read (a fault of its own, not of MyInvois). */
let breakVenue = 0;
vi.mock("../src/lib/accounting", async (original) => {
  const real = await original<typeof import("../src/lib/accounting")>();
  return {
    ...real,
    salesJournal: async (venueId: number, ...rest: [string, string, { counter?: boolean }?]) => {
      if (venueId === breakVenue) throw new Error("the journal could not be read");
      return real.salesJournal(venueId, ...rest);
    },
  };
});

import { createAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { issueReceipt } from "../src/lib/documents";
import { notSentRetryMinutes, requestEInvoice, retryNotSent, runEInvoicing, saveEInvoiceSettings, submitPending } from "../src/lib/myinvois";
import { forgetTokens } from "../src/lib/myinvois/client";
import { receiptToken } from "../src/lib/receipts";
import { createVenue } from "../src/lib/store";
import { todayISO } from "../src/lib/time";

/**
 * E-invoicing keeps going (audit 9 G15, ADR 0055): one venue's failure does not stop the others, the month before is
 * consolidated on any day of the month and not only in its first seven, and a document that was *not sent* is tried
 * again by itself and is never silent. MyInvois is a stand-in throughout (INTEGRATION_VERIFICATION_REQUIRED).
 */
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
  legalName: "Resilient Arena Sdn Bhd",
  addressLine: "1 Jalan Sukan",
  city: "Petaling Jaya",
  postcode: "46000",
  stateCode: "10",
  phone: "+60312345678",
  email: "finance@resilient.my",
};
const BUYER = {
  name: "Syarikat Hantar Sdn Bhd",
  tin: "C2584563200",
  idType: "BRN",
  idNumber: "201901234567",
  email: "accounts@hantar.my",
  phone: "+60123456789",
  addressLine: "Lot 66, Jalan Perdana",
  city: "Kuala Lumpur",
  postcode: "50480",
  stateCode: "14",
};

const sent: string[] = [];
let down = false;
function fakeMyInvois() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body?: unknown } = {}) => {
      if (url.endsWith("/connect/token")) return Response.json({ access_token: "tok", expires_in: 3600 });
      if (url.endsWith("/api/v1.0/documentsubmissions/")) {
        if (down) throw new Error("connect ECONNREFUSED");
        const [d] = (JSON.parse(init.body as string) as { documents: { codeNumber: string }[] }).documents;
        sent.push(d.codeNumber);
        return Response.json({ submissionUid: `S-${d.codeNumber}`, acceptedDocuments: [{ uuid: `U-${d.codeNumber}`, invoiceCodeNumber: d.codeNumber }] }, { status: 202 });
      }
      return new Response("not found", { status: 404 });
    })
  );
}

let venueA = 0;
let venueB = 0;
let venueC = 0;
let venueD = 0;
let seq = 0;
/** This month, where nothing has been consolidated: a customer's own e-invoice can still be asked for. */
const thisMonth = todayISO("Asia/Kuala_Lumpur").slice(0, 7);

async function venueWith(name: string, manager: string) {
  const made = await createVenue({ name, area: "PJ", address: "x", phone: `03777${String(++seq).padStart(5, "0")}` });
  if (!made.ok) throw new Error("venue");
  const staff = await createAdmin({ name: `Manager ${name}`, email: manager, password: "a long enough password", venueId: made.venue.id, role: "manager" });
  if (!staff.ok) throw new Error(staff.error);
  forgetTokens();
  fakeMyInvois();
  expect((await saveEInvoiceSettings(made.venue.id, SETTINGS)).ok).toBe(true);
  vi.unstubAllGlobals();
  // Switched on, so the stand-in is reached when this venue's drafts are sent.
  await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(made.venue.id);
  return made.venue.id;
}

/** A receipt of last month, in October 2026 (the stand-in clock below is early November or later in the month). */
async function sale(venueId: number, amount: number, month = "2026-10") {
  const doc = await issueReceipt({
    source: `resilient:${++seq}`,
    venueId,
    userId: null,
    name: "Walk-in",
    lines: [{ description: "Court hire", amount }],
    paidVia: "cash",
    taxable: false,
    issuedAt: `${month}-15 04:00:00`,
  });
  if (!doc) throw new Error("receipt");
  return doc;
}

const at = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
  return new Date(iso);
};
const codes = async (venueId: number) =>
  ((await getDb().prepare("SELECT code_number FROM e_invoices WHERE venue_id = ? ORDER BY id").all(venueId)) as { code_number: string }[]).map((r) => r.code_number);
const staffMail = async (to: string, like: string) =>
  (await getDb().prepare("SELECT subject, body FROM messages WHERE kind = 'staff_alert' AND recipient = ? AND subject LIKE ?").all(to, like)) as { subject: string; body: string }[];
const ownerAlert = async (key: string) =>
  (await getDb().prepare("SELECT key, count, last_detail FROM system_alerts WHERE key = ?").get(key)) as { key: string; count: number; last_detail: string } | undefined;

beforeAll(async () => {
  venueA = await venueWith("Broken Arena", "manager@broken.my");
  venueB = await venueWith("Healthy Arena", "manager@healthy.my");
  venueC = await venueWith("Newcomer Arena", "manager@newcomer.my");
  venueD = await venueWith("Retry Arena", "manager@retry.my");
});

beforeEach(() => {
  sent.length = 0;
  down = false;
  breakVenue = 0;
  forgetTokens();
  fakeMyInvois();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("one venue's failure", () => {
  it("does not stop the other venues, and is recorded and told to its own staff and the owner", async () => {
    await sale(venueA, 30);
    await sale(venueB, 40);
    breakVenue = venueA;
    const now = at("2026-11-03T02:00:00Z");
    await runEInvoicing(now);

    // The healthy venue's month was written down and sent in the same run.
    expect(await codes(venueB)).toEqual(["CON-2026-10"]);
    expect(sent).toContain("CON-2026-10");
    expect(await codes(venueA)).toEqual([]);

    // The failure is the owner's alert and a message to that venue's manager, and no other venue's.
    expect(await ownerAlert(`einvoice:${venueA}:consolidating`)).toMatchObject({ count: 1, last_detail: expect.stringContaining("journal could not be read") });
    const told = await staffMail("manager@broken.my", "%E-invoicing stopped%");
    expect(told).toHaveLength(1);
    expect(told[0].body).toContain("Broken Arena");
    expect(await staffMail("manager@healthy.my", "%E-invoicing stopped%")).toEqual([]);

    // Run again: the failure is counted, but staff are not told again within the owner's resend hours.
    await runEInvoicing(now);
    expect((await ownerAlert(`einvoice:${venueA}:consolidating`))!.count).toBe(2);
    expect(await staffMail("manager@broken.my", "%E-invoicing stopped%")).toHaveLength(1);
    // And when the fault is gone the month is made, once.
    breakVenue = 0;
    await runEInvoicing(now);
    expect(await codes(venueA)).toEqual(["CON-2026-10"]);
    await runEInvoicing(now);
    expect(await codes(venueA)).toEqual(["CON-2026-10"]);
  });
});

describe("the month before is consolidated beyond its first seven days", () => {
  it("is made on the twentieth for a venue already e-invoicing, once an hour, and never twice", async () => {
    const venue = await venueWith("Late Arena", "manager@late.my");
    await sale(venue, 55);
    // It has e-invoiced before this month: a document from September exists.
    await getDb()
      .prepare("INSERT INTO e_invoices (venue_id, kind, type_code, code_number, period, total, status, created_at) VALUES (?, 'consolidated', '01', 'CON-2026-09', '2026-09', 10, 'pending', '2026-10-02 04:00:00')")
      .run(venue);
    // Not on the half hour: the catch-up is hourly.
    await runEInvoicing(at("2026-11-20T02:30:00Z"));
    expect(await codes(venue)).toEqual(["CON-2026-09"]);
    // In the first minutes of an hour it is made.
    await runEInvoicing(at("2026-11-20T03:00:00Z"));
    expect(await codes(venue)).toEqual(["CON-2026-09", "CON-2026-10"]);
    await runEInvoicing(at("2026-11-20T04:00:00Z"));
    expect(await codes(venue)).toEqual(["CON-2026-09", "CON-2026-10"]);
  });

  it("is not made after the seventh day for a venue that has never e-invoiced: its sales from before it began are not sent unasked", async () => {
    await sale(venueC, 25);
    await runEInvoicing(at("2026-11-20T02:00:00Z"));
    expect(await codes(venueC)).toEqual([]);
    // In the first seven days it is, as it always was.
    await runEInvoicing(at("2026-11-05T02:00:00Z"));
    expect(await codes(venueC)).toEqual(["CON-2026-10"]);
  });
});

describe("a document that was not sent", () => {
  /** A customer's own e-invoice that could not be sent because MyInvois was down: a draft, `failed`. */
  async function notSent(venue: number) {
    const doc = await sale(venue, 20, thisMonth);
    down = true;
    const asked = await requestEInvoice(doc.ref, receiptToken(doc.ref), BUYER);
    down = false;
    if (!asked.ok) throw new Error(asked.error);
    expect(asked.einvoice.status).toBe("failed");
    return asked.einvoice;
  }

  it("is tried again by itself after its back-off, sent when the cause is gone, and was alerted when it failed", async () => {
    const draft = await notSent(venueD);
    // Alerted at once: the owner (kept alert) and the venue's manager.
    expect(await ownerAlert(`einvoice:${venueD}:not-sent`)).toMatchObject({ count: 1 });
    const told = await staffMail("manager@retry.my", "%was not sent%");
    expect(told).toHaveLength(1);
    expect(told[0].subject).toContain(draft.codeNumber);

    const failedAt = new Date();
    // Inside the back-off nothing moves; after it the document waits again and is sent.
    expect(await retryNotSent(venueD, new Date(failedAt.getTime() + 5 * 60_000))).toBe(0);
    expect(await submitPending(venueD, new Date(failedAt.getTime() + 5 * 60_000))).toBe(0);
    expect(sent).not.toContain(draft.codeNumber);
    const later = new Date(failedAt.getTime() + 20 * 60_000);
    await submitPending(venueD, later);
    expect(sent).toContain(draft.codeNumber);
    const row = (await getDb().prepare("SELECT status, error FROM e_invoices WHERE id = ?").get(draft.id)) as { status: string; error: string | null };
    expect(row).toMatchObject({ status: "submitted", error: null });
  });

  it("goes on failing quietly for the venue, and loudly for the owner, while MyInvois stays down, with a growing back-off", async () => {
    const draft = await notSent(venueD);
    const first = new Date(Date.now() + 20 * 60_000);
    down = true;
    await submitPending(venueD, first);
    const attempts = async () =>
      Number(((await getDb().prepare("SELECT COUNT(*) AS n FROM e_invoice_attempts WHERE e_invoice_id = ? AND event = 'not_sent'").get(draft.id)) as { n: number | string }).n);
    expect(await attempts()).toBe(2);
    expect((await ownerAlert(`einvoice:${venueD}:not-sent`))!.count).toBeGreaterThanOrEqual(3);
    // Staff are told again only when the owner is (not every try): the first message stands.
    expect(await staffMail("manager@retry.my", "%was not sent%")).toHaveLength(1);
    // Two failures: the next try is not due 20 minutes after the second, but is after 40.
    expect(await retryNotSent(venueD, new Date(Date.now() + 20 * 60_000))).toBe(0);
    expect(await retryNotSent(venueD, new Date(Date.now() + 40 * 60_000))).toBeGreaterThanOrEqual(1);
    expect([1, 2, 3, 4, 5, 6, 7].map(notSentRetryMinutes)).toEqual([15, 30, 60, 120, 240, 360, 360]);
  });

  it("is never retried by itself when LHDN may hold it: an unknown outcome is for staff to settle", async () => {
    const doc = await sale(venueD, 20, thisMonth);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/connect/token")) return Response.json({ access_token: "tok", expires_in: 3600 });
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      })
    );
    forgetTokens();
    const asked = await requestEInvoice(doc.ref, receiptToken(doc.ref), BUYER);
    if (!asked.ok) throw new Error(asked.error);
    expect(asked.einvoice).toMatchObject({ status: "failed", outcomeUnknown: true });
    sent.length = 0;
    fakeMyInvois();
    // Any other draft of the venue that was not sent goes again; this one, whose outcome is unknown, does not.
    await retryNotSent(venueD, new Date(Date.now() + 3 * 24 * 3600_000));
    await submitPending(venueD, new Date(Date.now() + 3 * 24 * 3600_000));
    expect(sent).not.toContain(asked.einvoice.codeNumber);
    expect(((await getDb().prepare("SELECT status FROM e_invoices WHERE id = ?").get(asked.einvoice.id)) as { status: string }).status).toBe("failed");
  });
});
