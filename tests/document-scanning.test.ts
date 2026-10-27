import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
// Any temporary file the upload or the scan wrote would land here: it must stay empty.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "docscan-"));
const SCRATCH = fs.mkdtempSync(path.join(TMP, "x-"));
process.env.TMPDIR = SCRATCH;
process.env.TMP = SCRATCH;
process.env.TEMP = SCRATCH;

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { uploaded } from "../src/lib/approval-documents";
import { placeRetentionHold } from "../src/lib/approval-retention";
import { apply, customerAct, decide, linkCoachAccount, openDocument, requestById, saveRequirement, type ApplyInput } from "../src/lib/approvals";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { saveCoach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { ClamdScanner, parseClamdAddress, readReply, scanMode, setDocumentScanner, signaturesDate } from "../src/lib/document-scanner";
import {
  checkScanner,
  MAX_MANUAL_RETRIES,
  MAX_SCAN_ATTEMPTS,
  requeueWaitingDocuments,
  retryDocumentScan,
  RETRY_MINUTES,
  scanDocument,
  scanDueDocuments,
  scannerHealth,
} from "../src/lib/document-scanning";
import { addManaged } from "../src/lib/managed-people";
import { exportCustomerData, pruneOldData } from "../src/lib/privacy";
import { createResources } from "../src/lib/resources";
import { createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as myRoute from "../src/app/api/my/approvals/route";
import * as myDocRoute from "../src/app/api/my/approvals/document/route";
import * as adminDocRoute from "../src/app/api/admin/approvals/document/route";
import * as coachDocRoute from "../src/app/api/my/reviews/document/route";
import * as policyRoute from "../src/app/api/admin/document-policy/route";
import { fakeScanner, type FakeScanner } from "./helpers/scanner";

/**
 * Supporting documents are scanned for malware before anybody can open them
 * (lib/document-scanning.ts; docs/architecture/security.md#supporting-documents;
 * ADR 0024), against a stand-in scanner here, and clamd's protocol against
 * stand-in sockets. The real engine: tests/document-scanning-engine.test.ts.
 *
 * Stored in quarantine, `pending`, never handed out; released (`clean`) only
 * by the server's own call to the scanner; `rejected` when it finds
 * something (the bytes wiped at once); `failed` after a bounded number of
 * tries; never clean by default. An approval that needs a document waits for
 * a clean one. Nobody outside the application's own people learns anything
 * of a document in any state.
 */

const ZONE = "Asia/Kuala_Lumpur";
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const PDF = Buffer.from(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "latin1"
);
/** A PDF that passes the structural checks and carries the EICAR test string in a comment. */
const EICAR_PDF = Buffer.concat([PDF.subarray(0, 9), Buffer.from(`% ${EICAR}\n`, "latin1"), PDF.subarray(9)]);
const doc = (bytes = PDF) => uploaded(Buffer.from(bytes), "certificate.pdf", "application/pdf");

let n = 0;
let venueA: number;
let venueB: number;
let staffA: { id: number; name: string; cookie: string };
let staffB: { id: number; name: string; cookie: string };
let coachOk: { id: number; cookie: string };
let coachOther: { id: number; cookie: string };
let scanner: FakeScanner;

async function customer() {
  const made = await registerUser({ name: `Scan ${++n}`, email: `docscan${n}@scan.test`, phone: `0178${String(n).padStart(6, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now') WHERE id = ?").run(made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function staffMember(venueId: number | null, name: string) {
  const made = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}@scan.test`, password: "a long enough password", venueId });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}`, admin: made.admin };
}

async function coach(venueId: number, name: string) {
  const made = await saveCoach(venueId, { name, sports: ["kayak"], rate: 50, hours: [] });
  if (!made.ok) throw new Error(made.error);
  const account = await customer();
  const linked = await linkCoachAccount(venueId, made.coach.id, account.email);
  if (!linked.ok) throw new Error(linked.error);
  return { id: made.coach.id, cookie: account.cookie };
}

const diving = (extra: Partial<ApplyInput> = {}): ApplyInput => ({
  venueId: venueA,
  sport: "kayak",
  declaration: true,
  adult: true,
  certReference: "PADI Open Water 12345, PADI",
  certExpiresOn: addDays(todayISO(ZONE), 300),
  ...extra,
});

const get = (url: string, cookie: string | null) =>
  new NextRequest(url, { method: "GET", headers: { "x-forwarded-for": `10.88.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}) } });

const db = () => getDb();
const docRow = async (id: number) =>
  (await db()
    .prepare("SELECT scan_status, scan_failure, scan_attempts, scan_next_at, scan_finding, scan_error, scan_engine, octet_length(content) AS bytes FROM approval_documents WHERE id = ?")
    .get(id)) as {
    scan_status: string;
    scan_failure: string | null;
    scan_attempts: number;
    scan_next_at: Date | null;
    scan_finding: string | null;
    scan_error: string | null;
    scan_engine: string | null;
    bytes: number;
  };
/** As if its next try were due now. */
const dueNow = (id: number) => db().prepare("UPDATE approval_documents SET scan_next_at = now() - interval '1 second' WHERE id = ?").run(id);
const staff = () => ({ kind: "staff" as const, admin: { id: staffA.id, name: staffA.name } });

async function applied(bytes = PDF) {
  const me = await customer();
  const made = await apply(me, diving(), [doc(bytes)]);
  if (!made.ok) throw new Error(`${made.code}: ${made.error}`);
  return { me, requestId: made.request.id, docId: made.request.documents[0].id };
}

beforeAll(async () => {
  const make = async (name: string, phone: string) => {
    const v = await createVenue({ name, area: "Puchong", address: "x", phone, openMin: 7 * 60, closeMin: 23 * 60 });
    if (!v.ok) throw new Error("venue");
    return v.venue.id;
  };
  venueA = await make("Scan Pool Puchong", "0312349401");
  venueB = await make("Scan Pool Cheras", "0312349402");
  for (const v of [venueA, venueB]) {
    const r = await createResources({ venueId: v, sport: "kayak", name: "Dive pool", offPeakRate: 30, peakRate: 30, capacity: 10 });
    if (!r.ok) throw new Error(r.error);
  }
  staffA = await staffMember(venueA, "Sara Scan");
  staffB = await staffMember(venueB, "Sam Elsewhere");
  coachOk = await coach(venueA, "Cleo Coach");
  coachOther = await coach(venueA, "Dev Coach");
  for (const venueId of [venueA, venueB]) {
    const saved = await saveRequirement(venueId, {
      sport: "kayak",
      kind: "certification",
      documentLabel: "Your diving certification card",
      documentPurpose: "Diving here needs proof of an open-water certification.",
      declaration: "The certification I send is my own and in force.",
      validDays: 365,
      coachIds: venueId === venueA ? [coachOk.id] : [],
    });
    if (!saved.ok) throw new Error(saved.error);
  }
});

beforeEach(() => {
  scanner = fakeScanner();
  setDocumentScanner(scanner);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => setDocumentScanner(null));


describe("quarantine until the scan passes", () => {
  it("keeps a document unopenable, and its application unapprovable, while the scanner is away; releases it once the scan passes", async () => {
    scanner.answer = { kind: "error", error: "unavailable", detail: "ECONNREFUSED" };
    const { me, requestId, docId } = await applied();
    const first = await docRow(docId);
    expect(first).toMatchObject({ scan_status: "pending", scan_attempts: 1 });
    expect((await requestById(requestId))!.documents[0].scan).toBe("pending");
    // Nobody opens it: not the applicant, not the venue, not its coach.
    expect(await openDocument(docId, { kind: "customer", userId: me.id, name: me.name })).toEqual({ withheld: "pending" });
    const res = await adminDocRoute.GET(get(`http://localhost/api/admin/approvals/document?venueId=${venueA}&id=${docId}`, staffA.cookie));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "SCAN_NOT_RELEASED", scan: "pending" });
    expect((await coachDocRoute.GET(get(`http://localhost/api/my/reviews/document?id=${docId}`, coachOk.cookie))).status).toBe(409);
    // Withheld openings are not recorded as openings.
    expect(((await db().prepare("SELECT COUNT(*)::int AS n FROM approval_document_access WHERE document_id = ?").get(docId)) as { n: number }).n).toBe(0);
    // A review that needs the document cannot be completed.
    expect(await decide(staff(), requestId, "approve", { venueId: venueA })).toMatchObject({ ok: false, code: "SCAN_NOT_CLEAN", status: 409 });
    // Its next try is not due yet: the scheduler leaves it.
    await scanDueDocuments();
    expect((await docRow(docId)).scan_attempts).toBe(1);
    // The scanner is back; the next try is due.
    scanner.answer = { kind: "clean", engine: "FakeScan 1.0/2/Mon Oct 26 07:00:00 2026" };
    await dueNow(docId);
    await scanDueDocuments();
    expect(await docRow(docId)).toMatchObject({ scan_status: "clean", scan_attempts: 2, scan_next_at: null, scan_engine: "FakeScan 1.0/2/Mon Oct 26 07:00:00 2026" });
    const opened = await myDocRoute.GET(get(`http://localhost/api/my/approvals/document?id=${docId}`, me.cookie));
    expect(opened.status).toBe(200);
    expect(Buffer.from(await opened.arrayBuffer()).equals(PDF)).toBe(true);
    expect(await decide(staff(), requestId, "approve", { venueId: venueA })).toMatchObject({ ok: true, request: { status: "approved" } });
  });

  it("scans at once when the scanner answers, so a document sent is usually released straight away", async () => {
    const { docId, requestId } = await applied();
    expect((await docRow(docId)).scan_status).toBe("clean");
    expect(scanner.calls).toBe(1);
    expect((await requestById(requestId))!.documents[0].scan).toBe("clean");
  });

  it("holds the review while a second document sent in answer is still being checked", async () => {
    const { me, requestId } = await applied();
    expect((await decide(staff(), requestId, "ask", { venueId: venueA, reason: "The card is blurred; send a clearer one." })).ok).toBe(true);
    scanner.answer = { kind: "error", error: "timeout", detail: "no answer" };
    const answered = await customerAct(me, requestId, "answer", { answer: "A clearer scan" }, [doc()]);
    expect(answered).toMatchObject({ ok: true });
    expect((answered as { request: { documents: { scan: string }[] } }).request.documents.map((d) => d.scan)).toEqual(["clean", "pending"]);
    // One clean is not enough while another sent for the review is still being checked.
    expect(await decide(staff(), requestId, "approve", { venueId: venueA })).toMatchObject({ ok: false, code: "SCAN_NOT_CLEAN" });
  });
});

describe("what the scanner says", () => {
  it("found something: refused at once, its bytes wiped, recorded in the history, never opened; logs name no contents", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
    scanner.answer = (content) => (content.includes(Buffer.from("EICAR-STANDARD")) ? { kind: "found", finding: "Eicar-Test-Signature", engine: "FakeScan" } : { kind: "clean", engine: "FakeScan" });
    const { me, requestId, docId } = await applied(EICAR_PDF);
    expect(await docRow(docId)).toMatchObject({ scan_status: "rejected", scan_finding: "Eicar-Test-Signature", bytes: 0, scan_next_at: null });
    const request = (await requestById(requestId))!;
    expect(request.documents[0]).toMatchObject({ scan: "rejected", size: EICAR_PDF.length });
    expect(request.events.map((e) => e.action)).toContain("scan_rejected");
    expect(await openDocument(docId, { kind: "staff", adminId: staffA.id, name: staffA.name, venueId: venueA })).toEqual({ withheld: "rejected" });
    expect(await decide(staff(), requestId, "approve", { venueId: venueA })).toMatchObject({ ok: false, code: "SCAN_NOT_CLEAN" });
    // The applicant's export lists it, without bytes.
    const exported = (await exportCustomerData(me.id))!.approvals as { documents: { malwareScan: string; base64: string | null }[] }[];
    expect(exported.flatMap((a) => a.documents)).toEqual([expect.objectContaining({ malwareScan: "rejected", base64: null })]);
    // The log says which document and which signature, never the contents or whose it is.
    expect(logged.join("\n")).toContain(`supporting document ${docId}`);
    expect(logged.join("\n")).not.toContain("EICAR-STANDARD");
    expect(logged.join("\n")).not.toContain(me.name);
    // A late, repeated result changes nothing.
    scanner.answer = { kind: "clean", engine: "FakeScan" };
    expect(await scanDocument(docId)).toBe("rejected");
  });

  it("unavailable, timed out or inconclusive: tried again on a bounded schedule, then failed for good, never clean", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The last try is an answer a working scanner could not give for this document: unscannable, for good.
    const errors = [
      { kind: "error" as const, error: "inconclusive" as const, detail: "Can't allocate memory ERROR" },
      { kind: "error" as const, error: "unavailable" as const, detail: "ECONNREFUSED" },
      { kind: "error" as const, error: "timeout" as const, detail: "no answer" },
    ];
    let i = 0;
    scanner.answer = () => errors[i++ % errors.length];
    const { requestId, docId } = await applied();
    for (let attempt = 1; attempt < MAX_SCAN_ATTEMPTS; attempt++) {
      const row = await docRow(docId);
      expect(row.scan_status).toBe("pending");
      expect(row.scan_attempts).toBe(attempt);
      // The next try is that many minutes on.
      const wait = (new Date(row.scan_next_at!).getTime() - Date.now()) / 60_000;
      expect(wait).toBeGreaterThan(RETRY_MINUTES[attempt - 1] - 1);
      expect(wait).toBeLessThanOrEqual(RETRY_MINUTES[attempt - 1]);
      await dueNow(docId);
      await scanDueDocuments();
    }
    const failed = await docRow(docId);
    expect(failed).toMatchObject({ scan_status: "failed", scan_failure: "unscannable", scan_attempts: MAX_SCAN_ATTEMPTS, scan_next_at: null });
    expect(failed.scan_error).toMatch(/^inconclusive:/);
    expect(scanner.calls).toBe(MAX_SCAN_ATTEMPTS);
    // No more tries, whatever is asked.
    await dueNow(docId).catch(() => undefined);
    await scanDueDocuments();
    expect(await scanDocument(docId)).toBe("failed");
    expect(scanner.calls).toBe(MAX_SCAN_ATTEMPTS);
    expect((await requestById(requestId))!.events.map((e) => e.action)).toContain("scan_failed");
    expect(await openDocument(docId, { kind: "staff", adminId: staffA.id, name: staffA.name, venueId: venueA })).toEqual({ withheld: "failed" });
    expect(await decide(staff(), requestId, "approve", { venueId: venueA })).toMatchObject({ ok: false, code: "SCAN_NOT_CLEAN" });
    // Asking for more, or refusing, is still open to the reviewer.
    expect((await decide(staff(), requestId, "ask", { venueId: venueA, reason: "Please send the card again." })).ok).toBe(true);
  });

  it("too large for the scanner's limits fails at once; a scanner that throws is a failed try", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    scanner.answer = { kind: "error", error: "too_large", detail: "size limit exceeded" };
    const big = await applied();
    expect(await docRow(big.docId)).toMatchObject({ scan_status: "failed", scan_attempts: 1 });
    scanner.answer = () => {
      throw new Error("boom");
    };
    const thrown = await applied();
    expect(await docRow(thrown.docId)).toMatchObject({ scan_status: "pending", scan_attempts: 1 });
  });

  it("repeated and concurrent scans of one document scan it once and settle it once", async () => {
    let release: () => void = () => undefined;
    scanner.answer = { kind: "error", error: "unavailable", detail: "away" };
    const { docId } = await applied();
    expect(scanner.calls).toBe(1);
    scanner.answer = () => new Promise((resolve) => (release = () => resolve({ kind: "clean", engine: "FakeScan" })));
    await dueNow(docId);
    const first = scanDocument(docId);
    await vi.waitFor(() => expect(scanner.calls).toBe(2));
    // Claimed by the first: the second (another instance, the scheduler, a retry) leaves it alone.
    expect(await scanDocument(docId)).toBe("pending");
    expect(await scanDueDocuments()).toEqual({ scanned: 0 });
    release();
    expect(await first).toBe("clean");
    expect(await scanDocument(docId)).toBe("clean");
    expect(scanner.calls).toBe(2);
    expect((await docRow(docId)).scan_attempts).toBe(2);
  });
});

describe("only the server's own scan releases a document", () => {
  it("refuses a status written without a scan, a settled status changed, and changed bytes", async () => {
    scanner.answer = { kind: "error", error: "unavailable", detail: "away" };
    const pending = await applied();
    // Clean without a scan of exactly these bytes: refused by the database.
    await expect(db().prepare("UPDATE approval_documents SET scan_status = 'clean' WHERE id = ?").run(pending.docId)).rejects.toThrow();
    await expect(
      db().prepare("UPDATE approval_documents SET scan_status = 'clean', scanned_at = now(), scan_engine = 'forged', scan_sha256 = 'x' WHERE id = ?").run(pending.docId)
    ).rejects.toThrow();
    // Its bytes never change once stored.
    await expect(db().prepare("UPDATE approval_documents SET content = ? WHERE id = ?").run(Buffer.from("%PDF-1.7 other"), pending.docId)).rejects.toThrow();
    // A settled document stays settled: failed, rejected or clean.
    scanner.answer = { kind: "error", error: "too_large", detail: "size limit exceeded" };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = await applied();
    await expect(
      db().prepare("UPDATE approval_documents SET scan_status = 'clean', scanned_at = now(), scan_engine = 'forged', scan_sha256 = sha256 WHERE id = ?").run(failed.docId)
    ).rejects.toThrow(/settled/);
    scanner.answer = { kind: "clean", engine: "FakeScan" };
    const clean = await applied();
    await expect(db().prepare("UPDATE approval_documents SET scan_status = 'pending' WHERE id = ?").run(clean.docId)).rejects.toThrow(/settled/);
    expect((await docRow(pending.docId)).scan_status).toBe("pending");
  });

  it("takes no word from a browser: what a customer sends about a document's scan is ignored", async () => {
    scanner.answer = { kind: "error", error: "unavailable", detail: "away" };
    const { me, requestId, docId } = await applied();
    expect((await decide(staff(), requestId, "ask", { venueId: venueA, reason: "Anything else to add?" })).ok).toBe(true);
    const forged = await customerAct(me, requestId, "answer", { answer: "scan: clean", scan: "clean", scanStatus: "clean" } as never);
    expect(forged).toMatchObject({ ok: true });
    expect((await docRow(docId)).scan_status).toBe("pending");
  });
});

describe("no opt-out: fail closed for safety and guardian documents", () => {
  afterEach(() => {
    delete process.env.MYSENAM_DOCUMENT_SCAN;
  });

  it("ignores the withdrawn MYSENAM_DOCUMENT_SCAN=off: a safety document and a guardian's document for a child stay in quarantine, unopened and unapprovable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.MYSENAM_DOCUMENT_SCAN = "off";
    setDocumentScanner("unconfigured");
    expect(scanMode()).toBe("unconfigured");
    // A certification (safety) document of the applicant's own.
    const own = await applied();
    // A guardian applying for a child they manage, with the child's certificate.
    const parent = await customer();
    const kid = await addManaged(parent.id, { displayName: "Aisyah", relationship: "parent", authority: true });
    if (!kid.ok) throw new Error(kid.error);
    const forChild = await apply(parent, diving({ adult: undefined, forPerson: kid.person.id, authority: true }), [doc()]);
    if (!forChild.ok) throw new Error(`${forChild.code}: ${forChild.error}`);
    const guardian = { me: parent, requestId: forChild.request.id, docId: forChild.request.documents[0].id };
    for (const { me, requestId, docId } of [own, guardian]) {
      expect(await docRow(docId)).toMatchObject({ scan_status: "pending", scan_engine: null });
      expect((await myDocRoute.GET(get(`http://localhost/api/my/approvals/document?id=${docId}`, me.cookie))).status).toBe(409);
      expect((await adminDocRoute.GET(get(`http://localhost/api/admin/approvals/document?venueId=${venueA}&id=${docId}`, staffA.cookie))).status).toBe(409);
      expect(await decide(staff(), requestId, "approve", { venueId: venueA })).toMatchObject({ ok: false, code: "SCAN_NOT_CLEAN" });
    }
    // The status the opt-out wrote is gone from the database: nothing can be stored as taken unscanned.
    await expect(db().prepare("UPDATE approval_documents SET scan_status = 'not_scanned' WHERE id = ?").run(own.docId)).rejects.toThrow();
    // Once a scanner is there, they are scanned like any other, and only then released.
    setDocumentScanner(scanner);
    for (const { docId } of [own, guardian]) {
      await dueNow(docId);
      expect(await scanDocument(docId)).toBe("clean");
    }
  });

  it("takes documents into quarantine with no scanner configured, so nothing sent is lost; tries run out into waiting, never into release or removal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setDocumentScanner("unconfigured");
    const { me, requestId, docId } = await applied();
    expect((await requestById(requestId))!.status).toBe("pending");
    expect(await docRow(docId)).toMatchObject({ scan_status: "pending", scan_attempts: 1 });
    expect((await docRow(docId)).scan_error).toMatch(/^unavailable: no scanner configured/);
    for (let i = 1; i < MAX_SCAN_ATTEMPTS; i++) {
      await dueNow(docId);
      await scanDueDocuments();
    }
    expect(await docRow(docId)).toMatchObject({ scan_status: "failed", scan_failure: "scanner_unavailable", scan_attempts: MAX_SCAN_ATTEMPTS });
    const request = (await requestById(requestId))!;
    expect(request.documents[0]).toMatchObject({ scan: "failed", scanWaiting: true });
    // Waiting is not a failure of the document: the application's history does not say it could not be checked.
    expect(request.events.map((e) => e.action)).not.toContain("scan_failed");
    expect(await openDocument(docId, { kind: "customer", userId: me.id, name: me.name })).toEqual({ withheld: "failed" });
    // Long past the quarantine period, it is still kept: no scanner is no reason to remove it.
    await db().prepare("UPDATE approval_documents SET scanned_at = now() - interval '60 days' WHERE id = ?").run(docId);
    await pruneOldData();
    expect((await docRow(docId)).scan_status).toBe("failed");
  });
});

describe("scanning a failed document again", () => {
  let owner: Awaited<ReturnType<typeof staffMember>>;
  let manager: Awaited<ReturnType<typeof staffMember>>;
  const retries = async (docId: number) =>
    (await db()
      .prepare("SELECT kind, by_name, reason, outcome, settled_at FROM approval_document_scan_retries WHERE document_id = ? ORDER BY id")
      .all(docId)) as { kind: string; by_name: string; reason: string; outcome: string; settled_at: Date | null }[];
  const post = (body: Record<string, unknown>, cookie: string) =>
    policyRoute.POST(
      new NextRequest("http://localhost/api/admin/document-policy", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.89.${++n % 250}.${n % 200}`, cookie },
        body: JSON.stringify(body),
      })
    );
  /** A document that failed for good: too large for the scanner's limits. */
  async function unscannable() {
    scanner.answer = { kind: "error", error: "too_large", detail: "size limit exceeded" };
    const made = await applied();
    expect(await docRow(made.docId)).toMatchObject({ scan_status: "failed", scan_failure: "unscannable" });
    return made;
  }

  beforeAll(async () => {
    owner = await staffMember(null, "Rina Retry Owner");
    manager = await staffMember(venueA, "Mona Venue Manager");
  });

  it("is the platform owner's alone, with a reason; it puts the same bytes back in quarantine, never releases them, and records who, when, why and the outcome", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { me, docId } = await unscannable();
    const before = (await db().prepare("SELECT content, sha256 FROM approval_documents WHERE id = ?").get(docId)) as { content: Uint8Array; sha256: string };
    // Not the venue's staff, not without a reason.
    expect(await retryDocumentScan(manager.admin, { documentId: docId, reason: "Please try again" })).toMatchObject({ ok: false, code: "SCAN_RETRY_OWNER", status: 403 });
    expect((await post({ action: "retry", documentId: docId, reason: "Please try again" }, staffA.cookie)).status).toBe(403);
    expect(await retryDocumentScan(owner.admin, { documentId: docId, reason: "" })).toMatchObject({ ok: false, code: "SCAN_RETRY_REASON" });
    // The scanner still cannot answer for it: back in quarantine, never released, failed again.
    scanner.answer = { kind: "error", error: "unavailable", detail: "ECONNREFUSED" };
    expect(await retryDocumentScan(owner.admin, { documentId: docId, reason: "StreamMaxLength raised to 25M" })).toMatchObject({ ok: true, status: "pending", alreadyQueued: false });
    const row = await docRow(docId);
    expect(row).toMatchObject({ scan_status: "pending", scan_failure: null, scan_attempts: 1 });
    expect(await openDocument(docId, { kind: "customer", userId: me.id, name: me.name })).toEqual({ withheld: "pending" });
    // Asked again while it waits: nothing more happens, nothing more is counted.
    const again = await post({ action: "retry", documentId: docId, reason: "Clicked twice by mistake" }, owner.cookie);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "pending", alreadyQueued: true });
    expect(await retries(docId)).toEqual([expect.objectContaining({ kind: "manual", by_name: owner.name, reason: "StreamMaxLength raised to 25M", outcome: "queued", settled_at: null })]);
    // Its scan passes: released by the scan, and the retry's outcome written.
    scanner.answer = { kind: "clean", engine: "FakeScan 1.0/3/Tue Oct 27 06:00:00 2026" };
    await dueNow(docId);
    await scanDueDocuments();
    expect(await docRow(docId)).toMatchObject({ scan_status: "clean", scan_failure: null });
    expect(await retries(docId)).toEqual([expect.objectContaining({ outcome: "clean", settled_at: expect.any(Date) })]);
    const after = (await db().prepare("SELECT content, sha256, scan_rounds FROM approval_documents WHERE id = ?").get(docId)) as { content: Uint8Array; sha256: string; scan_rounds: number };
    expect(Buffer.from(after.content).equals(Buffer.from(before.content))).toBe(true);
    expect(after).toMatchObject({ sha256: before.sha256, scan_rounds: 2 });
    // A clean document is not scanned again.
    expect(await retryDocumentScan(owner.admin, { documentId: docId, reason: "Once more, to be sure" })).toMatchObject({ ok: false, code: "SCAN_RETRY_NOT_FAILED", status: 409 });
    expect((await retries(docId)).map((r) => r.outcome)).toEqual(["clean", "refused_not_failed"]);
    // In the activity log, under the owner's name.
    const logged = (await db().prepare("SELECT admin_name, detail FROM staff_actions WHERE action = 'approval.scan_retry' ORDER BY id").all()) as { admin_name: string; detail: string }[];
    expect(logged[0]).toMatchObject({ admin_name: owner.name });
    expect(logged[0].detail).toContain(`supporting document ${docId}`);
  });

  it("refuses, and asks for a new upload, when the bytes changed or are gone; a refused document is unscannable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const changed = await unscannable();
    // Bytes changed behind the app's back (the guard trigger set aside, as only a direct database edit could).
    await db().prepare("ALTER TABLE approval_documents DISABLE TRIGGER approval_documents_scan_guard").run();
    try {
      await db().prepare("UPDATE approval_documents SET content = ? WHERE id = ?").run(Buffer.from("%PDF-1.7 something else %%EOF"), changed.docId);
    } finally {
      await db().prepare("ALTER TABLE approval_documents ENABLE TRIGGER approval_documents_scan_guard").run();
    }
    const res = await post({ action: "retry", documentId: changed.docId, reason: "Scanner was upgraded" }, owner.cookie);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "SCAN_RETRY_NEW_UPLOAD" });
    expect((await retries(changed.docId)).map((r) => r.outcome)).toEqual(["refused_integrity"]);
    expect((await docRow(changed.docId)).scan_status).toBe("failed");
    // The database itself refuses to put changed bytes back in quarantine.
    await expect(db().prepare("UPDATE approval_documents SET scan_status = 'pending', scan_failure = NULL WHERE id = ?").run(changed.docId)).rejects.toThrow(/settled/);
    // Gone: removed by retention, so there is nothing to scan.
    const gone = await unscannable();
    await db().prepare("UPDATE approval_documents SET scanned_at = now() - interval '8 days' WHERE id = ?").run(gone.docId);
    await pruneOldData();
    expect(await retryDocumentScan(owner.admin, { documentId: gone.docId, reason: "Scanner was upgraded" })).toMatchObject({ ok: false, code: "SCAN_RETRY_GONE", status: 404 });
  });

  it("is bounded: at most three retries by the owner, then a new upload is needed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { docId } = await unscannable();
    for (let i = 1; i <= MAX_MANUAL_RETRIES; i++) {
      expect(await retryDocumentScan(owner.admin, { documentId: docId, reason: `Attempt number ${i}` })).toMatchObject({ ok: true, status: "failed" });
    }
    expect(await retryDocumentScan(owner.admin, { documentId: docId, reason: "One more time" })).toMatchObject({ ok: false, code: "SCAN_RETRY_LIMIT" });
    expect((await retries(docId)).map((r) => r.outcome)).toEqual([...Array(MAX_MANUAL_RETRIES).fill("failed_unscannable"), "refused_limit"]);
    expect(scanner.calls).toBe(1 + MAX_MANUAL_RETRIES);
  });

  it("two retries at once put it back once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { docId } = await unscannable();
    scanner.answer = { kind: "error", error: "unavailable", detail: "away" };
    const both = await Promise.all([
      retryDocumentScan(owner.admin, { documentId: docId, reason: "First click on retry" }),
      retryDocumentScan(owner.admin, { documentId: docId, reason: "Second click on retry" }),
    ]);
    expect(both.every((r) => r.ok)).toBe(true);
    expect(both.filter((r) => r.ok && r.alreadyQueued)).toHaveLength(1);
    expect((await retries(docId)).filter((r) => r.outcome !== "refused_not_failed")).toHaveLength(1);
    expect((await docRow(docId)).scan_attempts).toBe(1);
  });

  it("lists failed documents for the owner only, with their retries and no contents, names or applicant", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { docId, me } = await unscannable();
    const asOwner = await policyRoute.GET(get("http://localhost/api/admin/document-policy", owner.cookie));
    const body = (await asOwner.json()) as { failed: Record<string, unknown>[] };
    const mine = body.failed.find((d) => d.id === docId)!;
    expect(mine).toMatchObject({ failure: "unscannable", intact: true, venueId: venueA, manualRetries: 0 });
    expect(JSON.stringify(body.failed)).not.toContain(me.name);
    expect(JSON.stringify(body.failed)).not.toContain("certificate.pdf");
    const asStaff = (await (await policyRoute.GET(get("http://localhost/api/admin/document-policy", staffA.cookie))).json()) as Record<string, unknown>;
    expect(asStaff.failed).toBeUndefined();
  });
});

describe("documents waiting for a scanner, and legacy documents", () => {
  it("go back into quarantine by themselves once the scanner answers again, and are scanned; not while it is down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    scanner.answer = { kind: "error", error: "unavailable", detail: "ECONNREFUSED" };
    const { requestId, docId } = await applied();
    for (let i = 1; i < MAX_SCAN_ATTEMPTS; i++) {
      await dueNow(docId);
      await scanDueDocuments();
    }
    expect(await docRow(docId)).toMatchObject({ scan_status: "failed", scan_failure: "scanner_unavailable" });
    // Still down: left waiting.
    scanner.state = { reachable: false, engine: null, signaturesAt: null, error: "unavailable: ECONNREFUSED" };
    expect(await requeueWaitingDocuments()).toEqual({ requeued: 0 });
    // A timeout from a scanner that then does not answer at all is the scanner's fault too.
    // Back: put back in quarantine by the app itself, and scanned.
    scanner.state = { reachable: true, engine: "FakeScan 1.0/4/Tue Oct 27 06:00:00 2026", signaturesAt: new Date().toISOString(), error: null };
    scanner.answer = { kind: "clean", engine: "FakeScan 1.0/4/Tue Oct 27 06:00:00 2026" };
    expect((await requeueWaitingDocuments()).requeued).toBeGreaterThanOrEqual(1);
    expect((await docRow(docId)).scan_status).toBe("pending");
    await scanDueDocuments(100);
    expect((await docRow(docId)).scan_status).toBe("clean");
    const history = (await db().prepare("SELECT kind, by_name, outcome FROM approval_document_scan_retries WHERE document_id = ?").all(docId)) as Record<string, string>[];
    expect(history).toEqual([{ kind: "recovery", by_name: "MySenam", outcome: "clean" }]);
    expect((await requestById(requestId))!.events.map((e) => e.action)).toContain("scan_requeued");
  });

  it("a timeout from a scanner that no longer answers leaves the document waiting, not unscannable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    scanner.answer = { kind: "error", error: "timeout", detail: "no answer" };
    scanner.state = { reachable: false, engine: null, signaturesAt: null, error: "timeout" };
    const { docId } = await applied();
    for (let i = 1; i < MAX_SCAN_ATTEMPTS; i++) {
      await dueNow(docId);
      await scanDueDocuments();
    }
    expect(await docRow(docId)).toMatchObject({ scan_status: "failed", scan_failure: "scanner_unavailable" });
    expect((await docRow(docId)).scan_error).toMatch(/^unavailable: no answer/);
  });

  it("a legacy document is never treated as clean or removed for want of a scanner, but goes at its own retention deadline, recorded as retention", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setDocumentScanner("unconfigured");
    const { requestId, docId } = await applied();
    // As migration 0159 marks a document stored before scanning existed, whose tries ran out with no scanner.
    await db()
      .prepare("UPDATE approval_documents SET legacy_reason = 'before_scanning', scan_status = 'failed', scan_failure = 'scanner_unavailable', scanned_at = now() - interval '200 days' WHERE id = ?")
      .run(docId);
    const health = await scannerHealth();
    expect(health.legacy.waiting).toBeGreaterThanOrEqual(1);
    expect(health.legacy.clean).toBe(0);
    await pruneOldData();
    expect((await docRow(docId)).scan_status).toBe("failed");
    expect((await requestById(requestId))!.documents[0]).toMatchObject({ scan: "failed", scanWaiting: true });
    // Its own deadline: the application was refused, and its review window has passed.
    expect((await decide(staff(), requestId, "reject", { venueId: venueA, reason: "Certificate not for this activity." })).ok).toBe(true);
    await pruneOldData();
    expect((await docRow(docId)).scan_status).toBe("failed");
    await db().prepare("UPDATE approval_requests SET decided_at = now() - interval '40 days', closed_at = now() - interval '40 days' WHERE id = ?").run(requestId);
    await pruneOldData();
    expect(await docRow(docId)).toBeUndefined();
    const removed = (await db().prepare("SELECT why, scan_status, scan_failure, legacy_reason FROM approval_document_removals WHERE document_id = ?").all(docId)) as Record<string, string>[];
    expect(removed).toEqual([{ why: "retention", scan_status: "failed", scan_failure: "scanner_unavailable", legacy_reason: "before_scanning" }]);
  });

  it("records refused and unscannable documents removed after the quarantine period as quarantine", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    scanner.answer = { kind: "error", error: "too_large", detail: "size limit exceeded" };
    const { docId } = await applied();
    await db().prepare("UPDATE approval_documents SET scanned_at = now() - interval '8 days' WHERE id = ?").run(docId);
    await pruneOldData();
    expect(await docRow(docId)).toBeUndefined();
    const removed = (await db().prepare("SELECT why, scan_failure FROM approval_document_removals WHERE document_id = ?").all(docId)) as Record<string, string>[];
    expect(removed).toEqual([{ why: "quarantine", scan_failure: "unscannable" }]);
  });

  it("tells the owners when documents wait for a scanner that is missing or down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setDocumentScanner("unconfigured");
    await applied();
    let health = await checkScanner();
    expect(health.problems).toEqual(expect.arrayContaining(["unconfigured"]));
    let alert = (await db().prepare("SELECT last_detail FROM system_alerts WHERE key = 'document-scanner'").get()) as { last_detail: string };
    expect(alert.last_detail).toContain("No malware scanner is configured");
    setDocumentScanner(scanner);
    scanner.state = { reachable: false, engine: null, signaturesAt: null, error: "unavailable: ECONNREFUSED" };
    health = await checkScanner();
    expect(health.problems).toEqual(expect.arrayContaining(["unreachable", "waiting"]));
    alert = (await db().prepare("SELECT last_detail FROM system_alerts WHERE key = 'document-scanner'").get()) as { last_detail: string };
    expect(alert.last_detail).toContain("no scanner answered");
  });
});

describe("who can see a document, in every state", () => {
  it("only the applicant, the venue's staff and its named coach; to everybody else it does not exist", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const docs: Record<string, { me: Awaited<ReturnType<typeof customer>>; docId: number }> = {};
    scanner.answer = { kind: "error", error: "unavailable", detail: "away" };
    docs.pending = await applied();
    scanner.answer = { kind: "clean", engine: "FakeScan" };
    docs.clean = await applied();
    scanner.answer = { kind: "found", finding: "Eicar-Test-Signature", engine: "FakeScan" };
    docs.rejected = await applied(EICAR_PDF);
    scanner.answer = { kind: "error", error: "too_large", detail: "size limit exceeded" };
    docs.failed = await applied();
    const stranger = await customer();
    const missing = 999_999;
    const notFound = await (await myDocRoute.GET(get(`http://localhost/api/my/approvals/document?id=${missing}`, stranger.cookie))).json();
    for (const [state, { me, docId }] of Object.entries(docs)) {
      const entitled = state === "clean" ? 200 : 409;
      expect((await myDocRoute.GET(get(`http://localhost/api/my/approvals/document?id=${docId}`, me.cookie))).status, state).toBe(entitled);
      expect((await adminDocRoute.GET(get(`http://localhost/api/admin/approvals/document?venueId=${venueA}&id=${docId}`, staffA.cookie))).status, state).toBe(entitled);
      expect((await coachDocRoute.GET(get(`http://localhost/api/my/reviews/document?id=${docId}`, coachOk.cookie))).status, state).toBe(entitled);
      // Nobody signed in.
      expect((await myDocRoute.GET(get(`http://localhost/api/my/approvals/document?id=${docId}`, null))).status, state).toBe(401);
      expect((await adminDocRoute.GET(get(`http://localhost/api/admin/approvals/document?venueId=${venueA}&id=${docId}`, null))).status, state).toBe(401);
      // Another customer, another venue's staff, a coach not named: the same answer as a document that does not exist.
      const strangers = [
        await myDocRoute.GET(get(`http://localhost/api/my/approvals/document?id=${docId}`, stranger.cookie)),
        await adminDocRoute.GET(get(`http://localhost/api/admin/approvals/document?venueId=${venueB}&id=${docId}`, staffB.cookie)),
        await coachDocRoute.GET(get(`http://localhost/api/my/reviews/document?id=${docId}`, coachOther.cookie)),
      ];
      for (const res of strangers) {
        expect(res.status, state).toBe(404);
        expect(await res.json(), state).toEqual(notFound);
      }
      // Venue B's staff cannot ask as venue A.
      expect((await adminDocRoute.GET(get(`http://localhost/api/admin/approvals/document?venueId=${venueA}&id=${docId}`, staffB.cookie))).status, state).toBe(403);
    }
  });
});

describe("the quarantine period", () => {
  it("removes what is left of refused and unscannable documents after it, unless a hold keeps the application", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    scanner.answer = { kind: "found", finding: "Eicar-Test-Signature", engine: "FakeScan" };
    const rejected = await applied(EICAR_PDF);
    scanner.answer = { kind: "error", error: "too_large", detail: "size limit exceeded" };
    const failed = await applied();
    const held = await applied();
    const owner = await staffMember(null, "Oona Owner");
    const hold = await placeRetentionHold(owner.admin, {
      venueId: venueA,
      requestId: held.requestId,
      basis: "dispute",
      reason: "The applicant disputes the refusal of their document.",
      reviewBy: addDays(todayISO(), 30),
    });
    expect(hold.ok).toBe(true);
    await db().prepare("UPDATE approval_documents SET scanned_at = now() - interval '6 days' WHERE id IN (?, ?, ?)").run(rejected.docId, failed.docId, held.docId);
    await pruneOldData();
    expect(await docRow(rejected.docId)).toBeDefined();
    await db().prepare("UPDATE approval_documents SET scanned_at = now() - interval '8 days' WHERE id IN (?, ?, ?)").run(rejected.docId, failed.docId, held.docId);
    await pruneOldData();
    expect(await docRow(rejected.docId)).toBeUndefined();
    expect(await docRow(failed.docId)).toBeUndefined();
    expect((await docRow(held.docId)).scan_status).toBe("failed");
    // The fact stays in the application's history.
    expect((await requestById(rejected.requestId))!.events.map((e) => e.action)).toContain("scan_rejected");
  });
});

describe("the scanner's health", () => {
  it("reports reachability, signature age and stuck documents, and tells the owners", async () => {
    scanner.state = { reachable: true, engine: "FakeScan 1.0/27800/Mon Oct 19 07:00:00 2026", signaturesAt: new Date(Date.now() - 72 * 3_600_000).toISOString(), error: null };
    let health = await scannerHealth();
    expect(health).toMatchObject({ mode: "scanner", reachable: true });
    expect(health.signatureAgeHours).toBeGreaterThan(71);
    expect(health.problems).toContain("signatures_old");
    scanner.state = { reachable: false, engine: null, signaturesAt: null, error: "unavailable: ECONNREFUSED" };
    health = await checkScanner();
    expect(health.problems).toContain("unreachable");
    const alert = (await db().prepare("SELECT subject, last_detail FROM system_alerts WHERE key = 'document-scanner'").get()) as { subject: string; last_detail: string };
    expect(alert.last_detail).toContain("does not answer");
    scanner.state = { reachable: true, engine: "FakeScan 1.0", signaturesAt: null, error: null };
    expect((await scannerHealth()).problems).toContain("signatures_unknown");
    setDocumentScanner("unconfigured");
    expect((await scannerHealth()).problems).toContain("unconfigured");
  });
});

describe("clamd's protocol", () => {
  it("reads its answers: clean, found, a size limit, anything else inconclusive, never clean", () => {
    expect(readReply("stream: OK", "ClamAV")).toEqual({ kind: "clean", engine: "ClamAV" });
    expect(readReply("stream: Eicar-Test-Signature FOUND\0", "ClamAV")).toEqual({ kind: "found", finding: "Eicar-Test-Signature", engine: "ClamAV" });
    expect(readReply("INSTREAM size limit exceeded. ERROR", "ClamAV")).toMatchObject({ kind: "error", error: "too_large" });
    for (const odd of ["", "stream: OK but not quite", "lstat() failed: ERROR", "OK"]) expect(readReply(odd, "ClamAV")).toMatchObject({ kind: "error", error: "inconclusive" });
    expect(signaturesDate("ClamAV 1.5.4/27800/Sun Oct 26 07:23:01 2026")).toBe("2026-10-26T07:23:01.000Z");
    expect(signaturesDate("ClamAV 1.5.4")).toBeNull();
    expect(parseClamdAddress("127.0.0.1:3310")).toEqual({ host: "127.0.0.1", port: 3310 });
    expect(parseClamdAddress("tcp://clamav")).toEqual({ host: "clamav", port: 3310 });
    expect(parseClamdAddress("clamav:99999")).toBeNull();
  });

  /** A stand-in clamd on a local port, answering each connection with `reply` (or not at all). */
  async function standIn(reply: ((command: string) => string | null) | null) {
    const received: Buffer[] = [];
    const server = net.createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (d) => {
        chunks.push(d);
        const all = Buffer.concat(chunks);
        const nul = all.indexOf(0);
        if (nul < 0 || !reply) return;
        const command = all.subarray(1, nul).toString();
        if (command === "INSTREAM") {
          // Wait for the terminating zero-length chunk.
          if (all.length < nul + 1 + 4 || all.readUInt32BE(all.length - 4) !== 0) return;
          received.push(all.subarray(nul + 1));
        }
        const answer = reply(command);
        if (answer !== null) socket.end(`${answer}\0`);
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    return { port, received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it("streams the bytes in chunks and reads clean and found", async () => {
    const body = Buffer.alloc(200 * 1024, 7);
    const server = await standIn((c) => (c === "VERSION" ? "ClamAV 1.5.4/27800/Sun Oct 26 07:23:01 2026" : c === "PING" ? "PONG" : "stream: OK"));
    try {
      const clamd = new ClamdScanner("127.0.0.1", server.port);
      expect(await clamd.scan(body)).toEqual({ kind: "clean", engine: "ClamAV 1.5.4/27800/Sun Oct 26 07:23:01 2026" });
      // Length-prefixed chunks, then a zero length: the bytes as sent.
      const stream = server.received[0];
      const parts: Buffer[] = [];
      for (let at = 0; ; ) {
        const len = stream.readUInt32BE(at);
        if (len === 0) break;
        parts.push(stream.subarray(at + 4, at + 4 + len));
        at += 4 + len;
      }
      expect(Buffer.concat(parts).equals(body)).toBe(true);
      expect(await clamd.status()).toMatchObject({ reachable: true, signaturesAt: "2026-10-26T07:23:01.000Z" });
    } finally {
      await server.close();
    }
    const found = await standIn((c) => (c === "VERSION" ? "ClamAV 1.5.4" : "stream: Eicar-Test-Signature FOUND"));
    try {
      expect(await new ClamdScanner("127.0.0.1", found.port).scan(Buffer.from(EICAR))).toMatchObject({ kind: "found", finding: "Eicar-Test-Signature" });
    } finally {
      await found.close();
    }
  });

  it("is unavailable when nothing listens, times out when nothing answers, and is inconclusive on nonsense", async () => {
    const closed = await standIn(null);
    const port = closed.port;
    await closed.close();
    expect(await new ClamdScanner("127.0.0.1", port).scan(PDF)).toMatchObject({ kind: "error", error: "unavailable" });
    expect(await new ClamdScanner("127.0.0.1", port).status()).toMatchObject({ reachable: false });
    const silent = await standIn(() => null);
    try {
      expect(await new ClamdScanner("127.0.0.1", silent.port, 300).scan(PDF)).toMatchObject({ kind: "error", error: "timeout" });
    } finally {
      await silent.close();
    }
    const nonsense = await standIn((c) => (c === "VERSION" ? "ClamAV 1.5.4" : "stream: maybe"));
    try {
      expect(await new ClamdScanner("127.0.0.1", nonsense.port).scan(PDF)).toMatchObject({ kind: "error", error: "inconclusive" });
    } finally {
      await nonsense.close();
    }
  });
});

describe("memory", () => {
  it("refuses an upload past the limit even when it declares no length, reading no further than the limit", async () => {
    const me = await customer();
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++pulled > 100) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const res = await myRoute.POST(
      new NextRequest("http://localhost/api/my/approvals", {
        method: "POST",
        body,
        duplex: "half",
        headers: { cookie: me.cookie, "content-type": "multipart/form-data; boundary=x", "x-forwarded-for": "10.89.1.1" },
      } as ConstructorParameters<typeof NextRequest>[1])
    );
    expect(res.status).toBe(413);
    // About 30 MB (three documents of 10 MB and the form) was read, not the 100 MB sent.
    expect(pulled).toBeLessThan(40);
  });
});

describe("temporary files", () => {
  it("none are written by uploading, checking or scanning", () => {
    expect(fs.readdirSync(SCRATCH)).toEqual([]);
  });
});
