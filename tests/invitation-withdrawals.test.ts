import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { accessEntryId, accessList, addAccess, linkAccess, setAccessSettings } from "../src/lib/access";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { getDb, transactionStats } from "../src/lib/db";
import { askToJoin, decide, gameForViewer, gamePlayers, inviteByEmail, openGame, withdrawEmailInvitation } from "../src/lib/games";
import { createGroup, groupView, inviteToGroup, withdrawGroupInvitation } from "../src/lib/groups";
import { acceptGuestInvitation, inviteGuest, myInviteVenues, setGuestPolicy, withdrawGuestInvitation } from "../src/lib/guest-invites";
import { translator } from "../src/lib/i18n";
import { drainOutbox, setTransport } from "../src/lib/outbox";
import { acceptPlayerInvitation, openEmailInvitationCount } from "../src/lib/player-invitations";
import { saveProfile } from "../src/lib/player-profiles";
import { resetRateLimits } from "../src/lib/rate-limit";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import type { Sport } from "../src/lib/types";
import * as guestsRoute from "../src/app/api/my/guests/route";
import * as guestAcceptRoute from "../src/app/api/guest-invitations/route";
import * as accessRoute from "../src/app/api/admin/venue-access/route";
import * as gameRoute from "../src/app/api/games/[id]/route";
import * as groupRoute from "../src/app/api/groups/[id]/route";
import * as playerAcceptRoute from "../src/app/api/player-invitations/route";

/**
 * Withdrawing an emailed invitation not yet accepted (the owner's decision of
 * 28 October 2026): a resident's guest's, by the resident or the venue's
 * manager; a game's, by its host or whoever sent it; a group's, by its
 * organiser. Nobody else, and nothing at another venue, game or group: they
 * hear it is not found. Withdrawn only while open, under the lock accepting
 * takes, so a withdrawal racing an acceptance is one or the other; twice is
 * the same answer; an accepted, run-out or replaced one is refused with a
 * pointer and nothing changes. The link is then refused in the same words as
 * one run out, and the address is told only if the email had gone, the same
 * whether or not an account holds it.
 */

let n = 0;
type Person = User & { cookie: string };

async function person(profile?: Record<string, unknown>, email?: string): Promise<Person> {
  n++;
  const made = await registerUser({ name: `Rv${n} Person`, email: email ?? `rv7-${n}@players.my`, phone: `01380${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  if (profile) {
    const saved = await saveProfile(made.user.id, profile);
    if (!saved.ok) throw new Error(saved.error);
  }
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

function req(url: string, method: string, cookie: string | null, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.71.${n % 250}.${(n * 7) % 250}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

async function mailsTo(email: string) {
  return (await getDb()
    .prepare("SELECT id, subject, body, kind, venue_id, status, locale, dedupe_key FROM messages WHERE channel = 'email' AND lower(recipient) = lower(?) ORDER BY id")
    .all(email)) as { id: number; subject: string; body: string; kind: string; venue_id: number | null; status: string; locale: string; dedupe_key: string | null }[];
}
async function tokenIn(email: string, page: "guest-invitation" | "player-invitation"): Promise<string> {
  const match = new RegExp(`${page}\\?token=([A-Za-z0-9_-]+)`).exec((await mailsTo(email)).at(-1)?.body ?? "");
  if (!match) throw new Error(`no invitation emailed to ${email}`);
  return match[1];
}

/** A transport that marks every message sent, as a working mail provider would. */
const sendsEverything = { name: "test", send: async () => undefined };

/**
 * Drains the outbox until the first email to this address has gone (a drain started in the background may be
 * sending it), then waits for that background drain to finish too, so that what is counted next is the next
 * request's own statements.
 */
async function untilSent(email: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await drainOutbox();
    if ((await mailsTo(email))[0]?.status === "sent") return untilQuiet();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`the email to ${email} was not sent`);
}

/** Until no statement has been sent for 50 ms. */
async function untilQuiet(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const before = transactionStats().queries;
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (transactionStats().queries === before) return;
  }
}

beforeEach(() => resetRateLimits());
afterEach(() => setTransport(null));

// ----------------------------------------------------------------- guests

let kondo: number;
let other: number;
let host: Person;
let neighbour: Person;
let elsewhere: Person;

async function venue(name: string) {
  const made = await createVenue({ name, area: "Cheras", address: "1 Jalan Ujian", phone: "0300000000", openHour: 7, closeHour: 23 });
  if (!made.ok) throw new Error("venue");
  const court = await createCourt({ venueId: made.venue.id, name: "Court A", sport: "badminton", offPeakRate: 0, peakRate: 0 });
  if (!court.ok) throw new Error(court.error);
  await setAccessSettings(made.venue.id, { access: "private" });
  await setGuestPolicy(made.venue.id, { perResident: 10, days: 3 });
  return made.venue.id;
}
async function resident(venueId: number, label: string): Promise<Person> {
  const p = await person();
  await addAccess(venueId, [{ phone: p.phone, name: p.name, label }], null);
  const linked = await linkAccess(venueId, (await accessEntryId(venueId, p.phone))!, p.email, null);
  if (!linked.ok) throw new Error(linked.error);
  return p;
}
async function staff(venueId: number, role: "manager" | "desk") {
  n++;
  const made = await createAdmin({ name: `Staff ${n}`, email: `rv7-staff${n}@kondo.my`, password: "a long enough password", venueId, role });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

let guestPhone = 0;
/** A guest invited by `by` with an email: the entry's id and the link's token. */
async function invitedGuest(by: Person, email: string, venueId = kondo) {
  const phone = `0187${String(++guestPhone).padStart(6, "0")}`;
  const made = await inviteGuest(by.id, { venueId, phone, name: `Guest ${guestPhone}`, days: 2, email });
  if (!made.ok) throw new Error(made.error);
  return { id: made.guest.id, phone, token: await tokenIn(email, "guest-invitation").catch(() => "") }; // Gone once sent: read only where nothing sends it.
}
const withdrawRoute = (who: Person, body: unknown) => guestsRoute.PATCH(req("http://localhost/api/my/guests", "PATCH", who.cookie, body));
const acceptGuest = (who: Person, token: string) => guestAcceptRoute.POST(req("http://localhost/api/guest-invitations", "POST", who.cookie, { token }));
const staffPost = (cookie: string, body: Record<string, unknown>) => accessRoute.POST(req("http://localhost/api/admin/venue-access", "POST", cookie, body));
const invitationRow = async (entryId: number) =>
  (await getDb()
    .prepare("SELECT used_at, cancelled_at, revoked_at, revoked_by_user, revoked_by_admin, revoke_reason FROM guest_invitations WHERE entry_id = ? ORDER BY id DESC LIMIT 1")
    .get(entryId)) as { used_at: unknown; cancelled_at: unknown; revoked_at: unknown; revoked_by_user: number | null; revoked_by_admin: number | null; revoke_reason: string | null };

beforeAll(async () => {
  kondo = await venue("Kondo Rv7");
  other = await venue("Another Kondo Rv7");
  host = await resident(kondo, "A-1-1");
  neighbour = await resident(kondo, "A-1-2");
  elsewhere = await resident(other, "B-1-1");
});

describe("a resident withdrawing a guest's emailed invitation", () => {
  it("withdraws it, keeps the guest on the list, refuses the link like one run out, and answers the same twice", async () => {
    const guest = await person();
    const invited = await invitedGuest(host, guest.email);
    const before = await mailsTo(guest.email);
    expect(before).toHaveLength(1);
    expect(before[0].status).toBe("queued");

    const first = await withdrawRoute(host, { action: "withdrawInvitation", id: invited.id });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.withdrawn).toBe(true);
    const listed = firstBody.venues[0].guests.find((g: { id: number }) => g.id === invited.id);
    // Still on the list by their number; shown as withdrawn, no longer as an invitation out.
    expect(listed).toMatchObject({ phone: invited.phone, linked: false, invited: false, withdrawn: true });
    // Who and when, on the invitation's own row.
    expect(await invitationRow(invited.id)).toMatchObject({ revoked_by_user: host.id, revoked_by_admin: null, revoke_reason: null });
    expect((await invitationRow(invited.id)).revoked_at).not.toBeNull();
    // Its email had not gone: it never goes, the link in it not kept, and nothing else is sent.
    const after = await mailsTo(guest.email);
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("abandoned");
    expect(after[0].body).not.toContain(invited.token);

    // Again: the same answer, nothing changed.
    const second = await withdrawRoute(host, { action: "withdrawInvitation", id: invited.id });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);
    expect(await mailsTo(guest.email)).toHaveLength(1);

    // The link: refused in the same words as one run out, or made up.
    const withdrawnAnswer = await acceptGuest(guest, invited.token);
    const expiring = await invitedGuest(host, guest.email);
    await getDb().prepare("UPDATE guest_invitations SET expires_on = ? WHERE entry_id = ?").run(addDays(todayISO(), -1), expiring.id);
    const ranOut = await acceptGuest(guest, expiring.token);
    const madeUp = await acceptGuest(guest, "z".repeat(32));
    for (const r of [withdrawnAnswer, ranOut, madeUp]) expect(r.status).toBe(404);
    const bodies = await Promise.all([withdrawnAnswer, ranOut, madeUp].map((r) => r.json()));
    expect(bodies[0]).toMatchObject({ code: "GUEST_INVITATION_INVALID" });
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toEqual(bodies[2]);
    expect(((await getDb().prepare("SELECT user_id FROM venue_access_list WHERE id = ?").get(invited.id)) as { user_id: number | null }).user_id).toBeNull();

    // Invited again: a new link, out and usable, no longer shown withdrawn.
    const again = await inviteGuest(host.id, { venueId: kondo, phone: invited.phone, name: "Again", days: 2, email: guest.email });
    expect(again).toMatchObject({ ok: true, guest: { id: invited.id, invited: true } });
    const shown = (await myInviteVenues(host.id))[0].guests.find((g) => g.id === invited.id)!;
    expect(shown.invited).toBe(true);
    expect(shown.withdrawn).toBeUndefined();
    expect((await acceptGuest(guest, await tokenIn(guest.email, "guest-invitation"))).status).toBe(200);
  });

  it("tells the address only once the email had gone, in the language it was written in, the same whether or not an account holds it", async () => {
    await getDb().prepare("UPDATE users SET locale = 'ms' WHERE id = ?").run(host.id);
    try {
      const holder = await person();
      const nobody = "rv7-nobody-guest@nowhere.my";
      const answers: string[] = [];
      const statements: number[] = [];
      const notices: Awaited<ReturnType<typeof mailsTo>> = [];
      for (const email of [holder.email, nobody]) {
        setTransport(sendsEverything);
        const invited = await invitedGuest(host, email);
        await untilSent(email);
        setTransport(null); // The notice stays queued, its words readable.
        const before = transactionStats().queries;
        const res = await withdrawRoute(host, { action: "withdrawInvitation", id: invited.id });
        statements.push(transactionStats().queries - before);
        const body = await res.json();
        answers.push(JSON.stringify({ status: res.status, withdrawn: body.withdrawn, keys: Object.keys(body).sort() }));
        notices.push((await mailsTo(email))[1]);
      }
      expect(answers[1]).toBe(answers[0]);
      expect(statements[1]).toBe(statements[0]);
      const ms = translator("ms");
      for (const notice of notices) {
        expect(notice).toMatchObject({ kind: "account_email", venue_id: null, locale: "ms", subject: ms("rv7.mail.guest.s", { venue: "Kondo Rv7" }) });
        // Never who withdrew it or why.
        expect(notice.body).not.toContain(host.name.split(" ")[0]);
      }
      expect(notices[0].body).toBe(notices[1].body);
    } finally {
      await getDb().prepare("UPDATE users SET locale = NULL WHERE id = ?").run(host.id);
    }
  });

  it("is refused for anybody else's guest, at this venue or another, as if there were none", async () => {
    const invited = await invitedGuest(host, "rv7-theirs@nowhere.my");
    const theirs = await invitedGuest(elsewhere, "rv7-elsewhere@nowhere.my", other);
    const refused = [
      await withdrawRoute(neighbour, { action: "withdrawInvitation", id: invited.id }),
      await withdrawRoute(elsewhere, { action: "withdrawInvitation", id: invited.id }),
      await withdrawRoute(host, { action: "withdrawInvitation", id: theirs.id }),
      await withdrawRoute(host, { action: "withdrawInvitation", id: 99_999_999 }),
    ];
    for (const r of refused) expect(r.status).toBe(404);
    const bodies = await Promise.all(refused.map((r) => r.json()));
    for (const b of bodies) expect(b).toEqual(bodies[3]);
    expect(bodies[0]).toMatchObject({ code: "INVITATION_NOT_FOUND" });
    expect((await invitationRow(invited.id)).revoked_at).toBeNull();
    expect((await invitationRow(theirs.id)).revoked_at).toBeNull();
    expect((await withdrawRoute(host, { action: "nonsense", id: invited.id })).status).toBe(400);
  });

  it("refuses an accepted invitation, pointing to taking the guest off, and one run out or replaced, changing nothing", async () => {
    const guest = await person();
    const invited = await invitedGuest(host, guest.email);
    expect((await acceptGuestInvitation(guest, invited.token)).ok).toBe(true);
    const accepted = await withdrawRoute(host, { action: "withdrawInvitation", id: invited.id });
    expect(accepted.status).toBe(409);
    expect(await accepted.json()).toMatchObject({ code: "INVITATION_ACCEPTED_GUEST" });
    expect(await invitationRow(invited.id)).toMatchObject({ revoked_at: null, revoked_by_user: null });
    expect((await invitationRow(invited.id)).used_at).not.toBeNull();
    expect(((await getDb().prepare("SELECT user_id FROM venue_access_list WHERE id = ?").get(invited.id)) as { user_id: number }).user_id).toBe(guest.id);

    const lapsed = await invitedGuest(host, "rv7-lapsed@nowhere.my");
    await getDb().prepare("UPDATE guest_invitations SET expires_on = ? WHERE entry_id = ?").run(addDays(todayISO(), -1), lapsed.id);
    const ranOut = await withdrawGuestInvitation(host.id, lapsed.id);
    expect(ranOut).toMatchObject({ ok: false, status: 409, code: "INVITATION_NOT_PENDING" });
    expect((await invitationRow(lapsed.id)).revoked_at).toBeNull();
  });
});

describe("the venue's manager withdrawing a guest's emailed invitation", () => {
  it("withdraws it with a reason, logged as its own action, the list showing it out then withdrawn", async () => {
    const manager = await staff(kondo, "manager");
    const invited = await invitedGuest(host, "rv7-staff-1@nowhere.my");
    expect((await accessList(kondo)).find((e) => e.id === invited.id)).toMatchObject({ kind: "guest", invitation: "pending" });

    expect((await staffPost(manager.cookie, { venueId: kondo, action: "withdrawInvitation", id: invited.id })).status).toBe(400);
    expect((await staffPost(manager.cookie, { venueId: kondo, action: "withdrawInvitation", id: invited.id, reason: "   " })).status).toBe(400);
    expect((await invitationRow(invited.id)).revoked_at).toBeNull();

    const res = await staffPost(manager.cookie, { venueId: kondo, action: "withdrawInvitation", id: invited.id, reason: "Unit owner asked us to" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.withdrawn).toBe(true);
    expect(body.list.find((e: { id: number }) => e.id === invited.id)).toMatchObject({ invitation: "withdrawn" });
    expect(await invitationRow(invited.id)).toMatchObject({ revoked_by_admin: manager.id, revoked_by_user: null, revoke_reason: "Unit owner asked us to" });
    const logged = (await getDb().prepare("SELECT admin_id, venue_id, action, detail FROM staff_actions WHERE action = 'guest_invitation.withdrawn'").all()) as {
      admin_id: number;
      venue_id: number;
      detail: string;
    }[];
    expect(logged).toEqual([expect.objectContaining({ admin_id: manager.id, venue_id: kondo })]);
    expect(logged[0].detail).toContain("Unit owner asked us to");

    // Again: the same answer, nothing more logged.
    const again = await staffPost(manager.cookie, { venueId: kondo, action: "withdrawInvitation", id: invited.id, reason: "Twice" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(body);
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM staff_actions WHERE action = 'guest_invitation.withdrawn'").get()) as { n: number }).toEqual({ n: 1 });
    // The resident sees it withdrawn too.
    expect((await myInviteVenues(host.id))[0].guests.find((g) => g.id === invited.id)).toMatchObject({ invited: false, withdrawn: true });
  });

  it("is a manager's job; another venue's staff are refused that venue, and an entry of another venue is not found", async () => {
    const invited = await invitedGuest(host, "rv7-staff-2@nowhere.my");
    const desk = await staff(kondo, "desk");
    const deskAnswer = await staffPost(desk.cookie, { venueId: kondo, action: "withdrawInvitation", id: invited.id, reason: "Desk try" });
    expect(deskAnswer.status).toBe(403);

    const otherManager = await staff(other, "manager");
    expect((await staffPost(otherManager.cookie, { venueId: kondo, action: "withdrawInvitation", id: invited.id, reason: "Not ours" })).status).toBe(403);
    const crossed = await staffPost(otherManager.cookie, { venueId: other, action: "withdrawInvitation", id: invited.id, reason: "Not ours" });
    expect(crossed.status).toBe(404);
    expect(await crossed.json()).toMatchObject({ code: "INVITATION_NOT_FOUND" });
    expect((await invitationRow(invited.id)).revoked_at).toBeNull();
  });

  it("refuses an accepted one, pointing to the list, changing nothing", async () => {
    const manager = await staff(kondo, "manager");
    const guest = await person();
    const invited = await invitedGuest(host, guest.email);
    expect((await acceptGuestInvitation(guest, invited.token)).ok).toBe(true);
    const res = await staffPost(manager.cookie, { venueId: kondo, action: "withdrawInvitation", id: invited.id, reason: "Too late" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "INVITATION_ACCEPTED_GUEST" });
    expect(await invitationRow(invited.id)).toMatchObject({ revoked_at: null, revoked_by_admin: null, revoke_reason: null });
  });
});

describe("a guest's withdrawal racing its acceptance", () => {
  it("is one or the other, never both", async () => {
    const racer = await resident(kondo, "A-9-9");
    let accepted = 0;
    let withdrawn = 0;
    for (let i = 0; i < 6; i++) {
      const guest = await person();
      const invited = await invitedGuest(racer, guest.email);
      const [a, w] = await Promise.all([acceptGuestInvitation(guest, invited.token), withdrawGuestInvitation(racer.id, invited.id)]);
      expect(a.ok !== (w.ok && w.changed)).toBe(true);
      const row = await invitationRow(invited.id);
      const entry = (await getDb().prepare("SELECT user_id FROM venue_access_list WHERE id = ?").get(invited.id)) as { user_id: number | null };
      if (a.ok) {
        accepted++;
        expect(w).toMatchObject({ ok: false, code: "INVITATION_ACCEPTED_GUEST" });
        expect(row.revoked_at).toBeNull();
        expect(entry.user_id).toBe(guest.id);
      } else {
        withdrawn++;
        expect(a).toMatchObject({ code: "GUEST_INVITATION_INVALID" });
        expect(row.used_at).toBeNull();
        expect(entry.user_id).toBeNull();
      }
    }
    expect(accepted + withdrawn).toBe(6);
  });
});

// ----------------------------------------------------------------- games and groups

let courtId: number;
let sport: Sport;
let slot = 0;

async function hostGame(over: Partial<Parameters<typeof openGame>[1]> = {}, by?: Person) {
  const owner = by ?? (await person({ adult: true }));
  slot++;
  const made = await createBooking({
    courtId,
    date: addDays(todayISO(), 2 + (slot % 10)),
    hours: [8 + Math.floor(slot / 10)],
    name: owner.name,
    phone: owner.phone,
    userId: owner.id,
  });
  if (!made.ok) throw new Error("booking");
  const opened = await openGame(owner.id, { bookingCode: made.booking.code, spots: 10, level: null, share: 0, autoAccept: true, ...over });
  if (!opened.ok) throw new Error(opened.error);
  return { host: owner, game: opened.game };
}
const gamePost = (who: Person, gameId: number, body: unknown) => gameRoute.POST(req(`http://localhost/api/games/${gameId}`, "POST", who.cookie, body), params(gameId));
const groupPost = (who: Person, groupId: number, body: unknown) => groupRoute.POST(req(`http://localhost/api/groups/${groupId}`, "POST", who.cookie, body), params(groupId));
const acceptPlayer = (who: Person, token: string) => playerAcceptRoute.POST(req("http://localhost/api/player-invitations", "POST", who.cookie, { token }));
const lastInvitation = async (column: "game_id" | "group_id", id: number) =>
  (await getDb().prepare(`SELECT id, used_at, cancelled_at, revoked_at, revoked_by FROM player_invitations WHERE ${column} = ? ORDER BY id DESC LIMIT 1`).get(id)) as {
    id: number;
    used_at: string | null;
    cancelled_at: string | null;
    revoked_at: string | null;
    revoked_by: number | null;
  };

beforeAll(async () => {
  const made = await createVenue({ name: "Arena Rv7", area: "Petaling Jaya", address: "2 Jalan Ujian", phone: "0300000001", openHour: 7, closeHour: 23 });
  if (!made.ok) throw new Error("venue");
  const court = await createCourt({ venueId: made.venue.id, name: "Court 1", sport: "badminton", offPeakRate: 0, peakRate: 0 });
  if (!court.ok) throw new Error(court.error);
  courtId = court.court.id;
  sport = "badminton";
});

describe("a host withdrawing an emailed invitation to a game", () => {
  it("withdraws it under the game's lock: the count of invitations out drops, the host sees it withdrawn, the link is refused, twice is the same", async () => {
    const { host: h, game } = await hostGame();
    const friend = await person({ adult: true, invitable: true });
    await inviteByEmail(h.id, game.id, friend.email);
    const token = await tokenIn(friend.email, "player-invitation");
    const { id } = await lastInvitation("game_id", game.id);
    expect(await openEmailInvitationCount(game.id)).toBe(1);

    const first = await gamePost(h, game.id, { action: "withdrawInvitation", invitationId: id });
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body).toMatchObject({ withdrawn: true, game: { id: game.id, emailInvites: [{ id, withdrawn: true }] } });
    expect(await openEmailInvitationCount(game.id)).toBe(0);
    expect(await lastInvitation("game_id", game.id)).toMatchObject({ id, revoked_by: h.id, used_at: null });
    // Not sent yet: never sent, the link not kept.
    const mails = await mailsTo(friend.email);
    expect(mails).toHaveLength(1);
    expect(mails[0].status).toBe("abandoned");
    expect(mails[0].body).not.toContain(token);

    const second = await gamePost(h, game.id, { action: "withdrawInvitation", invitationId: id });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(body);

    const refused = await acceptPlayer(friend, token);
    const madeUp = await acceptPlayer(friend, "q".repeat(32));
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual(await madeUp.json());
    expect((await gamePlayers(game.id)).some((p) => p.userId === friend.id)).toBe(false);

    // Invited again: a new link that works; the withdrawn one is still shown as such beside it.
    await inviteByEmail(h.id, game.id, friend.email);
    expect((await gameForViewer(game.id, h.id))!.emailInvites).toEqual([
      { id, expiresAt: expect.any(String), withdrawn: true },
      { id: (await lastInvitation("game_id", game.id)).id, expiresAt: expect.any(String) },
    ]);
    expect((await acceptPlayer(friend, await tokenIn(friend.email, "player-invitation"))).status).toBe(200);
  });

  it("lets the player who sent it withdraw it; anybody else, or another game's host, hears it is not found", async () => {
    const { host: h, game } = await hostGame({ autoAccept: false });
    const inside = await person({ adult: true });
    await askToJoin(inside, game.id);
    await decide(h.id, (await gamePlayers(game.id)).find((p) => p.userId === inside.id)!.id, "accept");
    await inviteByEmail(inside.id, game.id, "rv7-from-player@nowhere.my");
    const { id } = await lastInvitation("game_id", game.id);

    const stranger = await person({ adult: true });
    const { host: otherHost, game: otherGame } = await hostGame();
    const refusals = [
      await withdrawEmailInvitation(stranger.id, game.id, id),
      await withdrawEmailInvitation(otherHost.id, otherGame.id, id),
      await withdrawEmailInvitation(otherHost.id, game.id, id),
      await withdrawEmailInvitation(h.id, game.id, 99_999_999),
      await withdrawEmailInvitation(h.id, game.id, "1"),
    ];
    for (const r of refusals) expect(r).toEqual(refusals[3]);
    expect(refusals[0]).toMatchObject({ ok: false, status: 404, code: "INVITATION_NOT_FOUND" });
    expect((await lastInvitation("game_id", game.id)).revoked_at).toBeNull();

    expect(await withdrawEmailInvitation(inside.id, game.id, id)).toEqual({ ok: true, changed: true });
    expect(await lastInvitation("game_id", game.id)).toMatchObject({ revoked_by: inside.id });
  });

  it("refuses an accepted one, pointing to removing the player, and one run out or replaced, changing nothing", async () => {
    const { host: h, game } = await hostGame();
    const friend = await person({ adult: true, invitable: true });
    await inviteByEmail(h.id, game.id, friend.email);
    const replacedId = (await lastInvitation("game_id", game.id)).id;
    await inviteByEmail(h.id, game.id, friend.email);
    const { id } = await lastInvitation("game_id", game.id);
    expect((await acceptPlayer(friend, await tokenIn(friend.email, "player-invitation"))).status).toBe(200);

    const accepted = await gamePost(h, game.id, { action: "withdrawInvitation", invitationId: id });
    expect(accepted.status).toBe(409);
    expect(await accepted.json()).toMatchObject({ code: "INVITATION_ACCEPTED_GAME" });
    expect((await gamePlayers(game.id)).find((p) => p.userId === friend.id)).toMatchObject({ status: "accepted" });
    expect(await withdrawEmailInvitation(h.id, game.id, replacedId)).toMatchObject({ ok: false, status: 409, code: "INVITATION_NOT_PENDING" });

    await inviteByEmail(h.id, game.id, "rv7-lapse@nowhere.my");
    const lapse = await lastInvitation("game_id", game.id);
    await getDb().prepare("UPDATE player_invitations SET expires_at = datetime('now', '-1 minutes') WHERE id = ?").run(lapse.id);
    expect(await withdrawEmailInvitation(h.id, game.id, lapse.id)).toMatchObject({ ok: false, status: 409, code: "INVITATION_NOT_PENDING" });
    expect((await lastInvitation("game_id", game.id)).revoked_at).toBeNull();
  });

  it("answers and works the same whether or not an account holds the address, and tells the address once the email had gone", async () => {
    const { host: h, game } = await hostGame();
    const holder = await person({ adult: true });
    const nobody = "rv7-nobody-game@nowhere.my";
    const answers: string[] = [];
    const statements: number[] = [];
    const notices: Awaited<ReturnType<typeof mailsTo>> = [];
    for (const email of [holder.email, nobody]) {
      setTransport(sendsEverything);
      await inviteByEmail(h.id, game.id, email);
      const { id } = await lastInvitation("game_id", game.id);
      await untilSent(email);
      setTransport(null); // The notice stays queued, its words readable.
      const before = transactionStats().queries;
      const res = await gamePost(h, game.id, { action: "withdrawInvitation", invitationId: id });
      statements.push(transactionStats().queries - before);
      const body = await res.json();
      answers.push(JSON.stringify({ status: res.status, withdrawn: body.withdrawn, keys: Object.keys(body.game).sort() }));
      notices.push((await mailsTo(email))[1]);
    }
    expect(answers[1]).toBe(answers[0]);
    expect(statements[1]).toBe(statements[0]);
    for (const notice of notices) {
      expect(notice).toMatchObject({ kind: "account_email", venue_id: null, locale: "en" });
      expect(notice.subject).toContain("Arena Rv7");
      expect(notice.body).not.toContain(h.name.split(" ")[0]);
      expect(notice.body).not.toContain("token=");
    }
    expect(notices[0].body).toBe(notices[1].body);
  });
});

describe("an organiser withdrawing an emailed invitation to a group", () => {
  it("withdraws it; only the organiser may; an accepted one is refused with a pointer; the count of members stays right", async () => {
    const organiser = await person({ adult: true });
    const made = await createGroup(organiser.id, { name: "Rv7 Doubles", sport });
    if (!made.ok) throw new Error(made.error);
    const groupId = made.group.id;
    const friend = await person({ adult: true, invitable: true });
    await inviteToGroup(organiser.id, groupId, "rv7-group-nobody@nowhere.my");
    const pending = await lastInvitation("group_id", groupId);
    await inviteToGroup(organiser.id, groupId, friend.email);
    const toAccept = await lastInvitation("group_id", groupId);

    const member = await person({ adult: true });
    const outsiders = [await withdrawGroupInvitation(member.id, groupId, pending.id), await withdrawGroupInvitation(organiser.id, groupId + 1000, pending.id)];
    for (const r of outsiders) expect(r).toMatchObject({ ok: false, status: 404, code: "INVITATION_NOT_FOUND" });

    const res = await groupPost(organiser, groupId, { action: "withdrawInvitation", invitationId: pending.id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.withdrawn).toBe(true);
    expect(body.group.emailInvites).toEqual([
      { id: pending.id, expiresAt: expect.any(String), withdrawn: true },
      { id: toAccept.id, expiresAt: expect.any(String) },
    ]);
    expect(body.group.members).toBe(1);
    const again = await groupPost(organiser, groupId, { action: "withdrawInvitation", invitationId: pending.id });
    expect(await again.json()).toEqual(body);

    expect((await acceptPlayer(friend, await tokenIn(friend.email, "player-invitation"))).status).toBe(200);
    const accepted = await groupPost(organiser, groupId, { action: "withdrawInvitation", invitationId: toAccept.id });
    expect(accepted.status).toBe(409);
    expect(await accepted.json()).toMatchObject({ code: "INVITATION_ACCEPTED_GROUP" });
    expect((await groupView(groupId, organiser.id))!.members).toBe(2);
  });
});

describe("a game's or a group's withdrawal racing its acceptance", () => {
  // Accepting reads more before it takes the lock than withdrawing does: the withdrawal starts a little later each time,
  // so that each side gets there first in some of the runs.
  const after = <R,>(ms: number, run: () => Promise<R>) => new Promise<void>((resolve) => setTimeout(resolve, ms)).then(run);

  it("is one or the other for a game, under its row lock, and the game's numbers stay right", async () => {
    const { host: h, game } = await hostGame({ spots: 10 });
    let joined = 0;
    for (let i = 0; i < 8; i++) {
      const friend = await person({ adult: true, invitable: true });
      await inviteByEmail(h.id, game.id, friend.email);
      const token = await tokenIn(friend.email, "player-invitation");
      const { id } = await lastInvitation("game_id", game.id);
      const [a, w] = await Promise.all([acceptPlayerInvitation(friend, token), after(i * 4, () => withdrawEmailInvitation(h.id, game.id, id))]);
      expect(a.ok !== (w.ok && w.changed)).toBe(true);
      const row = await lastInvitation("game_id", game.id);
      if (a.ok) {
        joined++;
        expect(w).toMatchObject({ ok: false, code: "INVITATION_ACCEPTED_GAME" });
        expect(row.revoked_at).toBeNull();
      } else {
        expect(a).toMatchObject({ code: "PLAYER_INVITATION_INVALID" });
        expect(row.used_at).toBeNull();
      }
    }
    const view = (await gameForViewer(game.id, h.id))!;
    expect((view.players ?? []).filter((p) => p.status === "accepted")).toHaveLength(joined);
    expect(view.joined).toBe(joined);
    expect(await openEmailInvitationCount(game.id)).toBe(0);
  });

  it("is one or the other for a group, under its row lock", async () => {
    const organiser = await person({ adult: true });
    const made = await createGroup(organiser.id, { name: "Rv7 Race", sport, capacity: 20 });
    if (!made.ok) throw new Error(made.error);
    let joined = 0;
    for (let i = 0; i < 8; i++) {
      const friend = await person({ adult: true, invitable: true });
      await inviteToGroup(organiser.id, made.group.id, friend.email);
      const token = await tokenIn(friend.email, "player-invitation");
      const { id } = await lastInvitation("group_id", made.group.id);
      const [a, w] = await Promise.all([acceptPlayerInvitation(friend, token), after(i * 3, () => withdrawGroupInvitation(organiser.id, made.group.id, id))]);
      expect(a.ok !== (w.ok && w.changed)).toBe(true);
      if (a.ok) joined++;
      else expect(a).toMatchObject({ code: "PLAYER_INVITATION_INVALID" });
    }
    expect((await groupView(made.group.id, organiser.id))!.members).toBe(joined + 1);
  });
});
