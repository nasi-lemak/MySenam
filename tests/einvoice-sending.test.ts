import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { createAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { issueReceipt } from "../src/lib/documents";
import {
  einvoicesDue,
  listEInvoices,
  pruneEInvoices,
  recordFromPortal,
  requestEInvoice,
  retryEInvoice,
  saveEInvoiceSettings,
  SENDING_INTERRUPTED,
  submitOne,
  submitPending,
} from "../src/lib/myinvois";
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
 *
 * A submission that may have reached LHDN without MySenam hearing back (an
 * interrupted claim, a timeout) is an unknown outcome, not "not sent": the
 * owner's decision of 29 October 2026 (migration 0260). It is never sent
 * again blindly, staff reconcile it with LHDN, and each attempt is kept.
 */

const ZONE = "Asia/Kuala_Lumpur";
const thisMonth = todayISO(ZONE).slice(0, 7);

let venueId: number;
let n = 0;

/** The codes LHDN was sent, in order. */
const sent: string[] = [];
let downNext = false;
/**
 * How LHDN's answer to the next submission goes wrong. `timeout`, `unreadable` and `gateway` happen after the
 * request went out (LHDN may hold the document); `refused` and `unavailable` are LHDN saying it took nothing.
 */
let failNext: null | "timeout" | "unreadable" | "gateway" | "refused" | "unavailable" = null;
/** What the stand-in LHDN holds, by document UUID, for the portal lookups (get document details / get submission). */
const holds = new Map<string, { internalId: string; submissionUid: string; status?: string }>();
let lookupDown = false;
/** The document JSON LHDN was sent for each code, as it arrived. */
const sentJson = new Map<string, string>();
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
        const [d] = (JSON.parse(init.body as string) as { documents: { codeNumber: string; document: string }[] }).documents;
        if (failNext === "refused") {
          failNext = null;
          return Response.json({ error: { message: "Bad request" } }, { status: 400 });
        }
        if (failNext === "unavailable") {
          failNext = null;
          return Response.json({ error: { message: "Maintenance" } }, { status: 503 });
        }
        sent.push(d.codeNumber);
        sentJson.set(d.codeNumber, Buffer.from(d.document, "base64").toString("utf8"));
        if (failNext) {
          const how = failNext;
          failNext = null;
          if (how === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
          if (how === "gateway") return Response.json({ error: { message: "Bad gateway" } }, { status: 502 });
          return new Response("<html>not json</html>", { status: 200 });
        }
        if (gate) {
          gate.entered();
          await gate.release;
        }
        return Response.json({ submissionUid: `S-${d.codeNumber}-${sent.length}`, acceptedDocuments: [{ uuid: `U-${d.codeNumber}-${sent.length}`, invoiceCodeNumber: d.codeNumber }] }, { status: 202 });
      }
      const details = url.match(/\/documents\/([^/]+)\/details$/);
      if (details) {
        if (lookupDown) throw new Error("connect ECONNREFUSED");
        const held = holds.get(decodeURIComponent(details[1]));
        if (!held) return Response.json({ error: { message: "Not found" } }, { status: 404 });
        return Response.json({ status: held.status ?? "Valid", longId: `LONG-${details[1]}`, internalId: held.internalId, submissionUid: held.submissionUid });
      }
      const submission = url.match(/\/documentsubmissions\/([^/]+)$/);
      if (submission) {
        if (lookupDown) throw new Error("connect ECONNREFUSED");
        const uid = decodeURIComponent(submission[1]);
        const docs = [...holds].filter(([, h]) => h.submissionUid === uid).map(([uuid, h]) => ({ uuid, internalId: h.internalId }));
        if (docs.length === 0) return Response.json({ error: { message: "Not found" } }, { status: 404 });
        return Response.json({ documentSummary: docs });
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

/** A customer's own e-invoice asked for while LHDN's answer goes wrong as `how` says: a draft, `failed`. */
async function askedWith(how: NonNullable<typeof failNext>) {
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
  failNext = how;
  const asked = await requestEInvoice(doc.ref, receiptToken(doc.ref), BUYER);
  if (!asked.ok) throw new Error(asked.error);
  return asked.einvoice;
}

const row = async (id: number) =>
  (await getDb()
    .prepare(
      "SELECT status, sending_at, submission_uid, uuid, error, outcome_unknown_at, last_attempt_at, attempt_payload, document, total::text AS total FROM e_invoices WHERE id = ?"
    )
    .get(id)) as {
    status: string;
    sending_at: string | null;
    submission_uid: string | null;
    uuid: string | null;
    error: string | null;
    outcome_unknown_at: string | null;
    last_attempt_at: string | null;
    attempt_payload: string | null;
    document: string | null;
    total: string;
  };

const listed = async (id: number) => (await listEInvoices(venueId)).find((e) => e.id === id)!;
const events = async (id: number) => (await listed(id)).history.map((h) => h.event);
/** What the venue's staff were told about a document, by recipient. */
const alertsAbout = async (code: string, to: string) =>
  (await getDb()
    .prepare("SELECT subject, body, locale FROM messages WHERE kind = 'staff_alert' AND recipient = ? AND subject LIKE ? ORDER BY id")
    .all(to, `%${code}%`)) as { subject: string; body: string; locale: string }[];
const MANAGER = "manager@sending.my";

const settle = () => new Promise((r) => setTimeout(r, 50));

beforeAll(async () => {
  const made = await createVenue({ name: "Sending Arena", area: "PJ", address: "x", phone: "0377771235" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  for (const [email, locale] of [
    [MANAGER, undefined],
    ["melayu@sending.my", "ms"],
    ["zhong@sending.my", "zh"],
  ] as const) {
    const staff = await createAdmin({ name: `Staff ${email}`, email, password: "a long enough password", venueId, role: "manager", locale });
    if (!staff.ok) throw new Error(staff.error);
  }
  forgetTokens();
  fakeMyInvois();
  expect((await saveEInvoiceSettings(venueId, SETTINGS)).ok).toBe(true);
  vi.unstubAllGlobals();
});

beforeEach(() => {
  forgetTokens();
  fakeMyInvois();
  sent.length = 0;
  failNext = null;
  downNext = false;
  lookupDown = false;
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

  it("is not sent again by itself when its sending was interrupted: it is an unknown outcome staff reconcile, then send", async () => {
    const draft = await notSent();
    // A sender stopped between asking LHDN and writing the answer down, long ago.
    await getDb()
      .prepare(
        "UPDATE e_invoices SET status = 'pending', error = NULL, outcome_unknown_at = NULL, sending_at = datetime('now', '-1 hours'), last_attempt_at = datetime('now', '-1 hours') WHERE id = ?"
      )
      .run(draft.id);
    const claimStart = (await row(draft.id)).last_attempt_at;
    await submitPending(venueId);
    expect(sent).toHaveLength(0);
    // Still a draft for every reader that treats `failed` so, but marked unknown, with the attempt's own time kept.
    expect(await row(draft.id)).toMatchObject({ status: "failed", sending_at: null, error: SENDING_INTERRUPTED, last_attempt_at: claimStart });
    expect((await row(draft.id)).outcome_unknown_at).not.toBeNull();
    const shown = await listed(draft.id);
    expect(shown).toMatchObject({ status: "failed", state: "unknown", outcome: "unknown", outcomeUnknown: true, lastAttemptAt: claimStart, error: null });
    expect(shown.actions).toEqual(["record", "send"]);
    // Sending it is refused until the manager says LHDN does not have it.
    expect(await retryEInvoice(draft.id, venueId)).toMatchObject({ ok: false, error: expect.stringContaining("not known") });
    expect(sent).toHaveLength(0);
    // Sent by staff once they have checked, once.
    expect(await retryEInvoice(draft.id, venueId, { notAtLhdn: true, by: { id: null, name: "Mgr Tan" } })).toMatchObject({
      ok: true,
      confirmedNotAtLhdn: true,
      einvoice: { status: "submitted", outcomeUnknown: false },
    });
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

describe("a submission whose outcome is unknown is not shown as not sent", () => {
  // A draft an earlier test left waiting is sent now, so that what is counted below is only what each test does.
  beforeEach(async () => {
    await submitPending(venueId);
    sent.length = 0;
  });

  it("keeps a clear failure (LHDN could not be reached) as Not sent, with no alert", async () => {
    const draft = await notSent();
    expect(await listed(draft.id)).toMatchObject({ state: "failed", outcome: null, outcomeUnknown: false, actions: ["send"] });
    expect(await events(draft.id)).toEqual(["claimed", "not_sent"]);
    expect((await row(draft.id)).outcome_unknown_at).toBeNull();
    expect((await row(draft.id)).attempt_payload).toBeNull();
    expect(await alertsAbout(draft.codeNumber, MANAGER)).toHaveLength(0);
    // A plain failure is sent again as before, without any confirmation.
    expect(await retryEInvoice(draft.id, venueId)).toMatchObject({ ok: true, einvoice: { status: "submitted" } });
    expect(await events(draft.id)).toEqual(["claimed", "not_sent", "claimed", "sent"]);
  });

  it("keeps LHDN saying it took nothing (a 400, a 503) as Not sent", async () => {
    for (const how of ["refused", "unavailable"] as const) {
      const e = await askedWith(how);
      expect(e).toMatchObject({ status: "failed", state: "failed", outcomeUnknown: false });
      expect(await alertsAbout(e.codeNumber, MANAGER)).toHaveLength(0);
    }
  });

  it.each(["timeout", "unreadable", "gateway"] as const)("shows a submission that ended in a %s as an unknown outcome, once told to staff", async (how) => {
    const e = await askedWith(how);
    // LHDN was sent it, and MySenam has no answer.
    expect(sent).toEqual([e.codeNumber]);
    expect(e).toMatchObject({ status: "failed", state: "unknown", outcome: "unknown", outcomeUnknown: true });
    expect(e.lastAttemptAt).not.toBeNull();
    expect(e.outcomeUnknownAt).not.toBeNull();
    expect(e.actions).toEqual(["record", "send"]);
    expect(await events(e.id)).toEqual(["claimed", "outcome_unknown"]);
    // What was sent is kept with the claim, for the record if LHDN turns out to hold it.
    expect(JSON.parse((await row(e.id)).attempt_payload!)).toMatchObject({ document: sentJson.get(e.codeNumber) });
    // Staff are told once, in their own language, and the scheduler never sends it again.
    await submitPending(venueId);
    await submitPending(venueId);
    expect(sent).toEqual([e.codeNumber]);
    expect(await alertsAbout(e.codeNumber, MANAGER)).toHaveLength(1);
    const [ms] = await alertsAbout(e.codeNumber, "melayu@sending.my");
    expect(ms.subject).toContain("hasil penyerahan tidak diketahui");
    const [zh] = await alertsAbout(e.codeNumber, "zhong@sending.my");
    expect(zh.subject).toContain("提交结果未知");
    const [en] = await alertsAbout(e.codeNumber, MANAGER);
    expect(en.subject).toContain("submission outcome unknown");
    expect(en.body).toContain("will not be sent again by itself");
  });

  it("tells staff once when a stale claim is found, however often the scheduler runs", async () => {
    const draft = await notSent();
    await getDb().prepare("UPDATE e_invoices SET status = 'pending', error = NULL, sending_at = datetime('now', '-1 hours') WHERE id = ?").run(draft.id);
    await submitPending();
    await submitPending();
    await submitPending(venueId);
    expect(await alertsAbout(draft.codeNumber, MANAGER)).toHaveLength(1);
    expect(await events(draft.id)).toEqual(["claimed", "not_sent", "outcome_unknown"]);
  });

  it("does not send one blindly: refused without the manager's word that LHDN does not have it, and that word is kept", async () => {
    const e = await askedWith("timeout");
    sent.length = 0;
    expect(await retryEInvoice(e.id, venueId, { notAtLhdn: false })).toMatchObject({ ok: false });
    expect(await retryEInvoice(e.id, venueId, {})).toMatchObject({ ok: false });
    expect(await submitOne(e.id)).toMatchObject({ status: "failed" });
    await submitPending(venueId);
    expect(sent).toHaveLength(0);
    const done = await retryEInvoice(e.id, venueId, { notAtLhdn: true, by: { id: null, name: "Mgr Tan" } });
    expect(done).toMatchObject({ ok: true, confirmedNotAtLhdn: true, einvoice: { status: "submitted", outcomeUnknown: false } });
    expect(sent).toEqual([e.codeNumber]);
    expect(await events(e.id)).toEqual(["claimed", "outcome_unknown", "confirmed_not_at_lhdn", "claimed", "sent"]);
    const confirm = (await listed(e.id)).history.find((h) => h.event === "confirmed_not_at_lhdn")!;
    expect(confirm.by).toBe("Mgr Tan");
    // Cleared once settled, so a later plain failure is not shown as unknown again; the history still says so.
    expect(await row(e.id)).toMatchObject({ outcome_unknown_at: null, attempt_payload: null, status: "submitted" });
  });

  it("is an ordinary failed draft when, sent again after the manager checked, it fails clearly this time", async () => {
    const e = await askedWith("gateway");
    downNext = true;
    const again = await retryEInvoice(e.id, venueId, { notAtLhdn: true, by: { id: null, name: "Mgr Tan" } });
    expect(again).toMatchObject({ ok: true, einvoice: { status: "failed", state: "failed", outcomeUnknown: false } });
    expect(await events(e.id)).toEqual(["claimed", "outcome_unknown", "confirmed_not_at_lhdn", "claimed", "not_sent"]);
  });

  it("shows a row left by the old interruption wording as unknown too, and never deletes it as a draft LHDN never had", async () => {
    const draft = await notSent();
    await getDb().prepare("UPDATE e_invoices SET error = ?, outcome_unknown_at = NULL, created_at = datetime('now', '-30 years') WHERE id = ?").run(SENDING_INTERRUPTED, draft.id);
    const shown = await listed(draft.id);
    expect(shown).toMatchObject({ state: "unknown", outcomeUnknown: true, actions: ["record", "send"], lastAttemptAt: expect.any(String) });
    expect(await retryEInvoice(draft.id, venueId)).toMatchObject({ ok: false });
    // Ordinary old drafts go at the end of the statutory period; one LHDN may hold does not.
    const plain = await notSent();
    await getDb().prepare("UPDATE e_invoices SET created_at = datetime('now', '-30 years') WHERE id = ?").run(plain.id);
    const due = await einvoicesDue();
    expect(due).toBeGreaterThanOrEqual(1);
    await pruneEInvoices();
    expect(await row(draft.id)).toMatchObject({ status: "failed" });
    expect(await getDb().prepare("SELECT 1 FROM e_invoices WHERE id = ?").get(plain.id)).toBeUndefined();
    // A history goes with a draft that never was in doubt (the cascade), and with nothing else.
    expect(await getDb().prepare("SELECT 1 FROM e_invoice_attempts WHERE e_invoice_id = ?").get(plain.id)).toBeUndefined();
    await expect(getDb().prepare("DELETE FROM e_invoices WHERE id = ?").run(draft.id)).resolves.toBeDefined();
  });

  it("keeps each attempt's history append-only", async () => {
    const e = await askedWith("timeout");
    await expect(getDb().prepare("UPDATE e_invoice_attempts SET detail = 'x' WHERE e_invoice_id = ?").run(e.id)).rejects.toThrow(/never edited or deleted/);
    await expect(getDb().prepare("DELETE FROM e_invoice_attempts WHERE e_invoice_id = ?").run(e.id)).rejects.toThrow(/never edited or deleted/);
    expect((await listed(e.id)).history.length).toBeGreaterThanOrEqual(2);
  });
});

describe("LHDN has it: recording what the portal shows", () => {
  // A draft an earlier test left waiting is sent now, so that what is counted below is only what each test does.
  beforeEach(async () => {
    await submitPending(venueId);
    sent.length = 0;
  });

  /** An unknown outcome that LHDN, it turns out, did receive: it holds it under these identifiers. */
  async function heldByLhdn() {
    const e = await askedWith("timeout");
    const uuid = `UUID${e.id}ABCDEFGHIJKLMNOP`;
    const submissionUid = `SUB${e.id}ABCDEFGHIJKLMNOPQ`;
    holds.set(uuid, { internalId: e.codeNumber, submissionUid });
    return { e, uuid, submissionUid };
  }
  const MGR = { id: null, name: "Mgr Tan" };

  it("records the identifiers by the document UUID, with what was sent as it was kept, and the document is then frozen", async () => {
    const { e, uuid, submissionUid } = await heldByLhdn();
    const before = await row(e.id);
    const done = await recordFromPortal(e.id, venueId, { documentUuid: uuid }, MGR);
    expect(done).toMatchObject({ ok: true, einvoice: { uuid, submissionUid, outcomeUnknown: false, status: "valid", actions: ["recheck"] } });
    const after = await row(e.id);
    // The payload and total are what the attempt built when it was claimed.
    expect(after.document).toBe(sentJson.get(e.codeNumber));
    expect(JSON.parse(before.attempt_payload!).document).toBe(after.document);
    expect(after.attempt_payload).toBeNull();
    expect(Number(after.total)).toBe(JSON.parse(before.attempt_payload!).total);
    expect(after.submission_uid).toBe(submissionUid);
    expect(await events(e.id)).toEqual(["claimed", "outcome_unknown", "recorded_from_portal"]);
    expect((await listed(e.id)).history.at(-1)).toMatchObject({ by: "Mgr Tan", detail: expect.stringContaining(uuid) });
    // The sent-frozen trigger now holds it, as for any document LHDN has.
    await expect(getDb().prepare("UPDATE e_invoices SET total = 1 WHERE id = ?").run(e.id)).rejects.toThrow(/does not change/);
    await expect(getDb().prepare("DELETE FROM e_invoices WHERE id = ?").run(e.id)).rejects.toThrow(/kept/);
    // Not unknown any more, not sendable, and recording again is refused.
    expect(await retryEInvoice(e.id, venueId, { notAtLhdn: true })).toMatchObject({ ok: false });
    expect(await recordFromPortal(e.id, venueId, { documentUuid: uuid }, MGR)).toMatchObject({ ok: false });
    expect(sent).toEqual([e.codeNumber]);
  });

  it("records by the submission ID alone, finding the document of this number in it", async () => {
    const { e, uuid, submissionUid } = await heldByLhdn();
    holds.set(`OTHERUUID${e.id}ABCDEFGH`, { internalId: "SOMEONE-ELSES", submissionUid });
    expect(await recordFromPortal(e.id, venueId, { submissionUid }, MGR)).toMatchObject({ ok: true, einvoice: { uuid, submissionUid, status: "valid" } });
  });

  it("records what LHDN says of it: found invalid, or still being validated", async () => {
    const a = await heldByLhdn();
    holds.get(a.uuid)!.status = "Submitted";
    expect(await recordFromPortal(a.e.id, venueId, { documentUuid: a.uuid }, MGR)).toMatchObject({ ok: true, einvoice: { status: "submitted", actions: ["recheck"] } });
  });

  it("refuses and changes nothing when the document under those identifiers is not this one", async () => {
    const { e, uuid, submissionUid } = await heldByLhdn();
    holds.set("UUIDOFANOTHERDOCUMENT1", { internalId: "CON-1999-01", submissionUid: "SUBOFANOTHER1" });
    const wrong = await recordFromPortal(e.id, venueId, { documentUuid: "UUIDOFANOTHERDOCUMENT1" }, MGR);
    expect(wrong).toMatchObject({ ok: false, error: expect.stringContaining("CON-1999-01") });
    // A submission that holds no document of ours; a UUID that is another document of ours' submission; a submission that differs.
    expect(await recordFromPortal(e.id, venueId, { submissionUid: "SUBOFANOTHER1" }, MGR)).toMatchObject({ ok: false, error: expect.stringContaining("holds no document numbered") });
    expect(await recordFromPortal(e.id, venueId, { submissionUid, documentUuid: "UUIDOFANOTHERDOCUMENT1" }, MGR)).toMatchObject({ ok: false });
    holds.set(uuid, { internalId: e.codeNumber, submissionUid: "SUBDIFFERENT" });
    expect(await recordFromPortal(e.id, venueId, { submissionUid, documentUuid: uuid }, MGR)).toMatchObject({ ok: false });
    // LHDN not answering that number at all; nothing given; something that is no identifier.
    expect(await recordFromPortal(e.id, venueId, { documentUuid: "NOSUCHDOCUMENT0001" }, MGR)).toMatchObject({ ok: false, error: expect.stringContaining("could not be asked") });
    expect(await recordFromPortal(e.id, venueId, {}, MGR)).toMatchObject({ ok: false });
    expect(await recordFromPortal(e.id, venueId, { documentUuid: "../../x?y" }, MGR)).toMatchObject({ ok: false });
    expect(await row(e.id)).toMatchObject({ status: "failed", uuid: null, submission_uid: null, document: null });
    expect((await row(e.id)).outcome_unknown_at).not.toBeNull();
    expect(await events(e.id)).toEqual(["claimed", "outcome_unknown"]);
  });

  it("changes nothing and says why when LHDN cannot be asked", async () => {
    const { e, uuid } = await heldByLhdn();
    lookupDown = true;
    expect(await recordFromPortal(e.id, venueId, { documentUuid: uuid }, MGR)).toMatchObject({ ok: false, error: expect.stringContaining("could not be asked") });
    expect(await row(e.id)).toMatchObject({ status: "failed", uuid: null });
    expect((await listed(e.id)).outcomeUnknown).toBe(true);
  });

  it("refuses a UUID another e-invoice here already holds, and a document that is not an unknown outcome", async () => {
    const a = await heldByLhdn();
    expect((await recordFromPortal(a.e.id, venueId, { documentUuid: a.uuid }, MGR)).ok).toBe(true);
    const b = await heldByLhdn();
    holds.set(a.uuid, { internalId: b.e.codeNumber, submissionUid: a.submissionUid });
    expect(await recordFromPortal(b.e.id, venueId, { documentUuid: a.uuid }, MGR)).toMatchObject({ ok: false, error: expect.stringContaining("already holds") });
    const plain = await notSent();
    expect(await recordFromPortal(plain.id, venueId, { documentUuid: a.uuid }, MGR)).toMatchObject({ ok: false, error: expect.stringContaining("outcome at LHDN is unknown") });
  });

  it("records a row marked before migration 0260 (no payload kept) with LHDN's identifiers only", async () => {
    const e = await notSent();
    await getDb().prepare("UPDATE e_invoices SET error = ?, outcome_unknown_at = NULL, last_attempt_at = NULL WHERE id = ?").run(SENDING_INTERRUPTED, e.id);
    const uuid = `UUIDLEGACY${e.id}ABCDEFGHIJ`;
    holds.set(uuid, { internalId: e.codeNumber, submissionUid: `SUBLEGACY${e.id}ABCDEFGH` });
    expect(await recordFromPortal(e.id, venueId, { documentUuid: uuid }, MGR)).toMatchObject({ ok: true, einvoice: { uuid, outcomeUnknown: false } });
    expect(await row(e.id)).toMatchObject({ document: null, status: "valid" });
  });
});
