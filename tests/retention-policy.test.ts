import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "fs";
import path from "path";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, type Admin } from "../src/lib/admin-auth";
import { uploaded } from "../src/lib/approval-documents";
import { approvalRetentionDue } from "../src/lib/approval-retention";
import { apply, decide, saveRequirement } from "../src/lib/approvals";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { setDocumentScanner } from "../src/lib/document-scanner";
import { pruneOldData } from "../src/lib/privacy";
import { createResources } from "../src/lib/resources";
import { DEFAULT_POLICY, policyEvents, recordPolicyReview, retentionPolicy, setRetentionPolicy } from "../src/lib/retention-policy";
import { createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import PrivacyPage from "../src/app/privacy/page";
import * as policyRoute from "../src/app/api/admin/document-policy/route";
import { passingScanner } from "./helpers/scanner";

/**
 * The install's own retention periods for applications (lib/retention-policy.ts;
 * docs/architecture/privacy.md#applications-to-be-approved-for-an-activity; ADR 0024).
 * The defaults are the product owner's provisional choice, not legal
 * requirements; the platform owner may set the install's own, an activity
 * may keep less, never more; until a review is recorded (who, when, on what
 * basis) they are shown as provisional, and any change lapses the review.
 */

let n = 0;
let venueId: number;
let owner: Admin;
let manager: Admin;
let ownerCookie: string;
let managerCookie: string;

async function admin(name: string, venue: number | null) {
  const made = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}@policy.test`, password: "a long enough password", venueId: venue });
  if (!made.ok) throw new Error(made.error);
  return made.admin;
}

const PDF = Buffer.from(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "latin1"
);

const req = (method: string, cookie: string, body?: unknown) =>
  new NextRequest("http://localhost/api/admin/document-policy", {
    method,
    headers: { cookie, "content-type": "application/json", "x-forwarded-for": `10.91.${++n % 250}.1` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

beforeAll(async () => {
  setDocumentScanner(passingScanner());
  const v = await createVenue({ name: "Policy Lake", area: "Putrajaya", address: "x", phone: "0312349601", openMin: 7 * 60, closeMin: 19 * 60 });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const r = await createResources({ venueId, sport: "kayak", name: "Kayak bay", offPeakRate: 20, peakRate: 20, capacity: 10 });
  if (!r.ok) throw new Error(r.error);
  owner = await admin("Pat Owner", null);
  manager = await admin("Max Manager", venueId);
  ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.id)).token}`;
});
afterAll(() => setDocumentScanner(null));

describe("the install's periods", () => {
  it("start as the owner's provisional defaults, with no review recorded, and say so in the privacy notice", async () => {
    const p = await retentionPolicy();
    expect(p).toMatchObject({ documentDays: 90, reviewDays: 30, recordDays: 365, quarantineDays: 7, provisional: true });
    expect(p.coverage.MY.reviews).toEqual([]);
    expect(p.coverage.SG.reviews).toEqual([]);
    expect(p).toMatchObject(DEFAULT_POLICY);
    const html = renderToStaticMarkup(await PrivacyPage());
    expect(html).toContain("These periods are provisional: they have not yet been reviewed by a lawyer.");
    expect(html).toContain("Copies in backups.");
    expect(html).toContain("erased again");
  });

  it("are the platform owner's to change, within wide bounds; a manager cannot", async () => {
    expect(await setRetentionPolicy(manager, { documentDays: 60 })).toMatchObject({ ok: false, status: 403 });
    expect((await policyRoute.POST(req("POST", managerCookie, { action: "set", documentDays: 60 }))).status).toBe(403);
    for (const bad of [{ documentDays: 3 }, { documentDays: 400 }, { reviewDays: 0 }, { recordDays: 20 }, { recordDays: 3000 }, { quarantineDays: 31 }, { documentDays: 20, reviewDays: 25 }])
      expect(await setRetentionPolicy(owner, bad), JSON.stringify(bad)).toMatchObject({ ok: false, status: 400 });
    expect(await retentionPolicy()).toMatchObject({ documentDays: 90, reviewDays: 30, recordDays: 365 });
  });

  it("record a review only with its provenance, per jurisdiction and period, as the owner's record, never as approval; a change lapses it, and all is kept", async () => {
    const full = {
      jurisdictions: ["MY"],
      scope: ["documentDays", "reviewDays", "recordDays", "quarantineDays"],
      reviewedOn: todayISO(),
      reviewerName: "Aisha Rahman",
      reviewerRole: "Advocate & Solicitor, High Court of Malaya",
      firm: "Rahman & Co",
      adviceReference: "Letter RC/2026/114",
      basis: "Reviewed against the retention principle for these purposes.",
    };
    // A name and a day are not a review: each part of its provenance is required.
    for (const [missing, error] of [
      [{ jurisdictions: [] }, "Say which jurisdiction"],
      [{ jurisdictions: ["MY", "ID"] }, "Say which jurisdiction"],
      [{ scope: [] }, "Say which periods"],
      [{ scope: ["documentDays", "erasureLedger"] }, "Say which periods"],
      [{ reviewerName: "" }, "reviewer's name"],
      [{ reviewerRole: "" }, "role or qualification"],
      [{ firm: "" }, "firm or organisation"],
      [{ adviceReference: "" }, "written advice"],
      [{ basis: "ok" }, "based on"],
      [{ reviewedOn: addDays(todayISO(), 1) }, "today or earlier"],
    ] as const)
      expect(await recordPolicyReview(owner, { ...full, ...missing }), JSON.stringify(missing)).toMatchObject({ ok: false, error: expect.stringContaining(error) });
    expect(await recordPolicyReview(manager, full)).toMatchObject({ ok: false, status: 403 });
    expect(await retentionPolicy()).toMatchObject({ provisional: true, home: "MY" });

    // Malaysia, every period; Singapore, the documents only: each recorded and shown on its own.
    const reviewed = await policyRoute.POST(req("POST", ownerCookie, { action: "review", ...full }));
    expect(reviewed.status).toBe(200);
    expect((await recordPolicyReview(owner, { ...full, jurisdictions: ["SG"], scope: ["documentDays"], reviewerName: "Tan Wei Ming", reviewerRole: "Advocate & Solicitor (Singapore)", firm: "Tan LLP", adviceReference: "Memo TL-88" })).ok).toBe(true);
    const policy = await retentionPolicy();
    expect(policy).toMatchObject({ provisional: false, home: "MY" });
    expect(policy.coverage.MY).toMatchObject({ provisional: [], reviews: [{ reviewerName: "Aisha Rahman", reviewerRole: full.reviewerRole, firm: "Rahman & Co", adviceReference: "Letter RC/2026/114", recordedBy: owner.name, periods: "90/30/365/7" }] });
    expect(policy.coverage.SG).toMatchObject({ covered: ["documentDays"], provisional: ["reviewDays", "recordDays", "quarantineDays"] });
    const html = renderToStaticMarkup(await PrivacyPage());
    expect(html).toContain("The platform owner has recorded a review of the periods for documents after the decision, documents kept for a review, closed applications, refused or unscannable documents in Malaysia by Aisha Rahman (Advocate &amp; Solicitor, High Court of Malaya, Rahman &amp; Co)");
    expect(html).toContain("MySenam has not verified it, and it is not a legal approval.");
    expect(html).not.toMatch(/legally approved|have been approved|were approved/i);
    // Singapore's review is not the Malaysian install's; on a Singapore install, what it leaves out stays provisional.
    expect(html).not.toContain("Tan Wei Ming");
    process.env.MYSENAM_COUNTRY = "SG";
    try {
      expect(await retentionPolicy()).toMatchObject({ home: "SG", provisional: true });
      const sg = renderToStaticMarkup(await PrivacyPage());
      expect(sg).toContain("Tan Wei Ming");
      expect(sg).toContain("Still provisional: documents kept for a review, closed applications, refused or unscannable documents.");
    } finally {
      delete process.env.MYSENAM_COUNTRY;
    }
    // Changing a period: every review lapses, and the periods are provisional again; a review dated before cannot be of them.
    const changed = await setRetentionPolicy(owner, { documentDays: 20, reviewDays: 10, recordDays: 120, quarantineDays: 3 });
    expect(changed).toMatchObject({ ok: true, policy: { documentDays: 20, reviewDays: 10, recordDays: 120, quarantineDays: 3, provisional: true, changedBy: owner.name } });
    expect((await retentionPolicy()).coverage.MY.reviews).toEqual([]);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM retention_policy_reviews WHERE lapsed_at IS NOT NULL").get()) as { n: number }).n).toBe(2);
    expect(await recordPolicyReview(owner, { ...full, reviewedOn: addDays(todayISO(), -1) })).toMatchObject({ ok: false, error: expect.stringContaining("before the periods were last changed") });
    const events = await policyEvents();
    expect(events.map((e) => e.kind)).toEqual(["changed", "reviewed", "reviewed"]);
    expect(events[0].detail).toContain("was 90, 30, 365, 7");
    expect(events[2].detail).toContain("not verified by MySenam");
    // Anybody on the staff reads the periods; only the owner sees the scanner and the record.
    const asManager = (await (await policyRoute.GET(req("GET", managerCookie))).json()) as Record<string, unknown>;
    expect(asManager).toMatchObject({ policy: { documentDays: 20 } });
    expect(asManager.scanner).toBeUndefined();
    const asOwner = (await (await policyRoute.GET(req("GET", ownerCookie))).json()) as Record<string, unknown>;
    expect(asOwner.scanner).toMatchObject({ mode: "scanner" });
    expect(asOwner.events).toHaveLength(3);
  });

  it("lapse a review recorded before provenance was required (migration 0162), keeping the record of it", async () => {
    const db = getDb();
    await db
      .prepare("UPDATE retention_policy SET reviewed_on = ?, reviewed_by = 'Old Name, Old Firm', review_basis = 'A basis only, no provenance.', review_recorded_by_name = 'Pat Owner', review_recorded_at = now() WHERE id = 1")
      .run(todayISO());
    await db.exec(fs.readFileSync(path.join(__dirname, "..", "db", "migrations", "0162_retention_review_provenance.sql"), "utf8"));
    const row = (await db.prepare("SELECT reviewed_on FROM retention_policy WHERE id = 1").get()) as { reviewed_on: string | null };
    expect(row.reviewed_on).toBeNull();
    const [lapsed] = await policyEvents(1);
    expect(lapsed).toMatchObject({ kind: "lapsed", by: "Migration 0162" });
    expect(lapsed.detail).toContain("Old Name, Old Firm");
    expect((await retentionPolicy()).provisional).toBe(true);
  });

  it("bound what an activity may set, and are what the retention run applies", async () => {
    const base = {
      sport: "kayak",
      declaration: "I can capsize and recover.",
      documentLabel: "Your paddling certificate",
      documentPurpose: "Taking a kayak out alone needs a certificate.",
    };
    // The install keeps documents 20 days now: an activity may not keep them 30.
    expect(await saveRequirement(venueId, { ...base, documentDays: 30 })).toMatchObject({ ok: false, error: "Documents are kept 1 to 20 days after the decision." });
    expect(await saveRequirement(venueId, { ...base, recordDays: 200 })).toMatchObject({ ok: false });
    expect((await saveRequirement(venueId, base)).ok).toBe(true);
    const made = await registerUser({ name: "Kay Paddler", email: "kay@policy.test", phone: "0176999001", password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now') WHERE id = ?").run(made.user.id);
    const applied = await apply(made.user, { venueId, sport: "kayak", declaration: true, adult: true }, [uploaded(Buffer.from(PDF), "cert.pdf", "application/pdf")]);
    if (!applied.ok) throw new Error(applied.error);
    const approved = await decide({ kind: "staff", admin: { id: manager.id, name: manager.name } }, applied.request.id, "approve", { venueId });
    expect(approved.ok).toBe(true);
    // Decided 21 days ago: past the install's 20 days for documents (the default 90 would have kept it).
    await getDb().prepare("UPDATE approval_requests SET decided_at = now() - interval '21 days' WHERE id = ?").run(applied.request.id);
    const due = await approvalRetentionDue();
    expect(due.find((l) => l.whatPhrase.key === "srv.ret.approvalDocuments")).toMatchObject({ days: 20, affected: 1 });
    expect(due.find((l) => l.whatPhrase.key === "srv.retx.quarantined")).toMatchObject({ days: 3 });
    await pruneOldData();
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM approval_documents WHERE request_id = ?").get(applied.request.id)) as { n: number }).n).toBe(0);
  });
});
