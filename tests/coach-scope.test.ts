import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { uploaded } from "../src/lib/approval-documents";
import { apply, linkCoachAccount, saveRequirement } from "../src/lib/approvals";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { coachLessons, coachPayoutsCsv, notifyCoaches, setCoachEmail, setCoachLink } from "../src/lib/coach-schedule";
import { saveCoach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { setDocumentScanner } from "../src/lib/document-scanner";
import { addManaged } from "../src/lib/managed-people";
import { createResources } from "../src/lib/resources";
import { createVenue } from "../src/lib/store";
import { setHouseRules } from "../src/lib/house-rules";
import { addDays, todayISO } from "../src/lib/time";
import { passingScanner } from "./helpers/scanner";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as calendarRoute from "../src/app/api/coach-calendar/[token]/route";
import * as payoutsRoute from "../src/app/api/admin/coach-payouts/route";
import * as reviewsRoute from "../src/app/api/my/reviews/route";
import * as reviewDocRoute from "../src/app/api/my/reviews/document/route";

/**
 * Coaches see only the children they supervise (ADR 0023, amended 27
 * October 2026; docs/features/programmes.md): a coach's own lessons (their
 * schedule, its calendar feed, their lesson emails, their own lessons file)
 * and the applications they are the named reviewer for, at their venue.
 * Never every child at the venue, another coach's students, another venue's,
 * or a document of an application they do not review.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0177${String(++n).padStart(6, "0")}`;
const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: at(8), until: at(21) }));

type Adult = Awaited<ReturnType<typeof adult>>;
async function adult(name: string) {
  const made = await registerUser({ name, email: `cs${++n}@coach.test`, phone: phone(), password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

let V: number;
let W: number;
let hallV: number;
let hallV2: number;
let hallW: number;
let mum: Adult;
const coach: Record<"a" | "b" | "w", { id: number; account: Adult; token: string }> = {} as never;
const kids: Record<"amani" | "bella" | "cara" | "dina", number> = {} as never;
let manager: { cookie: string };

async function makeCoach(venueId: number, name: string) {
  const made = await saveCoach(venueId, { name, sports: ["badminton"], rate: 40, hours });
  if (!made.ok) throw new Error(made.error);
  const account = await adult(name);
  const linked = await linkCoachAccount(venueId, made.coach.id, account.email);
  if (!linked.ok) throw new Error(linked.error);
  await setCoachEmail(made.coach.id, venueId, `${name.toLowerCase().replace(/\W/g, "")}@coach.test`);
  const link = (await setCoachLink(made.coach.id, venueId, true))!.link!;
  return { id: made.coach.id, account, token: link.pageUrl.split("/coach/")[1] };
}

async function child(name: string) {
  const made = await addManaged(mum.id, { displayName: name, relationship: "parent", authority: true }, mum.name);
  if (!made.ok) throw new Error(made.error);
  return made.person.id;
}

const book = (body: Record<string, unknown>) =>
  bookingsRoute.POST(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.66.${++n % 250}.1`, cookie: mum.cookie },
      body: JSON.stringify({ name: mum.name, phone: mum.phone, ...body }),
    })
  );

function pdf(): Buffer {
  return Buffer.from(
    [
      "%PDF-1.7\n",
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n",
      "trailer\n<< /Root 1 0 R >>\nstartxref\n0\n%%EOF\n",
    ].join(""),
    "latin1"
  );
}

let docAtV: number;
let appAtV: number;
let appAtW: number;

beforeAll(async () => {
  setDocumentScanner(passingScanner());
  const venue = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Cheras", address: "x", phone: ph, openMin: at(7), closeMin: at(23) });
    if (!v.ok) throw new Error("venue");
    expect((await setHouseRules(v.venue.id, { aheadDays: 45 })).ok).toBe(true);
    return v.venue.id;
  };
  V = await venue("Coach Hall", "0312351101");
  W = await venue("Other Hall", "0312351102");
  const court = async (venueId: number, sport: string, name: string) => {
    const r = await createResources({ venueId, sport, name, offPeakRate: 20, peakRate: 20, capacity: 1 });
    if (!r.ok) throw new Error(r.error);
    return r.courts[0].id;
  };
  hallV = await court(V, "badminton", "Court 1");
  hallV2 = await court(V, "badminton", "Court 2");
  hallW = await court(W, "badminton", "Court W");
  coach.a = await makeCoach(V, "Coach Ana");
  coach.b = await makeCoach(V, "Coach Ben");
  coach.w = await makeCoach(W, "Coach Wan");
  mum = await adult("Puan Rina");
  kids.amani = await child("Amani");
  kids.bella = await child("Bella");
  kids.cara = await child("Cara");
  kids.dina = await child("Dina");
  // Amani's lesson with Ana, Bella's with Ben, Cara on a court with no coach, Dina's with Wan at the other venue.
  for (const [courtId, coachId, kid, hour] of [
    [hallV, coach.a.id, kids.amani, 9],
    [hallV2, coach.b.id, kids.bella, 9],
    [hallV, null, kids.cara, 11],
    [hallW, coach.w.id, kids.dina, 9],
  ] as const) {
    const res = await book({ courtId, date: day(3), start: at(hour), end: at(hour + 1), participantIds: [kid], ...(coachId ? { coachId } : {}) });
    expect(res.status).toBe(201);
  }
  // Applications: Ana reviews archery at V (with a document); Wan reviews archery at W.
  for (const [venueId, reviewer] of [
    [V, coach.a.id],
    [W, coach.w.id],
  ] as const) {
    const saved = await saveRequirement(venueId, {
      sport: "archery",
      kind: "certification",
      documentLabel: "Their archery certificate",
      documentPurpose: "Shooting here needs proof of a beginner's course.",
      declaration: "The certificate I send is theirs and in force.",
      validDays: 365,
      coachIds: [reviewer],
    });
    if (!saved.ok) throw new Error(saved.error);
  }
  const atV = await apply(
    mum,
    { venueId: V, sport: "archery", declaration: true, forPerson: kids.amani, authority: true, certReference: "Beginner course, MAA", certExpiresOn: day(200) },
    [uploaded(pdf(), "certificate.pdf", "application/pdf")]
  );
  if (!atV.ok) throw new Error(atV.error);
  appAtV = atV.request.id;
  docAtV = atV.request.documents[0].id;
  const atW = await apply(
    mum,
    { venueId: W, sport: "archery", declaration: true, forPerson: kids.dina, authority: true, certReference: "Beginner course, MAA", certExpiresOn: day(200) },
    [uploaded(pdf(), "certificate.pdf", "application/pdf")]
  );
  if (!atW.ok) throw new Error(atW.error);
  appAtW = atW.request.id;
  const admin = await createAdmin({ name: "Mira Manager", email: "mira@coach.test", password: "a long enough password", venueId: V });
  if (!admin.ok) throw new Error(admin.error);
  manager = { cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(admin.admin.id)).token}` };
});
afterAll(() => setDocumentScanner(null));

const get = (route: { GET: (req: NextRequest, ctx?: never) => Promise<Response> }, url: string, cookie?: string) =>
  route.GET(new NextRequest(url, { headers: cookie ? { cookie } : {} }));

describe("a coach's own lessons", () => {
  it("their schedule and calendar name the child in their own lesson, never another coach's student or any other child", async () => {
    const lessons = await coachLessons(coach.a.id, day(0), day(30));
    expect(lessons.map((l) => l.student)).toEqual(["Amani"]);
    const feed = await calendarRoute.GET(new NextRequest(`http://localhost/api/coach-calendar/${coach.a.token}.ics`), { params: Promise.resolve({ token: `${coach.a.token}.ics` }) });
    expect(feed.headers.get("cache-control")).toBe("private, no-store");
    const ics = await feed.text();
    expect(ics).toContain("Amani");
    for (const other of ["Bella", "Cara", "Dina"]) expect(ics).not.toContain(other);
    // Another venue's coach: their own child only.
    expect((await coachLessons(coach.w.id, day(0), day(30))).map((l) => l.student)).toEqual(["Dina"]);
  });

  it("their lesson emails name their own students only", async () => {
    await notifyCoaches();
    const to = async (email: string) =>
      ((await getDb().prepare("SELECT body FROM messages WHERE kind = 'coach_lesson' AND recipient = ?").all(email)) as { body: string }[]).map((m) => m.body).join("\n");
    const ana = await to("coachana@coach.test");
    expect(ana).toContain("Amani");
    for (const other of ["Bella", "Cara", "Dina"]) expect(ana).not.toContain(other);
    expect(await to("coachben@coach.test")).not.toContain("Amani");
  });

  it("the lessons file to hand to one coach holds that coach's lessons only", async () => {
    const url = (extra: string) => `http://localhost/api/admin/coach-payouts?venueId=${V}&from=${day(0)}&to=${day(30)}&format=csv${extra}`;
    const own = await (await get(payoutsRoute as never, url(`&coachId=${coach.a.id}`), manager.cookie)).text();
    expect(own).toContain("Amani");
    expect(own).not.toContain("Bella");
    // The venue's own books keep every coach's.
    const all = await coachPayoutsCsv(V, day(0), day(30));
    expect(all).toContain("Amani");
    expect(all).toContain("Bella");
    // Another venue's coach, asked for at this venue: nothing.
    expect(await coachPayoutsCsv(V, day(0), day(30), coach.w.id)).not.toContain("Dina");
    expect((await get(payoutsRoute as never, url("&coachId=x"), manager.cookie)).status).toBe(400);
  });
});

describe("applications a coach reviews", () => {
  const reviews = async (who: Adult) =>
    ((await (await get(reviewsRoute as never, "http://localhost/api/my/reviews", who.cookie)).json()) as { requests: { id: number; forPerson: { name: string } | null }[] }).requests;

  it("lists the children they are named reviewer for, at their venue only; not to another coach; not once inactive", async () => {
    expect((await reviews(coach.a.account)).map((r) => [r.id, r.forPerson?.name])).toEqual([[appAtV, "Amani"]]);
    expect(await reviews(coach.b.account)).toEqual([]);
    expect((await reviews(coach.w.account)).map((r) => r.id)).toEqual([appAtW]);
    await getDb().prepare("UPDATE coaches SET active = 0 WHERE id = ?").run(coach.a.id);
    try {
      expect(await reviews(coach.a.account)).toEqual([]);
    } finally {
      await getDb().prepare("UPDATE coaches SET active = 1 WHERE id = ?").run(coach.a.id);
    }
  });

  it("opens a document only of an application they review: never another coach's, never another venue's", async () => {
    const open = (who: Adult) => get(reviewDocRoute as never, `http://localhost/api/my/reviews/document?id=${docAtV}`, who.cookie);
    expect((await open(coach.a.account)).status).toBe(200);
    expect((await open(coach.b.account)).status).toBe(404);
    expect((await open(coach.w.account)).status).toBe(404);
    // Each opening is attributed to the coach who opened it.
    expect(await getDb().prepare("SELECT viewer, coach_id FROM approval_document_access WHERE document_id = ?").all(docAtV)).toEqual([{ viewer: "coach", coach_id: coach.a.id }]);
  });
});
