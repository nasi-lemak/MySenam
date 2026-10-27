import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { counterEntrant, guardianEntrant, isEntrantRefusal, type Entrant } from "../src/lib/competition-entrants";
import { createCompetition } from "../src/lib/competitions";
import { getDb } from "../src/lib/db";
import { setPlayerLevel } from "../src/lib/games";
import { addManaged } from "../src/lib/managed-people";
import { createAtVenue, eraseParticipant, participantHistory } from "../src/lib/participants";
import { setAccessSettings } from "../src/lib/access";
import { createCourt, createVenue, listVenues, sellMembership } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { setPlayerGender } from "../src/lib/who";
import {
  confirmResult,
  createLeague,
  decideResult,
  disputeResult,
  join,
  joinAs,
  leagueDetail,
  leagueHousekeeping,
  leave,
  managedLeague,
  myLeague,
  reportResult,
  startSeason,
  type LeagueInput,
} from "../src/lib/leagues";
import { createTournament, enter, enterAs, managedEntries, myEntry, tournamentDetail, type TournamentInput } from "../src/lib/tournaments";
import * as tournamentRoute from "../src/app/api/tournaments/[id]/route";
import * as counterTournamentRoute from "../src/app/api/admin/tournaments/[id]/entries/route";
import * as counterLeagueRoute from "../src/app/api/admin/leagues/[id]/players/route";
import * as playerMatchRoute from "../src/app/api/leagues/[id]/matches/[matchId]/route";
import * as staffMatchRoute from "../src/app/api/admin/leagues/[id]/matches/[matchId]/route";

/**
 * Box leagues and tournaments: a league result changed only as it was seen,
 * staff decisions told to both sides, a gendered league's pairs, members-only
 * by the entrant's own membership, and entries made at the counter and by a
 * guardian for somebody they act for (lib/competition-entrants.ts).
 */

let ownerId: number;
let venueId: number;
let courts: number[];
let n = 0;
let dayOffset = 3;
const today = todayISO();

async function adult(name = "Player", opts: { gender?: "woman" | "man" } = {}): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} ${n}`, email: `ce${n}@entrants.test`, phone: `01370${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  if (opts.gender) await setPlayerGender(made.user.id, opts.gender);
  return made.user;
}

async function child(parent: User, displayName: string, birthYear?: number): Promise<number> {
  const made = await addManaged(parent.id, { displayName, relationship: "parent", authority: true, ...(birthYear ? { birthYear } : {}) }, parent.name);
  if (!made.ok) throw new Error(made.error);
  return made.person.id;
}

async function tournament(over: Partial<TournamentInput> = {}) {
  const day = addDays(today, dayOffset++);
  const made = await createTournament(
    { venueId, name: `Entrants Cup ${dayOffset}`, sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 10, maxEntries: 16, startsOn: day, endsOn: day, startHour: 9, endHour: 21, courtIds: courts, ...over },
    ownerId
  );
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

async function league(over: Partial<LeagueInput> = {}) {
  const made = await createLeague({ venueId, name: `Entrants Ladder ${++n}`, sport: "badminton", teamSize: 1, level: null, fee: 0, startsOn: addDays(today, 1), ...over }, ownerId);
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

/** A league of three under way: its first match, between a and b. */
async function running() {
  const l = await league();
  const [a, b, c] = [await adult(), await adult(), await adult()];
  const ids: number[] = [];
  for (const u of [a, b, c]) {
    const j = await join(u, l.id);
    if (!j.ok) throw new Error(j.error);
    ids.push(j.value.id);
  }
  const s = await startSeason(l.id, { startsOn: today }, today);
  if (!s.ok) throw new Error(s.error);
  const m = s.value.matches.find((x) => x.a === ids[0] && x.b === ids[1])!;
  return { l, a, b, c, pa: ids[0], pb: ids[1], m };
}

const matchNow = async (leagueId: number, matchId: number) => (await leagueDetail(leagueId, { forStaff: true }))!.matches.find((x) => x.id === matchId)!;

const mail = async (to: string) =>
  (await getDb().prepare("SELECT subject, body, locale FROM messages WHERE kind = 'programme' AND recipient = ? ORDER BY id").all(to)) as { subject: string; body: string; locale: string }[];

const staffCookie = async (adminId: number) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(adminId)).token}`;
const playerCookie = async (userId: number) => `${SESSION_COOKIE}=${(await createSession(userId)).token}`;

function post(url: string, body: unknown, cookie: string) {
  return new NextRequest(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courts = venue.courts.filter((c) => c.sport === "badminton").slice(0, 2).map((c) => c.id);
});

describe("a league result changes only as it was seen", () => {
  it("refuses a confirmation of a result corrected since, and takes one of the result as it is now", async () => {
    const { l, a, b, pa, m } = await running();
    const first = await reportResult(a.id, m.id, { winner: pa, score: "21-10, 21-12" });
    if (!first.ok) throw new Error(first.error);
    const seen = first.value.version;
    // a puts it right before b answers; b answers what they saw.
    const second = await reportResult(a.id, m.id, { winner: pa, score: "21-10, 21-15" });
    expect(second).toMatchObject({ ok: true, value: { score: "21-10, 21-15" } });
    if (!second.ok) return;
    expect(second.value.version).toBeGreaterThan(seen);
    expect(await confirmResult(b.id, m.id, { version: seen })).toMatchObject({ ok: false, code: "LG5_RESULT_CHANGED" });
    expect(await disputeResult(b.id, m.id, "It was not like that", { version: seen })).toMatchObject({ ok: false, code: "LG5_RESULT_CHANGED" });
    expect((await matchNow(l.id, m.id)).status).toBe("reported");
    expect(await confirmResult(b.id, m.id, { version: second.value.version })).toMatchObject({ ok: true, value: { status: "confirmed", score: "21-10, 21-15" } });
  });

  it("never turns a confirmed, decided or disputed result back to reported", async () => {
    const { l, a, b, pa, pb, m } = await running();
    await reportResult(a.id, m.id, { winner: pa, score: "21-10, 21-12" });
    expect(await confirmResult(b.id, m.id)).toMatchObject({ ok: true });
    expect(await reportResult(a.id, m.id, { winner: pa, score: "21-0, 21-0" })).toMatchObject({ ok: false, error: "This result is settled. Ask the venue if it is wrong." });
    expect(await decideResult(m.id, ownerId, { winner: pb, score: "10-21, 10-21" })).toMatchObject({ ok: true, value: { status: "confirmed", winner: pb } });
    expect(await reportResult(a.id, m.id, { winner: pa, score: "21-0, 21-0" })).toMatchObject({ ok: false });
    expect(await matchNow(l.id, m.id)).toMatchObject({ status: "confirmed", winner: pb, score: "10-21, 10-21" });
  });

  it("lets staff decide only on the result they were shown, and on what is there when they name none", async () => {
    const { l, a, pa, pb, m } = await running();
    const shown = (await matchNow(l.id, m.id)).version;
    await reportResult(a.id, m.id, { winner: pa, score: "21-10, 21-12" });
    expect(await decideResult(m.id, ownerId, { void: true }, { version: shown })).toMatchObject({ ok: false, code: "LG5_RESULT_CHANGED" });
    expect((await matchNow(l.id, m.id)).status).toBe("reported");
    const now = (await matchNow(l.id, m.id)).version;
    expect(await decideResult(m.id, ownerId, { winner: pb, walkover: true }, { version: now })).toMatchObject({ ok: true, value: { status: "walkover", winner: pb } });
    expect(await decideResult(m.id, ownerId, { clear: true })).toMatchObject({ ok: true, value: { status: "unplayed" } });
  });

  it("moves the version on every change, whatever made it: a walkover on leaving, a report standing unanswered", async () => {
    const { l, a, b, c, pa, m } = await running();
    await reportResult(a.id, m.id, { winner: pa, score: "21-10, 21-12" });
    const reported = (await matchNow(l.id, m.id)).version;
    await getDb().prepare("UPDATE league_matches SET reported_at = datetime('now', '-4 days') WHERE id = ?").run(m.id);
    await leagueHousekeeping(today);
    const stood = await matchNow(l.id, m.id);
    expect(stood.status).toBe("confirmed");
    expect(stood.version).toBeGreaterThan(reported);
    // b's answer to the report it saw comes too late.
    expect(await confirmResult(b.id, m.id, { version: reported })).toMatchObject({ ok: false, code: "LG5_RESULT_CHANGED" });
    const cMatch = (await leagueDetail(l.id))!.matches.find((x) => (x.a === pa || x.b === pa) && x.id !== m.id)!;
    const before = cMatch.version;
    await leave(pa);
    expect(await matchNow(l.id, cMatch.id)).toMatchObject({ status: "walkover" });
    expect((await matchNow(l.id, cMatch.id)).version).toBeGreaterThan(before);
    void c;
  });

  it("needs the version a player answers, through the route", async () => {
    const { l, a, b, pa, m } = await running();
    const r = await reportResult(a.id, m.id, { winner: pa, score: "21-10, 21-12" });
    if (!r.ok) throw new Error(r.error);
    const cookie = await playerCookie(b.id);
    const ctx = { params: Promise.resolve({ id: String(l.id), matchId: String(m.id) }) };
    expect((await playerMatchRoute.POST(post(`/api/leagues/${l.id}/matches/${m.id}`, { action: "confirm" }, cookie), ctx)).status).toBe(400);
    const stale = await playerMatchRoute.POST(post(`/api/leagues/${l.id}/matches/${m.id}`, { action: "confirm", version: r.value.version - 1 }, cookie), ctx);
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("LG5_RESULT_CHANGED");
    expect((await playerMatchRoute.POST(post(`/api/leagues/${l.id}/matches/${m.id}`, { action: "confirm", version: r.value.version }, cookie), ctx)).status).toBe(200);
  });
});

describe("staff decisions are told to both sides", () => {
  it("emails both players what the venue decided, each in their own language, and logs it", async () => {
    const { l, a, b, pa, pb, m } = await running();
    await getDb().prepare("UPDATE users SET locale = 'ms' WHERE id = ?").run(b.id);
    await reportResult(a.id, m.id, { winner: pa, score: "21-19, 21-19" });
    await disputeResult(b.id, m.id, "I won the second", { version: (await matchNow(l.id, m.id)).version });
    const res = await staffMatchRoute.POST(post("", { winner: pb, score: "19-21, 21-19, 15-21", version: (await matchNow(l.id, m.id)).version }, await staffCookie(ownerId)), {
      params: Promise.resolve({ id: String(l.id), matchId: String(m.id) }),
    });
    expect(res.status).toBe(200);
    const toA = (await mail(a.email)).at(-1)!;
    expect(toA.subject).toContain("the venue has decided a result");
    expect(toA.body).toContain("19-21, 21-19, 15-21");
    const toB = (await mail(b.email)).at(-1)!;
    expect(toB.locale).toBe("ms");
    expect(toB.body).toContain("Kakitangan pusat memutuskan");
    const logged = (await getDb().prepare("SELECT action FROM staff_actions WHERE action = 'league.result_decided' ORDER BY id DESC LIMIT 1").get()) as { action: string } | undefined;
    expect(logged?.action).toBe("league.result_decided");
  });

  it("tells them of a walkover, a match struck out, and one put back to be played", async () => {
    const { a, b, pa, m } = await running();
    for (const [input, says] of [
      [{ winner: pa, walkover: true }, "as a walkover"],
      [{ void: true }, "it does not count"],
      [{ clear: true }, "back to be played"],
    ] as const) {
      expect(await decideResult(m.id, ownerId, input)).toMatchObject({ ok: true });
      expect((await mail(a.email)).at(-1)!.body).toContain(says);
      expect((await mail(b.email)).at(-1)!.body).toContain(says);
    }
  });
});

describe("a women's or men's league of pairs", () => {
  it("asks the partner's declared gender and checks it, as a tournament does", async () => {
    const l = await league({ who: "women", teamSize: 2 });
    const her = await adult("Aisyah", { gender: "woman" });
    expect(await join(her, l.id, { partnerName: "Mei" })).toMatchObject({ ok: false, code: "PARTNER_GENDER" });
    expect(await join(her, l.id, { partnerName: "Ahmad", partnerGender: "man" })).toMatchObject({ ok: false, code: "WHO_WOMEN" });
    const joined = await join(her, l.id, { partnerName: "Mei", partnerGender: "woman" });
    expect(joined).toMatchObject({ ok: true });
    if (!joined.ok) return;
    expect(await getDb().prepare("SELECT partner_gender FROM league_players WHERE id = ?").get(joined.value.id)).toEqual({ partner_gender: "woman" });
    // Singles: the player alone, as before.
    const singles = await league({ who: "women" });
    expect(await join(await adult("Ali", { gender: "man" }), singles.id)).toMatchObject({ ok: false, code: "WHO_WOMEN" });
  });
});

describe("members only: the entrant's own membership, or a family one naming them", () => {
  let hall: number;
  let hallCourt: number;
  beforeAll(async () => {
    const v = await createVenue({ name: "Members Hall", area: "Klang", address: "1 Jalan Ahli", phone: "0331117777" });
    if (!v.ok) throw new Error("venue");
    hall = v.venue.id;
    await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(hall);
    const c = await createCourt({ venueId: hall, name: "Hall 1", sport: "badminton", offPeakRate: 10, peakRate: 10 });
    if (!c.ok) throw new Error(c.error);
    hallCourt = c.court.id;
  });
  const membership = async (holder: User, extra: { holderParticipantId?: number; covers?: number[] } = {}) => {
    const made = await sellMembership({ venueId: hall, holderName: holder.name, holderPhone: holder.phone, startsOn: today, expiresOn: addDays(today, 60), price: 0, adminId: ownerId, ...extra });
    if (!made.ok) throw new Error(made.error);
  };

  it("in a members-only tournament: a guardian's membership does not cover a child it does not name", async () => {
    const day = addDays(today, 20);
    const made = await createTournament(
      { venueId: hall, name: "Members Cup", sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 0, maxEntries: 16, startsOn: day, endsOn: day, startHour: 9, endHour: 12, courtIds: [hallCourt], membersOnly: true },
      ownerId
    );
    if (!made.ok) throw new Error(made.error);
    const t = made.value;
    const mum = await adult("Mum");
    await membership(mum);
    const kid = await child(mum, "Aina");
    const asMum = (await guardianEntrant(mum, kid)) as Entrant;
    expect(await enterAs(asMum, t.id)).toMatchObject({ ok: false, code: "LG5_MEMBERS_ENTRANT", vars: { name: "Aina" } });
    // Mum, herself, is a member.
    expect(await enter(mum, t.id)).toMatchObject({ ok: true });
    // A child of her own membership's family, or with one of their own.
    const dad = await adult("Dad");
    const named = await child(dad, "Badrul");
    await membership(dad, { covers: [named] });
    expect(await enterAs((await guardianEntrant(dad, named)) as Entrant, t.id)).toMatchObject({ ok: true });
    const own = await child(dad, "Chen");
    await membership(dad, { holderParticipantId: own });
    expect(await enterAs((await guardianEntrant(dad, own)) as Entrant, t.id)).toMatchObject({ ok: true });
    // Nobody's member at all.
    expect(await enter(await adult("Stranger"), t.id)).toMatchObject({ ok: false, code: "ENTRY_MEMBERS_ONLY" });
  });

  it("at a members-only venue's league: the child's own membership, whoever acts for them", async () => {
    await setAccessSettings(hall, { access: "members" });
    try {
      const made = await createLeague({ venueId: hall, name: "Members Ladder", sport: "badminton", teamSize: 1, level: null, fee: 0, startsOn: addDays(today, 1) }, ownerId);
      if (!made.ok) throw new Error(made.error);
      const parent = await adult("Parent");
      const member = await child(parent, "Dina");
      await membership(parent, { holderParticipantId: member });
      const notMember = await child(parent, "Eli");
      expect(await joinAs((await guardianEntrant(parent, member)) as Entrant, made.value.id)).toMatchObject({ ok: true });
      expect(await joinAs((await guardianEntrant(parent, notMember)) as Entrant, made.value.id)).toMatchObject({ ok: false, code: "LG5_MEMBERS_VENUE" });
      // The parent, not a member, cannot join for themself (the venue's rule, as before).
      expect(await join(parent, made.value.id)).toMatchObject({ ok: false, code: "MEMBERS_ONLY" });
    } finally {
      await setAccessSettings(hall, { access: "public" });
    }
  });
});

describe("a guardian enters somebody they act for", () => {
  it("enters the participant, by the same rules: their declared age, and the guardian's agreement for a minor", async () => {
    const t = await tournament({ ageMin: 8, ageMax: 15 });
    const mum = await adult("Siti");
    const kid = await child(mum, "Aina", 2015);
    const entrant = await guardianEntrant(mum, kid);
    if (isEntrantRefusal(entrant)) throw new Error(entrant.error);
    expect(await enterAs(entrant, t.id)).toMatchObject({ ok: false, code: "AGE_RANGE" });
    const born = `${Number(t.startsOn.slice(0, 4)) - 11}-01-01`;
    expect(await enterAs(entrant, t.id, { birthDate: born })).toMatchObject({ ok: false, code: "GUARDIAN_CONSENT" });
    const made = await enterAs(entrant, t.id, { birthDate: born, guardianConsent: true });
    expect(made).toMatchObject({ ok: true, value: { name: "Aina", participantId: kid, guardian: { name: mum.name } } });
    expect(await enterAs(entrant, t.id, { birthDate: born, guardianConsent: true })).toMatchObject({ ok: false, code: "LG5_ENTERED_ALREADY" });
    const row = (await getDb().prepare("SELECT user_id, participant_id FROM tournament_entries WHERE tournament_id = ? AND participant_id = ?").get(t.id, kid)) as { user_id: number; participant_id: number };
    expect(row).toEqual({ user_id: mum.id, participant_id: kid });
    // Hers to see, pay and withdraw; not her own entry.
    expect(await myEntry(mum.id, t.id)).toBeNull();
    expect((await managedEntries(mum.id, t.id)).map((e) => e.name)).toEqual(["Aina"]);
    expect((await mail(mum.email)).at(-1)!.body).toContain("This entry is for Aina.");
    expect((await participantHistory(kid)).some((e) => e.action === "tournament.entered")).toBe(true);
  });

  it("never for somebody another adult manages; and the guardian may enter too", async () => {
    const t = await tournament();
    const mum = await adult("Mum");
    const other = await adult("Other");
    const theirs = await child(other, "Zara");
    expect(await guardianEntrant(mum, theirs)).toMatchObject({ ok: false, code: "GUARD_NOT_FOUND", status: 404 });
    const kid = await child(mum, "Ali");
    expect(await enterAs((await guardianEntrant(mum, kid)) as Entrant, t.id)).toMatchObject({ ok: true });
    expect(await enter(mum, t.id)).toMatchObject({ ok: true });
  });

  it("through the page's route: enters, lists, and withdraws the entry made for them", async () => {
    const t = await tournament();
    const mum = await adult("Rina");
    const kid = await child(mum, "Kiki");
    const cookie = await playerCookie(mum.id);
    const ctx = { params: Promise.resolve({ id: String(t.id) }) };
    const made = await tournamentRoute.POST(post(`/api/tournaments/${t.id}`, { action: "enter", participantId: kid }, cookie), ctx);
    expect(made.status).toBe(201);
    const entryId = (await made.json()).entry.id as number;
    const shown = await (await tournamentRoute.GET(new NextRequest(`http://localhost/api/tournaments/${t.id}`, { headers: { cookie } }), ctx)).json();
    expect(shown.mine).toBeNull();
    expect(shown.managed.map((e: { id: number }) => e.id)).toEqual([entryId]);
    expect(shown.people.map((p: { name: string }) => p.name)).toContain("Kiki");
    expect((await tournamentRoute.POST(post(`/api/tournaments/${t.id}`, { action: "enter", participantId: 999999 }, cookie), ctx)).status).toBe(404);
    expect((await tournamentRoute.POST(post(`/api/tournaments/${t.id}`, { action: "withdraw", entryId }, cookie), ctx)).status).toBe(200);
    expect(await managedEntries(mum.id, t.id)).toEqual([]);
  });

  it("asks a participant's declared gender in a women's event", async () => {
    const t = await tournament({ category: "women" });
    const dad = await adult("Dad", { gender: "man" });
    const girl = await child(dad, "Hana");
    const entrant = (await guardianEntrant(dad, girl)) as Entrant;
    expect(await enterAs(entrant, t.id)).toMatchObject({ ok: false, code: "LG5_ENTRANT_GENDER" });
    expect(await enterAs(entrant, t.id, { gender: "man" })).toMatchObject({ ok: false, code: "WHO_WOMEN" });
    // The father's own gender is not asked: the entrant is the participant.
    expect(await enterAs(entrant, t.id, { gender: "woman" })).toMatchObject({ ok: true });
  });

  it("counts a competition's cap per person: the participant, not the guardian's account", async () => {
    const day = addDays(today, dayOffset++);
    const comp = await createCompetition(
      { venueId, name: "Junior Championship", sport: "badminton", startsOn: day, endsOn: day, startMin: 9 * 60, endMin: 13 * 60, matchMinutes: 30, courtIds: courts, maxDivisionsPerPlayer: 1 },
      ownerId
    );
    if (!comp.ok) throw new Error(comp.error);
    const division = async (name: string) => {
      const made = await createTournament(
        { venueId, competitionId: comp.value.id, name, sport: "badminton", format: "round_robin", teamSize: 1, level: null, entryFee: 0, maxEntries: 16, startsOn: "2099-01-01", endsOn: "2099-01-01", courtIds: [] } as TournamentInput,
        ownerId
      );
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    const [a, b] = [await division("Under 12"), await division("Under 15")];
    const mum = await adult("Mum");
    const kid = await child(mum, "Nur");
    const asMum = (await guardianEntrant(mum, kid)) as Entrant;
    expect(await enterAs(asMum, a.id)).toMatchObject({ ok: true });
    expect(await enterAs(asMum, b.id)).toMatchObject({ ok: false, code: "DIVISION_LIMIT" });
    // Mum's own entry is hers, not her child's.
    expect(await enter(mum, b.id)).toMatchObject({ ok: true });
  });

  it("joins a league for them: the participant's place, the guardian's number for box-mates, no level of the guardian's", async () => {
    const l = await league();
    const mum = await adult("Lina");
    await setPlayerLevel(mum.id, "badminton", "competitive");
    const kid = await child(mum, "Puteri");
    const placed = await joinAs((await guardianEntrant(mum, kid)) as Entrant, l.id);
    expect(placed).toMatchObject({ ok: true, value: { name: "Puteri" } });
    expect(await myLeague(mum.id, l.id)).toBeNull();
    expect((await managedLeague(mum.id, l.id)).map((p) => p.name)).toEqual(["Puteri"]);
    expect((await leagueDetail(l.id))!.people.find((p) => p.name === "Puteri")?.level).toBeNull();
    const others = [await adult(), await adult()];
    for (const u of others) await join(u, l.id);
    await startSeason(l.id, { startsOn: today }, today);
    const theirs = (await myLeague(others[0].id, l.id))!;
    expect(theirs.contacts.find((c) => c.name === "Puteri")?.phone).toBe(mum.phone);
  });
});

describe("entries at the counter", () => {
  it("front desk enters somebody on the number and name given, by the same rules, and it is logged", async () => {
    const desk = await createAdmin({ name: "Desk Nora", email: `desk${++n}@entrants.test`, password: "desk-password", venueId, role: "desk" });
    if (!desk.ok) throw new Error(desk.error);
    const cookie = await staffCookie(desk.admin.id);
    const t = await tournament({ category: "women", ageMin: 30 });
    const ctx = { params: Promise.resolve({ id: String(t.id) }) };
    const url = `/api/admin/tournaments/${t.id}/entries`;
    expect((await counterTournamentRoute.POST(post(url, { name: "Walk In" }, cookie), ctx)).status).toBe(400);
    const noGender = await counterTournamentRoute.POST(post(url, { phone: "0123334444", name: "Walk In", birthDate: "1980-05-05" }, cookie), ctx);
    expect(noGender.status).toBe(409);
    expect((await noGender.json()).code).toBe("LG5_ENTRANT_GENDER");
    const noAge = await counterTournamentRoute.POST(post(url, { phone: "0123334444", name: "Walk In", gender: "woman" }, cookie), ctx);
    expect((await noAge.json()).code).toBe("AGE_RANGE");
    const made = await counterTournamentRoute.POST(post(url, { phone: "0123334444", name: "Walk In", gender: "woman", birthDate: "1980-05-05" }, cookie), ctx);
    expect(made.status).toBe(201);
    const row = (await getDb()
      .prepare("SELECT user_id, contact_phone, entered_by_name, entrant_gender, name FROM tournament_entries WHERE tournament_id = ?")
      .get(t.id)) as Record<string, unknown>;
    expect(row).toEqual({ user_id: null, contact_phone: "0123334444", entered_by_name: "Desk Nora", entrant_gender: "woman", name: "Walk In" });
    const staffView = (await tournamentDetail(t.id, { forStaff: true }))!.entries[0];
    expect(staffView.atCounter).toEqual({ by: "Desk Nora", phone: "0123334444" });
    expect((await tournamentDetail(t.id))!.entries[0].atCounter).toBeUndefined();
    const logged = (await getDb().prepare("SELECT admin_name, detail FROM staff_actions WHERE action = 'tournament.entered_at_counter' ORDER BY id DESC LIMIT 1").get()) as {
      admin_name: string;
      detail: string;
    };
    expect(logged).toMatchObject({ admin_name: "Desk Nora", detail: expect.stringContaining("Walk In") });
  });

  it("enters a child the venue knows only with their guardian's number, and refuses another venue's staff", async () => {
    const t = await tournament();
    const known = await createAtVenue({
      venueId,
      admin: { id: ownerId, name: "Owner" },
      displayName: "Danish",
      guardian: { name: "Puan Rohani", phone: "0128887777", relationship: "parent", authority: true },
    });
    if (!known.ok) throw new Error(known.error);
    const cookie = await staffCookie(ownerId);
    const ctx = { params: Promise.resolve({ id: String(t.id) }) };
    const url = `/api/admin/tournaments/${t.id}/entries`;
    const wrong = await counterTournamentRoute.POST(post(url, { phone: "0120000001", participantId: known.participant.id }, cookie), ctx);
    expect(wrong.status).toBe(409);
    expect((await wrong.json()).code).toBe("PBK_NOT_GUARDIAN");
    const right = await counterTournamentRoute.POST(post(url, { phone: "0128887777", participantId: known.participant.id }, cookie), ctx);
    expect(right.status).toBe(201);
    expect((await right.json()).entry).toMatchObject({ name: "Danish", participantId: known.participant.id });

    const other = await createVenue({ name: "Other Hall", area: "Klang", address: "2 Jalan Lain", phone: "0331118888" });
    if (!other.ok) throw new Error("venue");
    const outsider = await createAdmin({ name: "Outsider", email: `out${++n}@entrants.test`, password: "desk-password", venueId: other.venue.id });
    if (!outsider.ok) throw new Error(outsider.error);
    expect((await counterTournamentRoute.POST(post(url, { phone: "0123334444", name: "Sneaky" }, await staffCookie(outsider.admin.id)), ctx)).status).toBe(403);
  });

  it("adds a league player at the counter, whose number their box-mates are given", async () => {
    const l = await league();
    const ctx = { params: Promise.resolve({ id: String(l.id) }) };
    const res = await counterLeagueRoute.POST(post(`/api/admin/leagues/${l.id}/players`, { phone: "0125556666", name: "Pak Walk" }, await staffCookie(ownerId)), ctx);
    expect(res.status).toBe(201);
    const [a, b] = [await adult(), await adult()];
    await join(a, l.id);
    await join(b, l.id);
    await startSeason(l.id, { startsOn: today }, today);
    expect((await myLeague(a.id, l.id))!.contacts.find((c) => c.name === "Pak Walk")?.phone).toBe("0125556666");
    expect((await leagueDetail(l.id, { forStaff: true }))!.people.find((p) => p.name === "Pak Walk")?.atCounter).toMatchObject({ phone: "0125556666" });
  });

  it("checks the counter entrant as any other: the number and name are needed", async () => {
    const e = await counterEntrant(venueId, { id: ownerId, name: "Owner" }, { phone: "12", name: "Shorty" });
    expect(e).toMatchObject({ ok: false, status: 400 });
    expect(await counterEntrant(venueId, { id: ownerId, name: "Owner" }, { phone: "0123334444", name: "" })).toMatchObject({ ok: false, status: 400 });
  });
});

describe("their own data", () => {
  it("a participant's record erased takes them out and their name off the draw and the boxes", async () => {
    const t = await tournament();
    const l = await league();
    const mum = await adult("Ida");
    const kid = await child(mum, "Yusof");
    const asMum = (await guardianEntrant(mum, kid)) as Entrant;
    await enterAs(asMum, t.id);
    await joinAs(asMum, l.id);
    await eraseParticipant(kid, "Asked to be forgotten");
    const entry = (await getDb().prepare("SELECT name, status, participant_id, user_id FROM tournament_entries WHERE tournament_id = ?").get(t.id)) as Record<string, unknown>;
    expect(entry).toEqual({ name: "(removed)", status: "withdrawn", participant_id: null, user_id: null });
    const player = (await getDb().prepare("SELECT name, status, participant_id FROM league_players WHERE league_id = ?").get(l.id)) as Record<string, unknown>;
    expect(player).toEqual({ name: "(removed)", status: "left", participant_id: null });
  });

  it("a guardian closing their account leaves a child's entry to the child's other guardian", async () => {
    const { eraseCustomer } = await import("../src/lib/privacy");
    const t = await tournament();
    const mum = await adult("Mum");
    const kid = await child(mum, "Zain");
    // A second guardian, recorded by the venue: the child's record stays when mum goes.
    await getDb()
      .prepare(
        `INSERT INTO participant_guardians (participant_id, contact_name, contact_phone, relationship, authority_declared_at, provenance, venue_id, recorded_by_name)
         VALUES (?, 'Encik Zul', '0129990000', 'parent', now(), 'counter', ?, 'Owner')`
      )
      .run(kid, venueId);
    await enterAs((await guardianEntrant(mum, kid)) as Entrant, t.id);
    await enter(mum, t.id);
    expect((await eraseCustomer(mum.id)).ok).toBe(true);
    const rows = (await getDb().prepare("SELECT name, status, participant_id, user_id FROM tournament_entries WHERE tournament_id = ? ORDER BY id").all(t.id)) as Record<string, unknown>[];
    expect(rows).toEqual([
      { name: "Zain", status: "entered", participant_id: kid, user_id: null },
      { name: "(removed)", status: "withdrawn", participant_id: null, user_id: null },
    ]);
  });
});
