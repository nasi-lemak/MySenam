import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import sharp from "sharp";
import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { listActivity } from "../src/lib/activity";
import { apply, customerApprovals, customerAct, decide, documentFor, requestById, saveRequirement, venueApprovals, type ApplyInput, type Reviewer } from "../src/lib/approvals";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { openGame, setPlayerLevel } from "../src/lib/games";
import { addManaged, editManaged, listManaged, managedPerson } from "../src/lib/managed-people";
import { recommendPlayers } from "../src/lib/matchmaking";
import { saveProfile } from "../src/lib/player-profiles";
import { eraseCustomer, exportCustomerData, pruneOldData } from "../src/lib/privacy";
import { createResources } from "../src/lib/resources";
import { signOffHolds } from "../src/lib/sign-offs";
import { accessCodeFor, createBookingSeries, createVenue, findBooking, listBookingsForDate, recordInduction, setPaymentStatus, updateCourt, updateVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { setWaiver, waiverSigned, waiverSignedFor } from "../src/lib/waivers";
import * as adminRoute from "../src/app/api/admin/approvals/route";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as myApprovalsRoute from "../src/app/api/my/approvals/route";
import * as peopleRoute from "../src/app/api/my/people/route";
import { setDocumentScanner } from "../src/lib/document-scanner";
import { passingScanner } from "./helpers/scanner";

// Documents are released only once the malware scan passes them (ADR 0024): a stand-in that passes everything,
// so these tests are about what happens around a released document. The scan itself: tests/document-scanning.test.ts.
beforeAll(() => setDocumentScanner(passingScanner()));
afterAll(() => setDocumentScanner(null));

/**
 * A parent or guardian applying for a child from their own account (ADR 0022;
 * docs/features/activities.md#applying-for-somebody-you-manage):
 *
 * - the child is a minimal record under the adult's account, never a user:
 *   no email, phone, photo, school or identity number, refused if sent;
 * - the adult applies for them, declaring their authority; documents,
 *   status and email go to the adult; where the activity asks, staff record
 *   that they reviewed the adult's authority before approving;
 * - eligibility is the child's own: the sign-off approval writes counts for
 *   the child alone, never for the parent or a sibling, and the parent's
 *   never for the child, in booking and at the door, until revoked;
 * - children never reach discovery or matchmaking; another adult can neither
 *   see nor act on somebody else's child;
 * - their data goes out with the adult's export and is erased with the adult.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0177${String(++n).padStart(6, "0")}`;

type Staff = { id: number; name: string; cookie: string };
type Adult = Awaited<ReturnType<typeof adult>>;
const staff = (s: { id: number; name: string }): Reviewer => ({ kind: "staff", admin: s });

let doorVenue: number;
let doorLane: number;
let checkVenue: number;
let badmintonCourt: number;
let doorManager: Staff;
let checkManager: Staff;
let checkDesk: Staff;

async function adult(name = "Parent") {
  const made = await registerUser({ name: `${name} ${++n}`, email: `ga${n}@guard.test`, phone: phone(), password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now') WHERE id = ?").run(made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function staffMember(venueId: number, name: string, role: "manager" | "desk" = "manager"): Promise<Staff> {
  const made = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}${++n}@guard.test`, password: "a long enough password", venueId, role });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

const req = (url: string, method: string, cookie: string | null, body?: unknown) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.77.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function child(parent: Adult, displayName = "Aisyah", extra: Record<string, unknown> = {}) {
  const made = await addManaged(parent.id, { displayName, relationship: "parent", authority: true, ...extra });
  if (!made.ok) throw new Error(`${made.code}: ${made.error}`);
  return made.person;
}

const archeryAt = (venueId: number, extra: Partial<ApplyInput> = {}): ApplyInput => ({ venueId, sport: "archery", declaration: true, waiver: true, ...extra });

async function applied(user: Adult, input: ApplyInput, files: Buffer[] = []) {
  const made = await apply(user, input, files);
  if (!made.ok) throw new Error(`${made.code}: ${made.error}`);
  return made.request;
}

/** A child of this adult, applied for and approved at the door venue. */
async function approvedChild(parent: Adult, name = "Aisyah") {
  const kid = await child(parent, name);
  const r = await applied(parent, archeryAt(doorVenue, { forPerson: kid.id, authority: true }));
  const done = await decide(staff(doorManager), r.id, "approve", { venueId: doorVenue });
  if (!done.ok) throw new Error(done.error);
  return { kid, request: done.request };
}

const holds = (venueId: number, user: Adult, participant: number | null, channel: "customer" | "staff" = "customer") =>
  signOffHolds({ venueId, sport: "archery", until: day(3), phone: user.phone, userId: user.id, channel, need: "any", participant });

/** Paid, inducted, and asked for at a quarter past the hour it starts. */
async function door(code: string, ph: string, date: string, hour: number) {
  await setPaymentStatus(code, true, "cash");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${date}T${String(hour).padStart(2, "0")}:15:00+08:00`));
  const result = await accessCodeFor(code, ph);
  vi.useRealTimers();
  return result;
}

/** A booking at the unmanned lane, as staff make it, for the adult or (participant) somebody they manage. */
async function laneBooking(user: Adult, date: string, hour: number, participant?: { id: number; name: string }, by: "staff" | "customer" = "staff") {
  return createBookingSeries({
    by,
    courtId: doorLane,
    date,
    start: at(hour),
    end: at(hour + 1),
    weeks: 1,
    name: user.name,
    phone: user.phone,
    userId: user.id,
    ...(participant ? { participant } : {}),
  });
}

beforeAll(async () => {
  const venue = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Bangsar", address: "x", phone: ph, openMin: at(7), closeMin: at(23) });
    if (!v.ok) throw new Error("venue");
    return v.venue.id;
  };
  doorVenue = await venue("Junior Range", "0312340301");
  checkVenue = await venue("Checked Range", "0312340302");
  const lane = async (venueId: number, sport: string, name: string) => {
    const r = await createResources({ venueId, sport, name, offPeakRate: 20, peakRate: 20, capacity: 1 });
    if (!r.ok) throw new Error(r.error);
    return r.courts[0].id;
  };
  doorLane = await lane(doorVenue, "archery", "Junior lane");
  await lane(checkVenue, "archery", "Checked lane");
  badmintonCourt = await lane(doorVenue, "badminton", "Hall court");
  doorManager = await staffMember(doorVenue, "Nadia Night");
  checkManager = await staffMember(checkVenue, "Kamal Check");
  checkDesk = await staffMember(checkVenue, "Dina Desk", "desk");

  for (const [venueId, input] of [
    [doorVenue, { sport: "archery", declaration: "My child will follow the range officer's calls at all times.", validDays: 365, waiver: true }],
    [checkVenue, { sport: "archery", declaration: "My child will follow the range officer's calls at all times.", validDays: 365, guardianCheck: true }],
    [
      doorVenue,
      {
        sport: "climbing",
        declaration: "The certificate sent is my child's own and in force.",
        documentLabel: "Their climbing course certificate",
        documentPurpose: "Children climb here only after a recognised course.",
        validDays: 365,
      },
    ],
  ] as const) {
    const s = await saveRequirement(venueId, input as unknown as Record<string, unknown>);
    if (!s.ok) throw new Error(s.error);
  }
  await setWaiver(doorVenue, "Archery is dangerous. Everybody shoots at their own risk and follows the range rules at all times.");

  // The door venue is unstaffed at every hour; its lane has a keypad.
  const opened = await updateCourt(doorLane, { unmanned: true, accessCode: "4321" });
  if (!opened.ok) throw new Error(opened.error);
  await updateVenue(doorVenue, { staffedFrom: 0, staffedTo: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------- the record

describe("people an adult manages", () => {
  it("holds a name, a declared birth year and relationship, and the adult's declared authority: nothing else", async () => {
    const me = await adult();
    const added = await addManaged(me.id, { displayName: "  Aisyah  ", birthYear: 2016, relationship: "parent", authority: true });
    expect(added).toMatchObject({ ok: true, person: { displayName: "Aisyah", birthYear: 2016, relationship: "parent", archivedAt: null } });
    if (!added.ok) return;
    expect(added.person.authorityDeclaredAt).toBeTruthy();
    // Exactly the columns held, and no contact details.
    const row = (await getDb().prepare("SELECT * FROM managed_people WHERE id = ?").get(added.person.id)) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      ["archived_at", "authority_declared_at", "birth_year", "created_at", "display_name", "id", "relationship", "updated_at", "user_id"].sort()
    );
    // No login of their own: no user row was made.
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM users WHERE name LIKE '%Aisyah%'").get()) as { n: number }).toEqual({ n: 0 });
  });

  it("refuses what it does not hold, a name that is contact details, and no declaration", async () => {
    const me = await adult();
    for (const extra of [{ email: "kid@x.my" }, { phone: "0123456789" }, { photo: "data:image/png;base64,AAAA" }, { school: "SK Bangsar" }, { idNumber: "160101-14-1234" }])
      expect(await addManaged(me.id, { displayName: "Amir", relationship: "parent", authority: true, ...extra })).toMatchObject({ ok: false, code: "GUARD_EXTRA_FIELD" });
    expect(await addManaged(me.id, { displayName: "amir@example.my", relationship: "parent", authority: true })).toMatchObject({ ok: false, code: "GUARD_NAME_NEEDED" });
    expect(await addManaged(me.id, { displayName: "012 345 6789", relationship: "parent", authority: true })).toMatchObject({ ok: false, code: "GUARD_NAME_NEEDED" });
    expect(await addManaged(me.id, { displayName: "Amir", relationship: "uncle", authority: true })).toMatchObject({ ok: false, code: "GUARD_RELATIONSHIP_NEEDED" });
    expect(await addManaged(me.id, { displayName: "Amir", relationship: "parent" })).toMatchObject({ ok: false, code: "GUARD_AUTHORITY_NEEDED" });
    expect(await addManaged(me.id, { displayName: "Amir", relationship: "parent", authority: true, birthYear: 1850 })).toMatchObject({ ok: false, code: "GUARD_BIRTH_YEAR_BAD" });
    expect(await listManaged(me.id)).toEqual([]);
    // Through the route too, and an edit cannot slip one in either.
    const res = await peopleRoute.POST(req("http://localhost/api/my/people", "POST", me.cookie, { displayName: "Amir", relationship: "guardian", authority: true, email: "a@b.my" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("GUARD_EXTRA_FIELD");
    const kid = await child(me, "Amir");
    expect(await editManaged(me.id, kid.id, { phone: "0123456789" })).toMatchObject({ ok: false, code: "GUARD_EXTRA_FIELD" });
  });

  it("are changed, archived and brought back by their adult; a changed relationship needs the declaration again", async () => {
    const me = await adult();
    const kid = await child(me, "Hana");
    expect(await editManaged(me.id, kid.id, { relationship: "guardian" })).toMatchObject({ ok: false, code: "GUARD_AUTHORITY_NEEDED" });
    expect(await editManaged(me.id, kid.id, { relationship: "guardian", authority: true, displayName: "Hana Sofea" })).toMatchObject({
      ok: true,
      person: { displayName: "Hana Sofea", relationship: "guardian" },
    });
    const res = await peopleRoute.PATCH(req("http://localhost/api/my/people", "PATCH", me.cookie, { id: kid.id, archived: true }));
    expect(res.status).toBe(200);
    expect(await listManaged(me.id)).toEqual([]);
    expect((await listManaged(me.id, { archived: true }))[0]).toMatchObject({ id: kid.id });
    expect(await editManaged(me.id, kid.id, { archived: false })).toMatchObject({ ok: true, person: { archivedAt: null } });
  });
});

// ---------------------------------------------------------------------------------------------- applying

describe("applying for a child", () => {
  it("records the child, the adult as applicant and guardian, and the authority declared; told to the adult", async () => {
    const me = await adult();
    const kid = await child(me, "Danish");
    expect(await apply(me, archeryAt(doorVenue, { forPerson: kid.id }))).toMatchObject({ ok: false, code: "GUARD_AUTHORITY_NEEDED" });
    const r = await applied(me, archeryAt(doorVenue, { forPerson: kid.id, authority: true }));
    expect(r).toMatchObject({
      userId: me.id,
      name: "Danish",
      status: "pending",
      declaredAdult: false,
      guardianName: me.name,
      forPerson: { id: kid.id, name: "Danish", relationship: "parent" },
      appliedBy: me.name,
    });
    expect(r.guardianDeclaredAt).toBeTruthy();
    expect(r.authorityDeclaredAt).toBeTruthy();
    // In the adult's own list, and the email about it to the adult, naming the child.
    expect((await customerApprovals(me.id)).map((x) => x.id)).toContain(r.id);
    const mail = (await getDb().prepare("SELECT body FROM messages WHERE recipient = ? ORDER BY id DESC LIMIT 1").get(me.email)) as { body: string };
    expect(mail.body).toContain("This is about Danish");
    // The waiver: agreed by the adult on the child's behalf, not as the adult's own.
    expect(await waiverSignedFor(doorVenue, kid.id)).toBe(true);
    expect(await waiverSigned(doorVenue, me.phone)).toBe(false);
    const sig = (await getDb().prepare("SELECT name, participant_name FROM waiver_signatures WHERE managed_person_id = ?").get(kid.id)) as { name: string; participant_name: string };
    expect(sig).toEqual({ name: me.name, participant_name: "Danish" });
    // The staff list says who applied for whom.
    const seen = (await venueApprovals(doorVenue)).find((x) => x.id === r.id)!;
    expect(seen.forPerson?.name).toBe("Danish");
    expect(seen.appliedBy).toBe(me.name);
  });

  it("one live application per person: the adult and each child apart; a sibling's does not block", async () => {
    const me = await adult();
    const a = await child(me, "Adam");
    const b = await child(me, "Batrisya");
    await applied(me, archeryAt(doorVenue, { forPerson: a.id, authority: true }));
    expect(await apply(me, archeryAt(doorVenue, { forPerson: a.id, authority: true }))).toMatchObject({ ok: false, code: "APR_ALREADY_LIVE" });
    await applied(me, archeryAt(doorVenue, { forPerson: b.id, authority: true }));
    await applied(me, archeryAt(doorVenue, { adult: true }));
  });

  it("documents for a child's application are the adult's to open, and the venue's; nobody else's", async () => {
    const me = await adult();
    const kid = await child(me, "Iman");
    const photo = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#225588" } }).jpeg().toBuffer();
    const r = await applied(me, { venueId: doorVenue, sport: "climbing", declaration: true, forPerson: kid.id, authority: true }, [photo]);
    expect(r.documents).toHaveLength(1);
    const id = r.documents[0].id;
    expect(await documentFor(id, { userId: me.id })).not.toBeNull();
    expect(await documentFor(id, { userId: (await adult()).id })).toBeNull();
    expect(await documentFor(id, { venueId: doorVenue })).not.toBeNull();
    expect(await documentFor(id, { venueId: checkVenue })).toBeNull();
  });

  it("an archived child keeps the application still under review; nothing new is made for them", async () => {
    const me = await adult();
    const kid = await child(me, "Zara");
    const r = await applied(me, archeryAt(doorVenue, { forPerson: kid.id, authority: true }));
    await editManaged(me.id, kid.id, { archived: true });
    expect((await requestById(r.id))!.status).toBe("pending");
    expect(await apply(me, archeryAt(checkVenue, { forPerson: kid.id, authority: true }))).toMatchObject({ ok: false, code: "GUARD_NOT_FOUND" });
    // The adult can still withdraw it.
    expect(await customerAct(me, r.id, "withdraw")).toMatchObject({ ok: true, request: { status: "withdrawn" } });
  });
});

// ---------------------------------------------------------------------------------------------- staff review of authority

describe("where the activity asks staff to review the adult's authority", () => {
  it("approval waits for it, recorded only by somebody who may grant it, never automatically", async () => {
    const me = await adult();
    const kid = await child(me, "Nur");
    const r = await applied(me, archeryAt(checkVenue, { forPerson: kid.id, authority: true, waiver: undefined }));
    expect(r.guardianCheck).toBe(true);
    expect(await decide(staff(checkManager), r.id, "approve", { venueId: checkVenue })).toMatchObject({ ok: false, code: "APR_CHILD_AUTHORITY_UNREVIEWED" });
    // Front desk, not delegated for this safety assessment, may not review it.
    expect(await decide(staff(checkDesk), r.id, "authority", { venueId: checkVenue })).toMatchObject({ ok: false, code: "APR_SAFETY_AUTHORITY" });
    // Through the route, by a manager, with a note.
    const res = await adminRoute.POST(
      req("http://localhost/api/admin/approvals", "POST", checkManager.cookie, { venueId: checkVenue, id: r.id, action: "authority", reason: "Saw the birth certificate at the desk; nothing kept." })
    );
    expect(res.status).toBe(200);
    const after = (await requestById(r.id))!;
    expect(after.authorityReviewedAt).toBeTruthy();
    expect(after.authorityReviewedBy).toBe(checkManager.name);
    expect(after.events.map((e) => e.action)).toContain("authority_reviewed");
    expect((await listActivity([checkVenue])).some((a) => a.action === "approval.authority_reviewed")).toBe(true);
    // Once only.
    expect(await decide(staff(checkManager), r.id, "authority", { venueId: checkVenue })).toMatchObject({ ok: false, code: "APR_WRONG_STATUS" });
    expect(await decide(staff(checkManager), r.id, "approve", { venueId: checkVenue })).toMatchObject({ ok: true, request: { status: "approved" } });
  });

  it("an adult's own application has no authority to review", async () => {
    const me = await adult();
    const r = await applied(me, archeryAt(checkVenue, { adult: true, waiver: undefined }));
    expect(await decide(staff(checkManager), r.id, "authority", { venueId: checkVenue })).toMatchObject({ ok: false, code: "APR_CHILD_OWN" });
    expect(await decide(staff(checkManager), r.id, "approve", { venueId: checkVenue })).toMatchObject({ ok: true });
  });

  it("off by default: the adult's declaration is recorded and approval goes ahead", async () => {
    const me = await adult();
    const { request } = await approvedChild(me, "Ilyas");
    expect(request).toMatchObject({ status: "approved", guardianCheck: false, authorityReviewedAt: null });
  });
});

// ---------------------------------------------------------------------------------------------- eligibility is the child's

describe("eligibility belongs to the child", () => {
  it("approval writes the child's sign-off: never the parent's, never a sibling's", async () => {
    const me = await adult();
    const sibling = await child(me, "Sibling");
    const { kid, request } = await approvedChild(me, "Firdaus");
    const so = (await getDb().prepare("SELECT managed_person_id, user_id, name, note FROM sign_offs WHERE id = (SELECT sign_off_id FROM approval_requests WHERE id = ?)").get(request.id)) as {
      managed_person_id: number;
      user_id: number;
      name: string;
      note: string;
    };
    expect(so).toMatchObject({ managed_person_id: kid.id, user_id: me.id, name: "Firdaus" });
    expect(so.note).toContain(`for somebody ${me.name} manages`);
    expect(await holds(doorVenue, me, kid.id)).toBe(true);
    expect(await holds(doorVenue, me, kid.id, "staff")).toBe(true);
    // The parent: online and at the counter, by account or by number.
    expect(await holds(doorVenue, me, null)).toBe(false);
    expect(await holds(doorVenue, me, null, "staff")).toBe(false);
    // The sibling.
    expect(await holds(doorVenue, me, sibling.id)).toBe(false);
    // Another adult cannot borrow it by naming the child.
    const other = await adult();
    expect(await holds(doorVenue, other, kid.id)).toBe(false);
  });

  it("the parent's own approval never counts for the child", async () => {
    const me = await adult();
    const kid = await child(me, "Qistina");
    const own = await applied(me, archeryAt(doorVenue, { adult: true }));
    await decide(staff(doorManager), own.id, "approve", { venueId: doorVenue });
    expect(await holds(doorVenue, me, null)).toBe(true);
    expect(await holds(doorVenue, me, kid.id)).toBe(false);
    expect(await holds(doorVenue, me, kid.id, "staff")).toBe(false);
    // And it does not stop the child being applied for, nor is replaced by the child's.
    const forKid = await applied(me, archeryAt(doorVenue, { forPerson: kid.id, authority: true }));
    await decide(staff(doorManager), forKid.id, "approve", { venueId: doorVenue });
    expect(await holds(doorVenue, me, null)).toBe(true);
    expect(await holds(doorVenue, me, kid.id)).toBe(true);
  });

  it("booking online: the child's booking on the child's sign-off; the parent and a sibling refused", async () => {
    const me = await adult();
    const sibling = await child(me, "Sibling Two");
    const { kid } = await approvedChild(me, "Haziq");
    const body = (date: string, hour: number, participantId?: number) => ({
      courtId: doorLane,
      date,
      start: at(hour),
      end: at(hour + 1),
      name: me.name,
      phone: me.phone,
      agreeWaiver: true,
      ...(participantId ? { participantId } : {}),
    });
    const forKid = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", me.cookie, body(day(2), 9, kid.id)));
    expect(forKid.status).toBe(201);
    const code = ((await forKid.json()) as { booking: { code: string } }).booking.code;
    expect(await findBooking(code, me.phone)).toMatchObject({ participantId: kid.id, participantName: "Haziq", name: me.name });
    const forMe = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", me.cookie, body(day(2), 10)));
    expect(((await forMe.json()) as { code: string }).code).toBe("SIGN_OFF_NEEDED");
    const forSibling = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", me.cookie, body(day(2), 11, sibling.id)));
    expect(((await forSibling.json()) as { code: string }).code).toBe("SIGN_OFF_NEEDED");
    // Somebody else's child cannot be named at all.
    const other = await adult();
    const stranger = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", other.cookie, { ...body(day(2), 12, kid.id), name: other.name, phone: other.phone }));
    expect(stranger.status).toBe(404);
    expect(((await stranger.json()) as { code: string }).code).toBe("GUARD_NOT_FOUND");
    // Staff see the child's name, booked by the adult, and the child's waiver.
    const row = (await listBookingsForDate(day(2), doorVenue)).find((b) => b.code === code)!;
    expect(row).toMatchObject({ participantName: "Haziq", name: me.name, waiverSigned: true });
  });

  it("door codes: the child's booking opens; the parent's and a sibling's do not; revoked, nothing", async () => {
    const me = await adult();
    await recordInduction({ venueId: doorVenue, phone: me.phone, name: me.name });
    const sibling = await child(me, "Sibling Three");
    const { kid, request } = await approvedChild(me, "Umar");
    const date = day(4);
    const mine = await laneBooking(me, date, 8, undefined, "staff");
    expect(mine).toMatchObject({ ok: false, code: "SIGN_OFF_NEEDED" });
    const forKid = await laneBooking(me, date, 9, { id: kid.id, name: kid.displayName }, "staff");
    if (!forKid.ok) throw new Error(forKid.error);
    expect(await door(forKid.bookings[0].code, me.phone, date, 9)).toMatchObject({ ok: true, accessCode: "4321" });
    // Made past the rules for the parent and for the sibling: neither gets a code on the child's approval.
    const over = (participant?: { id: number; name: string }, hour = 10) =>
      createBookingSeries({ by: "staff", staff: { override: true }, courtId: doorLane, date, start: at(hour), end: at(hour + 1), weeks: 1, name: me.name, phone: me.phone, userId: me.id, ...(participant ? { participant } : {}) });
    const parentOver = await over(undefined, 10);
    const siblingOver = await over({ id: sibling.id, name: sibling.displayName }, 11);
    if (!parentOver.ok || !siblingOver.ok) throw new Error("override");
    expect(await door(parentOver.bookings[0].code, me.phone, date, 10)).toMatchObject({ ok: false, reason: "approval-needed" });
    expect(await door(siblingOver.bookings[0].code, me.phone, date, 11)).toMatchObject({ ok: false, reason: "approval-needed" });
    // Revoked: the child's own booking is flagged for staff, the parent's is not, and the door stays shut.
    const revoked = await decide(staff(doorManager), request.id, "revoke", { venueId: doorVenue, reason: "Shot before the whistle." });
    expect(revoked).toMatchObject({ ok: true, request: { revoked: true } });
    expect(await door(forKid.bookings[0].code, me.phone, date, 9)).toMatchObject({ ok: false, reason: "approval-needed" });
    expect(await holds(doorVenue, me, kid.id)).toBe(false);
    const flagged = (await getDb().prepare("SELECT booking_id FROM approval_booking_flags WHERE request_id = ?").all(request.id)) as { booking_id: number }[];
    expect(flagged.map((f) => f.booking_id)).toEqual([forKid.bookings[0].id]);
  });

  it("a slot asked for with the child's application is booked for the child on approval", async () => {
    const me = await adult();
    const kid = await child(me, "Sofia");
    const r = await applied(me, archeryAt(doorVenue, { forPerson: kid.id, authority: true, slot: { courtId: doorLane, date: day(6), start: at(15), end: at(16) } }));
    const done = await decide(staff(doorManager), r.id, "approve", { venueId: doorVenue });
    if (!done.ok) throw new Error(done.error);
    expect(done.booking).toMatchObject({ participantId: kid.id, participantName: "Sofia", name: me.name });
    expect(await findBooking(done.booking!.code, me.phone)).toMatchObject({ participantId: kid.id });
  });
});

// ---------------------------------------------------------------------------------------------- discovery, isolation

describe("children stay out of discovery, and out of other adults' reach", () => {
  it("never appear in player suggestions, and a booking for one is never opened to strangers", async () => {
    const parent = await adult("Hostparent");
    const kid = await child(parent, "Khadijah");
    await setPlayerLevel(parent.id, "badminton", "intermediate");
    const fits = await adult("Finder");
    await setPlayerLevel(fits.id, "badminton", "intermediate");
    expect((await saveProfile(fits.id, { adult: true, discoverable: true })).ok).toBe(true);
    expect((await saveProfile(parent.id, { adult: true, discoverable: true })).ok).toBe(true);
    // The parent's own booking can be an open game, and the suggestions are users, never the child.
    const own = await createBookingSeries({ courtId: badmintonCourt, date: day(3), start: at(18), end: at(19), weeks: 1, name: parent.name, phone: parent.phone, userId: parent.id });
    if (!own.ok) throw new Error(own.error);
    const host = await adult("Host");
    const hostBooking = await createBookingSeries({ courtId: badmintonCourt, date: day(3), start: at(20), end: at(21), weeks: 1, name: host.name, phone: host.phone, userId: host.id });
    if (!hostBooking.ok) throw new Error(hostBooking.error);
    const game = await openGame(host.id, { bookingCode: hostBooking.bookings[0].code, spots: 2, level: null, share: 5, autoAccept: true });
    if (!game.ok) throw new Error(game.error);
    const found = await recommendPlayers(host.id, game.game.id, { limit: 50 });
    if (!found.ok) throw new Error(found.error);
    expect(found.players.map((p) => p.userId)).toEqual(expect.arrayContaining([parent.id, fits.id]));
    expect(found.players.some((p) => p.name.includes("Khadijah"))).toBe(false);
    const users = (await getDb().prepare("SELECT id FROM users").all()) as { id: number }[];
    for (const p of found.players) expect(users.map((u) => u.id)).toContain(p.userId);
    // A booking made for the child cannot be opened to other players.
    const forKid = await createBookingSeries({
      courtId: badmintonCourt,
      date: day(3),
      start: at(16),
      end: at(17),
      weeks: 1,
      name: parent.name,
      phone: parent.phone,
      userId: parent.id,
      participant: { id: kid.id, name: kid.displayName },
    });
    if (!forKid.ok) throw new Error(forKid.error);
    expect(await openGame(parent.id, { bookingCode: forKid.bookings[0].code, spots: 2, level: null, share: 5, autoAccept: true })).toMatchObject({
      ok: false,
      code: "GUARD_NO_OPEN_GAME",
    });
  });

  it("another adult can neither see, change, apply for nor book for somebody else's child", async () => {
    const me = await adult();
    const kid = await child(me, "Alya");
    const r = await applied(me, archeryAt(doorVenue, { forPerson: kid.id, authority: true }));
    const other = await adult("Other");
    expect(await managedPerson(other.id, kid.id)).toBeNull();
    expect(await listManaged(other.id, { archived: true })).toEqual([]);
    expect(await editManaged(other.id, kid.id, { displayName: "Taken" })).toMatchObject({ ok: false, code: "GUARD_NOT_FOUND" });
    const patched = await peopleRoute.PATCH(req("http://localhost/api/my/people", "PATCH", other.cookie, { id: kid.id, archived: true }));
    expect(patched.status).toBe(404);
    const listed = await peopleRoute.GET(req("http://localhost/api/my/people?archived=1", "GET", other.cookie));
    expect(((await listed.json()) as { people: unknown[] }).people).toEqual([]);
    expect(await apply(other, archeryAt(doorVenue, { forPerson: kid.id, authority: true }))).toMatchObject({ ok: false, code: "GUARD_NOT_FOUND" });
    expect((await customerApprovals(other.id)).map((x) => x.id)).not.toContain(r.id);
    expect(await customerAct(other, r.id, "withdraw")).toMatchObject({ ok: false, code: "APR_NOT_FOUND" });
    // The apply form lists only the adult's own people.
    const form = await myApprovalsRoute.GET(req(`http://localhost/api/my/approvals?venueId=${doorVenue}&sport=archery`, "GET", other.cookie));
    expect(((await form.json()) as { apply: { people: unknown[] } }).apply.people).toEqual([]);
    const mine = await myApprovalsRoute.GET(req(`http://localhost/api/my/approvals?venueId=${doorVenue}&sport=archery`, "GET", me.cookie));
    expect(((await mine.json()) as { apply: { people: { id: number }[] } }).apply.people.map((p) => p.id)).toEqual([kid.id]);
    expect((await (await peopleRoute.GET(req("http://localhost/api/my/people", "GET", null))).status)).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------- personal data

describe("export, erasure and retention", () => {
  it("the adult's export holds their people and their applications; erasure takes the people and their eligibility", async () => {
    const me = await adult();
    const { kid, request } = await approvedChild(me, "Mikail");
    const exported = (await exportCustomerData(me.id))!;
    expect(exported.managedPeople).toEqual([
      expect.objectContaining({ name: "Mikail", declaredRelationship: "parent", signOffs: [expect.objectContaining({ sport: "archery", revoked_at: null })] }),
    ]);
    expect(exported.approvals).toEqual(expect.arrayContaining([expect.objectContaining({ forPerson: { name: "Mikail", declaredRelationship: "parent" } })]));
    expect(exported.waivers).toEqual(expect.arrayContaining([expect.objectContaining({ on_behalf_of: "Mikail" })]));
    const signOffId = ((await getDb().prepare("SELECT sign_off_id FROM approval_requests WHERE id = ?").get(request.id)) as { sign_off_id: number }).sign_off_id;

    expect((await eraseCustomer(me.id)).ok).toBe(true);
    expect(await getDb().prepare("SELECT 1 FROM managed_people WHERE id = ?").get(kid.id)).toBeUndefined();
    expect(await getDb().prepare("SELECT 1 FROM approval_requests WHERE id = ?").get(request.id)).toBeUndefined();
    // The sign-off stays the venue's record, taken back: nothing can count on it once nobody manages them.
    const so = (await getDb().prepare("SELECT revoked_at, revoke_reason, managed_person_id FROM sign_offs WHERE id = ?").get(signOffId)) as {
      revoked_at: string | null;
      revoke_reason: string;
      managed_person_id: number | null;
    };
    expect(so.revoked_at).not.toBeNull();
    expect(so.revoke_reason).toBe("Account closed");
    // The waiver signed on the child's behalf stays the venue's record of consent.
    expect(await getDb().prepare("SELECT 1 FROM waiver_signatures WHERE participant_name = 'Mikail'").get()).toBeTruthy();
  });

  it("an archived person goes a year on, once nothing rests on them; one with an application stays", async () => {
    const me = await adult();
    const gone = await child(me, "Old One");
    const kept = await child(me, "Old Two");
    await applied(me, archeryAt(doorVenue, { forPerson: kept.id, authority: true }));
    for (const p of [gone, kept]) await editManaged(me.id, p.id, { archived: true });
    await getDb().prepare("UPDATE managed_people SET archived_at = now() - interval '400 days' WHERE id IN (?, ?)").run(gone.id, kept.id);
    await pruneOldData();
    expect(await getDb().prepare("SELECT 1 FROM managed_people WHERE id = ?").get(gone.id)).toBeUndefined();
    expect(await getDb().prepare("SELECT 1 FROM managed_people WHERE id = ?").get(kept.id)).toBeTruthy();
  });
});
