import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { getDb } from "../src/lib/db";
import { issueReceipt } from "../src/lib/documents";
import { listEInvoices, requestEInvoice, retryEInvoice, saveEInvoiceSettings, SENDING_INTERRUPTED, submitOne, submitPending } from "../src/lib/myinvois";
import { forgetTokens } from "../src/lib/myinvois/client";
import { receiptToken } from "../src/lib/receipts";
import { createVenue } from "../src/lib/store";
import { todayISO } from "../src/lib/time";

/**
 * A draft e-invoice reaches LHDN once (docs/integrations/myinvois.md#sending-once):
 * the scheduler sending what waits and staff pressing *Send* at the same
 * moment, or two servers, used to both read it as waiting and both send it.
 * Sending now claims the draft first (migration 0256), and only the claimant
 * asks LHDN. Against a pretend MyInvois that holds each submission until
 * the test lets it answer, so the two really are at it together. On PGlite,
 * and on Postgres with TEST_DATABASE_URL.
 */

const ZONE = "Asia/Kuala_Lumpur";
const thisMonth = todayISO(ZONE).slice(0, 7);

let venueId: number;
let n = 0;

/** The codes LHDN was sent, in order. */
const sent: string[] = [];
let downNext = false;
/** While set, each submission waits here until it is released. */
let gate: { entered: () => void; release: Promise<void> } | null = null;

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
        const [d] = (JSON.parse(init.body as string) as { documents: { codeNumber: string }[] }).documents;
        sent.push(d.codeNumber);
        if (gate) {
          gate.entered();
          await gate.release;
        }
        return Response.json({ submissionUid: `S-${d.codeNumber}-${sent.length}`, acceptedDocuments: [{ uuid: `U-${d.codeNumber}-${sent.length}`, invoiceCodeNumber: d.codeNumber }] }, { status: 202 });
      }
      return new Response("not found", { status: 404 });
    })
  );
}

/** Holds the next submission; resolves `entered` once LHDN is being asked. */
function holdLhdn() {
  let entered!: () => void;
  let release!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  gate = { entered, release: new Promise<void>((r) => (release = r)) };
  return {
    inside,
    release: () => {
      gate = null;
      release();
    },
  };
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
  legalName: "Sending Arena Sdn Bhd",
  addressLine: "1 Jalan Sukan",
  city: "Petaling Jaya",
  postcode: "46000",
  stateCode: "10",
  phone: "+60312345678",
  email: "finance@sending.my",
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

/** A customer's own e-invoice that could not be sent (MyInvois was down): a draft, `failed`. */
async function notSent() {
  const doc = await issueReceipt({
    source: `sending:${++n}`,
    venueId,
    userId: null,
    name: "Walk-in",
    lines: [{ description: "Court hire", amount: 40 }],
    paidVia: "cash",
    taxable: false,
    issuedAt: `${thisMonth}-01 04:00:00`,
  });
  if (!doc) throw new Error("receipt");
  downNext = true;
  const asked = await requestEInvoice(doc.ref, receiptToken(doc.ref), BUYER);
  if (!asked.ok) throw new Error(asked.error);
  expect(asked.einvoice.status).toBe("failed");
  return asked.einvoice;
}

const row = async (id: number) =>
  (await getDb().prepare("SELECT status, sending_at, submission_uid, uuid, error FROM e_invoices WHERE id = ?").get(id)) as {
    status: string;
    sending_at: string | null;
    submission_uid: string | null;
    uuid: string | null;
    error: string | null;
  };

const settle = () => new Promise((r) => setTimeout(r, 50));

beforeAll(async () => {
  const made = await createVenue({ name: "Sending Arena", area: "PJ", address: "x", phone: "0377771235" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  forgetTokens();
  fakeMyInvois();
  expect((await saveEInvoiceSettings(venueId, SETTINGS)).ok).toBe(true);
  vi.unstubAllGlobals();
});

beforeEach(() => {
  forgetTokens();
  fakeMyInvois();
  sent.length = 0;
});
afterEach(() => {
  gate = null;
  vi.unstubAllGlobals();
});

describe("a draft e-invoice sent at the same moment twice", () => {
  it("reaches LHDN once when staff send it while the scheduler sends what waits", async () => {
    const draft = await notSent();
    const lhdn = holdLhdn();
    // Staff press Send: the draft is waiting again and its sender is with LHDN.
    const staff = retryEInvoice(draft.id, venueId);
    await lhdn.inside;
    expect((await row(draft.id)).sending_at).not.toBeNull();
    // The scheduler's run at that moment finds it claimed and leaves it.
    const scheduler = submitPending(venueId);
    await settle();
    lhdn.release();
    const [byStaff] = await Promise.all([staff, scheduler]);
    expect(sent.filter((c) => c === draft.codeNumber)).toHaveLength(1);
    expect(byStaff).toMatchObject({ ok: true, einvoice: { id: draft.id, status: "submitted" } });
    expect(await row(draft.id)).toMatchObject({ status: "submitted", sending_at: null, submission_uid: `S-${draft.codeNumber}-1` });
  });

  it("reaches LHDN once when two senders (two servers' schedulers) take the same draft", async () => {
    const draft = await notSent();
    await getDb().prepare("UPDATE e_invoices SET status = 'pending', error = NULL WHERE id = ?").run(draft.id);
    const lhdn = holdLhdn();
    const first = submitOne(draft.id);
    await lhdn.inside;
    const second = submitOne(draft.id);
    const third = submitPending();
    await settle();
    lhdn.release();
    const [a, b] = await Promise.all([first, second, third]);
    expect(sent.filter((c) => c === draft.codeNumber)).toHaveLength(1);
    expect(a.status).toBe("submitted");
    // The one that lost the claim says how it stood; it sent nothing.
    expect(["pending", "submitted"]).toContain(b.status);
    expect(await row(draft.id)).toMatchObject({ status: "submitted", sending_at: null });
  });

  it("is not sent again by itself when its sending was interrupted: staff check the portal, then send it", async () => {
    const draft = await notSent();
    // A sender stopped between asking LHDN and writing the answer down, long ago.
    await getDb()
      .prepare("UPDATE e_invoices SET status = 'pending', error = NULL, sending_at = datetime('now', '-1 hours') WHERE id = ?")
      .run(draft.id);
    await submitPending(venueId);
    expect(sent).toHaveLength(0);
    expect(await row(draft.id)).toMatchObject({ status: "failed", sending_at: null, error: SENDING_INTERRUPTED });
    const listed = (await listEInvoices(venueId)).find((e) => e.id === draft.id)!;
    expect(listed.actions).toEqual(["send"]);
    // Sent by staff, once.
    expect(await retryEInvoice(draft.id, venueId)).toMatchObject({ ok: true, einvoice: { status: "submitted" } });
    expect(sent).toEqual([draft.codeNumber]);
  });

  it("leaves a draft being sent right now alone", async () => {
    const draft = await notSent();
    await getDb()
      .prepare("UPDATE e_invoices SET status = 'pending', error = NULL, sending_at = datetime('now', '-1 minutes') WHERE id = ?")
      .run(draft.id);
    await submitPending(venueId);
    expect(await submitOne(draft.id)).toMatchObject({ status: "pending" });
    expect(sent).toHaveLength(0);
    expect((await row(draft.id)).sending_at).not.toBeNull();
    // As the sender that claimed it would, once it has LHDN's answer.
    await getDb().prepare("UPDATE e_invoices SET sending_at = NULL WHERE id = ?").run(draft.id);
  });
});
