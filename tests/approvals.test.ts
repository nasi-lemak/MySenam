import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import sharp from "sharp";
import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { listActivity } from "../src/lib/activity";
import {
  apply,
  customerAct,
  customerApprovals,
  decide,
  documentFor,
  expireApprovals,
  requestById,
  saveRequirement,
  type ApplyInput,
  type Reviewer,
} from "../src/lib/approvals";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { setCoachLink } from "../src/lib/coach-schedule";
import { saveCoach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { eraseCustomer, exportCustomerData, pruneOldData } from "../src/lib/privacy";
import { createResources } from "../src/lib/resources";
import { signOffHolds } from "../src/lib/sign-offs";
import {
  accessCodeFor,
  createBooking,
  createBookingSeries,
  createVenue,
  payBookingFromWallet,
  recordInduction,
  setPaymentStatus,
  topUpWallet,
  updateCourt,
  updateVenue,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { setWaiver } from "../src/lib/waivers";
import * as adminRoute from "../src/app/api/admin/approvals/route";
import * as settingsRoute from "../src/app/api/admin/approvals/settings/route";
import * as coachRoute from "../src/app/api/coach/[token]/approvals/route";
import * as myRoute from "../src/app/api/my/approvals/route";
import * as myOneRoute from "../src/app/api/my/approvals/[id]/route";

/**
 * Registering online for an activity that needs approval (lib/approvals.ts;
 * docs/features/activities.md#registering-online-for-approval). An
 * application is its own record and grants nothing until it is approved: no
 * booking of the activity, no door code. Approving writes the sign-off the
 * booking rules already check. A slot asked for is held by an expiring claim,
 * and booked on approval only if the database still has room; two approvals
 * never overbook one place.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (n: number) => addDays(todayISO(ZONE), n);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0178${String(++n).padStart(6, "0")}`;

let venueA: number;
let venueB: number;
let wall: number;
let laneA: number;
let laneB: number;
let staffA: { id: number; name: string; cookie: string };
let staffB: { id: number; name: string; cookie: string };
let climbCoach: { id: number; name: string; venueId: number; active: boolean; token: string };
const staff = (s: { id: number; name: string }): Reviewer => ({ kind: "staff", admin: s });

async function customer(opts: { locale?: string } = {}) {
  const made = await registerUser({ name: `Climber ${++n}`, email: `apr${n}@apr.test`, phone: phone(), password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), locale = ? WHERE id = ?").run(opts.locale ?? null, made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

const climbing = (extra: Partial<ApplyInput> = {}): ApplyInput => ({
  venueId: venueA,
  sport: "climbing",
  answers: { q1: "Two years at another wall", q2: "" },
  declaration: true,
  videoWatched: true,
  waiver: true,
  adult: true,
  ...extra,
});

const archeryA = (extra: Partial<ApplyInput> = {}): ApplyInput => ({ venueId: venueA, sport: "archery", declaration: true, adult: true, ...extra });

async function applied(user: Awaited<ReturnType<typeof customer>>, input: ApplyInput, files: Buffer[] = []) {
  const made = await apply(user, input, files);
  if (!made.ok) throw new Error(`${made.code}: ${made.error}`);
  return made.request;
}

async function staffMember(venueId: number, name: string) {
  const made = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}@apr.test`, password: "a long enough password", venueId });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

const req = (url: string, method: string, cookie: string | null, body?: unknown) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.77.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** Money anywhere for a user: online payments, credit, receipts, refunds. */
async function moneyFor(userId: number): Promise<number> {
  const db = getDb();
  const q = async (sql: string) => ((await db.prepare(sql).get(userId)) as { n: number }).n;
  return (
    (await q("SELECT COUNT(*)::int AS n FROM wallet_entries WHERE user_id = ?")) +
    (await q("SELECT COUNT(*)::int AS n FROM receipts WHERE user_id = ?")) +
    (await q("SELECT COUNT(*)::int AS n FROM online_payment_bookings pb JOIN bookings b ON b.id = pb.booking_id WHERE b.user_id = ?")) +
    (await q("SELECT COUNT(*)::int AS n FROM bookings WHERE user_id = ?"))
  );
}

beforeAll(async () => {
  const make = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Puchong", address: "x", phone: ph, openMin: at(7), closeMin: at(23) });
    if (!v.ok) throw new Error("venue");
    return v.venue.id;
  };
  venueA = await make("Crag Puchong", "0312349101");
  venueB = await make("Range Cheras", "0312349102");
  const res = async (venue: number, sport: string, name: string, capacity: number) => {
    const r = await createResources({ venueId: venue, sport, name, offPeakRate: 30, peakRate: 30, capacity });
    if (!r.ok) throw new Error(r.error);
    return r.courts[0].id;
  };
  wall = await res(venueA, "climbing", "Lead wall", 20);
  laneA = await res(venueA, "archery", "Lane A", 1);
  laneB = await res(venueB, "archery", "Range lane", 1);
  staffA = await staffMember(venueA, "Sam Staff");
  staffB = await staffMember(venueB, "Bea Other");
  await setWaiver(venueA, "Climbing is dangerous. I climb at my own risk and follow the wall's rules at all times.");

  const coach = await saveCoach(venueA, { name: "Ida Instructor", sports: ["climbing", "archery"], rate: 50, hours: [] });
  if (!coach.ok) throw new Error(coach.error);
  await setCoachLink(coach.coach.id, venueA, true);
  const token = ((await getDb().prepare("SELECT calendar_token FROM coaches WHERE id = ?").get(coach.coach.id)) as { calendar_token: string }).calendar_token;
  climbCoach = { id: coach.coach.id, name: "Ida Instructor", venueId: venueA, active: true, token };

  for (const [venueId, input] of [
    [
      venueA,
      {
        sport: "climbing",
        declaration: "I can tie in with a figure-of-eight knot and belay safely.",
        videoUrl: "https://video.example/belay-briefing",
        questions: [{ text: "Where have you climbed before?" }, { text: "Anything we should know?", required: false }],
        waiver: true,
        validDays: 365,
        pendingDays: 7,
        holdHours: 24,
        coachIds: [climbCoach.id],
      },
    ],
    [venueA, { sport: "archery", declaration: "I have shot at a range before and know its whistle signals.", validDays: 180, holdHours: 4 }],
    [venueB, { sport: "archery", declaration: "I will follow the range officer's calls.", inPerson: "Range safety briefing with an instructor", validDays: 365 }],
  ] as const) {
    const saved = await saveRequirement(venueId, input as Record<string, unknown>);
    if (!saved.ok) throw new Error(saved.error);
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe("what a venue may ask", () => {
  it("never asks for an identity document, and needs a real check, not questions alone", async () => {
    expect(await saveRequirement(venueA, { sport: "climbing", documentLabel: "A copy of your IC or passport" })).toMatchObject({ ok: false });
    expect(await saveRequirement(venueA, { sport: "climbing", questions: [{ text: "Why?" }] })).toMatchObject({ ok: false });
    expect(await saveRequirement(venueA, { sport: "climbing", kind: "certification", declaration: "I am certified to do this." })).toMatchObject({ ok: false });
  });
});

describe("applying", () => {
  it("asks everything the venue asks, and a minor's guardian, recorded as declared", async () => {
    const me = await customer();
    expect(await apply(me, climbing({ declaration: false }))).toMatchObject({ ok: false, code: "APR_DECLARATION_NEEDED" });
    expect(await apply(me, climbing({ videoWatched: false }))).toMatchObject({ ok: false, code: "APR_VIDEO_NEEDED" });
    expect(await apply(me, climbing({ answers: {} }))).toMatchObject({ ok: false, code: "APR_ANSWER_NEEDED" });
    expect(await apply(me, climbing({ waiver: false }))).toMatchObject({ ok: false, code: "APR_WAIVER_NEEDED" });
    expect(await apply(me, climbing({ adult: undefined }))).toMatchObject({ ok: false, code: "APR_ADULT_NEEDED" });
    expect(await apply(me, climbing({ adult: false }))).toMatchObject({ ok: false, code: "APR_GUARDIAN_NEEDED" });
    expect(await apply(me, climbing({ adult: false, guardianName: "Mum", guardianDeclaration: false }))).toMatchObject({ ok: false, code: "APR_GUARDIAN_NEEDED" });
    expect(await apply(me, climbing(), [Buffer.from("not wanted")])).toMatchObject({ ok: false, code: "APR_NO_DOCUMENTS" });
    const r = await applied(me, climbing({ adult: false, guardianName: "Mei Ling Tan", guardianDeclaration: true }));
    expect(r).toMatchObject({ status: "pending", declaredAdult: false, guardianName: "Mei Ling Tan" });
    expect(r.guardianDeclaredAt).not.toBeNull();
    expect(r.declaredAt).not.toBeNull();
    expect(r.videoWatchedAt).not.toBeNull();
    expect(r.waiverSignedAt).not.toBeNull();
    // As declared, never as verified: there is nothing that says otherwise.
    const cols = (await getDb().prepare("SELECT column_name FROM information_schema.columns WHERE table_name = 'approval_requests'").all()) as { column_name: string }[];
    expect(cols.some((c) => /verif/.test(c.column_name))).toBe(false);
    // One live application at a time.
    expect(await apply(me, climbing())).toMatchObject({ ok: false, code: "APR_ALREADY_LIVE" });
  });

  it("needs an account: the route refuses a guest", async () => {
    const res = await myRoute.POST(req("http://localhost/api/my/approvals", "POST", null, climbing()));
    expect(res.status).toBe(401);
  });
});

describe("a pending application grants nothing", () => {
  it("books nothing and gives no sign-off until approved, then the ordinary booking works", async () => {
    const me = await customer({ locale: "ms" });
    const r = await applied(me, climbing());
    expect(await signOffHolds({ venueId: venueA, sport: "climbing", until: day(3), phone: me.phone, userId: me.id, channel: "customer", need: "any" })).toBe(false);
    expect(await createBooking({ courtId: wall, date: day(3), start: at(9), end: at(11), name: me.name, phone: me.phone, userId: me.id })).toMatchObject({
      ok: false,
      code: "SIGN_OFF_NEEDED",
    });
    const done = await decide(staff(staffA), r.id, "approve", { venueId: venueA });
    expect(done).toMatchObject({ ok: true, request: { status: "approved", validUntil: addDays(todayISO(), 364) } });
    // The sign-off the booking rules check, linked to the account, lasting as the venue says.
    const so = (await getDb().prepare("SELECT * FROM sign_offs WHERE id = (SELECT sign_off_id FROM approval_requests WHERE id = ?)").get(r.id)) as {
      user_id: number;
      kind: string;
      expires_on: string;
      admin_id: number;
    };
    expect(so).toMatchObject({ user_id: me.id, kind: "operational", expires_on: addDays(todayISO(), 364), admin_id: staffA.id });
    expect((await createBooking({ courtId: wall, date: day(3), start: at(9), end: at(11), name: me.name, phone: me.phone, userId: me.id })).ok).toBe(true);
    // Who, when, what: in its own history and the staff activity log.
    const after = (await requestById(r.id))!;
    expect(after.events.map((e) => e.action)).toEqual(["submitted", "approved"]);
    expect(after.events[1]).toMatchObject({ actor: "staff", actorName: "Sam Staff" });
    const log = await listActivity([venueA]);
    expect(log.find((a) => a.action === "approval.approved")).toMatchObject({ adminName: "Sam Staff" });
    // Told by email, in the language the account last used.
    const mail = (await getDb()
      .prepare("SELECT locale, subject, body FROM messages WHERE recipient = ? AND kind = 'programme' ORDER BY id DESC LIMIT 1")
      .get(me.email)) as { locale: string; subject: string; body: string };
    expect(mail.locale).toBe("ms");
    expect(mail.subject).toContain("Diluluskan");
    expect(mail.body).toContain(`sehingga ${addDays(todayISO(), 364)}`);
    expect(mail.body).not.toContain("sehingga sehingga");
  });

  it("opens no door: an unmanned lane's code waits for the approval, however the booking was made", async () => {
    const lane = (await createResources({ venueId: venueB, sport: "archery", name: "Night lane", offPeakRate: 20, peakRate: 20, capacity: 1 })) as {
      ok: true;
      courts: { id: number }[];
    };
    const opened = await updateCourt(lane.courts[0].id, { unmanned: true, accessCode: "4821" });
    if (!opened.ok) throw new Error(opened.error);
    await updateVenue(venueB, { staffedFrom: 0, staffedTo: 0 });
    const me = await customer();
    // Applied, and the online part even accepted: the in-person briefing is still to come.
    const r = await applied(me, { venueId: venueB, sport: "archery", declaration: true, adult: true });
    await decide(staff(staffB), r.id, "approve", { venueId: venueB });
    expect((await requestById(r.id))!.status).toBe("in_person_due");
    // A manager books it past the rules; it is paid and they are inducted for out of hours.
    const date = day(2);
    const booked = await createBookingSeries({ by: "staff", staff: { override: true }, courtId: lane.courts[0].id, date, start: at(12), end: at(13), weeks: 1, name: me.name, phone: me.phone });
    if (!booked.ok) throw new Error(booked.error);
    await setPaymentStatus(booked.bookings[0].code, true, "cash");
    await recordInduction({ venueId: venueB, phone: me.phone, name: me.name });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${date}T12:15:00+08:00`));
    expect(await accessCodeFor(booked.bookings[0].code, me.phone)).toMatchObject({ ok: false, reason: "approval-needed" });
    vi.useRealTimers();
    // Staff record the briefing: approved, and now the door opens.
    expect(await decide(staff(staffB), r.id, "in_person", { venueId: venueB })).toMatchObject({ ok: true, request: { status: "approved" } });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${date}T12:20:00+08:00`));
    expect(await accessCodeFor(booked.bookings[0].code, me.phone)).toMatchObject({ ok: true, accessCode: "4821" });
  });
});

describe("deciding", () => {
  it("refuses with a reason the customer is told, lets the slot go and leaves nothing to refund", async () => {
    const me = await customer();
    const r = await applied(me, archeryA({ slot: { courtId: laneA, date: day(4), start: at(10), end: at(11) } }));
    expect(r.slot).toMatchObject({ status: "held" });
    expect(await decide(staff(staffA), r.id, "reject", { venueId: venueA })).toMatchObject({ ok: false, code: "APR_REASON_NEEDED" });
    expect(await decide(staff(staffA), r.id, "reject", { venueId: venueA, reason: "We could not confirm your experience." })).toMatchObject({
      ok: true,
      request: { status: "rejected", slot: { status: "released" } },
    });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE approval_id = ? AND active").get(r.id)) as { n: number }).n).toBe(0);
    expect(await moneyFor(me.id)).toBe(0);
    // The slot is free for anybody again.
    const other = await customer();
    await getDb().prepare("INSERT INTO sign_offs (venue_id, sport, phone, name, user_id) VALUES (?, 'archery', ?, ?, ?)").run(venueA, other.phone, other.name, other.id);
    expect((await createBooking({ courtId: laneA, date: day(4), start: at(10), end: at(11), name: other.name, phone: other.phone, userId: other.id })).ok).toBe(true);
    // Decided once: a second decision is refused.
    expect(await decide(staff(staffA), r.id, "approve", { venueId: venueA })).toMatchObject({ ok: false, code: "APR_WRONG_STATUS" });
  });

  it("asks for more, the customer answers, and it comes back for review", async () => {
    const me = await customer();
    const r = await applied(me, climbing());
    expect(await decide(staff(staffA), r.id, "ask", { venueId: venueA, reason: "Which wall, and when?" })).toMatchObject({ ok: true, request: { status: "info_requested" } });
    // Not the customer's to approve; nor somebody else's to answer.
    const stranger = await customer();
    expect(await customerAct(stranger, r.id, "answer", { answer: "Me!" })).toMatchObject({ ok: false, code: "APR_NOT_FOUND" });
    expect(await customerAct(me, r.id, "answer", { answer: "" })).toMatchObject({ ok: false, code: "APR_ANSWER_NEEDED" });
    const answered = await customerAct(me, r.id, "answer", { answer: "Camp5, every week for two years." });
    expect(answered).toMatchObject({ ok: true, request: { status: "pending" } });
    expect(await decide(staff(staffA), r.id, "approve", { venueId: venueA })).toMatchObject({ ok: true, request: { status: "approved" } });
    const events = (await requestById(r.id))!.events;
    expect(events.map((e) => [e.action, e.reason])).toEqual([
      ["submitted", null],
      ["asked", "Which wall, and when?"],
      ["answered", "Camp5, every week for two years."],
      ["approved", null],
    ]);
  });

  it("never lets an online declaration stand in for the in-person step", async () => {
    const me = await customer();
    const r = await applied(me, { venueId: venueB, sport: "archery", declaration: true, adult: true, slot: { courtId: laneB, date: day(5), start: at(10), end: at(11) } });
    const online = await decide(staff(staffB), r.id, "approve", { venueId: venueB });
    // The slot is booked as the session at which the briefing is done; nothing else.
    expect(online).toMatchObject({ ok: true, request: { status: "in_person_due", slot: { status: "booked" } } });
    if (!online.ok) return;
    expect(online.booking).not.toBeNull();
    expect(await signOffHolds({ venueId: venueB, sport: "archery", until: day(5), phone: me.phone, userId: me.id, channel: "customer", need: "any" })).toBe(false);
    expect(await createBooking({ courtId: laneB, date: day(6), start: at(10), end: at(11), name: me.name, phone: me.phone, userId: me.id })).toMatchObject({
      ok: false,
      code: "SIGN_OFF_NEEDED",
    });
    // Approving again online does not complete it.
    expect(await decide(staff(staffB), r.id, "approve", { venueId: venueB })).toMatchObject({ ok: false, code: "APR_WRONG_STATUS" });
    // The in-person step, recorded by staff, does; and the session booked is not booked twice.
    const done = await decide(staff(staffB), r.id, "in_person", { venueId: venueB, reason: "Shot a full end safely" });
    expect(done).toMatchObject({ ok: true, request: { status: "approved" }, booking: null });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE user_id = ?").get(me.id)) as { n: number }).n).toBe(1);
    expect((await createBooking({ courtId: laneB, date: day(6), start: at(10), end: at(11), name: me.name, phone: me.phone, userId: me.id })).ok).toBe(true);
  });

  it("lets the customer book the in-person session online once the online part is accepted", async () => {
    const me = await customer();
    const r = await applied(me, { venueId: venueB, sport: "archery", declaration: true, adult: true });
    await decide(staff(staffB), r.id, "approve", { venueId: venueB });
    const res = await myOneRoute.POST(
      req(`http://localhost/api/my/approvals/${r.id}`, "POST", me.cookie, { action: "slot", slot: { courtId: laneB, date: day(12), start: at(10), end: at(11) } }),
      { params: Promise.resolve({ id: String(r.id) }) }
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { bookingCode: string | null }).bookingCode).toBeTruthy();
    expect((await requestById(r.id))!).toMatchObject({ status: "in_person_due", slot: { status: "booked" } });
    // A session for the in-person step, and still no sign-off until it is done.
    expect(await signOffHolds({ venueId: venueB, sport: "archery", until: day(12), phone: me.phone, userId: me.id, channel: "customer", need: "any" })).toBe(false);
  });

  it("records the in-person step done first, and completes on the online review", async () => {
    const me = await customer();
    const r = await applied(me, { venueId: venueB, sport: "archery", declaration: true, adult: true });
    expect(await decide(staff(staffB), r.id, "in_person", { venueId: venueB })).toMatchObject({ ok: true, request: { status: "pending" } });
    expect(await signOffHolds({ venueId: venueB, sport: "archery", until: day(1), phone: me.phone, userId: me.id, channel: "customer", need: "any" })).toBe(false);
    expect(await decide(staff(staffB), r.id, "approve", { venueId: venueB })).toMatchObject({ ok: true, request: { status: "approved" } });
  });
});

describe("who may decide", () => {
  it("an authorised coach reviews what the venue named them for, and nothing else", async () => {
    const me = await customer();
    const climb = await applied(me, climbing());
    const shoot = await applied(me, archeryA());
    const coach: Reviewer = { kind: "coach", coach: climbCoach };
    expect(await decide(coach, shoot.id, "approve")).toMatchObject({ ok: false, code: "APR_NOT_REVIEWER", status: 403 });
    // At their link: their list holds only what they may review.
    const list = await coachRoute.GET(req(`http://localhost/api/coach/${climbCoach.token}/approvals`, "GET", null), { params: Promise.resolve({ token: climbCoach.token }) });
    const ids = ((await list.json()) as { requests: { id: number; sport: string }[] }).requests.map((r) => r.sport);
    expect(ids).toContain("climbing");
    expect(ids).not.toContain("archery");
    const res = await coachRoute.POST(req(`http://localhost/api/coach/${climbCoach.token}/approvals`, "POST", null, { id: climb.id, action: "approve" }), {
      params: Promise.resolve({ token: climbCoach.token }),
    });
    expect(res.status).toBe(200);
    const after = (await requestById(climb.id))!;
    expect(after.events.at(-1)).toMatchObject({ actor: "coach", actorName: "Ida Instructor" });
    expect((await listActivity([venueA])).find((a) => a.action === "approval.approved" && a.adminName.includes("Ida"))).toBeDefined();
    // No manager's powers: the settings are an admin route, closed to a coach link.
    expect((await settingsRoute.POST(req("http://localhost/api/admin/approvals/settings", "POST", null, { venueId: venueA, sport: "climbing", declaration: "Anything goes now." }))).status).toBe(401);
    // A coach the venue retires reviews nothing more.
    expect(await decide({ kind: "coach", coach: { ...climbCoach, active: false } }, shoot.id, "approve")).toMatchObject({ ok: false, status: 403 });
  });

  it("another venue's staff can neither see nor decide", async () => {
    const me = await customer();
    const r = await applied(me, climbing());
    expect((await adminRoute.GET(req(`http://localhost/api/admin/approvals?venueId=${venueA}`, "GET", staffB.cookie))).status).toBe(403);
    expect((await adminRoute.POST(req("http://localhost/api/admin/approvals", "POST", staffB.cookie, { venueId: venueA, id: r.id, action: "approve" }))).status).toBe(403);
    const asOwn = await adminRoute.POST(req("http://localhost/api/admin/approvals", "POST", staffB.cookie, { venueId: venueB, id: r.id, action: "approve" }));
    expect(asOwn.status).toBe(404);
    expect((await requestById(r.id))!.status).toBe("pending");
    // The venue's own staff see it, and decide it.
    const list = await adminRoute.GET(req(`http://localhost/api/admin/approvals?venueId=${venueA}&waiting=1`, "GET", staffA.cookie));
    expect(((await list.json()) as { requests: { id: number }[] }).requests.some((x) => x.id === r.id)).toBe(true);
    expect((await adminRoute.POST(req("http://localhost/api/admin/approvals", "POST", staffA.cookie, { venueId: venueA, id: r.id, action: "approve" }))).status).toBe(200);
  });
});

describe("slots held while an application waits", () => {
  it("holds the slot from everybody else, and on approval books it through the ordinary path", async () => {
    const me = await customer();
    const r = await applied(me, archeryA({ slot: { courtId: laneA, date: day(6), start: at(14), end: at(15) } }));
    const other = await customer();
    await getDb().prepare("INSERT INTO sign_offs (venue_id, sport, phone, name, user_id) VALUES (?, 'archery', ?, ?, ?)").run(venueA, other.phone, other.name, other.id);
    expect((await createBooking({ courtId: laneA, date: day(6), start: at(14), end: at(15), name: other.name, phone: other.phone, userId: other.id })).ok).toBe(false);
    // Nothing charged while it waits: no booking, no money.
    expect(await moneyFor(me.id)).toBe(0);
    const done = await decide(staff(staffA), r.id, "approve", { venueId: venueA });
    expect(done).toMatchObject({ ok: true, request: { slot: { status: "booked" } } });
    if (!done.ok || !done.booking) throw new Error("not booked");
    // A booking like any other: unpaid, priced, and paid the ordinary way.
    expect(done.booking).toMatchObject({ status: "confirmed", paymentStatus: "unpaid" });
    expect(done.booking.totalPrice).toBeGreaterThan(0);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE approval_id = ? AND active").get(r.id)) as { n: number }).n).toBe(0);
    expect((await topUpWallet({ userId: me.id, amount: 100, adminId: staffA.id, venueId: venueA })).ok).toBe(true);
    expect(await payBookingFromWallet(done.booking.id)).toMatchObject({ ok: true });
  });

  it("lets a hold go when its time is up; approved after the slot was taken, nothing is overbooked", async () => {
    const me = await customer();
    const r = await applied(me, archeryA({ slot: { courtId: laneA, date: day(7), start: at(14), end: at(15) } }));
    await getDb().prepare("UPDATE approval_requests SET hold_until = now() - interval '1 minute' WHERE id = ?").run(r.id);
    await getDb().prepare("UPDATE claims SET expires_at = now() - interval '1 minute' WHERE approval_id = ?").run(r.id);
    expect((await expireApprovals()).holds).toBeGreaterThanOrEqual(1);
    expect((await requestById(r.id))!.slot).toMatchObject({ status: "lapsed" });
    const other = await customer();
    await getDb().prepare("INSERT INTO sign_offs (venue_id, sport, phone, name, user_id) VALUES (?, 'archery', ?, ?, ?)").run(venueA, other.phone, other.name, other.id);
    expect((await createBooking({ courtId: laneA, date: day(7), start: at(14), end: at(15), name: other.name, phone: other.phone, userId: other.id })).ok).toBe(true);
    const done = await decide(staff(staffA), r.id, "approve", { venueId: venueA });
    expect(done).toMatchObject({ ok: true, booking: null, request: { status: "approved", slot: { status: "taken" } } });
    const onSlot = (await getDb()
      .prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE court_id = ? AND date = ? AND start_min = ? AND status = 'confirmed'")
      .get(laneA, day(7), at(14))) as { n: number };
    expect(onSlot.n).toBe(1);
    // Told: approved, the slot gone, the waiting list or another time offered.
    const mail = (await getDb().prepare("SELECT body FROM messages WHERE recipient = ? ORDER BY id DESC LIMIT 1").get(me.email)) as { body: string };
    expect(mail.body).toMatch(/waiting list/);
  });

  it("two approvals racing for one place: one is booked, the other is told it is gone", async () => {
    const date = day(8);
    const slot = { courtId: laneA, date, start: at(16), end: at(17) };
    const first = await customer();
    const second = await customer();
    const a = await applied(first, archeryA({ slot }));
    // The first hold runs out; the second customer's application holds the same place.
    await getDb().prepare("UPDATE claims SET expires_at = now() - interval '1 minute' WHERE approval_id = ?").run(a.id);
    const b = await applied(second, archeryA({ slot }));
    expect(b.slot).toMatchObject({ status: "held" });
    const [x, y] = await Promise.all([decide(staff(staffA), a.id, "approve", { venueId: venueA }), decide(staff(staffA), b.id, "approve", { venueId: venueA })]);
    expect(x.ok && y.ok).toBe(true);
    const booked = [x, y].filter((d) => d.ok && d.booking !== null);
    expect(booked).toHaveLength(1);
    const onSlot = (await getDb()
      .prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE court_id = ? AND date = ? AND start_min = ? AND status = 'confirmed'")
      .get(laneA, date, at(16))) as { n: number };
    expect(onSlot.n).toBe(1);
    // Both approved: the approval does not depend on the slot.
    expect((await requestById(a.id))!.status).toBe("approved");
    expect((await requestById(b.id))!.status).toBe("approved");
  });

  it("the same application approved twice at once is approved, and booked, once", async () => {
    const me = await customer();
    const r = await applied(me, archeryA({ slot: { courtId: laneA, date: day(9), start: at(10), end: at(11) } }));
    const results = await Promise.all([decide(staff(staffA), r.id, "approve", { venueId: venueA }), decide(staff(staffA), r.id, "approve", { venueId: venueA })]);
    expect(results.filter((d) => d.ok)).toHaveLength(1);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE user_id = ?").get(me.id)) as { n: number }).n).toBe(1);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM sign_offs WHERE user_id = ? AND revoked_at IS NULL").get(me.id)) as { n: number }).n).toBe(1);
  });

  it("withdrawing lets the slot go, and refuses a slot the rules do not allow", async () => {
    const me = await customer();
    expect(await apply(me, archeryA({ slot: { courtId: laneA, date: day(3), start: at(3), end: at(4) } }))).toMatchObject({ ok: false, code: "APR_SLOT_BAD" });
    expect(await apply(me, archeryA({ slot: { courtId: laneB, date: day(3), start: at(10), end: at(11) } }))).toMatchObject({ ok: false, code: "APR_SLOT_BAD" });
    const r = await applied(me, archeryA({ slot: { courtId: laneA, date: day(10), start: at(10), end: at(11) } }));
    const res = await myOneRoute.POST(req(`http://localhost/api/my/approvals/${r.id}`, "POST", me.cookie, { action: "withdraw" }), { params: Promise.resolve({ id: String(r.id) }) });
    expect(res.status).toBe(200);
    expect((await requestById(r.id))!).toMatchObject({ status: "withdrawn", slot: { status: "released" } });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE approval_id = ? AND active").get(r.id)) as { n: number }).n).toBe(0);
  });
});

describe("the clock", () => {
  it("lapses an application nobody acts on, its hold with it", async () => {
    const me = await customer();
    const r = await applied(me, archeryA({ slot: { courtId: laneA, date: day(11), start: at(10), end: at(11) } }));
    await getDb().prepare("UPDATE approval_requests SET expires_at = now() - interval '1 minute' WHERE id = ?").run(r.id);
    expect((await expireApprovals()).expired).toBeGreaterThanOrEqual(1);
    expect((await requestById(r.id))!).toMatchObject({ status: "expired", slot: { status: "released" } });
    expect((await listActivity([venueA])).find((a) => a.action === "approval.expired")).toMatchObject({ adminName: "Automatic" });
    expect(await decide(staff(staffA), r.id, "approve", { venueId: venueA })).toMatchObject({ ok: false, code: "APR_WRONG_STATUS" });
    // It can be applied for again.
    expect((await apply(me, archeryA())).ok).toBe(true);
  });

  it("runs an approval out after its period: booking stops, and it is renewed by applying again", async () => {
    const me = await customer();
    const r = await applied(me, archeryA());
    await decide(staff(staffA), r.id, "approve", { venueId: venueA });
    // Close to its end: the customer hears, once.
    await getDb().prepare("UPDATE approval_requests SET valid_until = ? WHERE id = ?").run(day(5), r.id);
    const first = await expireApprovals();
    expect(first.reminded).toBeGreaterThanOrEqual(1);
    expect((await expireApprovals()).reminded).toBe(0);
    // Past it: the sign-off it wrote has run out too, and booking stops.
    await getDb().prepare("UPDATE approval_requests SET valid_until = ? WHERE id = ?").run(day(-1), r.id);
    await getDb().prepare("UPDATE sign_offs SET expires_on = ? WHERE id = (SELECT sign_off_id FROM approval_requests WHERE id = ?)").run(day(-1), r.id);
    expect(await createBooking({ courtId: laneA, date: day(2), start: at(8), end: at(9), name: me.name, phone: me.phone, userId: me.id })).toMatchObject({ ok: false, code: "SIGN_OFF_NEEDED" });
    expect((await customerApprovals(me.id)).find((x) => x.id === r.id)).toMatchObject({ status: "approved", lapsed: true });
    const renewal = await applied(me, archeryA());
    expect(renewal.renewalOf).toBe(r.id);
    await decide(staff(staffA), renewal.id, "approve", { venueId: venueA });
    expect((await createBooking({ courtId: laneA, date: day(2), start: at(8), end: at(9), name: me.name, phone: me.phone, userId: me.id })).ok).toBe(true);
  });

  it("refuses a new application while an approval still has long to run", async () => {
    const me = await customer();
    const r = await applied(me, archeryA());
    await decide(staff(staffA), r.id, "approve", { venueId: venueA });
    expect(await apply(me, archeryA())).toMatchObject({ ok: false, code: "APR_ALREADY_APPROVED" });
  });
});

describe("documents and certifications", () => {
  let photo: Buffer;
  beforeAll(async () => {
    photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 20, g: 120, b: 200 } } }).jpeg().toBuffer();
    const saved = await saveRequirement(venueB, {
      sport: "climbing",
      kind: "certification",
      documentLabel: "Your lead-climbing certificate",
      declaration: "The certificate I send is my own and in force.",
      validDays: 3000,
    });
    if (!saved.ok) throw new Error(saved.error);
    const r = await createResources({ venueId: venueB, sport: "climbing", name: "Cert wall", offPeakRate: 30, peakRate: 30, capacity: 10 });
    if (!r.ok) throw new Error(r.error);
  });
  const cert = (extra: Partial<ApplyInput> = {}): ApplyInput => ({
    venueId: venueB,
    sport: "climbing",
    declaration: true,
    adult: true,
    certReference: "SPA-1234, Malaysian Mountaineering",
    certExpiresOn: day(200),
    ...extra,
  });

  it("asks for the document and the certificate's details, redraws the upload, and shows it only to whom it should", async () => {
    const me = await customer();
    expect(await apply(me, cert())).toMatchObject({ ok: false, code: "APR_DOCUMENT_NEEDED" });
    expect(await apply(me, cert(), [Buffer.from("%PDF-1.4 not an image")])).toMatchObject({ ok: false, code: "APR_DOCUMENT_BAD" });
    expect(await apply(me, cert({ certReference: "" }), [photo])).toMatchObject({ ok: false, code: "APR_CERT_NEEDED" });
    const r = await applied(me, cert(), [photo]);
    expect(r.documents).toHaveLength(1);
    expect(r.documents[0].contentType).toBe("image/webp");
    const id = r.documents[0].id;
    expect(await documentFor(id, { userId: me.id })).not.toBeNull();
    expect(await documentFor(id, { userId: (await customer()).id })).toBeNull();
    expect(await documentFor(id, { venueId: venueB })).not.toBeNull();
    expect(await documentFor(id, { venueId: venueA })).toBeNull();
    expect(await documentFor(id, { coachId: climbCoach.id })).toBeNull();
    // Approved: a certification, with what was declared, ending with the certificate.
    await decide(staff(staffB), r.id, "approve", { venueId: venueB });
    const so = (await getDb().prepare("SELECT kind, reference, expires_on FROM sign_offs WHERE id = (SELECT sign_off_id FROM approval_requests WHERE id = ?)").get(r.id)) as {
      kind: string;
      reference: string;
      expires_on: string;
    };
    expect(so).toEqual({ kind: "certification", reference: "SPA-1234, Malaysian Mountaineering", expires_on: day(200) });
  });

  it("goes out with the customer's data, is deleted on a clock after the decision, and goes with the account", async () => {
    const me = await customer();
    const r = await applied(me, cert(), [photo]);
    const exported = (await exportCustomerData(me.id))!;
    const mine = exported.approvals as { activity: string; documents: { base64: string }[]; history: unknown[] }[];
    expect(mine).toHaveLength(1);
    expect(mine[0].documents[0].base64.length).toBeGreaterThan(100);
    expect(mine[0].history.length).toBeGreaterThan(0);
    await decide(staff(staffB), r.id, "reject", { venueId: venueB, reason: "The certificate is not readable." });
    await getDb().prepare("UPDATE approval_requests SET decided_at = now() - interval '100 days' WHERE id = ?").run(r.id);
    await pruneOldData();
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM approval_documents WHERE request_id = ?").get(r.id)) as { n: number }).n).toBe(0);
    expect(await requestById(r.id)).not.toBeNull();
    const again = await applied(me, cert(), [photo]);
    expect((await eraseCustomer(me.id)).ok).toBe(true);
    expect(await requestById(again.id)).toBeNull();
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM approval_documents WHERE request_id = ?").get(again.id)) as { n: number }).n).toBe(0);
  });
});

describe("the customer's own page", () => {
  it("lists their applications and what a venue asks, and nobody else's", async () => {
    const me = await customer();
    await applied(me, climbing());
    const res = await myRoute.GET(req(`http://localhost/api/my/approvals?venueId=${venueA}&sport=climbing`, "GET", me.cookie));
    const body = (await res.json()) as { requests: { userId: number }[]; apply: { questions: unknown[]; waiverText: string | null; coachIds?: unknown } };
    expect(body.requests.every((r) => r.userId === me.id)).toBe(true);
    expect(body.apply.questions).toHaveLength(2);
    // The coaches who review are the venue's business, not the applicant's.
    expect(body.apply.coachIds).toBeUndefined();
    const other = await customer();
    const theirs = (await (await myRoute.GET(req("http://localhost/api/my/approvals", "GET", other.cookie))).json()) as { requests: unknown[] };
    expect(theirs.requests).toHaveLength(0);
  });
});
