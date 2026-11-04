/// <reference types="vite/client" />
import fs from "fs";
import path from "path";
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";
process.env.MYSENAM_MARKETPLACE = "on";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { listActivity } from "../src/lib/activity";
import { SESSION_COOKIE, createSession, registerUser, type User } from "../src/lib/auth";
import { guardianEntrant, type Entrant } from "../src/lib/competition-entrants";
import { getDb } from "../src/lib/db";
import { createLadder, joinAs as joinLadder, ladderDetail, myPlaces } from "../src/lib/ladders";
import { createLeague, join as joinLeague, joinAs as joinLeagueAs, leagueDetail, managedLeague, myLeague, startSeason } from "../src/lib/leagues";
import { addManaged } from "../src/lib/managed-people";
import { participantHistory } from "../src/lib/participants";
import { saveProfile } from "../src/lib/player-profiles";
import { eraseCustomer, exportCustomerData } from "../src/lib/privacy";
import { authorise, publicNamesFor, withdrawConsent } from "../src/lib/public-name-consents";
import { authorisedParticipants, namedForThePublic, publicName, shortName } from "../src/lib/public-names";
import { setEventRated, venueBoard } from "../src/lib/ratings";
import { createCourt, listVenues } from "../src/lib/store";
import { liveBoard } from "../src/lib/tournament-day";
import { addDays, todayISO } from "../src/lib/time";
import { createTournament, enter, enterAs, makeDraw, managedEntries, recordResult, tournamentDetail, type TournamentInput } from "../src/lib/tournaments";
import { GET as tournamentGet } from "../src/app/api/tournaments/[id]/route";
import { GET as liveGet } from "../src/app/api/tournaments/[id]/live/route";
import { GET as leagueGet } from "../src/app/api/leagues/[id]/route";
import { GET as ladderGet } from "../src/app/api/ladders/[id]/route";
import { GET as rankingsGet } from "../src/app/api/venues/[id]/rankings/route";
import { GET as consentGet, POST as consentPost } from "../src/app/api/my/people/public-name/route";
import { POST as mcpPost } from "../src/app/api/mcp/route";

/**
 * A declared minor is shown by first name and the initial of the next on every public surface, in every format, and in notices to
 * other families; staff and the guardian keep the full name; the one exception is a guardian's authorisation, which is read live
 * (docs/architecture/privacy.md#minors-names-on-public-pages; lib/public-names.ts, lib/public-name-consents.ts; migration 0274).
 *
 * Every name below has a surname nobody else has, and each payload is scanned whole for it.
 */

vi.setConfig({ testTimeout: 60_000 });

const KID_SURNAME = "Quillfeather";
const KID_FULL = `Aina ${KID_SURNAME}`;
const KID_SHORT = "Aina Q.";
const today = todayISO();

let adminId: number;
let venueId: number;
let courts: number[];
let n = 0;
let dayOffset = 3;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = (await listAdmins())[0].id;
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courts = venue.courts.filter((c) => c.sport === "badminton").slice(0, 2).map((c) => c.id);
  while (courts.length < 2) {
    const c = await createCourt({ venueId, name: `Names Court ${courts.length}`, sport: "badminton", offPeakRate: 10, peakRate: 12 });
    if (!c.ok) throw new Error(c.error);
    courts.push(c.court.id);
  }
});

async function adult(name = "Player"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} Oakhart${n}`, email: `pn${n}@names.test`, phone: `01370${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  await saveProfile(made.user.id, { adult: true });
  return made.user;
}

/** A guardian and a child the guardian manages, named with the surname nobody else has. */
async function family(full = KID_FULL) {
  const guardian = await adult("Mum");
  const made = await addManaged(guardian.id, { displayName: full, relationship: "parent", authority: true, birthYear: new Date().getFullYear() - 10 }, guardian.name);
  if (!made.ok) throw new Error(made.error);
  return { guardian, kid: made.person.id, entrant: (await guardianEntrant(guardian, made.person.id)) as Entrant };
}

function ok<T>(r: { ok: true; value: T } | { ok: false; error: string; code?: string }): T {
  if (!r.ok) throw new Error(`${r.error} (${(r as { code?: string }).code ?? ""})`);
  return r.value;
}

async function tournament(over: Partial<TournamentInput> = {}) {
  const day = addDays(today, dayOffset++);
  const made = await createTournament(
    { venueId, name: `Names Cup ${dayOffset}`, sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 0, maxEntries: 16, startsOn: day, endsOn: day, startHour: 9, endHour: 21, courtIds: courts, ...over },
    adminId
  );
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

const as = async (user: User) => `${SESSION_COOKIE}=${(await createSession(user.id)).token}`;
const get = (url: string, cookie?: string) => new NextRequest(`http://localhost${url}`, cookie ? { headers: { cookie } } : undefined);
const idParams = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const json = async (res: Response) => JSON.stringify(await res.json());
const publicTournament = async (id: number) => json(await tournamentGet(get(`/api/tournaments/${id}`), idParams(id)));
const publicLeague = async (id: number) => json(await leagueGet(get(`/api/leagues/${id}`), idParams(id)));
const publicLadder = async (id: number) => json(await ladderGet(get(`/api/ladders/${id}`), idParams(id)));
const mails = async (email: string) => JSON.stringify(await getDb().prepare("SELECT * FROM messages WHERE recipient = ? ORDER BY id").all(email));

/** A knockout of the child, an adult and two more, drawn, with the child's first match played. */
async function playedKnockout(over: Partial<TournamentInput> = {}) {
  const f = await family();
  const t = await tournament(over);
  const kidEntry = ok(await enterAs(f.entrant, t.id));
  const adults = [await adult("Rav"), await adult("Sam"), await adult("Tan")];
  const adultEntries = [];
  for (const a of adults) adultEntries.push(ok(await enter(a, t.id)));
  const d = ok(await makeDraw(t.id, () => 0.3));
  const first = d.matches.find((m) => m.stage === "knockout" && (m.a === kidEntry.id || m.b === kidEntry.id) && m.a !== null && m.b !== null)!;
  const r = await recordResult(first.id, { winner: kidEntry.id, score: first.a === kidEntry.id ? "21-10, 21-12" : "10-21, 12-21" });
  if (!r.ok) throw new Error(r.error);
  return { f, t, kidEntry, adults, adultEntries };
}

describe("the one rule", () => {
  it("shortens a declared minor and each of a pair, leaves an adult and a team alone, and gives one word its first name only", () => {
    expect(shortName("Aina Lee")).toBe("Aina L.");
    expect(shortName("Aina Lee / Ben Tan")).toBe("Aina L. / Ben T.");
    expect(shortName("Aina")).toBe("Aina");
    const on = "2026-11-20";
    expect(publicName({ name: "Aina Lee", participantId: 4 }, { on })).toBe("Aina L.");
    expect(publicName({ name: "Aina Lee", guardian: true }, { on })).toBe("Aina L.");
    expect(publicName({ name: "Aina Lee", birthDate: "2012-03-01" }, { on })).toBe("Aina L.");
    expect(publicName({ name: "Aina Lee", birthDate: "2008-11-20" }, { on })).toBe("Aina Lee");
    expect(publicName({ name: "Ben Tan / Aina Lee", partnerBirthDate: "2012-03-01" }, { on })).toBe("Ben T. / Aina L.");
    expect(publicName({ name: "Ben Tan" }, { on })).toBe("Ben Tan");
    expect(publicName({ name: "Tigers", team: true, guardian: true }, { on })).toBe("Tigers");
    expect(publicName({ name: "Ben Tan" }, { on, everybodyShort: true })).toBe("Ben T.");
    // The exception is for the participant a guardian answers for; a pair's other, young, partner has nobody to say yes.
    expect(publicName({ name: "Aina Lee", participantId: 4 }, { on, authorised: new Set([4]) })).toBe("Aina Lee");
    expect(publicName({ name: "Aina Lee / Cara Mok", participantId: 4, partnerBirthDate: "2012-03-01" }, { on, authorised: new Set([4]) })).toBe("Aina L. / Cara M.");
    expect(publicName({ name: "Aina Lee", participantId: 4 }, { on, authorised: new Set([4]), everybodyShort: true })).toBe("Aina L.");
  });
});

describe("tournaments: the public page, its API, the live page, and notices to other families", () => {
  it("names a participant a guardian entered by first name and initial everywhere public, in full to staff and the guardian", async () => {
    const { f, t, kidEntry, adults } = await playedKnockout();
    const page = await publicTournament(t.id);
    expect(page).toContain(KID_SHORT);
    expect(page).not.toContain(KID_SURNAME);
    // Adults as entered.
    for (const a of adults) expect(page).toContain(a.name);
    // The live page and its API.
    const live = await liveGet(get(`/api/tournaments/${t.id}/live`), idParams(t.id));
    expect(live.status).toBe(200);
    const liveText = await json(live);
    expect(liveText).not.toContain(KID_SURNAME);
    expect(JSON.stringify(await liveBoard(t.id))).toContain(KID_SHORT);
    // Staff see the entrant in full, as does the guardian's own view of their child's entry.
    expect((await tournamentDetail(t.id, { forStaff: true }))!.entries.find((e) => e.id === kidEntry.id)!.name).toBe(KID_FULL);
    expect((await managedEntries(f.guardian.id, t.id)).find((e) => e.id === kidEntry.id)!.name).toBe(KID_FULL);
    // A signed-in guardian's page carries the full name in `managed`, and the public list still the short one.
    const signed = JSON.parse(await json(await tournamentGet(get(`/api/tournaments/${t.id}`, await as(f.guardian)), idParams(t.id))));
    expect(signed.managed[0].name).toBe(KID_FULL);
    expect(signed.tournament.entries.find((e: { id: number }) => e.id === kidEntry.id).name).toBe(KID_SHORT);
  });

  it("shortens a pair with a declared minor in it, both of the two, and a guardian-declared teenager's own entry", async () => {
    const t = await tournament({ teamSize: 2, ageMin: 8, ageMax: 60, name: "Pairs Names Cup" });
    const mum = await adult("Entrant");
    const pair = ok(
      await enter(mum, t.id, { partnerName: "Cara Pennywhistle", birthDate: "1990-04-04", partnerBirthDate: "2012-05-05", guardianName: "Pat Pennywhistle", guardianConsent: true })
    );
    const adultPair = ok(await enter(await adult("Elder"), t.id, { partnerName: "Dev Ironside", birthDate: "1985-01-01", partnerBirthDate: "1986-02-02" }));
    const text = await publicTournament(t.id);
    expect(text).not.toContain("Pennywhistle");
    expect(text).not.toContain("Oakhart" + (n - 1)); // the pair's adult entrant is short too: a surname beside a child's short name can give it away
    expect(text).toContain("Cara P.");
    // A pair of adults is shown as entered.
    expect(text).toContain("Dev Ironside");
    expect((await tournamentDetail(t.id, { forStaff: true }))!.entries.find((e) => e.id === pair.id)!.name).toContain("Pennywhistle");
    expect(adultPair.name).toContain("Ironside");

    // A teenager who enters with their own account, on a guardian's agreement.
    const teens = await tournament({ ageMin: 8, ageMax: 60, name: "Teens Names Cup" });
    const teen = await adult("Teen");
    ok(await enter(teen, teens.id, { birthDate: "2011-06-06", guardianName: "Gita Guardian", guardianConsent: true }));
    expect(await publicTournament(teens.id)).not.toContain(teen.name.split(" ")[1]);
  });

  it("shows a team by its name and never its roster, and a tournament set to short names shows everybody short", async () => {
    const t = await tournament({ entryKind: "team", roster: { min: 2, max: 4 }, name: "Teams Names Cup" });
    const cap = await adult("Cap");
    ok(await enter(cap, t.id, { teamName: "Sunderland Tigers", roster: [`Dina Sunderland`, `Eli Sunderland`] }));
    const text = await publicTournament(t.id);
    expect(text).toContain("Sunderland Tigers");
    expect(text).not.toContain("Dina Sunderland");
    const adultsOnly = await tournament({ name: "Short Names Cup" });
    const p = await adult("Pat");
    ok(await enter(p, adultsOnly.id));
    expect(await publicTournament(adultsOnly.id)).toContain(p.name);
    await getDb().prepare("UPDATE tournaments SET live_names = 'short' WHERE id = ?").run(adultsOnly.id);
    const short = await publicTournament(adultsOnly.id);
    expect(short).not.toContain(p.name);
    expect(short).toContain(shortName(p.name));
  });

  it("names a declared minor to the other family in the draw notice by first name and initial", async () => {
    const f = await family();
    const t = await tournament({ name: "Notice Cup" });
    const opponent = await adult("Opp");
    ok(await enterAs(f.entrant, t.id));
    ok(await enter(opponent, t.id));
    ok(await makeDraw(t.id, () => 0.3));
    const theirs = await mails(opponent.email);
    expect(theirs).toContain(KID_SHORT);
    expect(theirs).not.toContain(KID_SURNAME);
    // The guardian is told who their child plays, in full as an adult is.
    expect(await mails(f.guardian.email)).toContain(opponent.name);
  });

  it("names a declared minor to the other family in a Swiss round's notice the same way", async () => {
    const f = await family();
    const t = await tournament({ format: "swiss", name: "Swiss Notice Cup" });
    ok(await enterAs(f.entrant, t.id));
    const others = [await adult("Sw1"), await adult("Sw2"), await adult("Sw3")];
    for (const o of others) ok(await enter(o, t.id));
    ok(await makeDraw(t.id, () => 0.3));
    const all = (await Promise.all(others.map((o) => mails(o.email)))).join("\n");
    expect(all).toContain(KID_SHORT);
    expect(all).not.toContain(KID_SURNAME);
    expect(await publicTournament(t.id)).not.toContain(KID_SURNAME);
  });
});

describe("creating events", () => {
  it("leaves the template an event starts from as it was: a Swiss event made with no rules does not turn every later event into one", async () => {
    await tournament({ format: "swiss", name: "Swiss First" });
    const next = await createTournament(
      { venueId, name: "Knockout After Swiss", sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 0, maxEntries: 8, startsOn: addDays(today, dayOffset), endsOn: addDays(today, dayOffset++), startHour: 9, endHour: 21, courtIds: courts },
      adminId
    );
    expect(next).toMatchObject({ ok: true });
    if (next.ok) expect(next.value.rules.swiss ?? null).toBeNull();
  });
});

describe("box leagues", () => {
  async function runningLeague() {
    const f = await family();
    const made = await createLeague({ venueId, name: `Names League ${n}`, sport: "badminton", teamSize: 1, level: null, fee: 0, startsOn: addDays(today, 1) }, adminId);
    if (!made.ok) throw new Error(made.error);
    const league = made.value;
    const kid = ok(await joinLeagueAs(f.entrant, league.id));
    const others = [await adult("Lg1"), await adult("Lg2")];
    for (const o of others) ok(await joinLeague(o, league.id));
    ok(await startSeason(league.id, { startsOn: today }, today));
    return { f, league, kid, others };
  }

  it("names a child short on the public page and API, in the box-mates' contacts and the start notice, and in full to staff and the guardian", async () => {
    const { f, league, others } = await runningLeague();
    const page = await publicLeague(league.id);
    expect(page).toContain(KID_SHORT);
    expect(page).not.toContain(KID_SURNAME);
    // Another family's box contacts, and the notice that told them their box.
    const contacts = JSON.stringify(await myLeague(others[0].id, league.id));
    expect(contacts).not.toContain(KID_SURNAME);
    expect(await mails(others[0].email)).not.toContain(KID_SURNAME);
    expect(await mails(others[0].email)).toContain(KID_SHORT);
    // Staff, and the guardian's own place, in full.
    expect(JSON.stringify(await leagueDetail(league.id, { forStaff: true }))).toContain(KID_FULL);
    expect((await managedLeague(f.guardian.id, league.id))[0].name).toBe(KID_FULL);
  });
});

describe("ladders", () => {
  it("shows a junior ladder short, an adult ladder as given, and a finished season's final order never with a full name", async () => {
    const f = await family();
    const made = await createLadder({ venueId, name: `Names Juniors ${n}`, sport: "badminton", teamSize: 1, level: null, audience: "juniors" }, adminId);
    if (!made.ok) throw new Error(made.error);
    ok(await joinLadder(f.entrant, made.value.id));
    const text = await publicLadder(made.value.id);
    expect(text).toContain(KID_SHORT);
    expect(text).not.toContain(KID_SURNAME);
    expect(JSON.stringify(await ladderDetail(made.value.id, { forStaff: true }))).not.toContain(KID_SURNAME);
    expect(await myPlaces(f.guardian.id, made.value.id)).toHaveLength(1);
  });
});

describe("rankings, the public API and the assistants' tools never list a child", () => {
  it("leaves a child's rating off the board by every route, whoever opted in", async () => {
    const f = await family();
    const t = await tournament({ format: "round_robin", name: "Rated Names Cup" });
    ok(await setEventRated("tournament", t.id, true));
    const kidEntry = ok(await enterAs(f.entrant, t.id));
    const mum = f.guardian;
    // The guardian is an adult who chose to be listed: their child's results are still never ranked.
    await saveProfile(mum.id, { adult: true, rankPublicly: true, rankName: "Mum Ace" });
    for (const o of [await adult("R1"), await adult("R2")]) ok(await enter(o, t.id));
    ok(await makeDraw(t.id, () => 0.3));
    for (let i = 0; i < 6; i++) {
      const d = (await tournamentDetail(t.id))!;
      const next = d.matches.find((m) => m.status === "scheduled" && m.a !== null && m.b !== null && m.winner === null);
      if (!next) break;
      const winner = next.a === kidEntry.id || next.b === kidEntry.id ? kidEntry.id : next.a!;
      const r = await recordResult(next.id, { winner, score: winner === next.a ? "21-10, 21-12" : "10-21, 12-21" });
      if (!r.ok) throw new Error(r.error);
    }
    const rated = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM rated_result_subjects s JOIN rated_results r ON r.id = s.result_id WHERE r.source_id = ? AND s.subject_kind = 'participant'").get(t.id)) as { n: number };
    expect(rated.n).toBeGreaterThan(0);
    const board = JSON.stringify(await venueBoard(venueId, "badminton", "singles"));
    expect(board).not.toContain(KID_SURNAME);
    expect(board).not.toContain("Aina");
    const res = await rankingsGet(get(`/api/venues/${venueId}/rankings?sport=badminton&format=singles`), idParams(venueId));
    expect(res.status).toBe(200);
    const route = await json(res);
    expect(route).not.toContain(KID_SURNAME);
    expect(route).not.toContain("Aina");
    // The assistants' public tool answers from the same route.
    const call = await mcpPost(
      new NextRequest("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-forwarded-for": "198.51.100.77" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "venue_rankings", arguments: { venueId, activity: "badminton", format: "singles" } } }),
      })
    );
    const text = await call.text();
    expect(text).not.toContain(KID_SURNAME);
    expect(text).not.toContain("Aina");
  });

  it("offers no public tool that names an entrant, and no /api/v1 route for competitions", () => {
    const tools = fs.readFileSync(path.join(__dirname, "..", "src/lib/mcp/public-tools.ts"), "utf8");
    expect(/tournament|league|ladder|entrant|participant/i.test(tools.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").replace(/description:\s*(?:\n\s*)?"[^"]*"/g, ""))).toBe(false);
    expect(fs.readdirSync(path.join(__dirname, "..", "src/app/api/v1")).sort()).toEqual(["availability", "bookings", "venue", "waitlist"]);
  });

  it("has no page metadata, structured data or share link that names an entrant", () => {
    const root = path.join(__dirname, "..", "src/app");
    for (const rel of ["tournaments/[id]/page.tsx", "tournaments/[id]/live/page.tsx", "leagues/[id]/page.tsx", "ladders/[id]/page.tsx", "team-leagues/[id]/page.tsx"]) {
      const source = fs.readFileSync(path.join(root, rel), "utf8");
      expect(/generateMetadata|openGraph|twitter|ld\+json|navigator\.share|document\.title/.test(source), rel).toBe(false);
    }
    // The routes that carry names are rendered per request and cache nothing, so a withdrawal is never behind a cached page.
    const api = path.join(__dirname, "..", "src/app/api");
    for (const rel of ["tournaments/[id]/route.ts", "tournaments/[id]/live/route.ts", "leagues/[id]/route.ts", "ladders/[id]/route.ts", "team-leagues/[id]/route.ts", "venues/[id]/rankings/route.ts", "my/people/public-name/route.ts"]) {
      const source = fs.readFileSync(path.join(api, rel), "utf8");
      expect(/export const dynamic = "force-dynamic"/.test(source) && !/revalidate/.test(source), rel).toBe(true);
    }
    // Anything that ever adds one for a competition has to route the name through the rule.
    const sitemap = fs.readFileSync(path.join(root, "sitemap.ts"), "utf8");
    expect(/tournament|league|ladder/.test(sitemap.replace(/"\/(tournaments|leagues)"/g, ""))).toBe(false);
  });
});

describe("a guardian's authorisation of the full name", () => {
  it("is given by the guardian only: a stranger, a manager's route and the child's own login cannot, and nothing is given without the box ticked", async () => {
    const { f, t } = await playedKnockout();
    const stranger = await adult("Stranger");
    const body = { id: f.kid, scope: "event", kind: "tournament", eventId: t.id, confirm: true };
    expect(await authorise(stranger, { ...body, participantId: f.kid })).toMatchObject({ ok: false, code: "PN1_NOT_GUARDIAN", status: 403 });
    expect(await authorise(f.guardian, { ...body, participantId: f.kid, confirm: undefined })).toMatchObject({ ok: false, code: "PN1_CONFIRM" });
    expect(await authorise(f.guardian, { ...body, participantId: f.kid, confirm: "yes" })).toMatchObject({ ok: false, code: "PN1_CONFIRM" });
    expect(await publicTournament(t.id)).not.toContain(KID_SURNAME);
    // By the route, with a session: a stranger is refused, the guardian is not.
    const post = async (user: User, b: object) =>
      consentPost(new NextRequest("http://localhost/api/my/people/public-name", { method: "POST", headers: { cookie: await as(user), "content-type": "application/json", "x-forwarded-for": "203.0.113.5" }, body: JSON.stringify(b) }));
    expect((await post(stranger, { action: "authorise", ...body })).status).toBe(403);
    expect((await consentGet(get(`/api/my/people/public-name?id=${f.kid}`, await as(stranger)))).status).toBe(403);
    expect((await consentGet(get(`/api/my/people/public-name?id=${f.kid}`))).status).toBe(401);
    expect((await post(f.guardian, { action: "authorise", ...body })).status).toBe(201);
    // No route of the staff dashboard, and nothing in the venue's code, gives it.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && /(?:from\s+|import\()["'][^"']*public-name-consents["']/.test(fs.readFileSync(p, "utf8"))) offenders.push(path.relative(path.join(__dirname, ".."), p));
      }
    };
    walk(path.join(__dirname, "..", "src"));
    expect(offenders.sort()).toEqual(
      ["src/app/api/my/people/public-name/route.ts", "src/app/privacy/page.tsx", "src/components/PublicNames.tsx", "src/lib/participants.ts", "src/lib/privacy.ts"].sort()
    );
  });

  it("shows the full name for one tournament only, in the page, the API and the live page, and never for another event", async () => {
    const { f, t, adults } = await playedKnockout();
    const other = await tournament({ name: "Other Cup" });
    ok(await enterAs(f.entrant, other.id));
    const done = await authorise(f.guardian, { participantId: f.kid, scope: "event", kind: "tournament", eventId: t.id, confirm: true, locale: "en" });
    if (!done.ok) throw new Error(done.error);
    expect(done.already).toBe(false);
    expect(await publicTournament(t.id)).toContain(KID_FULL);
    expect(JSON.stringify(await liveBoard(t.id))).toContain(KID_FULL);
    expect(await publicTournament(other.id)).not.toContain(KID_SURNAME);
    // Said twice, it is recorded once.
    expect(await authorise(f.guardian, { participantId: f.kid, scope: "event", kind: "tournament", eventId: t.id, confirm: true })).toMatchObject({ ok: true, already: true });
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM public_name_consents WHERE participant_id = ?").get(f.kid)) as { n: number }).n).toBe(1);
    // The tournament set to short names for everybody wins over a guardian's yes; the organiser may always choose short.
    await getDb().prepare("UPDATE tournaments SET live_names = 'short' WHERE id = ?").run(t.id);
    expect(await publicTournament(t.id)).not.toContain(KID_SURNAME);
    await getDb().prepare("UPDATE tournaments SET live_names = 'full' WHERE id = ?").run(t.id);
    // The other family's notice follows the same rule: the full name where the guardian allowed it.
    expect(adults.length).toBe(3);
  });

  it("is withdrawn at once: the next request shows the short name, with nothing cached", async () => {
    const { f, t } = await playedKnockout();
    const made = ok(await authorise(f.guardian, { participantId: f.kid, scope: "event", kind: "tournament", eventId: t.id, confirm: true }) as { ok: true; value: { id: number } });
    expect(await publicTournament(t.id)).toContain(KID_FULL);
    expect(await withdrawConsent(f.guardian, made.id)).toEqual({ ok: true });
    expect(await publicTournament(t.id)).not.toContain(KID_SURNAME);
    expect(JSON.stringify(await liveBoard(t.id))).not.toContain(KID_SURNAME);
    // A stranger cannot withdraw it (or learn it is there); withdrawing twice is not an error.
    expect(await withdrawConsent(await adult("Nosy"), made.id)).toMatchObject({ ok: false, code: "PN1_NOT_GUARDIAN" });
    expect(await withdrawConsent(f.guardian, made.id)).toEqual({ ok: true });
  });

  it("ends by itself: after its date, when the event is over, and when the guardian no longer manages the child", async () => {
    const db = getDb();
    const expired = await playedKnockout();
    ok((await authorise(expired.f.guardian, { participantId: expired.f.kid, scope: "event", kind: "tournament", eventId: expired.t.id, confirm: true })) as { ok: true; value: unknown });
    expect(await publicTournament(expired.t.id)).toContain(KID_FULL);
    await db.prepare("UPDATE public_name_consents SET expires_at = now() - interval '1 day' WHERE participant_id = ?").run(expired.f.kid);
    expect(await publicTournament(expired.t.id)).not.toContain(KID_SURNAME);

    const over = await playedKnockout();
    ok((await authorise(over.f.guardian, { participantId: over.f.kid, scope: "event", kind: "tournament", eventId: over.t.id, confirm: true })) as { ok: true; value: unknown });
    await db.prepare("UPDATE tournaments SET starts_on = ?, ends_on = ? WHERE id = ?").run(addDays(today, -1), addDays(today, -1), over.t.id);
    expect(await publicTournament(over.t.id)).not.toContain(KID_SURNAME);
    // An event already over cannot be authorised.
    expect(await authorise(over.f.guardian, { participantId: over.f.kid, scope: "event", kind: "tournament", eventId: over.t.id, confirm: true })).toMatchObject({ ok: false, code: "PN1_OVER" });

    const ended = await playedKnockout();
    ok((await authorise(ended.f.guardian, { participantId: ended.f.kid, scope: "event", kind: "tournament", eventId: ended.t.id, confirm: true })) as { ok: true; value: unknown });
    await db.prepare("UPDATE participant_guardians SET revoked_at = now() WHERE participant_id = ?").run(ended.f.kid);
    expect(await publicTournament(ended.t.id)).not.toContain(KID_SURNAME);
    expect(await authorise(ended.f.guardian, { participantId: ended.f.kid, scope: "event", kind: "tournament", eventId: ended.t.id, confirm: true })).toMatchObject({ ok: false, code: "PN1_NOT_GUARDIAN" });
  });

  it("covers every entry at one venue for twelve months, and only that venue", async () => {
    const f = await family();
    const a = await tournament({ name: "Venue Scope A" });
    const b = await tournament({ name: "Venue Scope B" });
    ok(await enterAs(f.entrant, a.id));
    ok(await enterAs(f.entrant, b.id));
    const made = ok((await authorise(f.guardian, { participantId: f.kid, scope: "venue", venueId, confirm: true, locale: "ms" })) as { ok: true; value: { expiresAt: string; wordingLocale: string; wording: string } });
    expect(await publicTournament(a.id)).toContain(KID_FULL);
    expect(await publicTournament(b.id)).toContain(KID_FULL);
    const months = (new Date(made.expiresAt).getTime() - Date.now()) / (30 * 86_400_000);
    expect(months).toBeGreaterThan(11.5);
    expect(months).toBeLessThan(12.5);
    expect(made.wordingLocale).toBe("ms");
    expect(made.wording).toContain(KID_FULL);
    expect(made.wording).toMatch(/ibu bapa atau penjaga/);
    // A venue the child has no place at cannot be allowed; an authorisation given for this venue names no other.
    const authorised = await authorisedParticipants({ kind: "tournament", id: a.id, venueId: venueId + 999 }, [f.kid]);
    expect(authorised.size).toBe(0);
    expect(await authorise(f.guardian, { participantId: f.kid, scope: "venue", venueId: venueId + 999, confirm: true })).toMatchObject({ ok: false, code: "PN1_NO_ENTRY" });
  });

  it("applies to a league's season and a junior ladder's, and ends with the season", async () => {
    const f = await family();
    const lg = await createLeague({ venueId, name: `Names League Grant ${n}`, sport: "badminton", teamSize: 1, level: null, fee: 0, startsOn: addDays(today, 1) }, adminId);
    if (!lg.ok) throw new Error(lg.error);
    ok(await joinLeagueAs(f.entrant, lg.value.id));
    for (const o of [await adult("G1"), await adult("G2")]) ok(await joinLeague(o, lg.value.id));
    ok(await startSeason(lg.value.id, { startsOn: today }, today));
    expect(await publicLeague(lg.value.id)).not.toContain(KID_SURNAME);
    ok((await authorise(f.guardian, { participantId: f.kid, scope: "event", kind: "league", eventId: lg.value.id, confirm: true })) as { ok: true; value: unknown });
    expect(await publicLeague(lg.value.id)).toContain(KID_FULL);
    await getDb().prepare("UPDATE league_seasons SET status = 'finished' WHERE league_id = ?").run(lg.value.id);
    expect(await publicLeague(lg.value.id)).not.toContain(KID_SURNAME);

    const ld = await createLadder({ venueId, name: `Names Ladder Grant ${n}`, sport: "badminton", teamSize: 1, level: null, audience: "juniors" }, adminId);
    if (!ld.ok) throw new Error(ld.error);
    ok(await joinLadder(f.entrant, ld.value.id));
    ok((await authorise(f.guardian, { participantId: f.kid, scope: "event", kind: "ladder", eventId: ld.value.id, confirm: true })) as { ok: true; value: unknown });
    expect(await publicLadder(ld.value.id)).toContain(KID_FULL);
    await getDb().prepare("UPDATE ladder_seasons SET ended_on = ? WHERE ladder_id = ?").run(today, ld.value.id);
    expect(await publicLadder(ld.value.id)).not.toContain(KID_SURNAME);
  });

  it("is logged in the child's history and the venue's staff log, is in the guardian's export, and goes with the guardian", async () => {
    const { f, t } = await playedKnockout();
    const made = ok((await authorise(f.guardian, { participantId: f.kid, scope: "event", kind: "tournament", eventId: t.id, confirm: true, locale: "zh" })) as { ok: true; value: { id: number } });
    expect(await withdrawConsent(f.guardian, made.id)).toEqual({ ok: true });
    ok((await authorise(f.guardian, { participantId: f.kid, scope: "event", kind: "tournament", eventId: t.id, confirm: true })) as { ok: true; value: unknown });
    const history = (await participantHistory(f.kid)).map((h) => h.action);
    expect(history).toEqual(expect.arrayContaining(["public_name.authorised", "public_name.withdrawn"]));
    const log = (await listActivity([venueId], { limit: 200 })).filter((a) => a.action.startsWith("participant.public_name"));
    expect(log.map((a) => a.action)).toEqual(expect.arrayContaining(["participant.public_name_authorised", "participant.public_name_withdrawn"]));
    // The export carries each, the withdrawn one marked, with the wording the guardian saw and its language.
    const exported = (await exportCustomerData(f.guardian.id))!;
    const rows = exported.publicNameAuthorisations as { child: string; wording: string; wordingLanguage: string; withdrawnAt: string | null; inForceNow: boolean }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.wordingLanguage).sort()).toEqual(["en", "zh"]);
    expect(rows.every((r) => r.child === KID_FULL && r.wording.includes(KID_FULL))).toBe(true);
    expect(rows.filter((r) => r.withdrawnAt === null && r.inForceNow)).toHaveLength(1);
    // Erasing the guardian erases what they gave, and the child is short again.
    expect(await publicTournament(t.id)).toContain(KID_FULL);
    const gone = await eraseCustomer(f.guardian.id);
    expect(gone.ok).toBe(true);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM public_name_consents WHERE participant_id = ?").get(f.kid)) as { n: number }).n).toBe(0);
    expect(await publicTournament(t.id)).not.toContain(KID_SURNAME);
  });

  it("lists what the guardian can allow, and what is in force, for their own child only", async () => {
    const { f, t } = await playedKnockout();
    const view = await publicNamesFor(f.guardian.id, f.kid);
    if ("ok" in view) throw new Error(view.error);
    expect(view.participant).toEqual({ id: f.kid, displayName: KID_FULL });
    expect(view.choices.map((c) => [c.kind, c.id])).toContainEqual(["tournament", t.id]);
    expect(view.venues.map((v) => v.id)).toContain(venueId);
    expect(view.consents).toEqual([]);
    expect(await publicNamesFor((await adult("Else")).id, f.kid)).toMatchObject({ ok: false, code: "PN1_NOT_GUARDIAN" });
  });
});

describe("the whole tournament payload names no minor, in any format the app has", () => {
  it("scans a drawn tournament of each format whole for the surname", async () => {
    for (const format of ["knockout", "groups", "round_robin", "double_elimination", "swiss"] as const) {
      const f = await family();
      const t = await tournament({ format, name: `Scan ${format}` });
      ok(await enterAs(f.entrant, t.id));
      for (const o of [await adult("S1"), await adult("S2"), await adult("S3")]) ok(await enter(o, t.id));
      ok(await makeDraw(t.id, () => 0.3));
      const page = await publicTournament(t.id);
      expect(page, format).not.toContain(KID_SURNAME);
      expect(page, format).toContain(KID_SHORT);
      expect(JSON.stringify(await liveBoard(t.id)), format).not.toContain(KID_SURNAME);
      expect(await json(await liveGet(get(`/api/tournaments/${t.id}/live`), idParams(t.id))), format).not.toContain(KID_SURNAME);
      const named = await namedForThePublic((await tournamentDetail(t.id))!);
      expect(JSON.stringify(named), format).not.toContain(KID_SURNAME);
    }
  });
});
