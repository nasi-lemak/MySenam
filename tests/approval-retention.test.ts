import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, type Admin } from "../src/lib/admin-auth";
import { uploaded } from "../src/lib/approval-documents";
import { approvalRetentionDue, placeRetentionHold, releaseRetentionHold, retentionHoldsAt } from "../src/lib/approval-retention";
import { apply, customerAct, decide, expireApprovals, requestById, requirementFor, saveRequirement, type ApplyInput } from "../src/lib/approvals";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { APPLICATION_HELD, eraseCustomer, exportCustomerData, pruneOldData, retentionDue } from "../src/lib/privacy";
import { createResources } from "../src/lib/resources";
import { signOffHolds } from "../src/lib/sign-offs";
import { createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as holdsRoute from "../src/app/api/admin/approvals/holds/route";

/**
 * Purpose-based retention for applications to be approved for an activity
 * (lib/approval-retention.ts; docs/architecture/privacy.md#applications-to-be-approved-for-an-activity).
 * Documents go once no decision, review or appeal needs them; an
 * application's answers and history a set time after it closes; the approval
 * itself (the sign-off) stands while it is valid, whatever happens to the
 * application. Only a hold placed by somebody entitled to, with a reason and
 * a review date, keeps anything longer, and it ends unless renewed.
 */

let n = 0;
let venueA: number;
let venueB: number;
let manager: Admin;
let managerB: Admin;
let desk: Admin;
let owner: Admin;
let deskCookie: string;
let managerCookie: string;

const PDF = Buffer.from(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "latin1"
);
const doc = () => uploaded(Buffer.from(PDF), "paddling certificate.pdf", "application/pdf");

async function customer() {
  const made = await registerUser({ name: `Paddler ${++n}`, email: `aprret${n}@ret.test`, phone: `0176${String(n).padStart(6, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now') WHERE id = ?").run(made.user.id);
  return made.user;
}

async function admin(input: { name: string; venueId: number | null; role?: "manager" | "desk" }) {
  const made = await createAdmin({ ...input, email: `${input.name.toLowerCase().replace(/\W/g, "")}@ret.test`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.admin;
}

const kayak = (extra: Partial<ApplyInput> = {}): ApplyInput => ({
  venueId: venueA,
  sport: "kayak",
  answers: { q1: "Two seasons on the Klang river" },
  declaration: true,
  adult: true,
  ...extra,
});

async function applied(sport: "kayak" | "canoe" = "kayak") {
  const user = await customer();
  const made = await apply(user, kayak({ sport }), [doc()]);
  if (!made.ok) throw new Error(`${made.code}: ${made.error}`);
  return { user, id: made.request.id };
}

const staff = () => ({ kind: "staff" as const, admin: { id: manager.id, name: manager.name } });
async function reject(id: number) {
  const r = await decide(staff(), id, "reject", { venueId: venueA, reason: "The certificate is from a club, not a recognised body." });
  if (!r.ok) throw new Error(r.error);
}
async function approve(id: number) {
  const r = await decide(staff(), id, "approve", { venueId: venueA, reason: "Certificate checked." });
  if (!r.ok) throw new Error(r.error);
}

const db = () => getDb();
/** As if decided that long ago; an application already noted as closed by then closed then too. */
const decidedAgo = (id: number, days: number) =>
  db()
    .prepare(
      "UPDATE approval_requests SET decided_at = now() - make_interval(days => ?), closed_at = CASE WHEN closed_at IS NULL THEN NULL ELSE now() - make_interval(days => ?) END WHERE id = ?"
    )
    .run(days, days, id);
const documents = async (id: number) => ((await db().prepare("SELECT COUNT(*)::int AS n FROM approval_documents WHERE request_id = ?").get(id)) as { n: number }).n;
const row = async (id: number) =>
  (await db().prepare("SELECT * FROM approval_requests WHERE id = ?").get(id)) as Record<string, unknown> | undefined;

beforeAll(async () => {
  const make = async (name: string, phone: string) => {
    const v = await createVenue({ name, area: "Putrajaya", address: "x", phone, openMin: 7 * 60, closeMin: 19 * 60 });
    if (!v.ok) throw new Error("venue");
    return v.venue.id;
  };
  venueA = await make("Lake Paddle Putrajaya", "0312349301");
  venueB = await make("River Paddle Klang", "0312349302");
  for (const [v, sport] of [
    [venueA, "kayak"],
    [venueA, "canoe"],
  ] as const) {
    const r = await createResources({ venueId: v, sport, name: `${sport} bay`, offPeakRate: 20, peakRate: 20, capacity: 10 });
    if (!r.ok) throw new Error(r.error);
  }
  const base = {
    declaration: "I can capsize and recover, and will wear a buoyancy aid at all times.",
    documentLabel: "Your paddling certificate",
    documentPurpose: "Taking a kayak out alone needs a recognised paddling certificate.",
    questions: [{ text: "Where have you paddled before?" }],
    validDays: 365,
  };
  for (const input of [
    { ...base, sport: "kayak" },
    // An activity that keeps less than the install allows.
    { ...base, sport: "canoe", reviewDays: 7, documentDays: 20, recordDays: 60 },
  ]) {
    const saved = await saveRequirement(venueA, input);
    if (!saved.ok) throw new Error(saved.error);
  }
  manager = await admin({ name: "Mona Manager", venueId: venueA });
  managerB = await admin({ name: "Mike Elsewhere", venueId: venueB });
  desk = await admin({ name: "Dina Desk", venueId: venueA, role: "desk" });
  owner = await admin({ name: "Olive Owner", venueId: null });
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.id)).token}`;
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.id)).token}`;
});

describe("what an activity may set", () => {
  it("allows shorter periods, never longer, and needs the document's purpose", async () => {
    const canoe = (await requirementFor(venueA, "canoe"))!;
    expect(canoe).toMatchObject({ reviewDays: 7, documentDays: 20, recordDays: 60, documentPurpose: expect.stringContaining("recognised paddling certificate") });
    const base = { sport: "canoe", declaration: "I can capsize and recover safely.", documentLabel: "Your paddling certificate", documentPurpose: "A recognised certificate is needed." };
    expect(await saveRequirement(venueA, { ...base, reviewDays: 91 })).toMatchObject({ ok: false });
    expect(await saveRequirement(venueA, { ...base, documentDays: 0 })).toMatchObject({ ok: false });
    expect(await saveRequirement(venueA, { ...base, recordDays: 366 })).toMatchObject({ ok: false });
    expect(await saveRequirement(venueA, { ...base, recordDays: 20 })).toMatchObject({ ok: false });
    // Nor past the database's own limits, whatever writes it.
    await expect(db().prepare("UPDATE approval_requirements SET record_days = 400 WHERE venue_id = ? AND sport = 'canoe'").run(venueA)).rejects.toThrow();
  });
});

describe("refused, withdrawn or lapsed", () => {
  it("keeps the documents through the review window, the record a year, then only the bare facts", async () => {
    const { user, id } = await applied();
    await reject(id);
    await decidedAgo(id, 10);
    await pruneOldData();
    expect(await documents(id)).toBe(1);
    await decidedAgo(id, 31);
    expect((await approvalRetentionDue()).find((l) => l.whatPhrase.key === "srv.ret.approvalDocuments")!.affected).toBeGreaterThan(0);
    await pruneOldData();
    expect(await documents(id)).toBe(0);
    const kept = (await requestById(id))!;
    expect(kept.answers).toEqual({ q1: "Two seasons on the Klang river" });
    await decidedAgo(id, 366);
    await db().prepare("UPDATE approval_requests SET closed_at = decided_at WHERE id = ?").run(id);
    await pruneOldData();
    expect(await row(id)).toBeUndefined();
    expect(((await db().prepare("SELECT COUNT(*)::int AS n FROM approval_events WHERE request_id = ?").get(id)) as { n: number }).n).toBe(0);
    const audit = (await db().prepare("SELECT * FROM approval_audit WHERE request_id = ?").get(id)) as Record<string, unknown>;
    expect(audit).toMatchObject({ venue_id: venueA, sport: "kayak", user_id: user.id, outcome: "rejected", decided_by: manager.name, decided_by_kind: "staff", removed_why: "retention" });
    // The bare facts only: nothing answered, declared or sent, no name or number.
    expect(Object.keys(audit).sort()).toEqual(
      ["applied_at", "closed_at", "decided_at", "decided_by", "decided_by_kind", "id", "outcome", "removed_at", "removed_why", "request_id", "sport", "user_id", "venue_id"].sort()
    );
    // The customer's export still says it existed.
    const exported = (await exportCustomerData(user.id))!.approvals as { recordRemoved?: boolean; status: string; decidedBy?: string }[];
    expect(exported).toEqual([expect.objectContaining({ recordRemoved: true, status: "rejected", decidedBy: manager.name })]);
  });

  it("goes by the activity's own shorter window, and treats a withdrawal and a lapse alike", async () => {
    const canoe = await applied("canoe");
    const withdrawn = await customerAct(canoe.user, canoe.id, "withdraw");
    expect(withdrawn).toMatchObject({ ok: true, request: { status: "withdrawn" } });
    await decidedAgo(canoe.id, 8);
    const lapsing = await applied();
    await db().prepare("UPDATE approval_requests SET expires_at = now() - interval '1 minute' WHERE id = ?").run(lapsing.id);
    await expireApprovals();
    expect((await requestById(lapsing.id))!.status).toBe("expired");
    await decidedAgo(lapsing.id, 29);
    await pruneOldData();
    expect(await documents(canoe.id)).toBe(0);
    expect(await documents(lapsing.id)).toBe(1);
    await decidedAgo(lapsing.id, 31);
    await pruneOldData();
    expect(await documents(lapsing.id)).toBe(0);
    // The canoe's record goes at its own 60 days after closing, the kayak's not yet.
    await db().prepare("UPDATE approval_requests SET closed_at = now() - interval '61 days' WHERE id IN (?, ?)").run(canoe.id, lapsing.id);
    await pruneOldData();
    expect(await row(canoe.id)).toBeUndefined();
    expect(await row(lapsing.id)).toBeDefined();
  });
});

describe("approved", () => {
  it("keeps documents at most 90 days, then the answers a year, while the approval stands and still lets the person book", async () => {
    const { user, id } = await applied();
    await approve(id);
    await decidedAgo(id, 60);
    await pruneOldData();
    expect(await documents(id)).toBe(1);
    await decidedAgo(id, 91);
    await pruneOldData();
    expect(await documents(id)).toBe(0);
    expect((await requestById(id))!.answers).toEqual({ q1: "Two seasons on the Klang river" });
    // A year after the decision, the approval still valid (a longer period, here): the history detail goes, the approval stays.
    await db().prepare("UPDATE approval_requests SET valid_until = ? WHERE id = ?").run(addDays(todayISO(), 400), id);
    await db().prepare("UPDATE sign_offs SET expires_on = ? WHERE id = (SELECT sign_off_id FROM approval_requests WHERE id = ?)").run(addDays(todayISO(), 400), id);
    await decidedAgo(id, 366);
    expect((await approvalRetentionDue()).find((l) => l.whatPhrase.key === "srv.ret.approvalsMinimised")!.affected).toBeGreaterThan(0);
    await pruneOldData();
    const r = (await row(id))!;
    expect(r).toMatchObject({ status: "approved", name: "(removed)", phone: "", answers: "{}", declared_at: null, cert_reference: null, court_id: null });
    expect(r.minimised_at).not.toBeNull();
    const reasons = (await db().prepare("SELECT reason FROM approval_events WHERE request_id = ?").all(id)) as { reason: string | null }[];
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.every((e) => e.reason === null)).toBe(true);
    const shown = (await requestById(id))!;
    expect(shown).toMatchObject({ status: "approved", lapsed: false, revoked: false });
    expect(await signOffHolds({ venueId: venueA, sport: "kayak", until: addDays(todayISO(), 30), phone: user.phone, userId: user.id, channel: "customer", need: "any" })).toBe(true);
  });

  it("keeps the eligibility when the application record is gone: the sign-off says who, what, how long and who gave it", async () => {
    const { user, id } = await applied();
    await approve(id);
    const signOffId = ((await row(id))!.sign_off_id) as number;
    await db().prepare("DELETE FROM approval_requests WHERE id = ?").run(id);
    const s = (await db().prepare("SELECT venue_id, sport, user_id, kind, expires_on, admin_id, note, revoked_at FROM sign_offs WHERE id = ?").get(signOffId)) as Record<string, unknown>;
    expect(s).toMatchObject({ venue_id: venueA, sport: "kayak", user_id: user.id, kind: "operational", admin_id: manager.id, revoked_at: null });
    expect(s.expires_on).toBe(addDays(todayISO(), 364));
    expect(String(s.note)).toContain(manager.name);
    expect(await signOffHolds({ venueId: venueA, sport: "kayak", until: todayISO(), phone: user.phone, userId: user.id, channel: "customer", need: "any" })).toBe(true);
  });

  it("closes when the approval ends or is taken back: documents after the review window, the record a year after", async () => {
    const ended = await applied();
    await approve(ended.id);
    await decidedAgo(ended.id, 20);
    await db().prepare("UPDATE approval_requests SET valid_until = ? WHERE id = ?").run(addDays(todayISO(), -40), ended.id);
    const revoked = await applied();
    await approve(revoked.id);
    await db().prepare("UPDATE sign_offs SET revoked_at = (now() - interval '35 days')::text, revoke_reason = 'Unsafe on the water' WHERE id = (SELECT sign_off_id FROM approval_requests WHERE id = ?)").run(revoked.id);
    const standing = await applied();
    await approve(standing.id);
    await decidedAgo(standing.id, 20);
    await pruneOldData();
    // Ended or taken back more than the review window ago: documents gone, well inside 90 days of the decision.
    expect(await documents(ended.id)).toBe(0);
    expect(await documents(revoked.id)).toBe(0);
    expect(await documents(standing.id)).toBe(1);
    expect(String((await row(ended.id))!.closed_at)).not.toBe("null");
    expect((await row(standing.id))!.closed_at).toBeNull();
    await db().prepare("UPDATE approval_requests SET closed_at = now() - interval '366 days' WHERE id IN (?, ?)").run(ended.id, revoked.id);
    await pruneOldData();
    expect(await row(ended.id)).toBeUndefined();
    expect(await row(revoked.id)).toBeUndefined();
    expect(((await db().prepare("SELECT outcome FROM approval_audit WHERE request_id = ?").get(ended.id)) as { outcome: string }).outcome).toBe("approved");
  });
});

describe("holds", () => {
  it("only a manager of the venue or the platform owner may place one, with a reason, a basis and a review date", async () => {
    const { id } = await applied();
    const hold = (who: Admin, extra: Record<string, unknown> = {}) =>
      placeRetentionHold(who, { venueId: venueA, requestId: id, basis: "dispute", reason: "The customer disputes the refusal through a lawyer.", reviewBy: addDays(todayISO(), 60), ...extra });
    expect(await hold(desk)).toMatchObject({ ok: false, status: 403 });
    expect(await hold(managerB)).toMatchObject({ ok: false, status: 403 });
    expect(await placeRetentionHold(managerB, { venueId: venueB, requestId: id, basis: "dispute", reason: "Not this venue's application at all.", reviewBy: addDays(todayISO(), 30) })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await hold(manager, { basis: "because" })).toMatchObject({ ok: false, status: 400 });
    expect(await hold(manager, { reason: "keep" })).toMatchObject({ ok: false, status: 400 });
    expect(await hold(manager, { reviewBy: addDays(todayISO(), 91) })).toMatchObject({ ok: false, error: "Give a review date within 90 days." });
    expect(await hold(manager, { reviewBy: todayISO() })).toMatchObject({ ok: false });
    expect(await hold(owner, { reviewBy: addDays(todayISO(), 366) })).toMatchObject({ ok: false, error: "Give a review date within a year." });
    const placed = await hold(manager);
    expect(placed).toMatchObject({ ok: true, hold: { basis: "dispute", placedByName: manager.name, placedByRole: "manager", active: true, reviewBy: addDays(todayISO(), 60) } });
    expect(await hold(owner, { reviewBy: addDays(todayISO(), 300), basis: "legal" })).toMatchObject({ ok: true, hold: { placedByRole: "owner" } });
    const logged = (await db().prepare("SELECT admin_name, action, detail FROM staff_actions WHERE action = 'approval.hold' ORDER BY id").all()) as { admin_name: string; detail: string }[];
    expect(logged.map((l) => l.admin_name)).toEqual([manager.name, owner.name]);
    // Through the dashboard: the desk is turned away; a manager sees the venue's holds.
    const req = (method: string, cookie: string, body?: unknown) =>
      new NextRequest(`http://localhost/api/admin/approvals/holds?venueId=${venueA}`, { method, headers: { cookie, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect((await holdsRoute.GET(req("GET", deskCookie))).status).toBe(403);
    expect((await holdsRoute.POST(req("POST", deskCookie, { venueId: venueA, requestId: id, basis: "legal", reason: "A claim has been filed.", reviewBy: addDays(todayISO(), 10) }))).status).toBe(403);
    const listed = (await (await holdsRoute.GET(req("GET", managerCookie))).json()) as { holds: { requestId: number }[] };
    expect(listed.holds.filter((h) => h.requestId === id)).toHaveLength(2);
  });

  it("keeps a held application past every date, until the hold is released or its review date passes", async () => {
    const a = await applied();
    const b = await applied();
    for (const x of [a, b]) {
      await reject(x.id);
      await decidedAgo(x.id, 400);
      await db().prepare("UPDATE approval_requests SET closed_at = decided_at WHERE id = ?").run(x.id);
    }
    const ha = await placeRetentionHold(manager, { venueId: venueA, requestId: a.id, basis: "safety", reason: "Capsize incident on the lake under investigation.", reviewBy: addDays(todayISO(), 30) });
    const hb = await placeRetentionHold(owner, { venueId: venueA, requestId: b.id, basis: "legal", reason: "Solicitor's letter received about the refusal.", reviewBy: addDays(todayISO(), 200) });
    if (!ha.ok || !hb.ok) throw new Error("hold");
    await pruneOldData();
    expect(await documents(a.id)).toBe(1);
    expect(await documents(b.id)).toBe(1);
    expect((await requestById(a.id))!.answers).toEqual({ q1: "Two seasons on the Klang river" });
    // The account cannot be closed under it.
    expect(await eraseCustomer(a.user.id)).toEqual({ ok: false, error: APPLICATION_HELD });
    // A hold not renewed ends on its review date.
    await db().prepare("UPDATE approval_holds SET review_by = ? WHERE id = ?").run(addDays(todayISO(), -1), ha.hold.id);
    // A hold released early ends then.
    expect(await releaseRetentionHold(desk, { venueId: venueA, holdId: hb.hold.id, reason: "Settled." })).toMatchObject({ ok: false, status: 403 });
    expect(await releaseRetentionHold(manager, { venueId: venueA, holdId: hb.hold.id, reason: "" })).toMatchObject({ ok: false });
    expect(await releaseRetentionHold(manager, { venueId: venueA, holdId: hb.hold.id, reason: "The claim was withdrawn." })).toEqual({ ok: true });
    expect((await retentionHoldsAt(venueA)).find((h) => h.id === hb.hold.id)).toMatchObject({ active: false, releasedByName: manager.name, releaseReason: "The claim was withdrawn." });
    await pruneOldData();
    expect(await row(a.id)).toBeUndefined();
    expect(await row(b.id)).toBeUndefined();
    expect((await eraseCustomer(a.user.id)).ok).toBe(true);
  });

  it("caps a manager at 180 days in all on one application; past that only the platform owner", async () => {
    const { id } = await applied();
    const first = await placeRetentionHold(manager, { venueId: venueA, requestId: id, basis: "incident", reason: "Equipment failure reported by this customer.", reviewBy: addDays(todayISO(), 80) });
    if (!first.ok) throw new Error(first.error);
    // As if the first hold had been placed 150 days ago, and had run its course.
    await db()
      .prepare("UPDATE approval_holds SET placed_at = now() - interval '150 days', review_by = ? WHERE id = ?")
      .run(addDays(todayISO(), -70), first.hold.id);
    const renew = (who: Admin, days: number) =>
      placeRetentionHold(who, { venueId: venueA, requestId: id, basis: "incident", reason: "Investigation still open with the insurer.", reviewBy: addDays(todayISO(), days) });
    expect(await renew(manager, 60)).toMatchObject({ ok: false, status: 403 });
    expect(await renew(manager, 25)).toMatchObject({ ok: true });
    expect(await renew(owner, 300)).toMatchObject({ ok: true, hold: { placedByRole: "owner" } });
  });
});

describe("cleaning up", () => {
  it("removes a document left on an application whose details have gone, and old access and audit records", async () => {
    const { id } = await applied();
    await approve(id);
    await db().prepare("UPDATE approval_requests SET minimised_at = now() WHERE id = ?").run(id);
    expect(await documents(id)).toBe(1);
    await db().prepare("INSERT INTO approval_document_access (document_id, request_id, venue_id, viewer, viewer_name, at) VALUES (1, ?, ?, 'staff', 'Old Viewer', now() - interval '731 days')").run(id, venueA);
    await db()
      .prepare("INSERT INTO approval_audit (request_id, venue_id, sport, outcome, applied_at, removed_why, closed_at, removed_at) VALUES (999999, ?, 'kayak', 'rejected', now(), 'retention', now() - interval '731 days', now())")
      .run(venueA);
    const due = await retentionDue();
    expect(due.find((l) => l.whatPhrase.key === "srv.ret.approvalsAudit")!.affected).toBeGreaterThanOrEqual(2);
    await pruneOldData();
    expect(await documents(id)).toBe(0);
    expect(((await db().prepare("SELECT COUNT(*)::int AS n FROM approval_document_access WHERE viewer_name = 'Old Viewer'").get()) as { n: number }).n).toBe(0);
    expect(((await db().prepare("SELECT COUNT(*)::int AS n FROM approval_audit WHERE request_id = 999999").get()) as { n: number }).n).toBe(0);
    // Nothing else is due once it has run.
    const after = await approvalRetentionDue();
    expect(after.every((l) => l.affected === 0)).toBe(true);
  });

  it("on erasure keeps only the bare facts, linked to nobody, and takes the name off what the customer opened", async () => {
    const { user, id } = await applied();
    const opened = await db()
      .prepare("INSERT INTO approval_document_access (document_id, request_id, venue_id, viewer, user_id, viewer_name) VALUES (1, ?, ?, 'customer', ?, ?) RETURNING id")
      .get(id, venueA, user.id, user.name) as { id: number };
    expect((await eraseCustomer(user.id)).ok).toBe(true);
    expect(await row(id)).toBeUndefined();
    expect(await documents(id)).toBe(0);
    const audit = (await db().prepare("SELECT user_id, outcome, removed_why FROM approval_audit WHERE request_id = ?").get(id)) as Record<string, unknown>;
    expect(audit).toEqual({ user_id: null, outcome: "pending", removed_why: "erasure" });
    expect(await db().prepare("SELECT user_id, viewer_name FROM approval_document_access WHERE id = ?").get(opened.id)).toEqual({ user_id: null, viewer_name: "(removed)" });
    expect(((await db().prepare("SELECT COUNT(*)::int AS n FROM approval_audit WHERE user_id = ?").get(user.id)) as { n: number }).n).toBe(0);
  });
});
