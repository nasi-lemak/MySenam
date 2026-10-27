import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import {
  accessEntryId,
  accessList,
  accessRefusal,
  addAccess,
  findAccountToLink,
  linkAccess,
  myPrivateVenues,
  onAccessList,
  setAccessSettings,
  unlinkAccess,
} from "../src/lib/access";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { openGame } from "../src/lib/games";
import { acceptGuestInvitation, inviteGuest, myInviteVenues, setGuestPolicy } from "../src/lib/guest-invites";
import { houseRuleRefusal, setHouseRules } from "../src/lib/house-rules";
import { createLeague } from "../src/lib/leagues";
import { mayShowVenue } from "../src/lib/listing";
import { eraseCustomer, exportCustomerData } from "../src/lib/privacy";
import { createBooking, createClassSessions, createCourt, createVenue } from "../src/lib/store";
import { createTournament } from "../src/lib/tournaments";
import { addDays, todayISO } from "../src/lib/time";
import * as accessRoute from "../src/app/api/admin/venue-access/route";
import * as availabilityRoute from "../src/app/api/availability/route";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as enrolRoute from "../src/app/api/classes/enrol/route";
import * as gameRoute from "../src/app/api/games/[id]/route";
import * as guestsRoute from "../src/app/api/my/guests/route";
import * as leagueRoute from "../src/app/api/leagues/[id]/route";
import * as myVenuesRoute from "../src/app/api/my/venues/route";
import * as tournamentRoute from "../src/app/api/tournaments/[id]/route";
import * as waitlistRoute from "../src/app/api/waitlist/route";

/**
 * A members-only or private venue's list counts an account only when it is
 * linked to the entry or has proved the entry's number (lib/access.ts,
 * `ENTRY_COUNTS_FOR`): a phone number typed on an account is not identity.
 * Staff at the counter still book on their word.
 */

let ownerId: number;
let kondo: number; // private
let kondoCourt: number;
let kelab: number; // members only
let other: number; // another business's private venue
let desk: { id: number; cookie: string };
let otherDesk: { id: number; cookie: string };
let n = 0;
const day = (k: number) => addDays(todayISO(), k);

type Person = { id: number; name: string; email: string; phone: string; cookie: string };
async function person(phone: string, proved = false): Promise<Person> {
  const made = await registerUser({ name: `Person ${++n}`, email: `acc${n}@kondo.my`, phone, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  if (proved) await getDb().prepare("UPDATE users SET verified_phone = phone, phone_verified_at = datetime('now') WHERE id = ?").run(made.user.id);
  return { id: made.user.id, name: made.user.name, email: made.user.email, phone, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function venue(name: string) {
  const made = await createVenue({ name, area: "Cheras", address: "1 Jalan Ujian", phone: "0300000000", openHour: 7, closeHour: 23 });
  if (!made.ok) throw new Error("venue");
  const court = await createCourt({ venueId: made.venue.id, name: "Court A", sport: "badminton", offPeakRate: 0, peakRate: 0 });
  if (!court.ok) throw new Error(court.error);
  return { id: made.venue.id, courtId: court.court.id };
}

async function staff(venueId: number) {
  const made = await createAdmin({ name: `Desk ${++n}`, email: `desk${n}@kondo.my`, password: "a long enough password", venueId, role: "manager" });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

const req = (url: string, method: string, cookie: string | null, body?: unknown) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.77.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const staffPost = (cookie: string, body: Record<string, unknown>) => accessRoute.POST(req("http://localhost/api/admin/venue-access", "POST", cookie, body));
const entryId = async (venueId: number, phone: string) => (await accessEntryId(venueId, phone))!;
const entry = async (venueId: number, phone: string) => (await accessList(venueId)).find((e) => e.phone === phone);

beforeAll(async () => {
  process.env.MYSENAM_PHONE_CHECK = "off";
  await ensureBootstrapAdmin();
  ownerId = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!.id;
  const k = await venue("Kondo Seri Indah");
  kondo = k.id;
  kondoCourt = k.courtId;
  kelab = (await venue("Kelab Rekreasi")).id;
  other = (await venue("Kondo Lain")).id;
  await setAccessSettings(kondo, { access: "private" });
  await setAccessSettings(kelab, { access: "members", listed: true });
  await setAccessSettings(other, { access: "private" });
  desk = await staff(kondo);
  otherDesk = await staff(other);
});

afterEach(() => {
  process.env.MYSENAM_PHONE_CHECK = "off";
});

describe("online, the list counts an account only when linked or proved", () => {
  it("refuses an account that only typed a listed number, at a private and a members-only venue", async () => {
    const typed = await person("0181000001");
    await addAccess(kondo, [{ phone: "018-100 0001", name: "Aisyah", label: "A-1-1" }], ownerId);
    await addAccess(kelab, [{ phone: "0181000001", kind: "member", label: "M-1" }], ownerId);
    expect(await onAccessList(kondo, typed.id)).toBe(false);
    expect(await accessRefusal(kondo, typed.id)).toMatchObject({ code: "PRIVATE_VENUE" });
    expect(await accessRefusal(kelab, typed.id)).toMatchObject({ code: "MEMBERS_ONLY" });
    expect(await mayShowVenue(kondo, { admin: null, userId: typed.id })).toMatchObject({ show: false });
    expect(await myPrivateVenues(typed.id)).toEqual([]);
    // The editor says so: an account carries the number, but nothing counts for it online.
    expect(await entry(kondo, "018-100 0001")).toMatchObject({ hasAccount: true, proved: false, account: null });
  });

  it("lets in the account staff linked, whatever number it carries", async () => {
    const resident = await person("0181000099"); // a different number from the list's
    await addAccess(kondo, [{ phone: "0181000002", name: "Lee", label: "B-2-2" }], ownerId);
    expect(await accessRefusal(kondo, resident.id)).toMatchObject({ code: "PRIVATE_VENUE" });
    const linked = await linkAccess(kondo, await entryId(kondo, "0181000002"), resident.email, ownerId);
    expect(linked).toMatchObject({ ok: true, account: { id: resident.id } });
    expect(await accessRefusal(kondo, resident.id)).toBeNull();
    expect(await myPrivateVenues(resident.id)).toEqual([{ id: kondo, name: "Kondo Seri Indah", area: "Cheras" }]);
    expect(await entry(kondo, "0181000002")).toMatchObject({ account: { id: resident.id, email: resident.email } });
  });

  it("lets in an account that proved the number, with phone checks on or off", async () => {
    const proved = await person("0181000003", true);
    await addAccess(kondo, [{ phone: "0181000003" }], ownerId);
    expect(await accessRefusal(kondo, proved.id)).toBeNull();
    process.env.MYSENAM_PHONE_CHECK = "on";
    expect(await accessRefusal(kondo, proved.id)).toBeNull();
    expect(await entry(kondo, "0181000003")).toMatchObject({ proved: true, account: null });
  });

  it("revokes online access when staff unlink the entry", async () => {
    const resident = await person("0181000004");
    await addAccess(kondo, [{ phone: "0181000004" }], ownerId);
    await linkAccess(kondo, await entryId(kondo, "0181000004"), resident.email, ownerId);
    expect(await accessRefusal(kondo, resident.id)).toBeNull();
    expect(await unlinkAccess(kondo, await entryId(kondo, "0181000004"))).toBe(true);
    expect(await accessRefusal(kondo, resident.id)).toMatchObject({ code: "PRIVATE_VENUE" });
    expect(await entry(kondo, "0181000004")).toMatchObject({ account: null });
  });

  it("does not change a public venue, or the counter", async () => {
    const pub = await venue("Dewan Awam");
    const nobody = await person("0181000005");
    expect(await accessRefusal(pub.id, nobody.id)).toBeNull();
    // Staff at the counter book an unlinked resident on their word.
    await addAccess(kondo, [{ phone: "0181000005", name: "Unlinked" }], ownerId);
    const atCounter = await bookingsRoute.POST(
      req("http://localhost/api/bookings", "POST", desk.cookie, { courtId: kondoCourt, date: day(3), hours: [9], name: "Unlinked", phone: "0181000005" })
    );
    expect(atCounter.status).toBe(201);
  });
});

describe("staff link and unlink", () => {
  it("finds the account by email or by its number, and says when a number is ambiguous", async () => {
    const a = await person("0182000001");
    expect(await findAccountToLink(a.email.toUpperCase())).toMatchObject({ ok: true, account: { id: a.id } });
    expect(await findAccountToLink("+60 18-200 0001")).toMatchObject({ ok: true, account: { id: a.id } });
    await person("0182000001");
    expect(await findAccountToLink("0182000001")).toMatchObject({ ok: false, error: "More than one account has that number: use the person's email." });
    expect(await findAccountToLink("nobody@nowhere.my")).toMatchObject({ ok: false, error: "No account has that email or number." });
    expect(await findAccountToLink("12")).toMatchObject({ ok: false });
  });

  it("links through the editor's route, on add or afterwards, and logs it", async () => {
    const r = await person("0182000010");
    const added = await staffPost(desk.cookie, { venueId: kondo, action: "add", phone: "0182000010", name: "Rahim", label: "C-3-3", account: r.email });
    expect(added.status).toBe(200);
    expect(await accessRefusal(kondo, r.id)).toBeNull();
    // A wrong account adds nobody.
    const wrong = await staffPost(desk.cookie, { venueId: kondo, action: "add", phone: "0182000011", account: "ghost@nowhere.my" });
    expect(wrong.status).toBe(400);
    expect(await accessEntryId(kondo, "0182000011")).toBeNull();

    const s = await person("0182000012");
    await staffPost(desk.cookie, { venueId: kondo, action: "add", phone: "0182000012" });
    const id = await entryId(kondo, "0182000012");
    const linked = await staffPost(desk.cookie, { venueId: kondo, action: "link", id, account: "0182000012" });
    expect(linked.status).toBe(200);
    const body = await linked.json();
    expect(body.list.find((e: { id: number }) => e.id === id)).toMatchObject({ account: { id: s.id } });
    expect(await accessRefusal(kondo, s.id)).toBeNull();
    const unlinked = await staffPost(desk.cookie, { venueId: kondo, action: "unlink", id });
    expect(unlinked.status).toBe(200);
    expect(await accessRefusal(kondo, s.id)).toMatchObject({ code: "PRIVATE_VENUE" });
    const logged = (await getDb()
      .prepare("SELECT detail FROM staff_actions WHERE venue_id = ? AND detail LIKE 'Access list: entry%' ORDER BY id")
      .all(kondo)) as { detail: string }[];
    expect(logged.map((l) => l.detail)).toEqual([`Access list: entry ${id} linked to account ${s.id}`, `Access list: entry ${id} unlinked`]);
  });

  it("keeps each venue's staff to their own list", async () => {
    const victim = await person("0182000020");
    await addAccess(kondo, [{ phone: "0182000020" }], ownerId);
    const id = await entryId(kondo, "0182000020");
    const intruder = await person("0182000021");
    // Another venue's staff, naming this venue: refused outright.
    expect((await staffPost(otherDesk.cookie, { venueId: kondo, action: "link", id, account: intruder.email })).status).toBe(403);
    expect((await staffPost(otherDesk.cookie, { venueId: kondo, action: "unlink", id })).status).toBe(403);
    // Naming their own venue with this venue's entry: not theirs to touch.
    expect((await staffPost(otherDesk.cookie, { venueId: other, action: "link", id, account: intruder.email })).status).toBe(404);
    expect((await staffPost(otherDesk.cookie, { venueId: other, action: "unlink", id })).status).toBe(404);
    expect(await accessRefusal(kondo, intruder.id)).toMatchObject({ code: "PRIVATE_VENUE" });
    expect(await entry(kondo, "0182000020")).toMatchObject({ account: null });
    expect(victim.id).toBeGreaterThan(0);
  });
});

describe("a resident's guest", () => {
  it("is linked to the guest's account when the guest accepts the invitation emailed to it, and needs it where numbers are not checked", async () => {
    const host = await person("0183000001");
    await addAccess(kondo, [{ phone: "0183000001", name: "Hafiz", label: "D-4-4" }], ownerId);
    await setGuestPolicy(kondo, { perResident: 3, days: 3 });
    // Not linked yet: the resident's typed number makes them nobody's host.
    expect(await myInviteVenues(host.id)).toEqual([]);
    expect(await inviteGuest(host.id, { venueId: kondo, phone: "0183000002", days: 1 })).toMatchObject({ code: "GUEST_NOT_HOST" });
    await linkAccess(kondo, await entryId(kondo, "0183000001"), host.email, ownerId);

    const withEmail = await person("0183000002");
    const res = await guestsRoute.POST(
      req("http://localhost/api/my/guests", "POST", host.cookie, { venueId: kondo, phone: "0183000002", name: "Ali", days: 2, email: withEmail.email })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    // Not linked until accepted: an address is never looked up (tests/guest-invitations.test.ts).
    expect(body).toMatchObject({ guest: { linked: false, invited: true }, phoneChecks: false });
    expect(await accessRefusal(kondo, withEmail.id)).toMatchObject({ code: "PRIVATE_VENUE" });
    const mail = (await getDb().prepare("SELECT body FROM messages WHERE recipient = ? ORDER BY id DESC").get(withEmail.email)) as { body: string };
    const token = /guest-invitation\?token=([A-Za-z0-9_-]+)/.exec(mail.body)![1];
    expect(await acceptGuestInvitation(withEmail, token)).toMatchObject({ ok: true });
    expect(await accessRefusal(kondo, withEmail.id)).toBeNull();
    expect(await entry(kondo, "0183000002")).toMatchObject({ kind: "guest", label: "D-4-4", invitedBy: "Hafiz", account: { id: withEmail.id } });

    const noEmail = await person("0183000003");
    expect(await inviteGuest(host.id, { venueId: kondo, phone: "0183000003", days: 1 })).toMatchObject({ ok: true, guest: { linked: false, invited: false } });
    expect(await accessRefusal(kondo, noEmail.id)).toMatchObject({ code: "PRIVATE_VENUE" });

    // An address no account has goes on as any other: same answer, an invitation sent, nothing linked.
    expect(await inviteGuest(host.id, { venueId: kondo, phone: "0183000004", days: 1, email: "nobody@nowhere.my" })).toMatchObject({
      ok: true,
      guest: { linked: false, invited: true },
    });
    expect(await inviteGuest(host.id, { venueId: kondo, phone: "0183000005", days: 1, email: host.email })).toMatchObject({ code: "GUEST_ACCOUNT_SELF" });
    expect(await accessEntryId(kondo, "0183000005")).toBeNull();
  });

  it("loses the old guest's link when another resident takes over a lapsed invitation", async () => {
    const host = (await getDb().prepare("SELECT id FROM users WHERE phone = '0183000001'").get()) as { id: number };
    const neighbour = await person("0183000010");
    await addAccess(kondo, [{ phone: "0183000010", name: "Mei", label: "E-5-5" }], ownerId);
    await linkAccess(kondo, await entryId(kondo, "0183000010"), neighbour.email, ownerId);
    await getDb().prepare("UPDATE venue_access_list SET expires_on = ? WHERE id = ?").run(day(-1), await entryId(kondo, "0183000002"));
    expect(await inviteGuest(neighbour.id, { venueId: kondo, phone: "0183000002", days: 1 })).toMatchObject({ ok: true, guest: { linked: false } });
    const ali = (await getDb().prepare("SELECT id FROM users WHERE phone = '0183000002'").get()) as { id: number };
    expect(await accessRefusal(kondo, ali.id)).toMatchObject({ code: "PRIVATE_VENUE" });
    expect(host.id).toBeGreaterThan(0);
  });

  it("counts a linked account's bookings with its household, whatever number it books under", async () => {
    const resident = await person("0183000020");
    const partner = await person("0183000021");
    await addAccess(kondo, [{ phone: "0183000020", label: "F-6-6" }, { phone: "0183000022", label: "F-6-6" }], ownerId);
    await linkAccess(kondo, await entryId(kondo, "0183000020"), resident.email, ownerId);
    await linkAccess(kondo, await entryId(kondo, "0183000022"), partner.email, ownerId);
    await setHouseRules(kondo, { upcoming: 1 });
    const booked = await createBooking({ courtId: kondoCourt, date: day(4), hours: [10], name: "Resident", phone: "0183000020", userId: resident.id });
    expect(booked.ok).toBe(true);
    // The partner's account carries another number than its entry's; the household is still one.
    expect(await houseRuleRefusal({ venueId: kondo, phone: partner.phone, userId: partner.id, dates: [day(5)], online: true })).toMatchObject({
      code: "LIMIT_UPCOMING",
    });
    await setHouseRules(kondo, { upcoming: null });
  });
});

describe("every path that consults the list", () => {
  let typed: Person;
  let linked: Person;
  let classId: number;
  let gameId: number;
  let tournamentId: number;
  let leagueId: number;

  beforeAll(async () => {
    typed = await person("0184000001");
    linked = await person("0184000002");
    await addAccess(kondo, [{ phone: "0184000001" }, { phone: "0184000002" }], ownerId);
    await linkAccess(kondo, await entryId(kondo, "0184000002"), linked.email, ownerId);
    const cls = await createClassSessions({ courtId: kondoCourt, name: "Yoga", instructor: "Coach", date: day(6), start: 18 * 60, end: 19 * 60, capacity: 1, price: 0 });
    if (!cls.ok) throw new Error(cls.error);
    classId = cls.classes[0].id;
    const host = await person("0184000003", true);
    await addAccess(kondo, [{ phone: "0184000003" }], ownerId);
    const b = await createBooking({ courtId: kondoCourt, date: day(7), hours: [20], name: "Host", phone: host.phone, userId: host.id });
    if (!b.ok) throw new Error(b.error);
    const game = await openGame(host.id, { bookingCode: b.booking.code, spots: 3, level: null, share: 0, autoAccept: true });
    if (!game.ok) throw new Error(game.error);
    gameId = game.game.id;
    const t = await createTournament(
      { venueId: kondo, name: "Kondo Cup", sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 0, maxEntries: 8, startsOn: day(20), endsOn: day(20), startHour: 9, endHour: 18, courtIds: [kondoCourt] },
      ownerId
    );
    if (!t.ok) throw new Error(t.error);
    tournamentId = t.value.id;
    const l = await createLeague({ venueId: kondo, name: "Kondo Ladder", sport: "badminton", teamSize: 1, level: null, fee: 0, startsOn: day(2) }, ownerId);
    if (!l.ok) throw new Error(l.error);
    leagueId = l.value.id;
  });

  it("the venue page and its availability", async () => {
    expect(await mayShowVenue(kondo, { admin: null, userId: typed.id })).toMatchObject({ show: false });
    expect(await mayShowVenue(kondo, { admin: null, userId: linked.id })).toMatchObject({ show: true });
    const grid = (who: Person) => availabilityRoute.GET(req(`http://localhost/api/availability?venueId=${kondo}&date=${day(3)}`, "GET", who.cookie));
    expect((await grid(typed)).status).toBe(404);
    expect((await grid(linked)).status).toBe(200);
  });

  it("booking a court", async () => {
    const book = (who: Person, hour: number) =>
      bookingsRoute.POST(req("http://localhost/api/bookings", "POST", who.cookie, { courtId: kondoCourt, date: day(8), hours: [hour], name: who.name, phone: who.phone }));
    const no = await book(typed, 9);
    expect(no.status).toBe(409);
    expect(await no.json()).toMatchObject({ code: "PRIVATE_VENUE" });
    expect((await book(linked, 10)).status).toBe(201);
  });

  it("enrolling in a class", async () => {
    const enrol = (who: Person) => enrolRoute.POST(req("http://localhost/api/classes/enrol", "POST", who.cookie, { classId, name: who.name, phone: who.phone }));
    const no = await enrol(typed);
    expect(no.status).toBe(409);
    expect(await no.json()).toMatchObject({ code: "PRIVATE_VENUE" });
    expect((await enrol(linked)).status).toBe(201);
  });

  it("joining a waiting list", async () => {
    const taken = await createBooking({ courtId: kondoCourt, date: day(9), hours: [11], name: "Taken", phone: "0184000099" });
    if (!taken.ok) throw new Error(taken.error);
    const wait = (who: Person) =>
      waitlistRoute.POST(req("http://localhost/api/waitlist", "POST", who.cookie, { courtId: kondoCourt, date: day(9), start: 11 * 60, end: 12 * 60, name: who.name, phone: who.phone }));
    const no = await wait(typed);
    expect(no.status).toBeGreaterThanOrEqual(400);
    expect(await no.json()).toMatchObject({ code: "PRIVATE_VENUE" });
    expect((await wait(linked)).status).toBe(201);
  });

  it("joining an open game", async () => {
    const join = (who: Person) =>
      gameRoute.POST(req(`http://localhost/api/games/${gameId}`, "POST", who.cookie, { action: "join" }), { params: Promise.resolve({ id: String(gameId) }) });
    const no = await join(typed);
    expect(no.status).toBe(403);
    expect(await no.json()).toMatchObject({ code: "PRIVATE_VENUE" });
    expect((await join(linked)).status).toBe(200);
  });

  it("entering a tournament", async () => {
    const enter = (who: Person) =>
      tournamentRoute.POST(req(`http://localhost/api/tournaments/${tournamentId}`, "POST", who.cookie, { action: "enter" }), {
        params: Promise.resolve({ id: String(tournamentId) }),
      });
    // A private venue's tournament is not there at all for somebody it does not count.
    expect((await enter(typed)).status).toBe(404);
    expect((await enter(linked)).status).toBe(201);
  });

  it("joining a league", async () => {
    const join = (who: Person) =>
      leagueRoute.POST(req(`http://localhost/api/leagues/${leagueId}`, "POST", who.cookie, { action: "join" }), { params: Promise.resolve({ id: String(leagueId) }) });
    expect((await join(typed)).status).toBe(404);
    expect((await join(linked)).status).toBe(201);
  });

  it("the account's own list of private venues", async () => {
    const mine = async (who: Person) => (await (await myVenuesRoute.GET(req("http://localhost/api/my/venues", "GET", who.cookie))).json()).venues;
    expect(await mine(typed)).toEqual([]);
    expect(await mine(linked)).toEqual([{ id: kondo, name: "Kondo Seri Indah", area: "Cheras" }]);
  });
});

describe("erasing the account", () => {
  it("unlinks the entry and leaves it on the list; the account's own export lists it until then", async () => {
    const leaving = await person("0185000001");
    await addAccess(kondo, [{ phone: "0185000001", name: "Leaving", label: "G-7-7" }], ownerId);
    const id = await entryId(kondo, "0185000001");
    await linkAccess(kondo, id, leaving.email, ownerId);
    const exported = await exportCustomerData(leaving.id);
    expect(exported?.venueLists).toEqual([expect.objectContaining({ venue: "Kondo Seri Indah", phone: "0185000001", label: "G-7-7" })]);
    expect((await eraseCustomer(leaving.id)).ok).toBe(true);
    const row = (await getDb().prepare("SELECT user_id FROM venue_access_list WHERE id = ?").get(id)) as { user_id: number | null } | undefined;
    expect(row).toEqual({ user_id: null });
    expect(await entry(kondo, "0185000001")).toMatchObject({ account: null });
  });
});
