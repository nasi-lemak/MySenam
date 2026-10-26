import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { listActivity } from "../src/lib/activity";
import { apply, requestById, saveRequirement } from "../src/lib/approvals";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { openGame, setPlayerLevel } from "../src/lib/games";
import { addManaged, listManaged } from "../src/lib/managed-people";
import { recommendPlayers } from "../src/lib/matchmaking";
import { acceptInvite, bookingPlaces, createAtVenue, createInvite, participantHistory, participantsForVenue } from "../src/lib/participants";
import { saveProfile } from "../src/lib/player-profiles";
import { eraseCustomer, exportCustomerData, pruneOldData } from "../src/lib/privacy";
import { createResources } from "../src/lib/resources";
import { addSignOff, signOffHolds } from "../src/lib/sign-offs";
import { accessCodeFor, createBookingSeries, createVenue, findBooking, isInducted, listInductions, setPaymentStatus, updateCourt, updateVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { setWaiver, signWaiver, waiverSigned, waiverSignedFor } from "../src/lib/waivers";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as inductionsRoute from "../src/app/api/admin/inductions/route";
import * as inductionRoute from "../src/app/api/admin/inductions/[id]/route";
import * as participantsRoute from "../src/app/api/admin/participants/route";
import * as participantRoute from "../src/app/api/admin/participants/[id]/route";
import * as signOffsRoute from "../src/app/api/admin/sign-offs/route";
import * as peopleRoute from "../src/app/api/my/people/route";
import * as invitesRoute from "../src/app/api/my/people/invites/route";
import * as acceptRoute from "../src/app/api/my/people/accept/route";

/**
 * Participants apart from accounts (ADR 0023; lib/participants.ts): the
 * person who takes part is not assumed to be the account holder, the booker
 * or the payer, and eligibility (sign-offs, certifications, inductions,
 * waivers, door codes) is the participant's own, whatever number, email or
 * account they share with a parent or a sibling. The owner's example: a
 * mother registers two children for climbing; child A is inducted and child
 * B is not: the mother has nothing unless she has her own, A is cleared, B
 * still needs it, and the shared phone number changes none of that.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0166${String(++n).padStart(6, "0")}`;

type Staff = { id: number; name: string; cookie: string };
type Adult = Awaited<ReturnType<typeof adult>>;

let venue: number;
let otherVenue: number;
let hall: number;
let lane: number;
let wall: number;
let manager: Staff;
let desk: Staff;
let otherManager: Staff;

async function adult(name = "Parent") {
  const made = await registerUser({ name: `${name} ${++n}`, email: `pt${n}@ptc.test`, phone: phone(), password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now') WHERE id = ?").run(made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function staffMember(venueId: number, name: string, role: "manager" | "desk" = "manager"): Promise<Staff> {
  const made = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}${++n}@ptc.test`, password: "a long enough password", venueId, role });
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

async function child(parent: Adult, displayName: string) {
  const made = await addManaged(parent.id, { displayName, relationship: "parent", authority: true }, parent.name);
  if (!made.ok) throw new Error(`${made.code}: ${made.error}`);
  return made.person;
}

/** A booking made by staff, for the adult or (participants) somebody else. */
async function booked(user: Adult, courtId: number, date: string, hour: number, participants?: { id: number; displayName: string }[], extra: Record<string, unknown> = {}) {
  const made = await createBookingSeries({
    by: "staff",
    courtId,
    date,
    start: at(hour),
    end: at(hour + 1),
    weeks: 1,
    name: user.name,
    phone: user.phone,
    userId: user.id,
    ...(participants ? { participants: participants.map((p) => ({ id: p.id, name: p.displayName })) } : {}),
    ...extra,
  });
  if (!made.ok) throw new Error(`${made.code}: ${made.error}`);
  return made.bookings[0];
}

/** Paid, and asked for at a quarter past the hour it starts. */
async function door(code: string, ph: string, date: string, hour: number) {
  await setPaymentStatus(code, true, "cash");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${date}T${String(hour).padStart(2, "0")}:15:00+08:00`));
  const result = await accessCodeFor(code, ph);
  vi.useRealTimers();
  return result;
}

async function induct(staff: Staff, ph: string, who: { participantId: number } | { name: string }) {
  return inductionsRoute.POST(req("http://localhost/api/admin/inductions", "POST", staff.cookie, { venueId: venue, phone: ph, ...who }));
}

const holds = (user: { phone: string; id: number | null }, participant: number | null, channel: "customer" | "staff" = "staff", need: "any" | "certification" = "any", sport = "archery") =>
  signOffHolds({ venueId: venue, sport, until: day(3), phone: user.phone, userId: user.id, channel, need, participant });

beforeAll(async () => {
  const make = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Bangsar", address: "x", phone: ph, openMin: at(7), closeMin: at(23) });
    if (!v.ok) throw new Error("venue");
    return v.venue.id;
  };
  venue = await make("Family Wall", "0312340401");
  otherVenue = await make("Elsewhere Wall", "0312340402");
  const resource = async (venueId: number, sport: string, name: string, capacity = 1) => {
    const r = await createResources({ venueId, sport, name, offPeakRate: 20, peakRate: 20, capacity });
    if (!r.ok) throw new Error(r.error);
    return r.courts[0].id;
  };
  hall = await resource(venue, "badminton", "Hall court");
  lane = await resource(venue, "archery", "Range lane");
  wall = await resource(venue, "climbing", "Bouldering wall", 8);
  await resource(otherVenue, "archery", "Other lane");
  for (const sport of ["archery", "climbing"]) {
    const s = await saveRequirement(venue, { sport, declaration: "I will follow the staff's calls.", validDays: 365 });
    if (!s.ok) throw new Error(s.error);
  }
  for (const [courtId, code] of [
    [hall, "1111"],
    [lane, "2222"],
    [wall, "3333"],
  ] as const) {
    const opened = await updateCourt(courtId, { unmanned: true, accessCode: code });
    if (!opened.ok) throw new Error(opened.error);
  }
  await updateVenue(venue, { staffedFrom: 0, staffedTo: 0 });
  manager = await staffMember(venue, "Maya Manager");
  desk = await staffMember(venue, "Dani Desk", "desk");
  otherManager = await staffMember(otherVenue, "Omar Other");
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------- the adult as themself

describe("the account holder taking part as themself", () => {
  it("is unchanged: no participant row, their own induction and number at the door", async () => {
    const me = await adult("Solo");
    const b = await booked(me, hall, day(2), 8);
    expect(await bookingPlaces(b.id)).toEqual([{ customer: true, participantId: null, name: null }]);
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM booking_participants WHERE booking_id = ?").get(b.id)) as { n: number }).toEqual({ n: 0 });
    expect(await findBooking(b.code, me.phone)).toMatchObject({ participantId: null, participantName: null, name: me.name });
    expect(await door(b.code, me.phone, day(2), 8)).toMatchObject({ ok: false, reason: "no-induction" });
    expect((await induct(desk, me.phone, { name: me.name })).status).toBe(201);
    expect(await door(b.code, me.phone, day(2), 8)).toMatchObject({ ok: true, accessCode: "1111" });
  });
});

// ---------------------------------------------------------------------------------------------- the owner's example

describe("eligibility belongs to the participant: child A inducted, child B not, the mother neither", () => {
  it("inductions and door codes: each by their own, whatever number they share", async () => {
    const mum = await adult("Mum");
    const a = await child(mum, "Alya");
    const b = await child(mum, "Bilal");
    const forA = await booked(mum, hall, day(3), 8, [a]);
    const forB = await booked(mum, hall, day(3), 9, [b]);
    const own = await booked(mum, hall, day(3), 10);
    // Staff record child A's induction on the mother's number, naming A: it is A's.
    const res = await induct(desk, mum.phone, { participantId: a.id });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { induction: { name: string; forParticipant: boolean; participantId: number } }).induction).toMatchObject({
      name: "Alya",
      forParticipant: true,
      participantId: a.id,
    });
    expect(await door(forA.code, mum.phone, day(3), 8)).toMatchObject({ ok: true, accessCode: "1111" });
    // B shares the number, the email and the mother: still needs it.
    expect(await door(forB.code, mum.phone, day(3), 9)).toMatchObject({ ok: false, reason: "no-induction" });
    // The mother has none unless she has her own.
    expect(await isInducted(venue, mum.phone)).toBe(false);
    expect(await door(own.code, mum.phone, day(3), 10)).toMatchObject({ ok: false, reason: "no-induction" });
    // Recording it twice for A is refused; for the mother herself it is her own, and changes nothing for B.
    expect((await induct(desk, mum.phone, { participantId: a.id })).status).toBe(409);
    expect((await induct(desk, mum.phone, { name: mum.name })).status).toBe(201);
    expect(await door(own.code, mum.phone, day(3), 10)).toMatchObject({ ok: true });
    expect(await door(forB.code, mum.phone, day(3), 9)).toMatchObject({ ok: false, reason: "no-induction" });
  });

  it("sign-offs and certifications: a child's count for that child alone; the parent's never for a child", async () => {
    const mum = await adult("Mum");
    const a = await child(mum, "Amani");
    const b = await child(mum, "Batrisya");
    // Unknown to the venue, a child cannot be named there at all.
    const unknown = await signOffsRoute.POST(
      req("http://localhost/api/admin/sign-offs", "POST", manager.cookie, { venueId: venue, sport: "archery", phone: mum.phone, participantId: a.id })
    );
    expect(unknown.status).toBe(404);
    // Registered there (a booking for her): through the staff route, naming the participant: theirs, on the mother's number.
    await booked(mum, hall, day(3), 14, [a]);
    const res = await signOffsRoute.POST(
      req("http://localhost/api/admin/sign-offs", "POST", manager.cookie, { venueId: venue, sport: "archery", phone: mum.phone, participantId: a.id })
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { signOff: { name: string; managedPersonId: number; userId: number | null } }).signOff).toMatchObject({
      name: "Amani",
      managedPersonId: a.id,
      userId: null,
    });
    for (const channel of ["staff", "customer"] as const) {
      expect(await holds(mum, a.id, channel)).toBe(true);
      expect(await holds(mum, b.id, channel)).toBe(false);
      expect(await holds(mum, null, channel)).toBe(false);
    }
    // The mother's own, on the same number: hers, never the children's.
    await addSignOff({ venueId: venue, sport: "archery", phone: mum.phone, name: mum.name, adminId: manager.id });
    expect(await holds(mum, null)).toBe(true);
    expect(await holds(mum, b.id)).toBe(false);
    // A certification seen for B: B's alone.
    const cert = await addSignOff({
      venueId: venue,
      sport: "archery",
      phone: mum.phone,
      name: "Batrisya",
      kind: "certification",
      reference: "Junior archery 2 (NAM)",
      expiresOn: day(200),
      adminId: manager.id,
      managedPersonId: b.id,
    });
    expect(cert.ok).toBe(true);
    expect(await holds(mum, b.id, "staff", "certification")).toBe(true);
    expect(await holds(mum, a.id, "staff", "certification")).toBe(false);
    expect(await holds(mum, null, "staff", "certification")).toBe(false);
    // Recording A's again replaces A's only.
    await addSignOff({ venueId: venue, sport: "archery", phone: mum.phone, name: "Amani", adminId: manager.id, managedPersonId: a.id });
    const live = (await getDb()
      .prepare("SELECT managed_person_id, kind FROM sign_offs WHERE phone = ? AND revoked_at IS NULL ORDER BY id")
      .all(mum.phone)) as { managed_person_id: number | null; kind: string }[];
    expect(live).toEqual([
      { managed_person_id: null, kind: "operational" },
      { managed_person_id: b.id, kind: "certification" },
      { managed_person_id: a.id, kind: "operational" },
    ]);
  });

  it("waivers: agreed for A counts for A, not B, not the mother", async () => {
    await setWaiver(venue, "Climbing and archery are dangerous. Everybody follows the staff's calls at all times, at their own risk.");
    const mum = await adult("Mum");
    const a = await child(mum, "Aqil");
    const b = await child(mum, "Basyir");
    await signWaiver(venue, { phone: mum.phone, name: mum.name, participant: { id: a.id, name: a.displayName } });
    expect(await waiverSignedFor(venue, a.id)).toBe(true);
    expect(await waiverSignedFor(venue, b.id)).toBe(false);
    expect(await waiverSigned(venue, mum.phone)).toBe(false);
    await signWaiver(venue, { phone: mum.phone, name: mum.name });
    expect(await waiverSigned(venue, mum.phone)).toBe(true);
    expect(await waiverSignedFor(venue, b.id)).toBe(false);
    await setWaiver(venue, "");
  });
});

// ---------------------------------------------------------------------------------------------- several in one booking

describe("a parent booking two children: each takes a place, each checked on their own", () => {
  it("two places, both named, both needing their own sign-off and induction", async () => {
    const mum = await adult("Mum");
    const a = await child(mum, "Aina");
    const b = await child(mum, "Bella");
    const both = [a, b].map((p) => ({ id: p.id, name: p.displayName }));
    await addSignOff({ venueId: venue, sport: "climbing", phone: mum.phone, name: "Aina", adminId: manager.id, managedPersonId: a.id });
    const asCustomer = (extra: Record<string, unknown> = {}) =>
      createBookingSeries({ by: "customer", courtId: wall, date: day(4), start: at(10), end: at(11), weeks: 1, name: mum.name, phone: mum.phone, userId: mum.id, participants: both, ...extra });
    expect(await asCustomer()).toMatchObject({ ok: false, code: "SIGN_OFF_NEEDED" });
    await addSignOff({ venueId: venue, sport: "climbing", phone: mum.phone, name: "Bella", adminId: manager.id, managedPersonId: b.id });
    // The mother taking a place too needs her own.
    expect(await asCustomer({ customerTakesPart: true })).toMatchObject({ ok: false, code: "SIGN_OFF_NEEDED" });
    // More places than people checked: refused online.
    expect(await asCustomer({ players: 3 })).toMatchObject({ ok: false, code: "SIGN_OFF_EACH" });
    const made = await asCustomer();
    if (!made.ok) throw new Error(made.error);
    const booking = made.bookings[0];
    expect(booking).toMatchObject({ players: 2, participantId: a.id, participantName: "Aina, Bella", name: mum.name });
    expect(await bookingPlaces(booking.id)).toEqual([
      { customer: false, participantId: a.id, name: "Aina" },
      { customer: false, participantId: b.id, name: "Bella" },
    ]);
    // The door: both inducted, each on their own.
    expect((await induct(desk, mum.phone, { participantId: a.id })).status).toBe(201);
    expect(await door(booking.code, mum.phone, day(4), 10)).toMatchObject({ ok: false, reason: "no-induction" });
    expect((await induct(desk, mum.phone, { participantId: b.id })).status).toBe(201);
    expect(await door(booking.code, mum.phone, day(4), 10)).toMatchObject({ ok: true, accessCode: "3333" });
    // Never opened to strangers.
    expect(await openGame(mum.id, { bookingCode: booking.code, spots: 2, level: null, share: 5, autoAccept: true })).toMatchObject({ ok: false, code: "GUARD_NO_OPEN_GAME" });
    // The same person twice is not two places.
    expect(
      await createBookingSeries({ by: "staff", courtId: wall, date: day(4), start: at(12), end: at(13), weeks: 1, name: mum.name, phone: mum.phone, userId: mum.id, participants: [both[0], both[0]] })
    ).toMatchObject({ ok: false, code: "PLAYERS_RANGE" });
  });
});

// ---------------------------------------------------------------------------------------------- at the counter

describe("a child with no login, added at the counter", () => {
  it("is the venue's to see and act for, nobody else's; shared numbers decide nothing", async () => {
    // An unrelated customer who happens to use the same number (a family's shared phone, an office line).
    const neighbour = await adult("Neighbour");
    const theirKid = await child(neighbour, "Nadia");
    await booked(neighbour, hall, day(5), 8, [theirKid]);
    // Front desk adds a child whose guardian has no account, on that same number.
    const refusedAdd = await participantsRoute.POST(
      req("http://localhost/api/admin/participants", "POST", desk.cookie, { venueId: venue, displayName: "Zaki", guardianName: "Puan Zainab", guardianPhone: neighbour.phone, relationship: "parent" })
    );
    expect(((await refusedAdd.json()) as { code: string }).code).toBe("PTC_COUNTER_AUTHORITY");
    const added = await participantsRoute.POST(
      req("http://localhost/api/admin/participants", "POST", desk.cookie, {
        venueId: venue,
        displayName: "Zaki",
        birthYear: 2015,
        guardianName: "Puan Zainab",
        guardianPhone: neighbour.phone,
        relationship: "parent",
        authority: true,
      })
    );
    expect(added.status).toBe(201);
    const zaki = ((await added.json()) as { participant: { id: number; origin: string; venueId: number } }).participant;
    expect(zaki).toMatchObject({ origin: "venue", venueId: venue });
    // Staff looking up the number see both families' children, as candidates, each with their own guardian.
    const listed = await participantsRoute.GET(req(`http://localhost/api/admin/participants?venueId=${venue}&phone=${neighbour.phone}`, "GET", desk.cookie));
    const found = ((await listed.json()) as { participants: { id: number; guardians: { name: string; account: boolean }[] }[] }).participants;
    expect(found.map((p) => p.id).sort()).toEqual([theirKid.id, zaki.id].sort());
    expect(found.find((p) => p.id === zaki.id)!.guardians).toEqual([expect.objectContaining({ name: "Puan Zainab", account: false })]);
    // Zaki inducted: neither the neighbour nor the neighbour's child is.
    expect((await induct(desk, neighbour.phone, { participantId: zaki.id })).status).toBe(201);
    expect(await isInducted(venue, neighbour.phone)).toBe(false);
    const forTheirKid = (await participantsForVenue(venue, neighbour.phone)).find((p) => p.id === theirKid.id)!;
    expect(forTheirKid.inductionId).toBeNull();
    // Nothing merged or moved: two people, one number.
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM participants WHERE id IN (?, ?)").get(theirKid.id, zaki.id)) as { n: number }).toEqual({ n: 2 });
    // Another venue sees nothing of them, and cannot act for them.
    const elsewhere = await participantsRoute.GET(req(`http://localhost/api/admin/participants?venueId=${otherVenue}&phone=${neighbour.phone}`, "GET", otherManager.cookie));
    expect(((await elsewhere.json()) as { participants: unknown[] }).participants).toEqual([]);
    const theirs = await inductionsRoute.POST(req("http://localhost/api/admin/inductions", "POST", otherManager.cookie, { venueId: otherVenue, phone: neighbour.phone, participantId: zaki.id }));
    expect(theirs.status).toBe(404);
    const crossVenue = await participantsRoute.GET(req(`http://localhost/api/admin/participants?venueId=${venue}&phone=${neighbour.phone}`, "GET", otherManager.cookie));
    expect(crossVenue.status).toBe(403);
    const crossLink = await participantRoute.PATCH(
      req(`http://localhost/api/admin/participants/${zaki.id}`, "PATCH", otherManager.cookie, { venueId: otherVenue, action: "link", email: neighbour.email, reason: "Asked at our desk" }),
      ctx(zaki.id)
    );
    expect(crossLink.status).toBe(404);
    // A number alone lists nothing to browse.
    const browse = await participantsRoute.GET(req(`http://localhost/api/admin/participants?venueId=${venue}`, "GET", desk.cookie));
    expect(browse.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------- their own login

describe("a participant later linking their own login", () => {
  it("keeps their bookings, sign-offs and inductions, and the account's eligibility includes them", async () => {
    // An adult a carer brought to the counter, with no login then.
    const made = await createAtVenue({
      venueId: venue,
      admin: { id: manager.id, name: manager.name },
      displayName: "Rahim",
      guardian: { name: "Encik Carer", phone: phone(), relationship: "other", authority: true },
    });
    if (!made.ok) throw new Error(made.error);
    const rahim = made.participant;
    const carerPhone = ((await getDb().prepare("SELECT contact_phone FROM participant_guardians WHERE participant_id = ?").get(rahim.id)) as { contact_phone: string }).contact_phone;
    await addSignOff({ venueId: venue, sport: "archery", phone: carerPhone, name: "Rahim", adminId: manager.id, managedPersonId: rahim.id });
    expect((await induct(manager, carerPhone, { participantId: rahim.id })).status).toBe(201);
    const carer = { id: null, name: "Encik Carer", phone: carerPhone };
    const earlier = await createBookingSeries({
      by: "staff",
      courtId: lane,
      date: day(6),
      start: at(9),
      end: at(10),
      weeks: 1,
      name: carer.name,
      phone: carer.phone,
      participants: [{ id: rahim.id, name: "Rahim" }],
    });
    if (!earlier.ok) throw new Error(earlier.error);

    // Rahim's own account. Before linking, nothing of his counts for it.
    const own = await adult("Rahim");
    expect(await holds(own, null, "customer")).toBe(false);
    // Front desk may not link; a manager may, with a reason, recorded.
    const asDesk = await participantRoute.PATCH(
      req(`http://localhost/api/admin/participants/${rahim.id}`, "PATCH", desk.cookie, { venueId: venue, action: "link", email: own.email, reason: "He came in with his carer" }),
      ctx(rahim.id)
    );
    expect(asDesk.status).toBe(403);
    const noReason = await participantRoute.PATCH(req(`http://localhost/api/admin/participants/${rahim.id}`, "PATCH", manager.cookie, { venueId: venue, action: "link", email: own.email }), ctx(rahim.id));
    expect(((await noReason.json()) as { code: string }).code).toBe("PTC_REASON_NEEDED");
    const linked = await participantRoute.PATCH(
      req(`http://localhost/api/admin/participants/${rahim.id}`, "PATCH", manager.cookie, { venueId: venue, action: "link", email: own.email, reason: "He came in with his carer, who agreed" }),
      ctx(rahim.id)
    );
    expect(linked.status).toBe(200);
    expect((await participantHistory(rahim.id)).map((e) => e.action)).toEqual(["participant.created", "linked_by_staff"]);
    expect((await listActivity([venue])).some((x) => x.action === "participant.linked")).toBe(true);

    // His account's own booking now stands on his sign-off and his induction.
    expect(await holds(own, null, "customer")).toBe(true);
    const mine = await createBookingSeries({ by: "customer", courtId: lane, date: day(6), start: at(11), end: at(12), weeks: 1, name: own.name, phone: own.phone, userId: own.id });
    if (!mine.ok) throw new Error(mine.error);
    expect(await door(mine.bookings[0].code, own.phone, day(6), 11)).toMatchObject({ ok: true, accessCode: "2222" });
    // His earlier booking is still his; his history goes out with his account's data.
    expect(await bookingPlaces(earlier.bookings[0].id)).toEqual([{ customer: false, participantId: rahim.id, name: "Rahim" }]);
    const exported = (await exportCustomerData(own.id))!;
    expect(exported.asParticipant).toMatchObject({
      name: "Rahim",
      signOffs: [expect.objectContaining({ sport: "archery" })],
      inductions: [expect.objectContaining({ venue: "Family Wall" })],
      bookings: [expect.objectContaining({ court: "Range lane" })],
    });
    // Once linked, not again, and that account is nobody else's own login.
    const again = await participantRoute.PATCH(
      req(`http://localhost/api/admin/participants/${rahim.id}`, "PATCH", manager.cookie, { venueId: venue, action: "link", email: (await adult()).email, reason: "Second try" }),
      ctx(rahim.id)
    );
    expect(((await again.json()) as { code: string }).code).toBe("PTC_ALREADY_LINKED");
  });

  it("a guardian hands over with a code; the account accepts; both sides agreed", async () => {
    const mum = await adult("Mum");
    const teen = await child(mum, "Tasha");
    await addSignOff({ venueId: venue, sport: "archery", phone: mum.phone, name: "Tasha", adminId: manager.id, managedPersonId: teen.id });
    const stranger = await adult("Stranger");
    expect(await createInvite(stranger, teen.id, "link")).toMatchObject({ ok: false, code: "GUARD_NOT_FOUND" });
    const res = await invitesRoute.POST(req("http://localhost/api/my/people/invites", "POST", mum.cookie, { id: teen.id, purpose: "link" }));
    expect(res.status).toBe(201);
    const { code } = (await res.json()) as { code: string };
    expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    // Only its hash is kept.
    expect(await getDb().prepare("SELECT 1 FROM participant_invites WHERE code_hash = ?").get(code)).toBeUndefined();
    // The guardian cannot be their own child's login.
    expect(await acceptInvite(mum, { code })).toMatchObject({ ok: false, code: "PTC_LINK_SELF" });
    const tasha = await adult("Tasha");
    const accepted = await acceptRoute.POST(req("http://localhost/api/my/people/accept", "POST", tasha.cookie, { code }));
    expect(accepted.status).toBe(200);
    expect((await accepted.json()) as { as: string }).toMatchObject({ as: "linked" });
    expect(await acceptInvite((await adult()), { code })).toMatchObject({ ok: false, code: "PTC_INVITE_INVALID" });
    // Her own sign-off counts for her account; the mother still manages her and sees it.
    expect(await holds(tasha, null, "customer")).toBe(true);
    expect(await holds(mum, null, "customer")).toBe(false);
    expect((await listManaged(mum.id)).find((p) => p.id === teen.id)).toMatchObject({ linked: true });
    const mine = await peopleRoute.GET(req("http://localhost/api/my/people", "GET", tasha.cookie));
    expect(((await mine.json()) as { own: { id: number } }).own).toMatchObject({ id: teen.id });
  });
});

// ---------------------------------------------------------------------------------------------- legacy, by number

describe("an older induction filed on a parent's number", () => {
  it("stays the number holder's until a manager gives it to the participant, with a reason, on record", async () => {
    const mum = await adult("Mum");
    const kid = await child(mum, "Khalid");
    const other = await adult("Unrelated");
    const notTheirs = await child(other, "Omar");
    await booked(other, hall, day(7), 15, [notTheirs]);
    const forKid = await booked(mum, hall, day(7), 8, [kid]);
    const own = await booked(mum, hall, day(7), 9);
    // As it was filed before participants: the child's name, the mother's number, flagged by migration 0140.
    const row = (await getDb()
      .prepare("INSERT INTO inductions (venue_id, phone, name, admin_id, review_reason) VALUES (?, ?, 'Khalid', ?, 'shared-number') RETURNING id")
      .get(venue, mum.phone, manager.id)) as { id: number };
    // Nothing is inferred from the number: it is still the mother's, never the child's.
    expect(await door(forKid.code, mum.phone, day(7), 8)).toMatchObject({ ok: false, reason: "no-induction" });
    expect(await door(own.code, mum.phone, day(7), 9)).toMatchObject({ ok: true });
    expect((await listInductions(venue)).find((i) => i.id === row.id)).toMatchObject({ needsReview: true, forParticipant: false });

    const patch = (staff: Staff, body: Record<string, unknown>) => inductionRoute.PATCH(req(`http://localhost/api/admin/inductions/${row.id}`, "PATCH", staff.cookie, body), ctx(row.id));
    expect((await patch(desk, { participantId: kid.id, reason: "Mum says it was Khalid" })).status).toBe(403);
    expect(((await (await patch(manager, { participantId: kid.id })).json()) as { code: string }).code).toBe("PTC_REASON_NEEDED");
    // Only somebody whose guardian is on that number: never another family's child.
    expect(((await (await patch(manager, { participantId: notTheirs.id, reason: "Typed the wrong child" })).json()) as { code: string }).code).toBe("PTC_NOT_CANDIDATE");
    // Another venue's manager cannot touch it.
    expect((await patch(otherManager, { participantId: kid.id, reason: "Not ours" })).status).toBe(403);
    const given = await patch(manager, { participantId: kid.id, reason: "Mum says it was Khalid who was shown round" });
    expect(given.status).toBe(200);
    expect(((await given.json()) as { induction: Record<string, unknown> }).induction).toMatchObject({
      participantId: kid.id,
      forParticipant: true,
      name: "Khalid",
      assignedFromName: "Khalid",
      needsReview: false,
      reviewedBy: manager.name,
    });
    expect(await door(forKid.code, mum.phone, day(7), 8)).toMatchObject({ ok: true });
    expect(await door(own.code, mum.phone, day(7), 9)).toMatchObject({ ok: false, reason: "no-induction" });
    expect((await participantHistory(kid.id)).map((e) => e.action)).toContain("induction.assigned");
    expect((await listActivity([venue])).some((x) => x.action === "induction.assigned")).toBe(true);
    // Once a participant's, not again.
    expect(((await (await patch(manager, { participantId: null, reason: "Changed my mind" })).json()) as { code: string }).code).toBe("PTC_INDUCTION_TAKEN");
  });

  it("or a manager confirms it is the number holder's own, closing the flag", async () => {
    const dad = await adult("Dad");
    await child(dad, "Danish");
    const row = (await getDb()
      .prepare("INSERT INTO inductions (venue_id, phone, name, review_reason) VALUES (?, ?, 'D. Senior', 'shared-number') RETURNING id")
      .get(venue, dad.phone)) as { id: number };
    const res = await inductionRoute.PATCH(
      req(`http://localhost/api/admin/inductions/${row.id}`, "PATCH", manager.cookie, { participantId: null, reason: "Dad himself, by his IC at the desk" }),
      ctx(row.id)
    );
    expect(res.status).toBe(200);
    expect((await listInductions(venue)).find((i) => i.id === row.id)).toMatchObject({ needsReview: false, forParticipant: false, reviewedBy: manager.name });
    expect(await isInducted(venue, dad.phone)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------- relationships

describe("guardian relationships: a second guardian, ended, revoked", () => {
  it("both guardians act for the child; one who ends it makes nothing new, and what was made stays", async () => {
    const mum = await adult("Mum");
    const dad = await adult("Dad");
    const kid = await child(mum, "Hana");
    // The mother's code; the father declares his own relationship and authority.
    const { code } = (await createInvite(mum, kid.id, "guardian")) as { code: string };
    expect(await acceptInvite(dad, { code, relationship: "parent" })).toMatchObject({ ok: false, code: "GUARD_AUTHORITY_NEEDED" });
    const accepted = await acceptRoute.POST(req("http://localhost/api/my/people/accept", "POST", dad.cookie, { code, relationship: "parent", authority: true }));
    expect(accepted.status).toBe(200);
    expect((await listManaged(dad.id)).map((p) => p.id)).toEqual([kid.id]);
    expect((await listManaged(mum.id)).find((p) => p.id === kid.id)).toMatchObject({ otherGuardians: 1 });
    const row = (await getDb().prepare("SELECT provenance, relationship FROM participant_guardians WHERE participant_id = ? AND user_id = ?").get(kid.id, dad.id)) as Record<string, unknown>;
    expect(row).toEqual({ provenance: "online", relationship: "parent" });

    // Both may book for her online; a booking made stays hers.
    const body = (who: Adult, hour: number) => ({ courtId: hall, date: day(8), start: at(hour), end: at(hour + 1), name: who.name, phone: who.phone, participantId: kid.id });
    const byMum = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", mum.cookie, body(mum, 8)));
    expect(byMum.status).toBe(201);
    const mumBooking = ((await byMum.json()) as { booking: { id: number; code: string } }).booking;
    expect((await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", dad.cookie, body(dad, 9)))).status).toBe(201);
    // One live application for her, whichever guardian makes it.
    const pending = await apply(mum, { venueId: venue, sport: "archery", declaration: true, forPerson: kid.id, authority: true });
    if (!pending.ok) throw new Error(pending.error);
    expect(await apply(dad, { venueId: venue, sport: "archery", declaration: true, forPerson: kid.id, authority: true })).toMatchObject({ ok: false, code: "APR_ALREADY_LIVE" });

    // The mother ends hers: her application still waiting is withdrawn; nothing new from her for the child.
    const ended = await peopleRoute.PATCH(req("http://localhost/api/my/people", "PATCH", mum.cookie, { id: kid.id, end: true, reason: "Custody arrangement" }));
    expect(ended.status).toBe(200);
    expect((await requestById(pending.request.id))!.status).toBe("withdrawn");
    const refused = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", mum.cookie, body(mum, 10)));
    expect(refused.status).toBe(404);
    expect(((await refused.json()) as { code: string }).code).toBe("GUARD_NOT_FOUND");
    expect(await apply(mum, { venueId: venue, sport: "archery", declaration: true, forPerson: kid.id, authority: true })).toMatchObject({ ok: false, code: "GUARD_NOT_FOUND" });
    expect(await createInvite(mum, kid.id, "guardian")).toMatchObject({ ok: false, code: "GUARD_NOT_FOUND" });
    expect(await listManaged(mum.id)).toEqual([]);
    // History stays: the booking she made is still the child's, the relationship kept as ended, with why.
    expect(await bookingPlaces(mumBooking.id)).toEqual([{ customer: false, participantId: kid.id, name: "Hana" }]);
    expect(await getDb().prepare("SELECT revoke_reason FROM participant_guardians WHERE participant_id = ? AND user_id = ?").get(kid.id, mum.id)).toEqual({ revoke_reason: "Custody arrangement" });
    // The father carries on, and may apply now.
    expect((await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", dad.cookie, body(dad, 11)))).status).toBe(201);
    expect((await apply(dad, { venueId: venue, sport: "archery", declaration: true, forPerson: kid.id, authority: true })).ok).toBe(true);

    // A manager revokes the father's, with a reason: the same follows.
    const dadsRow = (await getDb().prepare("SELECT id FROM participant_guardians WHERE participant_id = ? AND user_id = ? AND revoked_at IS NULL").get(kid.id, dad.id)) as { id: number };
    const noReason = await participantRoute.PATCH(req(`http://localhost/api/admin/participants/${kid.id}`, "PATCH", manager.cookie, { venueId: venue, action: "revokeGuardian", guardianId: dadsRow.id }), ctx(kid.id));
    expect(((await noReason.json()) as { code: string }).code).toBe("PTC_REASON_NEEDED");
    const revoked = await participantRoute.PATCH(
      req(`http://localhost/api/admin/participants/${kid.id}`, "PATCH", manager.cookie, { venueId: venue, action: "revokeGuardian", guardianId: dadsRow.id, reason: "Court order shown at the desk" }),
      ctx(kid.id)
    );
    expect(revoked.status).toBe(200);
    expect((await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", dad.cookie, body(dad, 12)))).status).toBe(404);
    expect((await participantHistory(kid.id)).map((e) => e.action)).toEqual(
      expect.arrayContaining(["participant.created", "invite.guardian", "guardian.added", "guardian.ended", "guardian.revoked_by_staff"])
    );
  });

  it("a code is good once, and not once its giver no longer acts for the child", async () => {
    const mum = await adult("Mum");
    const kid = await child(mum, "Iris");
    const { code } = (await createInvite(mum, kid.id, "guardian")) as { code: string };
    await peopleRoute.PATCH(req("http://localhost/api/my/people", "PATCH", mum.cookie, { id: kid.id, end: true }));
    expect(await acceptInvite(await adult(), { code, relationship: "parent", authority: true })).toMatchObject({ ok: false, code: "PTC_INVITE_INVALID" });
    expect(await acceptInvite(await adult(), { code: "AAAAA-BBBBB", relationship: "parent", authority: true })).toMatchObject({ ok: false, code: "PTC_INVITE_INVALID" });
  });
});

// ---------------------------------------------------------------------------------------------- discovery

describe("participants are never discoverable", () => {
  it("never in player suggestions, by name or otherwise", async () => {
    const parent = await adult("Hostparent");
    const kid = await child(parent, "Kamilah");
    await createAtVenue({ venueId: venue, admin: { id: manager.id, name: manager.name }, displayName: "Kasih", guardian: { name: "Puan K", phone: phone(), relationship: "parent", authority: true } });
    await setPlayerLevel(parent.id, "badminton", "intermediate");
    expect((await saveProfile(parent.id, { adult: true, discoverable: true })).ok).toBe(true);
    const host = await adult("Host");
    const hostBooking = await booked(host, hall, day(9), 20);
    const game = await openGame(host.id, { bookingCode: hostBooking.code, spots: 2, level: null, share: 5, autoAccept: true });
    if (!game.ok) throw new Error(game.error);
    const found = await recommendPlayers(host.id, game.game.id, { limit: 100 });
    if (!found.ok) throw new Error(found.error);
    expect(found.players.some((p) => /Kamilah|Kasih/.test(p.name))).toBe(false);
    expect(found.players.some((p) => p.userId === kid.id && p.name === kid.displayName)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------- personal data

describe("export, erasure and retention", () => {
  it("a guardian's export holds the people they manage and their record; one erased leaves a child another guardian manages", async () => {
    const mum = await adult("Mum");
    const dad = await adult("Dad");
    const kid = await child(mum, "Mira");
    const { code } = (await createInvite(mum, kid.id, "guardian")) as { code: string };
    await acceptInvite(dad, { code, relationship: "parent", authority: true });
    const so = await addSignOff({ venueId: venue, sport: "archery", phone: mum.phone, name: "Mira", adminId: manager.id, managedPersonId: kid.id });
    if (!so.ok) throw new Error(so.error);
    await induct(manager, mum.phone, { participantId: kid.id });
    await booked(mum, hall, day(10), 8, [kid]);
    const exported = (await exportCustomerData(mum.id))!;
    expect(exported.managedPeople).toEqual([
      expect.objectContaining({
        name: "Mira",
        declaredRelationship: "parent",
        otherGuardians: 1,
        signOffs: [expect.objectContaining({ sport: "archery", revoked_at: null })],
        inductions: [expect.objectContaining({ venue: "Family Wall" })],
        bookings: [expect.objectContaining({ court: "Hall court" })],
      }),
    ]);
    expect(exported.asParticipant).toBeNull();

    // The mother erased: her relationship goes; the child stays with the father, eligibility and all.
    expect((await eraseCustomer(mum.id)).ok).toBe(true);
    expect(await getDb().prepare("SELECT 1 FROM participants WHERE id = ?").get(kid.id)).toBeTruthy();
    expect((await listManaged(dad.id)).map((p) => p.id)).toEqual([kid.id]);
    expect((await getDb().prepare("SELECT revoked_at FROM sign_offs WHERE id = ?").get(so.signOff.id)) as { revoked_at: string | null }).toEqual({ revoked_at: null });
    expect(await holds(dad, kid.id, "customer")).toBe(true);
    // The father erased too: nobody acts for her any more, so she goes; her sign-off and induction are taken back,
    // and the induction stays a participant's (never the number's) as the venue's record.
    expect((await eraseCustomer(dad.id)).ok).toBe(true);
    expect(await getDb().prepare("SELECT 1 FROM participants WHERE id = ?").get(kid.id)).toBeUndefined();
    expect((await getDb().prepare("SELECT revoked_at IS NOT NULL AS revoked, revoke_reason FROM sign_offs WHERE id = ?").get(so.signOff.id)) as Record<string, unknown>).toEqual({
      revoked: true,
      revoke_reason: "Account closed",
    });
    expect(await getDb().prepare("SELECT for_participant, participant_id, revoked_at IS NOT NULL AS revoked FROM inductions WHERE name = 'Mira'").get()).toEqual({
      for_participant: true,
      participant_id: null,
      revoked: true,
    });
  });

  it("a venue's participant nobody has used for a year goes; one with an induction in force stays", async () => {
    const make = async (displayName: string) => {
      const made = await createAtVenue({ venueId: venue, admin: { id: manager.id, name: manager.name }, displayName, guardian: { name: "Puan Lama", phone: phone(), relationship: "parent", authority: true } });
      if (!made.ok) throw new Error(made.error);
      return made.participant;
    };
    const gone = await make("Lama Satu");
    const kept = await make("Lama Dua");
    await induct(manager, "0166999999", { participantId: kept.id });
    await getDb().prepare("UPDATE participants SET created_at = now() - interval '400 days' WHERE id IN (?, ?)").run(gone.id, kept.id);
    await pruneOldData();
    expect(await getDb().prepare("SELECT 1 FROM participants WHERE id = ?").get(gone.id)).toBeUndefined();
    expect(await getDb().prepare("SELECT 1 FROM participants WHERE id = ?").get(kept.id)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------- unauthorised

describe("nobody acts for somebody else's participant", () => {
  it("another account, through every route it has", async () => {
    const mum = await adult("Mum");
    const kid = await child(mum, "Puteri");
    const other = await adult("Other");
    const inv = await invitesRoute.POST(req("http://localhost/api/my/people/invites", "POST", other.cookie, { id: kid.id, purpose: "guardian" }));
    expect(inv.status).toBe(404);
    const end = await peopleRoute.PATCH(req("http://localhost/api/my/people", "PATCH", other.cookie, { id: kid.id, end: true }));
    expect(end.status).toBe(404);
    expect((await invitesRoute.POST(req("http://localhost/api/my/people/invites", "POST", null, { id: kid.id, purpose: "link" }))).status).toBe(401);
    expect((await acceptRoute.POST(req("http://localhost/api/my/people/accept", "POST", null, { code: "AAAAA-BBBBB" }))).status).toBe(401);
    // Nothing of hers changed.
    expect((await listManaged(mum.id)).map((p) => p.id)).toEqual([kid.id]);
    expect(await getDb().prepare("SELECT COUNT(*)::int AS n FROM participant_guardians WHERE participant_id = ?").get(kid.id)).toEqual({ n: 1 });
  });
});
