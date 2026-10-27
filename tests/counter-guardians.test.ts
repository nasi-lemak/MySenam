import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

// The outbox, with a switch to make queuing itself fail (a database or mail-queue fault).
const queue = vi.hoisted(() => ({ fail: false }));
vi.mock("../src/lib/outbox", async (original) => {
  const real = await original<typeof import("../src/lib/outbox")>();
  return {
    ...real,
    enqueue: async (...args: Parameters<typeof real.enqueue>) => {
      if (queue.fail) throw new Error("The message queue is down");
      return real.enqueue(...args);
    },
  };
});

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { listActivity } from "../src/lib/activity";
import { apply, decide, saveRequirement } from "../src/lib/approvals";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { runStep } from "../src/lib/db-steps";
import { eligibilityAt } from "../src/lib/eligibility";
import { acceptGuardianInvite, answerRequest, requestAtVenue } from "../src/lib/guardian-requests";
import { addManaged, listManaged } from "../src/lib/managed-people";
import { drainOutbox, setTransport } from "../src/lib/outbox";
import { acceptInvite, createAtVenue, createInvite, linkByStaff, participantHistory, participantsForVenue } from "../src/lib/participants";
import { exportCustomerData } from "../src/lib/privacy";
import { createResources } from "../src/lib/resources";
import { createVenue } from "../src/lib/store";
import { setHouseRules } from "../src/lib/house-rules";
import { addDays, todayISO } from "../src/lib/time";
import { createHash } from "crypto";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as participantRoute from "../src/app/api/admin/participants/[id]/route";
import * as participantsRoute from "../src/app/api/admin/participants/route";
import * as guardiansRoute from "../src/app/api/admin/participants/[id]/guardians/route";
import * as peopleRoute from "../src/app/api/my/people/route";
import * as acceptRoute from "../src/app/api/my/people/accept/route";
import * as requestsRoute from "../src/app/api/my/people/requests/route";
import * as reportRoute from "../src/app/api/my/people/report/route";

/**
 * Another guardian by verified consent (lib/guardian-requests.ts; ADR 0023,
 * amended 27 October 2026; docs/features/venue-operations.md#another-guardian-by-invitation).
 *
 * Reception staff no longer make an adult a guardian from a name and a
 * number. Staff (or a guardian) start a request; the adult accepts a
 * single-use code signed in to their own account, with their own
 * declaration; an existing guardian agrees online, or a manager records a
 * narrow exception; only then is there a relationship. A request grants
 * nothing. The other guardians are told by email, and a failure to tell
 * them undoes nothing. A guardian reports a mistake; a manager pauses,
 * keeps or revokes. Nothing is ever a second record of the child.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0188${String(++n).padStart(6, "0")}`;

type Staff = { id: number; name: string; cookie: string };
type Adult = Awaited<ReturnType<typeof adult>>;

let venue: number;
let otherVenue: number;
let hall: number;
let manager: Staff;
let desk: Staff;
let otherManager: Staff;

async function adult(name: string, ph = phone()) {
  const made = await registerUser({ name, email: `cg${++n}@cg.test`, phone: ph, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function staffMember(venueId: number, name: string, role: "manager" | "desk" = "manager"): Promise<Staff> {
  const made = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}${++n}@cg.test`, password: "a long enough password", venueId, role });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

const req = (url: string, method: string, cookie: string | null, body?: unknown) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.88.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const json = async (res: Response) => (await res.json()) as Record<string, unknown> & { code?: string };

const invite = (who: Staff, participantId: number, body: Record<string, unknown>) =>
  guardiansRoute.POST(req(`http://localhost/api/admin/participants/${participantId}/guardians`, "POST", who.cookie, body), ctx(participantId));
const patch = (who: Staff, participantId: number, body: Record<string, unknown>) =>
  participantRoute.PATCH(req(`http://localhost/api/admin/participants/${participantId}`, "PATCH", who.cookie, body), ctx(participantId));
const accept = (who: Adult, body: Record<string, unknown>) => acceptRoute.POST(req("http://localhost/api/my/people/accept", "POST", who.cookie, body));
const answer = (who: Adult, body: Record<string, unknown>) => requestsRoute.POST(req("http://localhost/api/my/people/requests", "POST", who.cookie, body));
const people = async (who: Adult) =>
  (await json(await peopleRoute.GET(req("http://localhost/api/my/people", "GET", who.cookie)))) as {
    people: { id: number }[];
    requests: {
      toAnswer: { id: number; participantId: number; proposedName: string }[];
      pending: { id: number; displayName: string }[];
      paused: { displayName: string }[];
      changes: { participantId: number; guardianshipId: number; kind: string; reported: boolean }[];
    };
  };
const bookAtCounter = (who: Staff, body: Record<string, unknown>) => bookingsRoute.POST(req("http://localhost/api/bookings", "POST", who.cookie, body));
const bookOnline = (who: Adult, participantId: number, hour: number, date = day(7)) =>
  bookingsRoute.POST(req("http://localhost/api/bookings", "POST", who.cookie, { courtId: hall, date, start: at(hour), end: at(hour + 1), name: who.name, phone: who.phone, participantId }));
const count = async (sql: string, ...args: unknown[]) => ((await getDb().prepare(sql).get(...args)) as { n: number }).n;
const messagesTo = (email: string) =>
  getDb().prepare("SELECT kind, subject, body, status FROM messages WHERE lower(recipient) = lower(?) ORDER BY id").all(email) as Promise<
    { kind: string; subject: string; body: string; status: string }[]
  >;

/** A child the mother added online, known to the venue by a booking there (each in a slot of its own). */
let slot = 0;
async function onlineChild(mum: Adult, displayName: string) {
  const made = await addManaged(mum.id, { displayName, birthYear: 2016, relationship: "parent", authority: true }, mum.name);
  if (!made.ok) throw new Error(made.error);
  const booked = await bookOnline(mum, made.person.id, 7 + Math.floor(slot / 30), day(10 + (slot++ % 30)));
  expect(booked.status).toBe(201);
  return made.person.id;
}

/** A child the venue added at the counter, with their mother on record by name and number only. */
async function counterChild(displayName: string, mumPhone = phone()) {
  const made = await createAtVenue({
    venueId: venue,
    admin: { id: manager.id, name: manager.name },
    displayName,
    birthYear: 2016,
    guardian: { name: "Puan Aminah", phone: mumPhone, relationship: "parent", authority: true },
  });
  if (!made.ok) throw new Error(made.error);
  return { id: made.participant.id, mumPhone };
}

/** The adult accepts a code signed in; returns the response body. */
async function accepts(who: Adult, code: string, relationship = "parent") {
  const res = await accept(who, { code, relationship, authority: true });
  expect(res.status).toBe(200);
  return json(res);
}

const reviewOn = () => addDays(todayISO(), 60);

beforeAll(async () => {
  const make = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Bangsar", address: "x", phone: ph, openMin: at(7), closeMin: at(23) });
    if (!v.ok) throw new Error("venue");
    return v.venue.id;
  };
  venue = await make("Guardian Centre", "0312350501");
  otherVenue = await make("Elsewhere Centre", "0312350502");
  const r = await createResources({ venueId: venue, sport: "badminton", name: "Hall A", offPeakRate: 20, peakRate: 20, capacity: 1 });
  if (!r.ok) throw new Error(r.error);
  hall = r.courts[0].id;
  const l = await createResources({ venueId: venue, sport: "archery", name: "Lane A", offPeakRate: 20, peakRate: 20, capacity: 1 });
  if (!l.ok) throw new Error(l.error);
  const s = await saveRequirement(venue, { sport: "archery", declaration: "My child will follow the range officer's calls.", validDays: 365, guardianCheck: true });
  if (!s.ok) throw new Error(s.error);
  expect((await setHouseRules(venue, { aheadDays: 45 })).ok).toBe(true);
  manager = await staffMember(venue, "Mona Manager");
  desk = await staffMember(venue, "Dewi Desk", "desk");
  otherManager = await staffMember(otherVenue, "Omar Other");
});

afterEach(() => {
  setTransport(null);
  queue.fail = false;
});

describe("staff start a request; the adult accepts on their own account; an existing guardian agrees", () => {
  it("grants nothing while pending, then acts once agreed; the other guardians are told, nobody new is made", async () => {
    const mum = await adult("Puan Siti");
    const gran = await adult("Nenek Ros");
    const dad = await adult("Encik Rahman");
    const kid = await onlineChild(mum, "Irfan");
    // The grandmother was added earlier by the mother's own code: the mother agreed by giving it, so it acts at once.
    const { code: granCode } = (await createInvite(mum, kid, "guardian")) as { code: string };
    expect(await acceptInvite(gran, { code: granCode, relationship: "other", authority: true })).toMatchObject({ ok: true, as: "guardian" });
    // The mother, who gave the code, is told; the grandmother is not told about herself.
    expect((await messagesTo(mum.email)).filter((m) => m.kind === "account_email")).toHaveLength(1);
    expect(await messagesTo(gran.email)).toEqual([]);

    const participants = await count("SELECT COUNT(*)::int AS n FROM participants");
    const counterBooking = { courtId: hall, date: day(5), start: at(9), end: at(10), name: dad.name, phone: dad.phone, participantIds: [kid] };
    expect((await json(await bookAtCounter(desk, counterBooking))).code).toBe("PBK_NOT_GUARDIAN");

    // Front desk starts it, for the father standing at the counter: a code, shown once.
    const started = await invite(desk, kid, { venueId: venue, proposedName: "Encik Rahman" });
    expect(started.status).toBe(201);
    const { request } = (await started.json()) as { request: { id: number; code: string; consentPossible: boolean } };
    expect(request.code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(request.consentPossible).toBe(true);
    expect(await getDb().prepare("SELECT 1 FROM participant_invites WHERE code_hash = ?").get(request.code)).toBeUndefined();
    const log = await listActivity([venue], {});
    expect(log.find((e) => e.action === "participant.guardian_requested" && (e.detail ?? "").includes(`participant ${kid}`))).toMatchObject({ adminName: "Dewi Desk" });

    // The father accepts it signed in, with his own declaration: pending, his name only of the child, nothing granted.
    expect((await json(await accept(dad, { code: request.code, relationship: "parent" }))).code).toBe("GUARD_AUTHORITY_NEEDED");
    const pending = await accepts(dad, request.code);
    expect(pending).toEqual({ as: "pending", person: { displayName: "Irfan" } });
    expect(await listManaged(dad.id)).toEqual([]);
    const dadsPage = await people(dad);
    expect(dadsPage.people).toEqual([]);
    expect(dadsPage.requests.pending).toEqual([expect.objectContaining({ displayName: "Irfan" })]);
    expect((await json(await bookOnline(dad, kid, 9))).code).toBe("GUARD_NOT_FOUND");
    expect((await json(await bookAtCounter(desk, counterBooking))).code).toBe("PBK_NOT_GUARDIAN");
    expect(await apply(dad, { venueId: venue, sport: "archery", declaration: true, forPerson: kid, authority: true })).toMatchObject({ ok: false, code: "GUARD_NOT_FOUND" });
    expect((await eligibilityAt({ taking: { userId: dad.id, self: false, participants: [kid] }, sport: "archery", date: day(5), venueIds: [venue] })).lines(venue, "signOff")).toEqual([]);
    expect(await createInvite(dad, kid, "guardian")).toMatchObject({ ok: false, code: "GUARD_NOT_FOUND" });
    const exported = (await exportCustomerData(dad.id))!;
    expect(exported.managedPeople).toEqual([]);
    expect(exported.guardianRequestsPending).toEqual([{ requestPending: true, since: expect.any(String) }]);
    expect(JSON.stringify(exported.guardianRequestsPending)).not.toContain("Irfan");

    // The guardians who could agree are told there is a request to answer; the father is not asked about himself.
    const mumAsked = (await messagesTo(mum.email)).at(-1)!;
    expect(mumAsked.subject).toContain("Irfan");
    expect(mumAsked.body).toContain("asked to become Irfan's guardian");
    // In the language the email is written in (lib/link-locale.ts).
    expect(mumAsked.body).toContain("https://book.example.my/account?lang=en#people");
    expect(mumAsked.body).toContain("Guardian Centre");
    expect(mumAsked.body).not.toContain("Rahman");
    expect(mumAsked.body).not.toContain(dad.phone);

    // Only somebody acting for the child may answer: not the father himself, not a stranger.
    expect((await json(await answer(dad, { id: request.id, agree: true }))).code).toBe("GV_REQUEST_NOT_FOUND");
    expect((await json(await answer(await adult("Stranger"), { id: request.id, agree: true }))).code).toBe("GV_REQUEST_NOT_FOUND");
    const mumsPage = await people(mum);
    expect(mumsPage.requests.toAnswer).toEqual([expect.objectContaining({ id: request.id, participantId: kid, proposedName: "Encik Rahman" })]);

    // The mother agrees: now, and only now, the father acts for the same child.
    const agreed = await answer(mum, { id: request.id, agree: true });
    expect(agreed.status).toBe(200);
    expect(await json(agreed)).toEqual({ status: "active" });
    expect((await listManaged(dad.id)).map((p) => p.id)).toEqual([kid]);
    expect((await bookAtCounter(desk, counterBooking)).status).toBe(201);
    expect((await bookOnline(dad, kid, 11)).status).toBe(201);
    expect(await count("SELECT COUNT(*)::int AS n FROM participants")).toBe(participants);
    const row = (await getDb()
      .prepare("SELECT user_id, provenance, relationship, venue_id, request_id, review_reason FROM participant_guardians WHERE participant_id = ? AND user_id = ?")
      .get(kid, dad.id)) as Record<string, unknown>;
    expect(row).toEqual({ user_id: dad.id, provenance: "online", relationship: "parent", venue_id: venue, request_id: request.id, review_reason: null });
    const trail = (await getDb()
      .prepare(
        "SELECT status, initiated_as, initiated_by_name, accepted_by_user_id, consented_by_user_id, exception_category FROM guardian_requests WHERE id = ?"
      )
      .get(request.id)) as Record<string, unknown>;
    expect(trail).toEqual({ status: "active", initiated_as: "staff", initiated_by_name: "Dewi Desk", accepted_by_user_id: dad.id, consented_by_user_id: mum.id, exception_category: null });
    expect((await participantHistory(kid)).map((e) => e.action)).toEqual(
      expect.arrayContaining(["guardian.requested", "guardian.request_accepted", "guardian.request_agreed", "guardian.added", "guardian.notified"])
    );

    // The grandmother is told a guardian was added (what, when, how to report it); the mother, who agreed, is not told again.
    const granTold = await messagesTo(gran.email);
    expect(granTold.map((m) => m.subject)).toEqual([expect.stringContaining("another adult asked"), expect.stringContaining("another guardian added")]);
    expect(granTold[1].body).toContain("Another guardian was added for Irfan on");
    expect(granTold[1].body).toContain("/account?lang=en#people");
    expect(granTold[1].body).toContain("Guardian Centre on 0312350501");
    for (const m of granTold) {
      expect(m.body).not.toContain("Rahman");
      expect(m.body).not.toContain("Hall A");
    }
    expect((await messagesTo(mum.email)).filter((m) => m.subject.includes("another guardian added"))).toHaveLength(1); // the grandmother's, earlier

    // A declaration online is not a review of authority: an activity that asks for one still asks.
    const applied = await apply(dad, { venueId: venue, sport: "archery", declaration: true, forPerson: kid, authority: true });
    if (!applied.ok) throw new Error(applied.error);
    expect(await decide({ kind: "staff", admin: { id: manager.id, name: manager.name } }, applied.request.id, "approve", { venueId: venue })).toMatchObject({
      ok: false,
      code: "APR_CHILD_AUTHORITY_UNREVIEWED",
    });
  });

  it("an existing guardian refuses: nothing is granted, and the code was good once", async () => {
    const mum = await adult("Puan Lina");
    const dad = await adult("Encik Lee");
    const kid = await onlineChild(mum, "Jannah");
    const { request } = (await json(await invite(manager, kid, { venueId: venue, proposedName: "Encik Lee" }))) as { request: { id: number; code: string } };
    await accepts(dad, request.code);
    expect((await json(await answer(mum, { id: request.id }))).code).toBe("GV_ANSWER_NEEDED");
    expect(await json(await answer(mum, { id: request.id, agree: false, reason: "I do not know this man" }))).toEqual({ status: "rejected" });
    expect(await listManaged(dad.id)).toEqual([]);
    expect((await people(dad)).requests.pending).toEqual([]);
    expect(await getDb().prepare("SELECT status, closed_by_user_id, close_reason FROM guardian_requests WHERE id = ?").get(request.id)).toEqual({
      status: "rejected",
      closed_by_user_id: mum.id,
      close_reason: "I do not know this man",
    });
    expect((await json(await answer(mum, { id: request.id, agree: true }))).code).toBe("GV_REQUEST_CLOSED");
    expect((await json(await accept(dad, { code: request.code, relationship: "parent", authority: true }))).code).toBe("PTC_INVITE_INVALID");
    expect(await count("SELECT COUNT(*)::int AS n FROM participant_guardians WHERE participant_id = ? AND user_id = ?", kid, dad.id)).toBe(0);
  });
});

describe("the exception, a manager's only", () => {
  it("binds a code to one account; with nobody able to agree online, only a manager's exception completes it, never the desk's", async () => {
    // The mother is on record by name and number only: she has no account to agree with.
    const kid = await counterChild("Khalid");
    const dad = await adult("Encik Tan");
    const started = await invite(desk, kid.id, { venueId: venue, proposedName: "Encik Tan", email: dad.email });
    expect(started.status).toBe(201);
    const { request } = (await started.json()) as { request: { id: number; code: string; consentPossible: boolean } };
    expect(request.consentPossible).toBe(false);
    // Somebody else's account cannot use the father's code.
    expect((await json(await accept(await adult("Someone Else"), { code: request.code, relationship: "parent", authority: true }))).code).toBe("PTC_INVITE_INVALID");
    expect((await accepts(dad, request.code)).as).toBe("pending");

    const found = (await json(await participantsRoute.GET(req(`http://localhost/api/admin/participants?venueId=${venue}&phone=${kid.mumPhone}`, "GET", desk.cookie)))) as {
      participants: { id: number; requests: { id: number; status: string; consentPossible: boolean; acceptedName: string }[] }[];
    };
    expect(found.participants.find((p) => p.id === kid.id)!.requests).toEqual([
      expect.objectContaining({ id: request.id, status: "awaiting_consent", consentPossible: false, acceptedName: "Encik Tan" }),
    ]);

    const body = { venueId: venue, action: "exception", requestId: request.id, category: "guardian_unavailable", reason: "Mother has no account; she agreed in person", reviewOn: reviewOn() };
    const byDesk = await patch(desk, kid.id, body);
    expect(byDesk.status).toBe(403);
    expect((await json(byDesk)).code).toBe("MANAGER_ONLY");
    expect((await json(await patch(manager, kid.id, { ...body, category: "it-is-fine" }))).code).toBe("GV_EXCEPTION_CATEGORY");
    expect((await json(await patch(manager, kid.id, { ...body, reason: "" }))).code).toBe("PTC_REASON_NEEDED");
    expect((await json(await patch(manager, kid.id, { ...body, reviewOn: addDays(todayISO(), 400) }))).code).toBe("GV_REVIEW_DATE");
    expect((await patch(otherManager, kid.id, body)).status).toBe(403);
    expect(await listManaged(dad.id)).toEqual([]);

    const done = await patch(manager, kid.id, body);
    expect(done.status).toBe(200);
    expect(await json(done)).toEqual({ ok: true, active: true });
    expect((await listManaged(dad.id)).map((p) => p.id)).toEqual([kid.id]);
    // Recorded as an exception, flagged for review; never as staff-reviewed authority.
    expect(
      await getDb().prepare("SELECT provenance, review_reason, reviewed_at FROM participant_guardians WHERE participant_id = ? AND user_id = ?").get(kid.id, dad.id)
    ).toEqual({ provenance: "online", review_reason: "exception", reviewed_at: null });
    expect(await getDb().prepare("SELECT exception_category, exception_by_name, to_char(exception_review_on, 'YYYY-MM-DD') AS exception_review_on FROM guardian_requests WHERE id = ?").get(request.id)).toEqual({
      exception_category: "guardian_unavailable",
      exception_by_name: "Mona Manager",
      exception_review_on: reviewOn(),
    });
    expect((await listActivity([venue], {})).some((e) => e.action === "participant.guardian_exception" && e.adminName === "Mona Manager")).toBe(true);
    expect((await participantHistory(kid.id)).find((e) => e.action === "guardian.exception")?.detail).toContain("not proof of legal guardianship");
    // The father's own number now books for him at the counter; the mother's still does.
    expect((await bookAtCounter(desk, { courtId: hall, date: day(6), start: at(13), end: at(14), name: dad.name, phone: dad.phone, participantIds: [kid.id] })).status).toBe(201);
    expect((await bookAtCounter(desk, { courtId: hall, date: day(6), start: at(15), end: at(16), name: "Puan Aminah", phone: kid.mumPhone, participantIds: [kid.id] })).status).toBe(201);
  });

  it("an exception before the adult accepts takes effect on acceptance; one that says so tells nobody, and the history says why", async () => {
    const mum = await adult("Puan Nora");
    const dad = await adult("Encik Hadi");
    const kid = await onlineChild(mum, "Lina");
    const before = (await messagesTo(mum.email)).length;
    const { request } = (await json(await invite(manager, kid, { venueId: venue, proposedName: "Encik Hadi" }))) as { request: { id: number; code: string } };
    const excepted = await patch(manager, kid, {
      venueId: venue,
      action: "exception",
      requestId: request.id,
      category: "custody_dispute",
      reason: "Court order seen; the mother is not to be told",
      reviewOn: reviewOn(),
      suppressNotice: true,
    });
    expect(await json(excepted)).toEqual({ ok: true, active: false });
    expect(await listManaged(dad.id)).toEqual([]);
    expect((await accepts(dad, request.code)).as).toBe("guardian");
    expect((await listManaged(dad.id)).map((p) => p.id)).toEqual([kid]);
    expect((await messagesTo(mum.email)).length).toBe(before);
    expect((await participantHistory(kid)).map((e) => e.action)).toContain("guardian.notice_suppressed");
    expect((await people(mum)).requests.changes.filter((c) => c.participantId === kid)).toEqual([]);
  });
});

describe("telling the other guardians", () => {
  it("a failed delivery, or a queue that is down, undoes nothing and loses no record", async () => {
    const mum = await adult("Puan Mei");
    const dad = await adult("Encik Wong");
    const uncle = await adult("Encik Lim");
    const kid = await onlineChild(mum, "Maya");
    const { code } = (await createInvite(mum, kid, "guardian")) as { code: string };
    // Delivery fails: the message is retried and given up on; the relationship and its record stay.
    setTransport({
      name: "down",
      send: async () => {
        throw new Error("mail server unreachable");
      },
    });
    await acceptInvite(dad, { code, relationship: "parent", authority: true });
    const result = await drainOutbox(100);
    expect(result.failed).toBeGreaterThan(0);
    expect((await messagesTo(mum.email)).at(-1)!.status).toBe("failed");
    expect((await listManaged(dad.id)).map((p) => p.id)).toEqual([kid]);
    expect((await participantHistory(kid)).map((e) => e.action)).toEqual(expect.arrayContaining(["guardian.added", "guardian.notified"]));
    // Queuing itself fails: still a guardian, and the failure is on record.
    queue.fail = true;
    const second = (await createInvite(mum, kid, "guardian")) as { code: string };
    expect(await acceptInvite(uncle, { code: second.code, relationship: "other", authority: true })).toMatchObject({ ok: true, as: "guardian" });
    expect((await listManaged(uncle.id)).map((p) => p.id)).toEqual([kid]);
    expect((await participantHistory(kid)).filter((e) => e.action === "guardian.notice_failed")).toEqual([
      expect.objectContaining({ detail: expect.stringContaining("The message queue is down") }),
    ]);
  });
});

describe("a reported mistake, reviewed by a manager", () => {
  it("is flagged; pausing stops the guardian acting; keeping restores; revoking ends it and tells the others", async () => {
    const mum = await adult("Puan Sara");
    const dad = await adult("Encik Ali");
    const kid = await onlineChild(mum, "Nadia");
    const { request } = (await json(await invite(desk, kid, { venueId: venue, proposedName: "Encik Ali" }))) as { request: { id: number; code: string } };
    await accepts(dad, request.code);
    await answer(mum, { id: request.id, agree: true });
    const change = (await people(mum)).requests.changes.find((c) => c.participantId === kid && c.kind === "added")!;
    expect(change).toMatchObject({ reported: false });
    // Not somebody else's to report, nor the father's own.
    const report = (who: Adult, body: Record<string, unknown>) => reportRoute.POST(req("http://localhost/api/my/people/report", "POST", who.cookie, body));
    expect((await json(await report(await adult("Stranger"), { id: kid, guardianshipId: change.guardianshipId }))).code).toBe("GV_CHANGE_NOT_FOUND");
    const dadsRow = (await getDb().prepare("SELECT id FROM participant_guardians WHERE participant_id = ? AND user_id = ?").get(kid, dad.id)) as { id: number };
    expect((await json(await report(dad, { id: kid, guardianshipId: dadsRow.id }))).code).toBe("GV_CHANGE_NOT_FOUND");
    expect((await report(mum, { id: kid, guardianshipId: change.guardianshipId, note: "We are separated; I agreed by mistake" })).status).toBe(200);
    expect((await people(mum)).requests.changes.find((c) => c.guardianshipId === change.guardianshipId)?.reported).toBe(true);
    // Nothing changes until a manager decides.
    expect((await listManaged(dad.id)).map((p) => p.id)).toEqual([kid]);

    // The review list: a manager's, not the desk's.
    const reviewUrl = `http://localhost/api/admin/participants?venueId=${venue}&review=1`;
    expect((await participantsRoute.GET(req(reviewUrl, "GET", desk.cookie))).status).toBe(403);
    const queued = (await json(await participantsRoute.GET(req(reviewUrl, "GET", manager.cookie)))) as {
      participants: { id: number; guardians: { id: number; review: string; reviewNote: string }[] }[];
    };
    expect(queued.participants.find((p) => p.id === kid)!.guardians).toEqual([
      expect.objectContaining({ id: dadsRow.id, review: "reported", reviewNote: expect.stringContaining("I agreed by mistake") }),
    ]);
    expect((await json(await participantsRoute.GET(req(`http://localhost/api/admin/participants?venueId=${otherVenue}&review=1`, "GET", otherManager.cookie)))).participants).toEqual([]);

    // Paused: the father acts for nobody meanwhile.
    expect((await patch(desk, kid, { venueId: venue, action: "suspendGuardian", guardianId: dadsRow.id, reason: "Looking into it" })).status).toBe(403);
    expect((await patch(manager, kid, { venueId: venue, action: "suspendGuardian", guardianId: dadsRow.id, reason: "Looking into it" })).status).toBe(200);
    expect(await listManaged(dad.id)).toEqual([]);
    expect((await people(dad)).requests.paused).toEqual([expect.objectContaining({ displayName: "Nadia" })]);
    expect((await json(await bookOnline(dad, kid, 15))).code).toBe("GUARD_NOT_FOUND");
    expect((await json(await bookAtCounter(desk, { courtId: hall, date: day(8), start: at(9), end: at(10), name: dad.name, phone: dad.phone, participantIds: [kid] }))).code).toBe(
      "PBK_NOT_GUARDIAN"
    );
    expect((await eligibilityAt({ taking: { userId: dad.id, self: false, participants: [kid] }, sport: "archery", date: day(8), venueIds: [venue] })).lines(venue, "signOff")).toEqual([]);
    // Kept: acting again, the flag closed.
    expect((await patch(manager, kid, { venueId: venue, action: "confirmGuardian", guardianId: dadsRow.id, reason: "Both parents confirmed in person" })).status).toBe(200);
    expect((await listManaged(dad.id)).map((p) => p.id)).toEqual([kid]);
    expect((await json(await patch(manager, kid, { venueId: venue, action: "confirmGuardian", guardianId: dadsRow.id, reason: "Again" }))).code).toBe("GV_NOTHING_TO_REVIEW");
    // Revoked: the mother is told a guardian stopped acting.
    const before = (await messagesTo(mum.email)).length;
    expect((await patch(manager, kid, { venueId: venue, action: "revokeGuardian", guardianId: dadsRow.id, reason: "Court order shown at the desk" })).status).toBe(200);
    const told = (await messagesTo(mum.email)).slice(before);
    expect(told).toEqual([expect.objectContaining({ subject: expect.stringContaining("stopped acting"), body: expect.stringContaining("stopped acting for them on") })]);
    expect((await participantHistory(kid)).map((e) => e.action)).toEqual(
      expect.arrayContaining(["guardian.reported", "guardian.suspended", "guardian.confirmed", "guardian.revoked_by_staff"])
    );
  });
});

describe("what never happens", () => {
  it("another venue reaches nothing; an unknown request is nobody's; a typed number makes nobody a guardian", async () => {
    const kid = await counterChild("Omar");
    const notTheirs = await invite(otherManager, kid.id, { venueId: venue, proposedName: "Encik X" });
    expect(notTheirs.status).toBe(403);
    const unknown = await invite(otherManager, kid.id, { venueId: otherVenue, proposedName: "Encik X" });
    expect(unknown.status).toBe(404);
    expect((await json(unknown)).code).toBe("PTC_NOT_FOUND");
    expect((await json(await invite(desk, kid.id, { venueId: venue }))).code).toBe("GV_PROPOSED_NEEDED");
    expect((await json(await invite(desk, kid.id, { venueId: venue, email: "nobody@cg.test" }))).code).toBe("PTC_NO_ACCOUNT");
    // The old way, by name and number: no relationship, whatever is sent.
    const typed = await invite(desk, kid.id, { venueId: venue, guardianName: "Encik Y", guardianPhone: phone(), relationship: "parent", authority: true });
    expect((await json(typed)).code).toBe("GV_PROPOSED_NEEDED");
    expect((await json(await patch(manager, kid.id, { venueId: venue, action: "addGuardian", email: "x@cg.test", relationship: "parent", authority: true, reason: "Old way" }))).error).toContain(
      "action is revokeGuardian, suspendGuardian"
    );
    expect(await count("SELECT COUNT(*)::int AS n FROM participant_guardians WHERE participant_id = ?", kid.id)).toBe(1);
    expect((await json(await answer(await adult("Nobody"), { id: 999999, agree: true }))).code).toBe("GV_REQUEST_NOT_FOUND");
  });

  it("never the participant's own login, nor somebody already a guardian", async () => {
    const kid = await counterChild("Maya");
    const own = await adult("Maya Own");
    expect((await linkByStaff({ venueId: venue, participantId: kid.id, email: own.email, admin: { id: manager.id, name: manager.name }, reason: "Her own login, she asked" })).ok).toBe(true);
    expect((await json(await invite(manager, kid.id, { venueId: venue, email: own.email }))).code).toBe("PTC_GUARDIAN_OWN_LOGIN");
    const mum = await adult("Puan Zara");
    const kid2 = await onlineChild(mum, "Zain");
    expect((await json(await invite(manager, kid2, { venueId: venue, email: mum.email }))).code).toBe("PTC_GUARDIAN_ALREADY");
    const { request } = (await json(await invite(manager, kid2, { venueId: venue, proposedName: "Puan Zara again" }))) as { request: { code: string } };
    expect((await json(await accept(mum, { code: request.code, relationship: "parent", authority: true }))).code).toBe("PTC_ALREADY_GUARDIAN");
  });

  it("guardians sharing one family number stay two people, and the shared number makes the second nobody's guardian until agreed", async () => {
    const family = phone();
    // The mother is on record at the counter by that number; the father's account is on the same number.
    const kid = await counterChild("Hana", family);
    const dad = await adult("Encik Faiz", family);
    // The number matches the mother's, yet the father's account acts for nobody.
    expect(await listManaged(dad.id)).toEqual([]);
    expect((await json(await bookOnline(dad, kid.id, 17))).code).toBe("GUARD_NOT_FOUND");
    const { request } = (await json(await invite(manager, kid.id, { venueId: venue, email: dad.email }))) as { request: { id: number; code: string } };
    await accepts(dad, request.code);
    await patch(manager, kid.id, { venueId: venue, action: "exception", requestId: request.id, category: "guardian_unavailable", reason: "Mother present, no account", reviewOn: reviewOn() });
    const guardians = (await participantsForVenue(venue, family)).find((p) => p.id === kid.id)!.guardians;
    expect(guardians.map((g) => [g.name, g.account])).toEqual([
      ["Puan Aminah", false],
      ["Encik Faiz", true],
    ]);
    expect(await count("SELECT COUNT(*)::int AS n FROM participants WHERE display_name = 'Hana'")).toBe(1);
  });
});

describe("at the same moment (real concurrency on Postgres)", () => {
  it("one code accepted twice at once, and one request agreed by two guardians at once: one relationship", async () => {
    const mum = await adult("Puan Ita");
    const gran = await adult("Nenek Ita");
    const kid = await onlineChild(mum, "Ita");
    const { code: granCode } = (await createInvite(mum, kid, "guardian")) as { code: string };
    await acceptInvite(gran, { code: granCode, relationship: "other", authority: true });
    const dad = await adult("Encik Ita");
    const made = await requestAtVenue({ venueId: venue, participantId: kid, admin: { id: desk.id, name: desk.name }, proposedName: "Encik Ita" });
    if (!made.ok) throw new Error(made.error);
    const hash = createHash("sha256").update(made.code.replace(/[^A-Z0-9]/g, "")).digest("hex");
    const accepted = await Promise.all(Array.from({ length: 5 }, () => acceptGuardianInvite(dad, hash, { relationship: "parent", authority: true })));
    expect(accepted.filter((r) => r.ok)).toHaveLength(1);
    const answers = await Promise.all([answerRequest(mum, made.requestId, true), answerRequest(gran, made.requestId, true)]);
    expect(answers.filter((r) => r.ok)).toHaveLength(1);
    expect(answers.every((r) => r.ok || r.code === "GV_REQUEST_CLOSED")).toBe(true);
    expect(await count("SELECT COUNT(*)::int AS n FROM participant_guardians WHERE participant_id = ? AND user_id = ? AND revoked_at IS NULL", kid, dad.id)).toBe(1);
  });
});

describe("relationships the earlier counter shortcut made (migration 0152)", () => {
  it("stay, flagged for a manager's review; the first guardian recorded with the child is not", async () => {
    const DIR = path.join(__dirname, "..", "db", "migrations");
    const FILES = fs.readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    const db = new PGlite({ extensions: { citext } });
    const run = async (files: string[]) => {
      for (const f of files) {
        const version = f.replace(/\.sql$/, "");
        await db.transaction(async (tx) => {
          await tx.exec(fs.readFileSync(path.join(DIR, f), "utf8"));
          await runStep(version, { query: async (sql, params) => ({ rows: (await tx.query(sql, params)).rows as Record<string, unknown>[] }) });
        });
      }
    };
    await run(FILES.filter((f) => f < "0152"));
    const id = async (sql: string, params: unknown[] = []) => (await db.query<{ id: number }>(`${sql} RETURNING id`, params)).rows[0].id;
    const v = await id("INSERT INTO venues (name, area, address, phone, time_zone) VALUES ('Old Counter', 'PJ', 'x', '031', 'Asia/Kuala_Lumpur')");
    const staff = await id("INSERT INTO admins (name, email, password_hash, venue_id) VALUES ('Desk', 'desk@old.my', 'x', $1)", [v]);
    const dad = await id("INSERT INTO users (name, email, phone, password_hash) VALUES ('Dad', 'dad@old.my', '0123', 'x')");
    const mumAccount = await id("INSERT INTO users (name, email, phone, password_hash) VALUES ('Mum', 'mum@old.my', '0124', 'x')");
    const kid = await id("INSERT INTO participants (display_name, origin, venue_id, created_by_admin_id) VALUES ('Aisyah', 'venue', $1, $2)", [v, staff]);
    const g = (sql: string, params: unknown[]) => id(`INSERT INTO participant_guardians ${sql}`, params);
    const first = await g(
      "(participant_id, contact_name, contact_phone, relationship, authority_declared_at, provenance, recorded_by_name, venue_id) VALUES ($1, 'Mum', '0125', 'parent', now(), 'counter', 'Desk', $2)",
      [kid, v]
    );
    const byNumber = await g(
      "(participant_id, contact_name, contact_phone, relationship, authority_declared_at, provenance, recorded_by_name, venue_id) VALUES ($1, 'Dad', '0123', 'parent', now(), 'counter', 'Desk', $2)",
      [kid, v]
    );
    const byAccount = await g("(participant_id, user_id, relationship, authority_declared_at, provenance, recorded_by_name, venue_id) VALUES ($1, $2, 'parent', now(), 'counter', 'Desk', $3)", [
      kid,
      dad,
      v,
    ]);
    const online = await g("(participant_id, user_id, relationship, authority_declared_at, provenance) VALUES ($1, $2, 'parent', now(), 'online')", [kid, mumAccount]);
    await run(FILES.filter((f) => f >= "0152"));
    const rows = (await db.query("SELECT id, review_reason, revoked_at FROM participant_guardians ORDER BY id")).rows;
    expect(rows).toEqual([
      { id: first, review_reason: null, revoked_at: null },
      { id: byNumber, review_reason: "counter-shortcut", revoked_at: null },
      { id: byAccount, review_reason: "counter-shortcut", revoked_at: null },
      { id: online, review_reason: null, revoked_at: null },
    ]);
    await db.close();
  });
});
