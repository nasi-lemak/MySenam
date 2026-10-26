import fs from "fs";
import os from "os";
import path from "path";
import { deflateSync } from "zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
// Any temporary file the upload path wrote would land here: it must stay empty.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "aprdoc-"));
const SCRATCH = fs.mkdtempSync(path.join(TMP, "x-"));
process.env.TMPDIR = SCRATCH;
process.env.TMP = SCRATCH;
process.env.TEMP = SCRATCH;

import sharp from "sharp";
import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { inspectPdf, MAX_PDF_PAGES, prepareDocument, safeFileName, uploaded } from "../src/lib/approval-documents";
import { apply, decide, linkCoachAccount, openDocument, saveRequirement, type ApplyInput } from "../src/lib/approvals";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { saveCoach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { exportCustomerData } from "../src/lib/privacy";
import { createResources } from "../src/lib/resources";
import { DOCUMENT_POLICY } from "../src/lib/security-headers";
import { createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { middleware } from "../src/middleware";
import * as myRoute from "../src/app/api/my/approvals/route";
import * as myDocRoute from "../src/app/api/my/approvals/document/route";
import * as adminDocRoute from "../src/app/api/admin/approvals/document/route";
import * as coachDocRoute from "../src/app/api/my/reviews/document/route";
import { setDocumentScanner } from "../src/lib/document-scanner";
import { passingScanner } from "./helpers/scanner";

// Documents are released only once the malware scan passes them (ADR 0024): a stand-in that passes everything,
// so these tests are about what happens around a released document. The scan itself: tests/document-scanning.test.ts.
beforeAll(() => setDocumentScanner(passingScanner()));
afterAll(() => setDocumentScanner(null));

/**
 * Supporting documents as PDFs, handled as documents that may hold sensitive
 * personal information (lib/approval-documents.ts; docs/architecture/security.md#supporting-documents):
 * what a file is comes from its bytes, never its name or declared type; a
 * PDF with encryption, scripts, actions, attachments, rich media or XFA, or
 * too many pages, is refused; it is handed out only as an attachment under a
 * policy that lets nothing in it run, only to the applicant, the venue's
 * staff and coaches authorised for that activity, and every opening is
 * recorded.
 */

// ------------------------------------------------------------ making PDFs

interface PdfOptions {
  pages?: number;
  /** Extra entries in the document catalogue. */
  catalog?: string;
  /** Extra entries in the trailer. */
  trailer?: string;
  /** Objects kept in a compressed object stream. */
  objStm?: string;
  /** The object stream's filter entry, as written. */
  objStmFilter?: string;
  /** Page objects kept in the object stream rather than in the open. */
  pagesInObjStm?: boolean;
  noEof?: boolean;
}

function pdf(o: PdfOptions = {}): Buffer {
  const n = o.pages ?? 1;
  const parts: Buffer[] = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const add = (s: string) => parts.push(Buffer.from(s, "latin1"));
  const kids = Array.from({ length: n }, (_, i) => `${10 + i} 0 R`).join(" ");
  add(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R ${o.catalog ?? ""}>>\nendobj\n`);
  add(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);
  const drawing = "BT /F1 12 Tf 72 712 Td (Certificate of competence) Tj ET";
  // A content stream with binary-looking bytes that happen to spell names: data, not syntax.
  const content = Buffer.concat([Buffer.from(drawing, "latin1"), Buffer.from("\n% /JavaScript /Launch /Encrypt\n", "latin1"), deflateSync(Buffer.from("x".repeat(500)))]);
  add(`3 0 obj\n<< /Length ${content.length} >>\nstream\n`);
  parts.push(content);
  add("\nendstream\nendobj\n");
  const pageObjects = Array.from({ length: n }, () => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 3 0 R >>`);
  let hidden = o.objStm ?? "";
  if (o.pagesInObjStm) hidden += pageObjects.join("\n");
  else for (const [i, p] of pageObjects.entries()) add(`${10 + i} 0 obj\n${p}\nendobj\n`);
  if (hidden) {
    const body = o.objStmFilter === "" ? Buffer.from(hidden, "latin1") : deflateSync(Buffer.from(hidden, "latin1"));
    add(`4 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Length ${body.length} ${o.objStmFilter ?? "/Filter /FlateDecode"} >>\nstream\n`);
    parts.push(body);
    add("\nendstream\nendobj\n");
  }
  add(`trailer\n<< /Root 1 0 R ${o.trailer ?? ""}>>\nstartxref\n0\n${o.noEof ? "" : "%%EOF\n"}`);
  return Buffer.concat(parts);
}

const code = async (file: Buffer, name?: string, type?: string) => {
  const r = await prepareDocument(uploaded(Buffer.from(file), name, type));
  return r.ok ? "ok" : r.code;
};

describe("what a PDF may be", () => {
  it("takes a plain PDF, by its bytes, with its pages counted and its name made safe", async () => {
    const made = await prepareDocument(uploaded(pdf({ pages: 2 }), "../../My Cert<script>.PDF", "application/pdf"));
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.document).toMatchObject({ contentType: "application/pdf", pages: 2, fileName: "My Cert script.pdf" });
    expect(made.document.content.equals(pdf({ pages: 2 }))).toBe(true);
    expect(made.document.sha256).toMatch(/^[0-9a-f]{64}$/);
    // No name or type given: the bytes decide.
    expect(await code(pdf())).toBe("ok");
    expect(await code(pdf(), "certificate", "application/octet-stream")).toBe("ok");
    // A destination to open at is a view, not an action: office suites write one.
    expect(await code(pdf({ catalog: "/OpenAction [10 0 R /XYZ null null 0]" }))).toBe("ok");
    // A link a reader clicks is allowed.
    expect(await code(pdf({ objStm: "<< /Type /Annot /Subtype /Link /A << /S /URI /URI (https://example.org/verify) >> >>" }))).toBe("ok");
    expect(safeFileName("", "pdf")).toBe("document.pdf");
  });

  it("refuses a file that is not what it says: wrong signature, a renamed program, HTML or SVG dressed as a PDF", async () => {
    expect(await code(Buffer.from("just some text, not a PDF at all"), "cert.pdf", "application/pdf")).toBe("APR_DOCUMENT_BAD");
    const exe = Buffer.concat([Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "latin1"), Buffer.alloc(200, 0x41)]);
    expect(await code(exe, "certificate.pdf", "application/pdf")).toBe("APR_DOCUMENT_BAD");
    expect(await code(Buffer.from("<!doctype html><html><script>alert(1)</script></html>"), "cert.pdf", "application/pdf")).toBe("APR_DOCUMENT_BAD");
    expect(await code(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), "cert.pdf", "image/svg+xml")).toBe("APR_DOCUMENT_BAD");
    expect(await code(Buffer.from("%PDF-1.7 <html><script>alert(1)</script></html>"), "cert.pdf")).toBe("APRDOC_PDF_BROKEN");
    // A real PDF under a name or type that says something else.
    expect(await code(pdf(), "certificate.exe")).toBe("APRDOC_MISMATCH");
    expect(await code(pdf(), "certificate.html", "text/html")).toBe("APRDOC_MISMATCH");
    expect(await code(pdf(), "certificate.pdf", "image/png")).toBe("APRDOC_MISMATCH");
    const jpeg = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#336699" } }).jpeg().toBuffer();
    expect(await code(jpeg, "scan.pdf", "application/pdf")).toBe("APRDOC_MISMATCH");
    expect(await code(jpeg, "scan.jpg", "image/jpeg")).toBe("ok");
    expect(await code(Buffer.alloc(0), "empty.pdf")).toBe("APR_DOCUMENT_BAD");
  });

  it("refuses encrypted PDFs, and any with scripts, actions, attachments, rich media or XFA, however written", async () => {
    expect(await code(pdf({ trailer: "/Encrypt 9 0 R" }))).toBe("APRDOC_PDF_ENCRYPTED");
    expect(await code(pdf({ catalog: "/OpenAction << /S /JavaScript /JS (app.alert(1)) >>" }))).toBe("APRDOC_PDF_ACTIVE");
    expect(await code(pdf({ catalog: "/OpenAction << /S /URI /URI (https://tracker.example) >>" }))).toBe("APRDOC_PDF_ACTIVE");
    expect(await code(pdf({ catalog: "/OpenAction 7 0 R" }))).toBe("APRDOC_PDF_ACTIVE");
    expect(await code(pdf({ catalog: "/Names << /JavaScript 8 0 R >>" }))).toBe("APRDOC_PDF_ACTIVE");
    // A name spelt with escapes is the same name.
    expect(await code(pdf({ catalog: "/Names << /J#61vaScript 8 0 R >>" }))).toBe("APRDOC_PDF_ACTIVE");
    expect(await code(pdf({ catalog: "/AA << /O << /S /Launch /F (calc.exe) >> >>" }))).toBe("APRDOC_PDF_ACTIVE");
    expect(await code(pdf({ catalog: "/Names << /EmbeddedFiles 8 0 R >>" }))).toBe("APRDOC_PDF_ACTIVE");
    expect(await code(pdf({ catalog: "/AcroForm << /XFA 8 0 R >>" }))).toBe("APRDOC_PDF_ACTIVE");
    expect(await code(pdf({ catalog: "/Extra << /Subtype /RichMedia >>" }))).toBe("APRDOC_PDF_ACTIVE");
    expect(await code(pdf({ catalog: "/Extra << /S /SubmitForm /F (https://x.example) >>" }))).toBe("APRDOC_PDF_ACTIVE");
    // Hidden in a compressed object stream: opened and checked the same way.
    expect(await code(pdf({ objStm: "<< /S /JavaScript /JS (app.launchURL('x')) >>" }))).toBe("APRDOC_PDF_ACTIVE");
    expect(await code(pdf({ objStm: "<< /Type /EmbeddedFile /Length 3 >>" }))).toBe("APRDOC_PDF_ACTIVE");
    expect(await code(pdf({ objStm: "<< /Encrypt 9 0 R >>" }))).toBe("APRDOC_PDF_ENCRYPTED");
    // One that cannot be opened here is not let through unchecked.
    expect(await code(pdf({ objStm: "<< /S /JavaScript >>", objStmFilter: "/Filter /LZWDecode" }))).toBe("APRDOC_PDF_BROKEN");
    expect(await code(pdf({ objStm: "<< /S /JavaScript >>", objStmFilter: "/Filter /FlateDecode /DecodeParms << /Predictor 12 >>" }))).toBe("APRDOC_PDF_BROKEN");
    expect(await code(pdf({ objStm: "<< /A 1 >>", objStmFilter: "/Filter [/ASCIIHexDecode /FlateDecode]" }))).toBe("APRDOC_PDF_BROKEN");
  });

  it("refuses a PDF with too many pages, none, or no proper end, counting pages wherever they are kept", async () => {
    expect(await code(pdf({ pages: MAX_PDF_PAGES }))).toBe("ok");
    expect(await code(pdf({ pages: MAX_PDF_PAGES + 1 }))).toBe("APRDOC_PDF_PAGES");
    expect(await code(pdf({ pages: MAX_PDF_PAGES + 1, pagesInObjStm: true }))).toBe("APRDOC_PDF_PAGES");
    expect(inspectPdf(pdf({ pages: 3, pagesInObjStm: true }))).toEqual({ ok: true, pages: 3 });
    expect(await code(pdf({ noEof: true }))).toBe("APRDOC_PDF_BROKEN");
    expect(await code(pdf({ pages: 0 }))).toBe("APRDOC_PDF_BROKEN");
  });

  it("refuses an oversized file, and an object stream that would decompress past the bound", async () => {
    const big = Buffer.concat([pdf(), Buffer.alloc(10 * 1024 * 1024)]);
    expect(await code(big)).toBe("APRDOC_TOO_BIG");
    // A small stream that opens into far more than any certificate holds.
    expect(await code(pdf({ objStm: "<< /A 1 >>" + " ".repeat(60 * 1024 * 1024) }))).toBe("APRDOC_TOO_BIG");
  });
});

// ------------------------------------------------------------ through the application

const ZONE = "Asia/Kuala_Lumpur";
let n = 0;
let venueA: number;
let venueB: number;
let staffA: { id: number; name: string; cookie: string };
let staffB: { id: number; name: string; cookie: string };
let coachOk: { id: number; cookie: string };
let coachOther: { id: number; cookie: string };

async function customer() {
  const made = await registerUser({ name: `Diver ${++n}`, email: `aprdoc${n}@doc.test`, phone: `0179${String(n).padStart(6, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now') WHERE id = ?").run(made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function staffMember(venueId: number, name: string) {
  const made = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}@doc.test`, password: "a long enough password", venueId });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

async function coach(venueId: number, name: string) {
  const made = await saveCoach(venueId, { name, sports: ["kayak"], rate: 50, hours: [] });
  if (!made.ok) throw new Error(made.error);
  // A coach reviews signed in to the account a manager linked to their record.
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
  new NextRequest(url, { method: "GET", headers: { "x-forwarded-for": `10.78.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}) } });

beforeAll(async () => {
  const make = async (name: string, phone: string) => {
    const v = await createVenue({ name, area: "Puchong", address: "x", phone, openMin: 7 * 60, closeMin: 23 * 60 });
    if (!v.ok) throw new Error("venue");
    return v.venue.id;
  };
  venueA = await make("Deep Blue Puchong", "0312349201");
  venueB = await make("Other Pool Cheras", "0312349202");
  for (const v of [venueA, venueB]) {
    const r = await createResources({ venueId: v, sport: "kayak", name: "Dive pool", offPeakRate: 30, peakRate: 30, capacity: 10 });
    if (!r.ok) throw new Error(r.error);
  }
  staffA = await staffMember(venueA, "Ana Staff");
  staffB = await staffMember(venueB, "Ben Staff");
  coachOk = await coach(venueA, "Cora Coach");
  coachOther = await coach(venueA, "Dan Coach");
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

describe("asking for a document", () => {
  it("needs the venue to say why, and still never an identity document", async () => {
    expect(await saveRequirement(venueA, { sport: "kayak", kind: "certification", documentLabel: "Your certification card", declaration: "I am certified to dive here." })).toMatchObject({
      ok: false,
      error: "Say why you need the document, in a sentence applicants will read.",
    });
    expect(
      await saveRequirement(venueA, { sport: "kayak", kind: "certification", documentLabel: "Your passport", documentPurpose: "To check who you are before diving." })
    ).toMatchObject({ ok: false });
    expect(
      await saveRequirement(venueA, { sport: "kayak", kind: "certification", documentLabel: "Your card", documentPurpose: "We need a copy of your MyKad for our records." })
    ).toMatchObject({ ok: false });
    // A venue whose settings predate the rule cannot take a document until it says why.
    await getDb().prepare("UPDATE approval_requirements SET document_purpose = NULL WHERE venue_id = ? AND sport = 'kayak'").run(venueB);
    const me = await customer();
    expect(await apply(me, diving({ venueId: venueB }), [uploaded(pdf(), "card.pdf", "application/pdf")])).toMatchObject({ ok: false, code: "APRDOC_NO_PURPOSE" });
    await getDb()
      .prepare("UPDATE approval_requirements SET document_purpose = 'Diving here needs proof of an open-water certification.' WHERE venue_id = ? AND sport = 'kayak'")
      .run(venueB);
  });

  it("takes a PDF sent as a form upload, writing no temporary file, and the customer sees its name, kind and size", async () => {
    const me = await customer();
    const form = new FormData();
    form.append("data", JSON.stringify(diving()));
    form.append("document", new File([new Uint8Array(pdf({ pages: 2 }))], "PADI card.pdf", { type: "application/pdf" }));
    const res = await myRoute.POST(new NextRequest("http://localhost/api/my/approvals", { method: "POST", body: form, headers: { cookie: me.cookie, "x-forwarded-for": "10.79.1.1" } }));
    expect(res.status).toBe(201);
    const { request } = (await res.json()) as { request: { documents: { fileName: string; contentType: string; pages: number; size: number }[] } };
    expect(request.documents).toEqual([expect.objectContaining({ fileName: "PADI card.pdf", contentType: "application/pdf", pages: 2, size: pdf({ pages: 2 }).length })]);
    expect(fs.readdirSync(SCRATCH)).toEqual([]);
  });

  it("refuses a disguised or scripted file sent as a form upload, and an oversized one before reading it", async () => {
    const me = await customer();
    const send = async (file: File) => {
      const form = new FormData();
      form.append("data", JSON.stringify(diving()));
      form.append("document", file);
      const res = await myRoute.POST(new NextRequest("http://localhost/api/my/approvals", { method: "POST", body: form, headers: { cookie: me.cookie, "x-forwarded-for": `10.79.2.${++n % 200}` } }));
      return { status: res.status, body: (await res.json()) as { code?: string } };
    };
    expect(await send(new File(["<html><script>alert(1)</script></html>"], "card.pdf", { type: "application/pdf" }))).toMatchObject({ status: 400, body: { code: "APR_DOCUMENT_BAD" } });
    expect(await send(new File([new Uint8Array(pdf())], "card.png", { type: "image/png" }))).toMatchObject({ status: 400, body: { code: "APRDOC_MISMATCH" } });
    expect(await send(new File([new Uint8Array(pdf({ catalog: "/OpenAction << /S /JavaScript /JS (x) >>" }))], "card.pdf", { type: "application/pdf" }))).toMatchObject({
      status: 400,
      body: { code: "APRDOC_PDF_ACTIVE" },
    });
    expect(await send(new File([new Uint8Array(pdf({ trailer: "/Encrypt 5 0 R" }))], "card.pdf", { type: "application/pdf" }))).toMatchObject({ status: 400, body: { code: "APRDOC_PDF_ENCRYPTED" } });
    expect((await send(new File([new Uint8Array(Buffer.alloc(10 * 1024 * 1024 + 1))], "card.pdf", { type: "application/pdf" }))).status).toBe(413);
    // Nothing was kept of any of them.
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM approval_requests WHERE user_id = ?").get(me.id)) as { n: number }).n).toBe(0);
    expect(fs.readdirSync(SCRATCH)).toEqual([]);
  });
});

describe("handing a PDF out", () => {
  let me: Awaited<ReturnType<typeof customer>>;
  let docId: number;
  let requestId: number;
  const file = pdf({ pages: 1 });
  beforeAll(async () => {
    me = await customer();
    const made = await apply(me, diving(), [uploaded(file, "Diving card.pdf", "application/pdf")]);
    if (!made.ok) throw new Error(made.error);
    docId = made.request.documents[0].id;
    requestId = made.request.id;
  });

  it("goes to the applicant as an attachment that nothing in it can run from, never cached", async () => {
    const res = await myDocRoute.GET(get(`http://localhost/api/my/approvals/document?id=${docId}`, me.cookie));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(file)).toBe(true);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="Diving card.pdf"; filename*=UTF-8''Diving%20card.pdf`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(DOCUMENT_POLICY);
    expect(DOCUMENT_POLICY).toContain("sandbox");
    expect(DOCUMENT_POLICY).toContain("default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("is served under the document policy wherever it is served, never the pages' one", () => {
    for (const url of ["/api/my/approvals/document?id=1", "/api/admin/approvals/document?venueId=1&id=1", "/api/my/reviews/document?id=1"])
      expect(middleware(new NextRequest(`http://localhost${url}`)).headers.get("content-security-policy"), url).toBe(DOCUMENT_POLICY);
    expect(middleware(new NextRequest("http://localhost/account/approvals")).headers.get("content-security-policy")).not.toBe(DOCUMENT_POLICY);
  });

  it("goes to the venue's staff and its authorised coach, and to nobody else: no session, another customer, another venue, another coach", async () => {
    expect((await myDocRoute.GET(get(`http://localhost/api/my/approvals/document?id=${docId}`, null))).status).toBe(401);
    const other = await customer();
    expect((await myDocRoute.GET(get(`http://localhost/api/my/approvals/document?id=${docId}`, other.cookie))).status).toBe(404);
    expect((await adminDocRoute.GET(get(`http://localhost/api/admin/approvals/document?venueId=${venueA}&id=${docId}`, staffA.cookie))).status).toBe(200);
    expect((await adminDocRoute.GET(get(`http://localhost/api/admin/approvals/document?venueId=${venueA}&id=${docId}`, null))).status).toBe(401);
    // Another venue's staff: refused at venue A, and not found asking as their own venue.
    expect((await adminDocRoute.GET(get(`http://localhost/api/admin/approvals/document?venueId=${venueA}&id=${docId}`, staffB.cookie))).status).toBe(403);
    expect((await adminDocRoute.GET(get(`http://localhost/api/admin/approvals/document?venueId=${venueB}&id=${docId}`, staffB.cookie))).status).toBe(404);
    const authorised = await coachDocRoute.GET(get(`http://localhost/api/my/reviews/document?id=${docId}`, coachOk.cookie));
    expect(authorised.status).toBe(200);
    expect(authorised.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect((await coachDocRoute.GET(get(`http://localhost/api/my/reviews/document?id=${docId}`, coachOther.cookie))).status).toBe(404);
    expect((await coachDocRoute.GET(get(`http://localhost/api/my/reviews/document?id=${docId}`, null))).status).toBe(401);
    expect(await openDocument(docId, { kind: "staff", adminId: staffB.id, name: staffB.name, venueId: venueB })).toBeNull();
  });

  it("records who opened it and when, and the applicant's export says so with the document itself", async () => {
    const opened = (await getDb()
      .prepare("SELECT viewer, viewer_name, user_id, admin_id, coach_id FROM approval_document_access WHERE document_id = ? ORDER BY id")
      .all(docId)) as { viewer: string; viewer_name: string; user_id: number | null; admin_id: number | null; coach_id: number | null }[];
    // Refused attempts open nothing and are not recorded as openings.
    expect(opened).toEqual([
      { viewer: "customer", viewer_name: me.name, user_id: me.id, admin_id: null, coach_id: null },
      { viewer: "staff", viewer_name: staffA.name, user_id: null, admin_id: staffA.id, coach_id: null },
      { viewer: "coach", viewer_name: "Cora Coach", user_id: null, admin_id: null, coach_id: coachOk.id },
    ]);
    const exported = (await exportCustomerData(me.id))!.approvals as { documents: { fileName: string; contentType: string; pages: number; base64: string }[]; documentsOpened: { name: string }[] }[];
    const mine = exported.find((a) => a.documents.length > 0)!;
    expect(mine.documents[0]).toMatchObject({ fileName: "Diving card.pdf", contentType: "application/pdf", pages: 1 });
    expect(Buffer.from(mine.documents[0].base64, "base64").equals(file)).toBe(true);
    expect(mine.documentsOpened.map((a) => a.name)).toEqual([me.name, staffA.name, "Cora Coach"]);
    expect(requestId).toBeGreaterThan(0);
  });

  it("is reviewed and approved like any document, the certification written from what was declared", async () => {
    const decided = await decide({ kind: "staff", admin: { id: staffA.id, name: staffA.name } }, requestId, "approve", { venueId: venueA });
    expect(decided).toMatchObject({ ok: true, request: { status: "approved" } });
  });
});
