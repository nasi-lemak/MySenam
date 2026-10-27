import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { createAdmin } from "../src/lib/admin-auth";
import { uploaded } from "../src/lib/approval-documents";
import { apply, customerApprovals, decide, openDocument, saveRequirement, type Reviewer } from "../src/lib/approvals";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { savePolicy } from "../src/lib/booking-policy";
import { getDb, resetTransactionStats, transactionStats } from "../src/lib/db";
import { setDocumentScanner } from "../src/lib/document-scanner";
import { eligibilityAt, type EligibilityLine } from "../src/lib/eligibility";
import { acceptGuardianInvite, requestAtVenue } from "../src/lib/guardian-requests";
import { addManaged } from "../src/lib/managed-people";
import { acceptInvite, createInvite } from "../src/lib/participants";
import { createResources } from "../src/lib/resources";
import { revokeSignOff } from "../src/lib/sign-offs";
import { createVenue, searchAvailability } from "../src/lib/store";
import { addDays, dayOfWeek, todayISO } from "../src/lib/time";
import { createHash } from "crypto";
import { passingScanner } from "./helpers/scanner";
import * as searchRoute from "../src/app/api/search/route";
import * as availabilityRoute from "../src/app/api/availability/route";
import * as myDocRoute from "../src/app/api/my/approvals/document/route";

/**
 * Eligibility follows the participant, not who applied (lib/eligibility.ts;
 * ADR 0023, amended 27 October 2026; docs/features/discovery.md#who-is-taking-part).
 * Guardian A applies for their child; guardian B, who acts for the same
 * child, sees the status of that application and of the child's own
 * sign-off (pending, more information, approved, expired, taken back), but
 * never A's application itself: its answers and documents stay A's, the
 * venue's staff's and its named reviewers'. An adult whose request to
 * become a guardian still waits sees nothing; nothing personal reaches a
 * shared cache; still one query for the page.
 */

const AREA = "Wali Tengah";
let n = 0;
const phone = () => `0167${String(++n).padStart(6, "0")}`;
let date = addDays(todayISO(), 5);
while ([0, 6].includes(dayOfWeek(date))) date = addDays(date, 1);
const AT = 10 * 60;

let X: number;
let staff: { id: number; name: string };
const reviewer = (): Reviewer => ({ kind: "staff", admin: staff });

type Adult = Awaited<ReturnType<typeof adult>>;
async function adult(name = "Adult") {
  const made = await registerUser({ name: `${name} ${++n}`, email: `ge${n}@wali.test`, phone: phone(), password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now') WHERE id = ?").run(made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

/** A child of guardian A's, with guardian B added by A's own code (both act for them). */
async function family(displayName: string) {
  const a = await adult("Guardian A");
  const b = await adult("Guardian B");
  const made = await addManaged(a.id, { displayName, relationship: "parent", authority: true }, a.name);
  if (!made.ok) throw new Error(made.error);
  const kid = made.person.id;
  const { code } = (await createInvite(a, kid, "guardian")) as { code: string };
  expect(await acceptInvite(b, { code, relationship: "parent", authority: true })).toMatchObject({ ok: true, as: "guardian" });
  return { a, b, kid };
}

const status = async (who: Adult, kid: number, needs: "signOff" | "certification" = "signOff", sport: "archery" | "kayak" = "archery"): Promise<EligibilityLine[] | undefined> =>
  (await eligibilityAt({ taking: { userId: who.id, self: false, participants: [kid] }, sport, date, venueIds: [X] })).lines(X, needs);

function pdf(): Buffer {
  const parts = [
    "%PDF-1.7\n",
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n",
    "trailer\n<< /Root 1 0 R >>\nstartxref\n0\n%%EOF\n",
  ];
  return Buffer.from(parts.join(""), "latin1");
}

beforeAll(async () => {
  setDocumentScanner(passingScanner());
  const v = await createVenue({ name: "Wali Range", area: AREA, address: "x", phone: "0312347201", openMin: 7 * 60, closeMin: 23 * 60 });
  if (!v.ok) throw new Error("venue");
  X = v.venue.id;
  for (const sport of ["archery", "kayak"] as const) {
    const r = await createResources({ venueId: X, sport, name: `${sport} 1`, offPeakRate: 20, peakRate: 20, capacity: 1 });
    if (!r.ok) throw new Error(r.error);
    await savePolicy({ court: r.courts[0].id }, sport === "kayak" ? { certification: true } : { signOff: true });
  }
  const admin = await createAdmin({ name: "Wira Range", email: "wira@wali.test", password: "a long enough password", venueId: X });
  if (!admin.ok) throw new Error(admin.error);
  staff = { id: admin.admin.id, name: "Wira Range" };
  const archery = await saveRequirement(X, { sport: "archery", declaration: "My child will follow the range officer's calls.", validDays: 365 });
  if (!archery.ok) throw new Error(archery.error);
  const kayak = await saveRequirement(X, {
    sport: "kayak",
    kind: "certification",
    documentLabel: "Their paddling certificate",
    documentPurpose: "Paddling here needs proof of a paddling certificate.",
    declaration: "The certificate I send is theirs and in force.",
    validDays: 365,
  });
  if (!kayak.ok) throw new Error(kayak.error);
});
afterAll(() => setDocumentScanner(null));

describe("the other guardian sees the child's status, whoever applied", () => {
  it("pending, more information asked, approved, expired, and taken back", async () => {
    const { a, b, kid } = await family("Aisha");
    expect(await status(b, kid)).toEqual([{ participant: kid, status: "required" }]);
    const made = await apply(a, { venueId: X, sport: "archery", declaration: true, forPerson: kid, authority: true });
    if (!made.ok) throw new Error(made.error);
    // Guardian A applied; guardian B sees it pending, as A does.
    expect(await status(b, kid)).toEqual([{ participant: kid, status: "pending" }]);
    expect(await status(a, kid)).toEqual([{ participant: kid, status: "pending" }]);
    expect((await decide(reviewer(), made.request.id, "ask", { venueId: X, reason: "Which hand does she draw with?" })).ok).toBe(true);
    expect(await status(b, kid)).toEqual([{ participant: kid, status: "info" }]);
    // Answered and approved by the venue: the child's own sign-off, which both see.
    await getDb().prepare("UPDATE approval_requests SET status = 'pending' WHERE id = ?").run(made.request.id);
    const approved = await decide(reviewer(), made.request.id, "approve", { venueId: X });
    if (!approved.ok) throw new Error(approved.error);
    expect(await status(b, kid)).toEqual([{ participant: kid, status: "eligible" }]);
    // Ran out before the day.
    const signOff = (await getDb().prepare("SELECT id FROM sign_offs WHERE managed_person_id = ? AND revoked_at IS NULL").get(kid)) as { id: number };
    await getDb().prepare("UPDATE sign_offs SET expires_on = ? WHERE id = ?").run(addDays(todayISO(), -1), signOff.id);
    expect(await status(b, kid)).toEqual([{ participant: kid, status: "expired" }]);
    // Taken back: required again.
    await getDb().prepare("UPDATE sign_offs SET expires_on = NULL WHERE id = ?").run(signOff.id);
    expect(await status(b, kid)).toEqual([{ participant: kid, status: "eligible" }]);
    await revokeSignOff(X, signOff.id, { adminId: staff.id, reason: "Taken back" });
    expect(await status(b, kid)).toEqual([{ participant: kid, status: "required" }]);
  });

  it("is the same on the venue's grid and in search, privately, still one query for the page", async () => {
    const { a, b, kid } = await family("Bilal");
    const made = await apply(a, { venueId: X, sport: "archery", declaration: true, forPerson: kid, authority: true });
    if (!made.ok) throw new Error(made.error);
    const get = (route: typeof searchRoute | typeof availabilityRoute, url: string, cookie?: string) =>
      route.GET(new NextRequest(url, { headers: { "x-forwarded-for": `10.77.${++n % 250}.1`, ...(cookie ? { cookie } : {}) } }));
    const grid = await get(availabilityRoute, `http://localhost/api/availability?venueId=${X}&date=${date}&sport=archery&taking=${kid}`, b.cookie);
    expect(grid.headers.get("cache-control")).toBe("private, no-store");
    expect(grid.headers.get("vary")).toContain("Cookie");
    expect((await grid.json()).eligibility).toEqual({ signOff: [{ participant: kid, status: "pending" }] });
    const searchUrl = `http://localhost/api/search?sport=archery&date=${date}&from=10:00&to=10:00&area=${encodeURIComponent(AREA)}&taking=${kid}`;
    const found = await get(searchRoute, searchUrl, b.cookie);
    expect(found.headers.get("cache-control")).toBe("private, no-store");
    expect((await found.json()).results.find((r: { venue: { id: number } }) => r.venue.id === X).eligibility).toEqual([{ participant: kid, status: "pending" }]);
    // The same address signed out: nothing personal.
    expect(await (await get(searchRoute, searchUrl)).text()).not.toContain("eligibility");
    // One query for the page, whoever applied.
    const query = (taking?: { userId: number; participants: number[] }) =>
      searchAvailability({ sport: "archery", date, area: AREA, fromMin: AT, toMin: AT, ...(taking ? { taking: { ...taking, self: false } } : {}) });
    await query();
    resetTransactionStats();
    await query();
    const anonymous = transactionStats().queries;
    resetTransactionStats();
    await query({ userId: b.id, participants: [kid] });
    expect(transactionStats().queries).toBe(anonymous + 1);
  });
});

describe("the status, never the application", () => {
  it("guardian B neither lists nor opens guardian A's application or its documents", async () => {
    const { a, b, kid } = await family("Chen");
    const made = await apply(
      a,
      { venueId: X, sport: "kayak", declaration: true, forPerson: kid, authority: true, certReference: "Paddle Level 2, MCKA", certExpiresOn: addDays(todayISO(), 200) },
      [uploaded(pdf(), "certificate.pdf", "application/pdf")]
    );
    if (!made.ok) throw new Error(made.error);
    const doc = made.request.documents[0].id;
    expect(await status(b, kid, "certification", "kayak")).toEqual([{ participant: kid, status: "pending" }]);
    expect((await customerApprovals(b.id)).map((r) => r.id)).not.toContain(made.request.id);
    expect(await openDocument(doc, { kind: "customer", userId: b.id, name: b.name })).toBeNull();
    const res = await myDocRoute.GET(new NextRequest(`http://localhost/api/my/approvals/document?id=${doc}`, { headers: { cookie: b.cookie } }));
    expect(res.status).toBe(404);
    // The applicant still opens their own.
    const own = await myDocRoute.GET(new NextRequest(`http://localhost/api/my/approvals/document?id=${doc}`, { headers: { cookie: a.cookie } }));
    expect(own.status).toBe(200);
    // Nobody but the applicant was recorded opening it.
    expect(await getDb().prepare("SELECT DISTINCT user_id FROM approval_document_access WHERE document_id = ?").all(doc)).toEqual([{ user_id: a.id }]);
  });
});

describe("who sees nothing", () => {
  it("an adult whose request to become a guardian still waits, a stranger, and a guardian revoked", async () => {
    const { a, kid } = await family("Dina");
    const made = await apply(a, { venueId: X, sport: "archery", declaration: true, forPerson: kid, authority: true });
    if (!made.ok) throw new Error(made.error);
    // Known to the venue by its application: staff invite the uncle, who accepts, and nobody has agreed yet.
    const uncle = await adult("Uncle");
    const request = await requestAtVenue({ venueId: X, participantId: kid, admin: { id: staff.id, name: staff.name }, proposedName: "Uncle" });
    if (!request.ok) throw new Error(request.error);
    const hash = createHash("sha256").update(request.code.replace(/[^A-Z0-9]/g, "")).digest("hex");
    expect(await acceptGuardianInvite(uncle, hash, { relationship: "other", authority: true })).toMatchObject({ ok: true, as: "pending" });
    expect(await status(uncle, kid)).toEqual([]);
    expect(await status(await adult("Stranger"), kid)).toEqual([]);
    // A guardian whose relationship was ended sees nothing either.
    const { a: mum, b: dad, kid: other } = await family("Eli");
    const applied = await apply(mum, { venueId: X, sport: "archery", declaration: true, forPerson: other, authority: true });
    if (!applied.ok) throw new Error(applied.error);
    expect(await status(dad, other)).toEqual([{ participant: other, status: "pending" }]);
    const row = (await getDb().prepare("SELECT id FROM participant_guardians WHERE participant_id = ? AND user_id = ?").get(other, dad.id)) as { id: number };
    await getDb().prepare("UPDATE participant_guardians SET revoked_at = now(), revoke_reason = 'test' WHERE id = ?").run(row.id);
    expect(await status(dad, other)).toEqual([]);
  });
});
