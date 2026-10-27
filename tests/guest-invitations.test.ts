import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { accessEntryId, accessList, accessRefusal, addAccess, linkAccess, setAccessSettings, unlinkAccess } from "../src/lib/access";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { acceptGuestInvitation, cancelGuest, inviteGuest, myInviteVenues, setGuestPolicy } from "../src/lib/guest-invites";
import { createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { resetRateLimits } from "../src/lib/rate-limit";
import * as guestsRoute from "../src/app/api/my/guests/route";
import * as acceptRoute from "../src/app/api/guest-invitations/route";

/**
 * A resident inviting a guest by email learns nothing about the address: not
 * whether an account holds it, nor whose it is (the owner's decision of
 * 27 October 2026; docs/architecture/security.md#no-account-enumeration).
 * The address is sent a single-use link that links the one guest entry to
 * the account that accepts it, signed in with that address.
 */

type Person = { id: number; name: string; email: string; phone: string; cookie: string };
let n = 0;
async function person(phone: string, email = `gi6-${++n}@kondo.my`): Promise<Person> {
  const made = await registerUser({ name: `Person ${n} Tester`, email, phone, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return { id: made.user.id, name: made.user.name, email: made.user.email, phone, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function venue(name: string) {
  const made = await createVenue({ name, area: "Cheras", address: "1 Jalan Ujian", phone: "0300000000", openHour: 7, closeHour: 23 });
  if (!made.ok) throw new Error("venue");
  const court = await createCourt({ venueId: made.venue.id, name: "Court A", sport: "badminton", offPeakRate: 0, peakRate: 0 });
  if (!court.ok) throw new Error(court.error);
  await setAccessSettings(made.venue.id, { access: "private" });
  await setGuestPolicy(made.venue.id, { perResident: 10, days: 3 });
  return made.venue.id;
}

/** A resident on the venue's list, linked by staff, who may invite guests. */
async function resident(venueId: number, phone: string, label: string): Promise<Person> {
  const p = await person(phone);
  await addAccess(venueId, [{ phone, name: p.name, label }], null);
  const linked = await linkAccess(venueId, (await accessEntryId(venueId, phone))!, p.email, null);
  if (!linked.ok) throw new Error(linked.error);
  return p;
}

function req(url: string, method: string, cookie: string | null, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const invite = (host: Person, body: Record<string, unknown>) => guestsRoute.POST(req("http://localhost/api/my/guests", "POST", host.cookie, body));
const accept = (who: Person | null, token: unknown) => acceptRoute.POST(req("http://localhost/api/guest-invitations", "POST", who?.cookie ?? null, { token }));

/** The emails queued to this address. */
async function mailsTo(email: string): Promise<{ id: number; subject: string; body: string; kind: string; venue_id: number | null }[]> {
  return (await getDb()
    .prepare("SELECT id, subject, body, kind, venue_id FROM messages WHERE channel = 'email' AND lower(recipient) = lower(?) ORDER BY id")
    .all(email)) as { id: number; subject: string; body: string; kind: string; venue_id: number | null }[];
}

/** The token in the last invitation emailed to this address. */
async function tokenFor(email: string): Promise<string> {
  const mails = await mailsTo(email);
  const match = /guest-invitation\?token=([A-Za-z0-9_-]+)/.exec(mails.at(-1)?.body ?? "");
  if (!match) throw new Error(`no invitation emailed to ${email}`);
  return match[1];
}

const entryOf = async (venueId: number, phone: string) => (await accessList(venueId)).find((e) => e.phone === phone);
const guestRow = async (venueId: number, phone: string) =>
  (await getDb().prepare("SELECT id, user_id FROM venue_access_list WHERE venue_id = ? AND phone_key = phone_key(?)").get(venueId, phone)) as
    | { id: number; user_id: number | null }
    | undefined;

let kondo: number;
let other: number;
let host: Person;

beforeAll(async () => {
  kondo = await venue("Kondo Gi6");
  other = await venue("Another Kondo");
  host = await resident(kondo, "0186000001", "A-1-1");
});

beforeEach(() => resetRateLimits());

describe("inviting with an email says nothing about the address", () => {
  it("gives byte-identical answers for an address with an account and one without, and emails both", async () => {
    const known = await person("0186000101", "Known.Guest@kondo.my");
    const unknown = "nobody-at-all@kondo.my";
    expect(await getDb().prepare("SELECT 1 AS n FROM users WHERE lower(email) = lower(?)").get(unknown)).toBeUndefined();

    const first = await invite(host, { venueId: kondo, phone: "0186000100", name: "Visitor", days: 2, email: known.email });
    const firstText = await first.text();
    const firstId = (await guestRow(kondo, "0186000100"))!.id;
    expect(await cancelGuest(host.id, firstId)).toBe(true);
    const second = await invite(host, { venueId: kondo, phone: "0186000100", name: "Visitor", days: 2, email: unknown });
    const secondText = await second.text();
    const secondId = (await guestRow(kondo, "0186000100"))!.id;

    expect(first.status).toBe(201);
    expect(second.status).toBe(first.status);
    expect([...first.headers.keys()].sort()).toEqual([...second.headers.keys()].sort());
    // Only the new row's id differs, as it would between any two invitations; nothing else, byte for byte, in the same order.
    const normalise = (text: string, id: number) => {
      const parsed = JSON.parse(text) as { guest: { id: number }; venues: { guests: { id: number }[] }[] };
      expect(parsed.guest.id).toBe(id);
      parsed.guest.id = 0;
      for (const v of parsed.venues) for (const g of v.guests) if (g.id === id) g.id = 0;
      return JSON.stringify(parsed);
    };
    expect(JSON.stringify(JSON.parse(firstText))).toBe(firstText);
    expect(normalise(firstText, firstId)).toBe(normalise(secondText, secondId));
    const body = JSON.parse(secondText);
    expect(Object.keys(body).sort()).toEqual(["guest", "phoneChecks", "venues"]);
    expect(body.guest).toEqual({ id: secondId, phone: "0186000100", name: "Visitor", expiresOn: addDays(todayISO(), 1), linked: false, invited: true });

    // The same work: one email each, the same words but for the link, through the outbox, to no venue's staff.
    const [toKnown] = await mailsTo(known.email);
    const [toUnknown] = await mailsTo(unknown);
    expect(toKnown).toBeDefined();
    expect(toUnknown).toBeDefined();
    const strip = (m: { subject: string; body: string; kind: string; venue_id: number | null }) => ({
      ...m,
      body: m.body.replace(/token=[A-Za-z0-9_-]+/, "token=T"),
    });
    const { id: _a, ...a } = toKnown;
    const { id: _b, ...b } = toUnknown;
    expect(strip(a)).toEqual(strip(b));
    expect(a).toMatchObject({ kind: "account_email", venue_id: null });
    expect(a.body).toContain("Kondo Gi6");
    expect(a.body).not.toContain(known.name);
    // Nothing linked: the account with that address is not let in by being named.
    expect(await accessRefusal(kondo, known.id)).toMatchObject({ code: "PRIVATE_VENUE" });
    expect((await guestRow(kondo, "0186000100"))!.user_id).toBeNull();
    expect(_a + _b).toBeGreaterThan(0);
  });

  it("refuses only what the resident can know: their own address, or something that is not an address", async () => {
    expect(await inviteGuest(host.id, { venueId: kondo, phone: "0186000110", days: 1, email: host.email.toUpperCase() })).toMatchObject({
      code: "GUEST_ACCOUNT_SELF",
    });
    expect(await inviteGuest(host.id, { venueId: kondo, phone: "0186000110", days: 1, email: "not an address" })).toMatchObject({ code: "GUEST_EMAIL_INVALID" });
    expect(await accessEntryId(kondo, "0186000110")).toBeNull();
  });

  it("keeps the guest rules: not a host, own number, and a guest cannot invite", async () => {
    const outsider = await person("0186000120");
    expect(await inviteGuest(outsider.id, { venueId: kondo, phone: "0186000121", days: 1, email: "x@kondo.my" })).toMatchObject({ code: "GUEST_NOT_HOST" });
    expect(await inviteGuest(host.id, { venueId: kondo, phone: host.phone, days: 1, email: "x@kondo.my" })).toMatchObject({ code: "GUEST_SELF" });
    expect(await inviteGuest(host.id, { venueId: kondo, phone: "0186000121", days: 4, email: "x@kondo.my" })).toMatchObject({ code: "GUEST_DAYS" });
    expect(await mailsTo("x@kondo.my")).toEqual([]);
  });
});

describe("accepting the invitation", () => {
  it("links only its one entry to the account signed in with that address", async () => {
    const guest = await person("0186000201", "ali.gi6@kondo.my");
    // Another of the host's guests, and the guest's own number elsewhere: neither is touched.
    expect(await inviteGuest(host.id, { venueId: kondo, phone: "0186000202", days: 2 })).toMatchObject({ ok: true });
    await addAccess(other, [{ phone: "0186000200", name: "Ali at the other", label: "Z-1" }], null);
    expect(await inviteGuest(host.id, { venueId: kondo, phone: "0186000200", name: "Ali", days: 2, email: "ALI.gi6@kondo.my" })).toMatchObject({ ok: true });
    const token = await tokenFor(guest.email);

    const res = await accept(guest, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ venue: { id: kondo, name: "Kondo Gi6" }, expiresOn: addDays(todayISO(), 1) });
    expect((await guestRow(kondo, "0186000200"))!.user_id).toBe(guest.id);
    expect(await accessRefusal(kondo, guest.id)).toBeNull();
    // Nothing else: no other entry, venue, household or power to invite.
    expect((await guestRow(kondo, "0186000202"))!.user_id).toBeNull();
    expect((await guestRow(other, "0186000200"))!.user_id).toBeNull();
    expect(await accessRefusal(other, guest.id)).toMatchObject({ code: "PRIVATE_VENUE" });
    expect(await myInviteVenues(guest.id)).toEqual([]);
    expect(await entryOf(kondo, "0186000200")).toMatchObject({ kind: "guest", label: "A-1-1", invitedBy: host.name, account: { id: guest.id } });
    expect(await getDb().prepare("SELECT 1 AS n FROM admins WHERE lower(email) = lower(?)").get(guest.email)).toBeUndefined();

    // Single use.
    const again = await accept(guest, token);
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ code: "GUEST_INVITATION_INVALID" });
  });

  it("shows the resident 'invitation sent' until it is accepted, then 'linked'", async () => {
    const guest = await person("0186000301", "mei.gi6@kondo.my");
    await inviteGuest(host.id, { venueId: kondo, phone: "0186000300", name: "Mei", days: 1, email: guest.email });
    const listed = async () => (await myInviteVenues(host.id))[0].guests.find((g) => g.phone === "0186000300");
    expect(await listed()).toMatchObject({ linked: false, invited: true });
    // The same while an address nobody holds waits.
    await inviteGuest(host.id, { venueId: kondo, phone: "0186000302", name: "Nobody", days: 1, email: "nobody-2@kondo.my" });
    expect((await myInviteVenues(host.id))[0].guests.find((g) => g.phone === "0186000302")).toMatchObject({ linked: false, invited: true });

    expect(await acceptGuestInvitation(guest, await tokenFor(guest.email))).toMatchObject({ ok: true });
    expect(await listed()).toMatchObject({ linked: true, invited: false });
    const res = await guestsRoute.GET(req("http://localhost/api/my/guests", "GET", host.cookie));
    const body = await res.json();
    expect(body.venues[0].guests.find((g: { phone: string }) => g.phone === "0186000300")).toMatchObject({ linked: true, invited: false });
  });

  it("refuses another account, leaving it for the right one", async () => {
    const right = await person("0186000401", "right.gi6@kondo.my");
    const wrong = await person("0186000402", "wrong.gi6@kondo.my");
    await inviteGuest(host.id, { venueId: kondo, phone: "0186000400", days: 1, email: right.email });
    const token = await tokenFor(right.email);
    const refused = await accept(wrong, token);
    expect(refused.status).toBe(404);
    expect(await refused.json()).toMatchObject({ code: "GUEST_INVITATION_INVALID" });
    // The inviter cannot take it either.
    expect(await acceptGuestInvitation(host, token)).toMatchObject({ code: "GUEST_INVITATION_INVALID" });
    expect((await guestRow(kondo, "0186000400"))!.user_id).toBeNull();
    expect((await accept(right, token)).status).toBe(200);
    expect((await guestRow(kondo, "0186000400"))!.user_id).toBe(right.id);
  });

  it("gives every unusable link the same answer: unknown, run out, replaced, cancelled, taken over, resident gone", async () => {
    const same = async (who: Person, token: string) => {
      const res = await accept(who, token);
      return { status: res.status, body: await res.text() };
    };
    const g = await person("0186000501", "g5.gi6@kondo.my");
    const unknown = await same(g, "x".repeat(32));
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body)).toMatchObject({ code: "GUEST_INVITATION_INVALID" });
    expect(await same(g, "short")).toEqual(unknown);

    // Run out: the invitation's last day passed (the entry with it).
    await inviteGuest(host.id, { venueId: kondo, phone: "0186000500", days: 1, email: g.email });
    const lapsed = await tokenFor(g.email);
    await getDb().prepare("UPDATE venue_access_list SET expires_on = ? WHERE id = ?").run(addDays(todayISO(), -1), (await guestRow(kondo, "0186000500"))!.id);
    await getDb().prepare("UPDATE guest_invitations SET expires_on = ? WHERE token_hash IS NOT NULL AND entry_id = ?").run(addDays(todayISO(), -1), (await guestRow(kondo, "0186000500"))!.id);
    expect(await same(g, lapsed)).toEqual(unknown);

    // Replaced: inviting again sends a new link and the old one stops working.
    await inviteGuest(host.id, { venueId: kondo, phone: "0186000510", days: 1, email: g.email });
    const old = await tokenFor(g.email);
    await inviteGuest(host.id, { venueId: kondo, phone: "0186000510", days: 2, email: g.email });
    const fresh = await tokenFor(g.email);
    expect(fresh).not.toBe(old);
    expect(await same(g, old)).toEqual(unknown);

    // Cancelled: the resident takes the guest off.
    expect(await cancelGuest(host.id, (await guestRow(kondo, "0186000510"))!.id)).toBe(true);
    expect(await same(g, fresh)).toEqual(unknown);

    // Taken over: a lapsed guest another resident invites keeps none of the old invitation.
    const neighbour = await resident(kondo, "0186000520", "B-2-2");
    await inviteGuest(host.id, { venueId: kondo, phone: "0186000521", days: 1, email: g.email });
    const before = await tokenFor(g.email);
    await getDb().prepare("UPDATE venue_access_list SET expires_on = ? WHERE id = ?").run(addDays(todayISO(), -1), (await guestRow(kondo, "0186000521"))!.id);
    expect(await inviteGuest(neighbour.id, { venueId: kondo, phone: "0186000521", days: 1 })).toMatchObject({ ok: true, guest: { invited: false } });
    expect(await same(g, before)).toEqual(unknown);

    // The resident gone from the list, or no longer counted as one (unlinked): their invitations go with them.
    const leaving = await resident(kondo, "0186000530", "C-3-3");
    await inviteGuest(leaving.id, { venueId: kondo, phone: "0186000531", days: 1, email: g.email });
    const fromLeaving = await tokenFor(g.email);
    expect(await unlinkAccess(kondo, (await accessEntryId(kondo, "0186000530"))!)).toBe(true);
    expect(await same(g, fromLeaving)).toEqual(unknown);
    await getDb().prepare("DELETE FROM venue_access_list WHERE id = ?").run((await accessEntryId(kondo, "0186000530"))!);
    expect(await accessEntryId(kondo, "0186000531")).toBeNull();
    expect(await same(g, fromLeaving)).toEqual(unknown);
    expect(await accessRefusal(kondo, g.id)).toMatchObject({ code: "PRIVATE_VENUE" });
  });

  it("works for somebody who makes their account after being invited", async () => {
    await inviteGuest(host.id, { venueId: kondo, phone: "0186000600", name: "New", days: 3, email: "brand.new@kondo.my" });
    const token = await tokenFor("brand.new@kondo.my");
    expect((await accept(null, token)).status).toBe(401);
    const made = await person("0186000601", "Brand.New@kondo.my");
    expect((await accept(made, token)).status).toBe(200);
    expect(await accessRefusal(kondo, made.id)).toBeNull();
  });

  it("grants nothing at another venue: a token is its own venue's entry only", async () => {
    const otherHost = await resident(other, "0186000701", "Q-1");
    const guest = await person("0186000703", "iso.gi6@kondo.my");
    await inviteGuest(otherHost.id, { venueId: other, phone: "0186000702", days: 1, email: guest.email });
    const token = await tokenFor(guest.email);
    expect((await accept(guest, token)).status).toBe(200);
    expect(await accessRefusal(other, guest.id)).toBeNull();
    expect(await accessRefusal(kondo, guest.id)).toMatchObject({ code: "PRIVATE_VENUE" });
    expect((await accessList(kondo)).some((e) => e.account?.id === guest.id)).toBe(false);
  });

  it("links once when the same link is accepted twice at once", async () => {
    const guest = await person("0186000801", "race.gi6@kondo.my");
    await inviteGuest(host.id, { venueId: kondo, phone: "0186000800", days: 1, email: guest.email });
    const token = await tokenFor(guest.email);
    const results = await Promise.all([acceptGuestInvitation(guest, token), acceptGuestInvitation(guest, token), acceptGuestInvitation(guest, token)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "GUEST_INVITATION_INVALID")).toBe(true);
    const used = (await getDb()
      .prepare("SELECT COUNT(*)::int AS n FROM guest_invitations WHERE entry_id = ? AND used_at IS NOT NULL")
      .get((await guestRow(kondo, "0186000800"))!.id)) as { n: number };
    expect(used.n).toBe(1);
  });

  it("keeps only hashes: neither the link nor the address is stored", async () => {
    await inviteGuest(host.id, { venueId: kondo, phone: "0186000900", days: 1, email: "hash.only@kondo.my" });
    const token = await tokenFor("hash.only@kondo.my");
    const rows = JSON.stringify(await getDb().prepare("SELECT * FROM guest_invitations").all());
    expect(rows).not.toContain(token);
    expect(rows).not.toContain("hash.only@kondo.my");
  });
});
