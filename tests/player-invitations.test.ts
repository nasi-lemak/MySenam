import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { getDb, transactionStats } from "../src/lib/db";
import { askToJoin, decide, gameForViewer, gamePlayers, INVITES_PER_DAY, inviteByEmail, invitesToday, myGames, openGame, setPlayerLevel } from "../src/lib/games";
import { createGroup, decideMember, groupView, inviteToGroup, joinGroup } from "../src/lib/groups";
import { acceptPlayerInvitation } from "../src/lib/player-invitations";
import { blockPlayer } from "../src/lib/player-safety";
import { saveProfile } from "../src/lib/player-profiles";
import { resetRateLimits } from "../src/lib/rate-limit";
import { createBooking, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import type { Sport } from "../src/lib/types";
import * as gameRoute from "../src/app/api/games/[id]/route";
import * as groupRoute from "../src/app/api/groups/[id]/route";
import * as acceptRoute from "../src/app/api/player-invitations/route";

/**
 * Inviting a player to an open game or a group by email says nothing about
 * the address: not whether an account holds it, whose it is or whether they
 * may be invited (the owner's decision of 27 October 2026;
 * docs/architecture/security.md#no-account-enumeration). The address is
 * emailed a single-use link; the host sees "invited (email)" until the
 * account signed in with that address accepts it, and the rules on who may be
 * invited (ADR 0016) are applied then.
 */

type Person = User & { cookie: string };
let n = 0;
let courtId: number;
let sport: Sport;
let slot = 0;

async function person(profile?: Record<string, unknown>): Promise<Person> {
  n++;
  const made = await registerUser({ name: `Invitee${n} Person`, email: `gi7-${n}@players.my`, phone: `01370${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  if (profile) {
    const saved = await saveProfile(made.user.id, profile);
    if (!saved.ok) throw new Error(saved.error);
  }
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function hostGame(over: Partial<Parameters<typeof openGame>[1]> = {}, by?: Person) {
  const host = by ?? (await person({ adult: true }));
  slot++;
  const made = await createBooking({
    courtId,
    date: addDays(todayISO(), 2 + (slot % 10)),
    hours: [8 + Math.floor(slot / 10)],
    name: host.name,
    phone: host.phone,
    userId: host.id,
  });
  if (!made.ok) throw new Error("booking");
  const opened = await openGame(host.id, { bookingCode: made.booking.code, spots: 3, level: null, share: 0, autoAccept: false, ...over });
  if (!opened.ok) throw new Error(opened.error);
  return { host, game: opened.game };
}

function req(url: string, method: string, cookie: string | null, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const inviteToGameRoute = (who: Person, gameId: number, email: string) =>
  gameRoute.POST(req(`http://localhost/api/games/${gameId}`, "POST", who.cookie, { action: "invite", email }), params(gameId));
const inviteToGroupRoute = (who: Person, groupId: number, email: string) =>
  groupRoute.POST(req(`http://localhost/api/groups/${groupId}`, "POST", who.cookie, { action: "invite", email }), params(groupId));
const accept = (who: Person | null, token: unknown) => acceptRoute.POST(req("http://localhost/api/player-invitations", "POST", who?.cookie ?? null, { token }));

/** The emails queued to this address. */
async function mailsTo(email: string) {
  return (await getDb()
    .prepare("SELECT id, subject, body, kind, venue_id FROM messages WHERE channel = 'email' AND lower(recipient) = lower(?) ORDER BY id")
    .all(email)) as { id: number; subject: string; body: string; kind: string; venue_id: number | null }[];
}

/** The token in the last invitation emailed to this address. */
async function tokenFor(email: string): Promise<string> {
  const match = /player-invitation\?token=([A-Za-z0-9_-]+)/.exec((await mailsTo(email)).at(-1)?.body ?? "");
  if (!match) throw new Error(`no invitation emailed to ${email}`);
  return match[1];
}

const statusOf = async (gameId: number, userId: number) =>
  ((await getDb().prepare("SELECT status FROM open_game_players WHERE game_id = ? AND user_id = ?").get(gameId, userId)) as { status: string } | undefined)?.status;
const memberOf = async (groupId: number, userId: number) =>
  ((await getDb().prepare("SELECT status FROM group_members WHERE group_id = ? AND user_id = ?").get(groupId, userId)) as { status: string } | undefined)?.status;

beforeAll(async () => {
  const v = (await listVenues()).find((x) => x.courts.length > 0)!;
  courtId = v.courts[0].id;
  sport = ((await getDb().prepare("SELECT sport FROM courts WHERE id = ?").get(courtId)) as { sport: Sport }).sport;
});

beforeEach(() => resetRateLimits());

describe("inviting to a game by email", () => {
  it("answers the same, does the same work and queues the same email whether or not an account holds the address", async () => {
    const { host, game } = await hostGame({ spots: 10 });
    const willing = await person({ adult: true, invitable: true });
    const stranger = await person({ adult: true });
    const minor = await person({ adult: false });
    const nobody = "nobody-gi7@nowhere.my";

    const answers: { status: number; body: unknown; keys: string[] }[] = [];
    const statements: number[] = [];
    for (const email of [willing.email, stranger.email, minor.email, nobody]) {
      const before = transactionStats().queries;
      const res = await inviteToGameRoute(host, game.id, email);
      statements.push(transactionStats().queries - before);
      const body = (await res.json()) as { game: Record<string, unknown> };
      answers.push({ status: res.status, body, keys: Object.keys(body.game).sort() });
    }
    // The same status, keys and body for every address, but for the count of invitations already out, which nobody sees.
    for (const a of answers) {
      expect(a.status).toBe(200);
      expect(a.keys).toEqual(answers[0].keys);
      expect(a.body).toEqual(answers[0].body);
    }
    // The same statements run for an account that may be invited, one that may not, a minor, and no account.
    expect(new Set(statements).size).toBe(1);
    // Nobody is put in the game by an address; each address is sent the same email, belonging to no venue.
    for (const u of [willing, stranger, minor]) expect(await statusOf(game.id, u.id)).toBeUndefined();
    const mails = await Promise.all([willing.email, stranger.email, minor.email, nobody].map(mailsTo));
    for (const m of mails) {
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({ kind: "account_email", venue_id: null, subject: mails[0][0].subject });
      expect(m[0].body.replace(/token=[A-Za-z0-9_-]+/, "")).toBe(mails[0][0].body.replace(/token=[A-Za-z0-9_-]+/, ""));
      // Written from what the host gave and the game, never from whoever holds the address.
      for (const u of [willing, stranger, minor]) expect(m[0].body).not.toContain(u.name.split(" ")[0]);
    }
    // Only a hash of the link is kept.
    const token = await tokenFor(nobody);
    const kept = (await getDb().prepare("SELECT token_hash, email_hash FROM player_invitations WHERE game_id = ?").all(game.id)) as { token_hash: string; email_hash: string }[];
    expect(kept).toHaveLength(4);
    expect(JSON.stringify(kept)).not.toContain(token);
    expect(JSON.stringify(kept)).not.toContain("nowhere.my");
  });

  it("shows the host 'invited (email)' and nobody's name until the invitation is accepted", async () => {
    const { host, game } = await hostGame();
    const willing = await person({ adult: true, invitable: true });
    await inviteByEmail(host.id, game.id, willing.email);
    await inviteByEmail(host.id, game.id, "nobody-host-view@nowhere.my");

    const view = (await gameForViewer(game.id, host.id))!;
    expect(view.players).toEqual([]);
    expect(view.emailInvites).toHaveLength(2);
    expect(Object.keys(view.emailInvites![0]).sort()).toEqual(["expiresAt", "id"]);
    const seen = JSON.stringify(view);
    expect(seen).not.toContain(willing.name.split(" ")[0]);
    expect(seen).not.toContain(`"userId":${willing.id}`);
    expect((await myGames(host.id)).hosting.find((g) => g.id === game.id)?.emailInvites).toHaveLength(2);
    // The route the host's page reads says no more.
    const res = await gameRoute.GET(req(`http://localhost/api/games/${game.id}`, "GET", host.cookie), params(game.id));
    expect(JSON.stringify(await res.json())).not.toContain(willing.name.split(" ")[0]);

    // Accepted, signed in with that address: now they are in the game, under their own name.
    const res2 = await accept(willing, await tokenFor(willing.email));
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ kind: "game", gameId: game.id, status: "accepted" });
    const after = (await gameForViewer(game.id, host.id))!;
    expect(after.players).toEqual([expect.objectContaining({ userId: willing.id, status: "accepted", invited: true })]);
    expect(after.emailInvites).toHaveLength(1);
  });

  it("counts every one sent against the daily limit, whoever holds the address, and an accepted one once", async () => {
    const { host, game } = await hostGame({ spots: 10 });
    const willing = await person({ adult: true, invitable: true });
    expect(await invitesToday(host.id)).toBe(0);
    await inviteByEmail(host.id, game.id, "nobody-count-1@nowhere.my");
    expect(await invitesToday(host.id)).toBe(1);
    await inviteByEmail(host.id, game.id, willing.email);
    expect(await invitesToday(host.id)).toBe(2);
    expect((await accept(willing, await tokenFor(willing.email))).status).toBe(200);
    expect(await invitesToday(host.id)).toBe(2);

    // At the limit, the next address is refused the same way, whoever holds it.
    await getDb()
      .prepare(
        `INSERT INTO player_invitations (game_id, invited_by, token_hash, email_hash, expires_at)
         SELECT ?, ?, 'filler-' || g, 'filler-' || g, datetime('now', '+1 day') FROM generate_series(1, ?) AS g`
      )
      .run(game.id, host.id, INVITES_PER_DAY - 2);
    const other = await person({ adult: true, invitable: true });
    const a = await inviteToGameRoute(host, game.id, other.email);
    const b = await inviteToGameRoute(host, game.id, "nobody-count-2@nowhere.my");
    expect(a.status).toBe(429);
    expect(b.status).toBe(429);
    expect(await a.json()).toEqual(await b.json());
    expect(await mailsTo(other.email)).toHaveLength(0);
  });

  it("refuses only what is about the inviter, the game or what was typed", async () => {
    const { host, game } = await hostGame();
    expect(await inviteByEmail(host.id, game.id, "not an address")).toMatchObject({ ok: false, status: 400, code: "INVITE_EMAIL_INVALID" });
    expect(await inviteByEmail(host.id, game.id, host.email.toUpperCase())).toMatchObject({ ok: false, status: 400, code: "INVITE_EMAIL_SELF" });
    const outsider = await person({ adult: true });
    expect(await inviteByEmail(outsider.id, game.id, "x-gi7@nowhere.my")).toMatchObject({ ok: false, status: 404 });
    // A private game: only its host invites.
    const { host: privateHost, game: secret } = await hostGame({ visibility: "private", autoAccept: true });
    const inside = await person({ adult: true, invitable: true });
    await inviteByEmail(privateHost.id, secret.id, inside.email);
    await accept(inside, await tokenFor(inside.email));
    expect(await inviteByEmail(inside.id, secret.id, "y-gi7@nowhere.my")).toMatchObject({ ok: false, status: 403 });
  });

  it("is spent once, works only for the account with that address, runs out, and is replaced by inviting again", async () => {
    const { host, game } = await hostGame({ spots: 4 });
    const willing = await person({ adult: true, invitable: true });
    const other = await person({ adult: true, invitable: true });

    await inviteByEmail(host.id, game.id, willing.email);
    const first = await tokenFor(willing.email);
    await inviteByEmail(host.id, game.id, willing.email.toUpperCase());
    const second = await tokenFor(willing.email);
    expect(second).not.toBe(first);

    const invalid = { error: expect.any(String), code: "PLAYER_INVITATION_INVALID" };
    // Replaced; another account's; made up: all the same answer.
    const replaced = await accept(willing, first);
    const notTheirs = await accept(other, second);
    const madeUp = await accept(willing, "x".repeat(32));
    for (const r of [replaced, notTheirs, madeUp]) expect(r.status).toBe(404);
    const bodies = await Promise.all([replaced, notTheirs, madeUp].map((r) => r.json()));
    for (const b of bodies) expect(b).toMatchObject(invalid);
    expect(bodies[1]).toEqual(bodies[2]);
    expect(await statusOf(game.id, other.id)).toBeUndefined();

    // The right account, once.
    expect((await accept(willing, second)).status).toBe(200);
    expect(await statusOf(game.id, willing.id)).toBe("accepted");
    expect((await accept(willing, second)).status).toBe(404);

    // Run out.
    const late = await person({ adult: true, invitable: true });
    await inviteByEmail(host.id, game.id, late.email);
    await getDb().prepare("UPDATE player_invitations SET expires_at = datetime('now', '-1 minutes') WHERE used_at IS NULL AND cancelled_at IS NULL AND game_id = ?").run(game.id);
    expect((await accept(late, await tokenFor(late.email))).status).toBe(404);
    expect(await gameForViewer(game.id, host.id)).toMatchObject({ emailInvites: [] });

    // Signed out: asked to sign in, and nothing is spent.
    const fresh = await person({ adult: true, invitable: true });
    await inviteByEmail(host.id, game.id, fresh.email);
    expect((await accept(null, await tokenFor(fresh.email))).status).toBe(401);
    expect((await accept(fresh, await tokenFor(fresh.email))).status).toBe(200);
  });

  it("leads to its own game only, and is not a way into a group", async () => {
    const { host, game } = await hostGame();
    const { game: otherGame } = await hostGame();
    const willing = await person({ adult: true, invitable: true });
    await inviteByEmail(host.id, game.id, willing.email);
    expect(await acceptPlayerInvitation(willing, await tokenFor(willing.email))).toMatchObject({ ok: true, kind: "game", gameId: game.id });
    expect(await statusOf(otherGame.id, willing.id)).toBeUndefined();
    expect(await getDb().prepare("SELECT 1 FROM group_members WHERE user_id = ?").get(willing.id)).toBeUndefined();
  });

  it("applies the rules on who may be invited when it is accepted, and refuses in the same words as no invitation", async () => {
    const { host, game } = await hostGame({ spots: 6 });
    const stranger = await person({ adult: true });
    const minor = await person({ adult: false });
    const unsaid = await person();
    const nope = await accept(stranger, "y".repeat(32));
    const nopeBody = await nope.json();
    for (const who of [stranger, minor, unsaid]) {
      await inviteByEmail(host.id, game.id, who.email);
      const res = await accept(who, await tokenFor(who.email));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(nopeBody);
      expect(await statusOf(game.id, who.id)).toBeUndefined();
    }

    // Somebody the host has come across here is a declared adult the host may invite.
    const known = await person({ adult: true });
    await askToJoin(known, game.id);
    await decide(host.id, (await gamePlayers(game.id)).find((p) => p.userId === known.id)!.id, "accept");
    const { game: next } = await hostGame({ spots: 4 }, host);
    await inviteByEmail(host.id, next.id, known.email);
    expect(await accept(known, await tokenFor(known.email)).then((r) => r.json())).toEqual({ kind: "game", gameId: next.id, status: "accepted" });

    // Blocked: refused the same way.
    expect(await blockPlayer(known.id, host.id)).toMatchObject({ ok: true });
    const { game: third } = await hostGame({}, host);
    await inviteByEmail(host.id, third.id, known.email);
    expect(await accept(known, await tokenFor(known.email)).then((r) => r.json())).toEqual(nopeBody);

    // A minor, only through a community group both are in.
    const group = await createGroup(host.id, { name: "Juniors gi7", sport });
    if (!group.ok) throw new Error(group.error);
    await joinGroup(minor.id, group.group.id);
    const row = (await getDb().prepare("SELECT id FROM group_members WHERE group_id = ? AND user_id = ?").get(group.group.id, minor.id)) as { id: number };
    await decideMember(host.id, row.id, "accept");
    await inviteByEmail(host.id, game.id, minor.email);
    expect(await accept(minor, await tokenFor(minor.email)).then((r) => r.json())).toEqual({ kind: "game", gameId: game.id, status: "accepted" });

    // An adults-only game: a declared adult only, refused the same way otherwise.
    const { game: adults } = await hostGame({ adultsOnly: true }, host);
    await inviteByEmail(host.id, adults.id, minor.email);
    expect(await accept(minor, await tokenFor(minor.email)).then((r) => r.json())).toEqual(nopeBody);
  });

  it("from a player in the game is still a request where the host decides", async () => {
    const { host, game } = await hostGame({ spots: 4, autoAccept: false });
    const inside = await person({ adult: true });
    await setPlayerLevel(inside.id, sport, "intermediate");
    await askToJoin(inside, game.id);
    await decide(host.id, (await gamePlayers(game.id))[0].id, "accept");
    const friend = await person({ adult: true, invitable: true });
    expect(await inviteByEmail(inside.id, game.id, friend.email)).toMatchObject({ ok: true });
    expect(await accept(friend, await tokenFor(friend.email)).then((r) => r.json())).toEqual({ kind: "game", gameId: game.id, status: "requested" });
  });

  it("is not spent when the game is full, and takes a place freed later", async () => {
    const { host, game } = await hostGame({ spots: 1, autoAccept: true });
    const willing = await person({ adult: true, invitable: true });
    await inviteByEmail(host.id, game.id, willing.email);
    const token = await tokenFor(willing.email);
    const first = await person({ adult: true });
    await askToJoin(first, game.id);
    const full = await accept(willing, token);
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ error: "That game is full." });
    const { leaveGame } = await import("../src/lib/games");
    await leaveGame(first.id, game.id);
    expect(await accept(willing, token).then((r) => r.json())).toEqual({ kind: "game", gameId: game.id, status: "accepted" });
  });

  it("lets only one of two invitees have the last place, under the game's lock", async () => {
    for (const waitlist of [false, true]) {
      const { host, game } = await hostGame({ spots: 1, autoAccept: false, waitlist });
      const people = await Promise.all([person({ adult: true, invitable: true }), person({ adult: true, invitable: true }), person({ adult: true, invitable: true })]);
      for (const p of people) await inviteByEmail(host.id, game.id, p.email);
      const tokens = await Promise.all(people.map((p) => tokenFor(p.email)));
      const results = await Promise.all(people.map((p, i) => acceptPlayerInvitation(p, tokens[i])));
      const statuses = await Promise.all(people.map((p) => statusOf(game.id, p.id)));
      expect(statuses.filter((s) => s === "accepted")).toHaveLength(1);
      expect(results.filter((r) => r.ok && r.kind === "game" && r.status === "accepted")).toHaveLength(1);
      if (waitlist) expect(statuses.filter((s) => s === "waitlisted")).toHaveLength(2);
      else {
        expect(results.filter((r) => !r.ok && r.error === "That game is full.")).toHaveLength(2);
        expect(statuses.filter((s) => s === undefined)).toHaveLength(2);
      }
      const counted = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM open_game_players WHERE game_id = ?").get(game.id)) as { n: number };
      expect(counted.n).toBe(waitlist ? 3 : 1);
    }
  });
});

describe("inviting to a group by email", () => {
  it("answers the same and queues the same email whatever the address, and shows the organiser no name", async () => {
    const organiser = await person({ adult: true });
    const made = await createGroup(organiser.id, { name: "Futsal gi7", sport, privacy: "private" });
    if (!made.ok) throw new Error(made.error);
    const id = made.group.id;
    const willing = await person({ adult: true, invitable: true });
    const stranger = await person({ adult: true });
    const minor = await person({ adult: false });

    const answers: { status: number; body: { group: Record<string, unknown> } }[] = [];
    const statements: number[] = [];
    for (const email of [willing.email, stranger.email, minor.email, "nobody-group@nowhere.my"]) {
      const before = transactionStats().queries;
      const res = await inviteToGroupRoute(organiser, id, email);
      statements.push(transactionStats().queries - before);
      answers.push({ status: res.status, body: (await res.json()) as { group: Record<string, unknown> } });
    }
    for (const a of answers) {
      expect(a.status).toBe(200);
      expect(Object.keys(a.body.group).sort()).toEqual(Object.keys(answers[0].body.group).sort());
      expect(a.body.group.roster).toEqual(answers[0].body.group.roster);
    }
    // One more "invited (email)" each time, and nothing else differs.
    expect(answers.map((a) => (a.body.group.emailInvites as unknown[]).length)).toEqual([1, 2, 3, 4]);
    expect(new Set(statements).size).toBe(1);
    for (const u of [willing, stranger, minor]) {
      expect(await memberOf(id, u.id)).toBeUndefined();
      expect(await mailsTo(u.email)).toHaveLength(1);
      expect(JSON.stringify(answers.at(-1)!.body)).not.toContain(u.name.split(" ")[0]);
    }
    expect((await mailsTo("nobody-group@nowhere.my"))[0]).toMatchObject({ kind: "account_email", venue_id: null });
    // A private group is not seen by those invited by email, until they accept.
    expect(await groupView(id, willing.id)).toBeNull();
  });

  it("makes a declared adult who opted in a member on accepting, and refuses anybody else in the same words as no invitation", async () => {
    const organiser = await person({ adult: true });
    const made = await createGroup(organiser.id, { name: "Wednesday gi7", sport, capacity: 3 });
    if (!made.ok) throw new Error(made.error);
    const id = made.group.id;
    const willing = await person({ adult: true, invitable: true });
    const stranger = await person({ adult: true });
    const minor = await person({ adult: false, invitable: false });
    const nopeBody = await (await accept(stranger, "z".repeat(32))).json();
    for (const who of [stranger, minor]) {
      await inviteToGroup(organiser.id, id, who.email);
      const res = await accept(who, await tokenFor(who.email));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(nopeBody);
      expect(await memberOf(id, who.id)).toBeUndefined();
    }
    expect(await invitesToday(organiser.id)).toBe(2);
    await inviteToGroup(organiser.id, id, willing.email);
    const token = await tokenFor(willing.email);
    expect(await accept(willing, token).then((r) => r.json())).toEqual({ kind: "group", groupId: id, name: "Wednesday gi7" });
    expect(await memberOf(id, willing.id)).toBe("member");
    expect((await accept(willing, token)).status).toBe(404);
    expect(await invitesToday(organiser.id)).toBe(3);
    // Now on the roster by first name, as members are.
    expect((await groupView(id, organiser.id))?.roster?.map((r) => r.userId)).toContain(willing.id);
    expect((await groupView(id, organiser.id))?.emailInvites).toHaveLength(2);
  });

  it("is not spent on a full group", async () => {
    const organiser = await person({ adult: true });
    const made = await createGroup(organiser.id, { name: "Pair gi7", sport, capacity: 2 });
    if (!made.ok) throw new Error(made.error);
    const id = made.group.id;
    const a = await person({ adult: true, invitable: true });
    const b = await person({ adult: true, invitable: true });
    await inviteToGroup(organiser.id, id, a.email);
    await inviteToGroup(organiser.id, id, b.email);
    expect((await accept(a, await tokenFor(a.email))).status).toBe(200);
    const full = await accept(b, await tokenFor(b.email));
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ error: "That group is full." });
    expect(await memberOf(id, b.id)).toBeUndefined();
    expect((await groupView(id, organiser.id))?.emailInvites).toHaveLength(1);
  });
});
