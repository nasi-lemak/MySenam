import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { addOfficial, answerReport, officialByToken, officialResult, openReports, REPORT_STANDS_HOURS, reportResult, revokeOfficial, standUnansweredReports } from "../src/lib/match-reports";
import { listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { createTournament, enter, makeDraw, recordResult, tournamentDetail, type TournamentInput } from "../src/lib/tournaments";
import { GET as officialGet, POST as officialPost } from "../src/app/api/officials/[token]/route";
import { POST as officialsAdd } from "../src/app/api/admin/tournaments/[id]/officials/route";

/**
 * Results entered by the people on court: players report and confirm their
 * own matches (disputes go to staff), and officials enter results through a
 * link of their own, recorded with their name.
 */

let ownerId: number;
let venueId: number;
let courtIds: number[];
let n = 0;
let day = 5;

async function player(): Promise<User> {
  n++;
  const made = await registerUser({ name: `Reporter ${n}`, email: `r${n}@rep.my`, phone: `01370${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

/** A drawn knockout of two (one match) or four, with each side's account. */
async function drawn(over: Partial<TournamentInput> = {}, size = 2) {
  const date = addDays(todayISO(), day++);
  const made = await createTournament(
    { venueId, courtIds, name: `Reported Cup ${day}`, sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 0, maxEntries: 8, startsOn: date, endsOn: date, startHour: 9, endHour: 17, resultsBy: "players", ...over } as TournamentInput,
    ownerId
  );
  if (!made.ok) throw new Error(made.error);
  const players: User[] = [];
  for (let i = 0; i < size; i++) {
    const p = await player();
    players.push(p);
    expect(await enter(p, made.value.id)).toMatchObject({ ok: true });
  }
  expect(await makeDraw(made.value.id, () => 0.5)).toMatchObject({ ok: true });
  const d = (await tournamentDetail(made.value.id, { forStaff: true }))!;
  const entryOf = (u: User) => d.entries.find((e) => e.userId === u.id)!.id;
  const match = d.matches.find((m) => m.a !== null && m.b !== null)!;
  const [sideA, sideB] = [players.find((p) => entryOf(p) === match.a)!, players.find((p) => entryOf(p) === match.b)!];
  return { t: made.value, d, match, sideA, sideB, entryOf, players };
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const venue = (await listVenues()).find((v) => v.courts.filter((c) => c.sport === "badminton").length >= 2)!;
  venueId = venue.id;
  courtIds = venue.courts.filter((c) => c.sport === "badminton").slice(0, 2).map((c) => c.id);
});

describe("players entering their own results", () => {
  it("one side reports, the other confirms, and only then is it the result, recorded as the players'", async () => {
    const { t, match, sideA, sideB } = await drawn();
    expect(t.resultsBy).toBe("players");
    // Not somebody else's match; a score that disagrees with the winner is refused at once.
    expect(await reportResult((await player()).id, match.id, { winner: match.a!, score: "21-10, 21-12" })).toMatchObject({ ok: false, error: "That is not your match." });
    expect(await reportResult(sideA.id, match.id, { winner: match.a!, score: "10-21, 12-21" })).toMatchObject({ ok: false });
    const first = await reportResult(sideA.id, match.id, { winner: match.a!, score: "21-10, 21-12" });
    expect(first).toMatchObject({ ok: true, value: { status: "pending", entryId: match.a } });
    // Nothing is recorded yet; the reporter cannot confirm their own.
    expect((await tournamentDetail(t.id))!.matches.find((m) => m.id === match.id)!.winner).toBeNull();
    expect(await answerReport(sideA.id, match.id, { confirm: true })).toMatchObject({ ok: false, error: expect.stringMatching(/other side confirms/) });
    expect(await reportResult(sideB.id, match.id, { winner: match.b!, score: "21-19, 21-19" })).toMatchObject({ ok: false, error: expect.stringMatching(/confirm it, or say it is wrong/) });
    expect(await answerReport(sideB.id, match.id, { confirm: true })).toMatchObject({ ok: true });
    const done = (await tournamentDetail(t.id))!.matches.find((m) => m.id === match.id)!;
    expect(done).toMatchObject({ winner: match.a, score: "21-10, 21-12", status: "done", resultBy: "players" });
    expect(await openReports(t.id)).toEqual([]);
  });

  it("a dispute goes to the venue's staff, whose result settles it; reporting is only for tournaments that ask players", async () => {
    const { t, match, sideA, sideB } = await drawn();
    expect(await reportResult(sideA.id, match.id, { winner: match.a!, score: "21-10, 21-12" })).toMatchObject({ ok: true });
    expect(await answerReport(sideB.id, match.id, { dispute: "x" })).toMatchObject({ ok: false });
    expect(await answerReport(sideB.id, match.id, { dispute: "I won the second game 21-19" })).toMatchObject({ ok: true, value: { status: "disputed" } });
    expect(await reportResult(sideA.id, match.id, { winner: match.a!, score: "21-10, 21-12" })).toMatchObject({ ok: false, error: expect.stringMatching(/disputed/) });
    expect(await openReports(t.id)).toEqual([expect.objectContaining({ status: "disputed", disputeNote: "I won the second game 21-19" })]);
    expect(await recordResult(match.id, { winner: match.b!, score: "10-21, 21-19, 15-21" })).toMatchObject({ ok: true });
    expect(await openReports(t.id)).toEqual([]);
    expect(((await getDb().prepare("SELECT status FROM tournament_reports WHERE match_id = ?").get(match.id)) as { status: string }).status).toBe("superseded");

    // Each side writes its own score first; it is kept with the first-named side's first.
    const other = await drawn();
    expect(await reportResult(other.sideB.id, other.match.id, { winner: other.match.b!, score: "21-15, 21-17" })).toMatchObject({ ok: true, value: { score: "15-21, 17-21" } });

    const staffRun = await drawn({ resultsBy: "staff" });
    expect(await reportResult(staffRun.sideA.id, staffRun.match.id, { winner: staffRun.match.a!, score: "21-10, 21-12" })).toMatchObject({ ok: false, error: expect.stringMatching(/venue enters/) });
  });
});

describe("a report nobody answers", () => {
  const db = () => getDb();
  /** As if the report had waited longer than it may. */
  const aged = (matchId: number) =>
    db().prepare(`UPDATE tournament_reports SET created_at = datetime('now', '-${REPORT_STANDS_HOURS + 1} hours') WHERE match_id = ? AND status = 'pending'`).run(matchId);

  it("asks the other side, says silence lets it stand, and stands a day later as the players' result", async () => {
    const { t, match, sideA, sideB } = await drawn();
    expect(await reportResult(sideA.id, match.id, { winner: match.a!, score: "21-10, 21-12" })).toMatchObject({ ok: true });
    const asked = (await db().prepare("SELECT subject, body FROM messages WHERE recipient = ? AND kind = 'programme' ORDER BY id DESC").get(sideB.email)) as {
      subject: string;
      body: string;
    };
    expect(asked.subject).toBe(`Confirm your result: ${t.name}`);
    expect(asked.body).toContain(`as 21-10, 21-12`);
    expect(asked.body).toContain(`it stands in ${REPORT_STANDS_HOURS} hours`);

    // Not yet a day: it waits.
    expect(await standUnansweredReports()).toBe(0);
    await aged(match.id);
    expect(await standUnansweredReports()).toBe(1);
    expect((await tournamentDetail(t.id))!.matches.find((m) => m.id === match.id)).toMatchObject({ winner: match.a, score: "21-10, 21-12", status: "done", resultBy: "players" });
    expect(await openReports(t.id)).toEqual([]);
    // Once only.
    expect(await standUnansweredReports()).toBe(0);
  });

  it("is never dropped: one that can no longer be recorded goes to the venue's staff as disputed", async () => {
    const { t, match, sideA } = await drawn();
    const desk = await createAdmin({ name: "Desk", email: "desk@rep.my", password: "desk-password", venueId });
    if (!desk.ok) throw new Error(desk.error);
    expect(await reportResult(sideA.id, match.id, { winner: match.a!, score: "21-10, 21-12" })).toMatchObject({ ok: true });
    // Its score no longer fits the result (as if the rules had changed under it).
    await db().prepare("UPDATE tournament_reports SET score = '10-21, 12-21' WHERE match_id = ? AND status = 'pending'").run(match.id);
    await aged(match.id);
    expect(await standUnansweredReports()).toBe(0);
    expect(await openReports(t.id)).toEqual([expect.objectContaining({ status: "disputed", disputeNote: expect.stringMatching(/^Unanswered, and could not be recorded/) })]);
    expect((await tournamentDetail(t.id))!.matches.find((m) => m.id === match.id)!.winner).toBeNull();
    const told = (await db().prepare("SELECT recipient FROM messages WHERE subject = ?").all(`A result needs entering: ${t.name}`)) as { recipient: string }[];
    expect(told.map((m) => m.recipient)).toContain("desk@rep.my");
  });

  it("is answered in time like any other: confirmed before the day is out, nothing is left to stand", async () => {
    const { match, sideA, sideB } = await drawn();
    expect(await reportResult(sideA.id, match.id, { winner: match.a!, score: "21-10, 21-12" })).toMatchObject({ ok: true });
    expect(await answerReport(sideB.id, match.id, { confirm: true })).toMatchObject({ ok: true });
    await aged(match.id);
    expect(await standUnansweredReports()).toBe(0);
  });
});

describe("officials", () => {
  it("enter results through a link of their own, recorded with their name, until the link is withdrawn", async () => {
    // Four players, so the tournament is still running after one result.
    const { t, match } = await drawn({ resultsBy: "staff" }, 4);
    const made = await addOfficial(t.id, "Referee Rahim", ownerId);
    if (!made.ok) throw new Error(made.error);
    const { token, official } = made.value;
    // Only the hash is kept.
    expect(((await getDb().prepare("SELECT token_hash FROM tournament_officials WHERE id = ?").get(official.id)) as { token_hash: string }).token_hash).not.toContain(token);
    expect(await officialByToken(token)).toMatchObject({ tournamentId: t.id, official: { name: "Referee Rahim" } });

    const seen = await officialGet(new NextRequest(`http://localhost/api/officials/${token}`), { params: Promise.resolve({ token }) });
    expect(await seen.json()).toMatchObject({ official: { name: "Referee Rahim" }, tournament: { id: t.id } });
    const res = await officialPost(
      new NextRequest(`http://localhost/api/officials/${token}`, { method: "POST", body: JSON.stringify({ matchId: match.id, winner: match.b, score: "21-15, 18-21, 17-21" }) }),
      { params: Promise.resolve({ token }) }
    );
    expect(res.status).toBe(200);
    expect((await tournamentDetail(t.id))!.matches.find((m) => m.id === match.id)).toMatchObject({ winner: match.b, resultBy: "official: Referee Rahim" });
    expect(((await getDb().prepare("SELECT admin_name, detail FROM staff_actions WHERE action = 'tournament.result' ORDER BY id DESC LIMIT 1").get()) as { admin_name: string }).admin_name).toBe(
      "Official: Referee Rahim"
    );
    // Another tournament's match: refused.
    const other = await drawn({ resultsBy: "staff" });
    expect(await officialResult(token, other.match.id, { winner: other.match.a!, score: "21-1, 21-1" })).toMatchObject({ ok: false, error: expect.stringMatching(/not in this tournament/) });
    expect(await revokeOfficial(t.id, official.id)).toBe(true);
    expect(await officialByToken(token)).toBeNull();
    expect((await officialGet(new NextRequest(`http://localhost/api/officials/${token}`), { params: Promise.resolve({ token }) })).status).toBe(404);
    expect(await officialByToken("not-a-token")).toBeNull();
  });

  it("are added by the venue's staff, with the link shown once", async () => {
    const { t } = await drawn({ resultsBy: "staff" });
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(ownerId)).token}`;
    const res = await officialsAdd(
      new NextRequest(`http://localhost/api/admin/tournaments/${t.id}/officials`, { method: "POST", headers: { cookie, origin: "http://localhost" }, body: JSON.stringify({ name: "Umpire Uma" }) }),
      { params: Promise.resolve({ id: String(t.id) }) }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.link).toMatch(/\/officials\/[A-Za-z0-9_-]{30,}$/);
    expect(await officialByToken(body.link.split("/").pop())).toMatchObject({ official: { name: "Umpire Uma" } });
  });
});
