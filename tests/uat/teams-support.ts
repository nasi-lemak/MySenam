import fs from "fs";
import { expect, inject } from "vitest";
import type { Locator, Page } from "playwright-core";
import { signUp, url, type Actor, type Device, type Scenario } from "./harness";

/**
 * What the team and team-league scenarios share (setup, not their subject):
 * a club of their own with badminton courts, a manager and a front desk; adults
 * and children made through the app's API; teams made the way the pages make
 * them (a captain's link, a member accepting it); a league of teams set up and
 * entered through the API where it is not the subject; the dashboard's Leagues
 * tab; the emails the app sent, read from its output; and a look at a venue's
 * own booking page for what is taken.
 */

export const CLUB_PASSWORD = "a club manager's long password";

const serverLog = inject("uatServerLog");

export interface Club {
  venueId: number;
  name: string;
  courtIds: number[];
  courtNames: string[];
  manager: { email: string; name: string };
  desk: { email: string; name: string };
}

/** A live club with badminton courts (two unless said), a manager and a front-desk account, made by the platform's owner. */
export async function clubVenue(owner: Actor, label: string, courts = 2): Promise<Club> {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const name = `${label} ${stamp}`;
  const made = await owner.api("POST", "/api/admin/venues", { name, area: "Shah Alam", address: "8 Jalan Kristal 7/71, Shah Alam", phone: "03-5510 7000" });
  if (made.status !== 201) throw new Error(`venue: ${JSON.stringify(made.body)}`);
  const venueId = (made.body.venue as { id: number }).id;
  const courtIds: number[] = [];
  const courtNames = Array.from({ length: courts }, (_, i) => `Court ${i + 1}`);
  for (const court of courtNames) {
    const c = await owner.api("POST", "/api/admin/courts", { venueId, sport: "badminton", name: court, offPeakRate: 15, peakRate: 22, capacity: 1, deposit: 0 });
    if (c.status >= 300) throw new Error(`court: ${JSON.stringify(c.body)}`);
    courtIds.push(((c.body.courts as { id: number }[] | undefined)?.[0] ?? (c.body.court as { id: number })).id);
  }
  const staff = {
    manager: { email: `club-manager-${stamp}@uat.mysenam.test`, name: `${label} Manager` },
    desk: { email: `club-desk-${stamp}@uat.mysenam.test`, name: `${label} Desk` },
  };
  for (const role of ["manager", "desk"] as const) {
    const r = await owner.api("POST", "/api/admin/admins", { name: staff[role].name, email: staff[role].email, password: CLUB_PASSWORD, venueId, role });
    if (r.status >= 300) throw new Error(`${role}: ${JSON.stringify(r.body)}`);
  }
  return { venueId, name, courtIds, courtNames, ...staff };
}

/** Member of staff signed in through the API (setup): their browser then carries the session. */
export async function staffApi(a: Actor, email: string): Promise<Actor> {
  const res = await a.api("POST", "/api/admin/auth/login", { email, password: CLUB_PASSWORD });
  if (res.status !== 200) throw new Error(`staff sign-in: ${res.status} ${JSON.stringify(res.body)}`);
  return a;
}

/** Signed in on the dashboard's own page, on its Leagues tab. */
export async function staffOnLeagues(a: Actor, email: string): Promise<void> {
  a.page.on("dialog", (d) => void d.accept());
  await a.page.goto(`${url}/admin`);
  await a.page.getByLabel("Email").fill(email);
  await a.page.getByLabel("Password").fill(CLUB_PASSWORD);
  await a.page.getByRole("button", { name: "Sign in" }).click();
  await a.page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
  await a.page.getByRole("button", { name: "Leagues", exact: true }).click();
  await a.page.getByText("Leagues of teams", { exact: true }).first().waitFor();
}

/** The dashboard's *Leagues of teams* panel, opened (it is read only once opened). */
export function leaguesOfTeams(page: Page): Locator {
  return page.locator("details").filter({ has: page.locator("summary", { hasText: "Leagues of teams" }) });
}

export async function openLeaguesOfTeams(page: Page): Promise<Locator> {
  const panel = leaguesOfTeams(page);
  if (!(await panel.evaluate((el) => (el as HTMLDetailsElement).open))) await panel.locator("summary").click();
  return panel;
}

// ------------------------------------------------------------ people and teams

/** An adult who has said so in their profile, signed in in their own browser. */
export async function adult(s: Scenario, name: string, device: Device = "desktop"): Promise<Actor> {
  return signUp(await s.actor(name, device), { profile: { adult: true } });
}

/** A child on this adult's account (as a parent), through the API: the participant's id. */
export async function addChild(parent: Actor, name: string, birthYear = 2014): Promise<number> {
  const r = await parent.api("POST", "/api/my/people", { displayName: name, birthYear, relationship: "parent", authority: true });
  if (r.status !== 201 && r.status !== 200) throw new Error(`child ${name}: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body.person as { id: number }).id;
}

export interface MyTeam {
  id: number;
  name: string;
  captain: Actor;
  members: Actor[];
}

/** The token in an invitation link. */
export const tokenOf = (link: string) => new URL(link).searchParams.get("token")!;

/**
 * A team the way its pages make it, through the API: the captain starts it and gives each member a link of their own, which that
 * member accepts with their own account. `declare` gives each member's date of birth (their own word, for an event's age range).
 */
export async function makeTeam(captain: Actor, name: string, members: Actor[], opts: { declare?: Record<string, { birthDate?: string; gender?: string }>; sport?: string; published?: boolean } = {}): Promise<MyTeam> {
  const made = await captain.api("POST", "/api/teams", { name, sport: opts.sport ?? "badminton", published: opts.published ?? false });
  if (made.status !== 201) throw new Error(`team ${name}: ${made.status} ${JSON.stringify(made.body)}`);
  const id = (made.body.team as { id: number }).id;
  for (const m of members) {
    const link = await captain.api("POST", `/api/teams/${id}`, { action: "inviteLink" });
    if (link.status !== 201) throw new Error(`link for ${m.name}: ${JSON.stringify(link.body)}`);
    const joined = await m.api("POST", "/api/team-invitations", { token: tokenOf(link.body.link as string), ...(opts.declare?.[m.name] ?? {}) });
    if (joined.status >= 300) throw new Error(`${m.name} joins ${name}: ${joined.status} ${JSON.stringify(joined.body)}`);
  }
  return { id, name, captain, members };
}

/** A team's roster as one of its members sees it: the members' ids on the team, by the name shown. */
export async function rosterIds(a: Actor, teamId: number): Promise<Record<string, number>> {
  const r = await a.api("GET", `/api/teams/${teamId}`);
  const roster = (r.body.team as { roster?: { id: number; name: string | null }[] }).roster ?? [];
  return Object.fromEntries(roster.filter((m) => m.name).map((m) => [m.name!, m.id]));
}

// ------------------------------------------------------------ team leagues, through the API

export interface LeagueFixture {
  id: number;
  date: string;
  startMin: number;
  minutes: number;
  courtId: number | null;
  courtName: string | null;
  home: { id: number; name: string };
  away: { id: number; name: string };
  status: string;
  version: number;
}

export interface LeagueView {
  id: number;
  name: string;
  status: string;
  courts: { id: number; name: string }[];
  fixtures: LeagueFixture[];
  standings: { leagueTeamId: number; name: string; position: number; played: number; won: number; drawn: number; lost: number; points: number }[];
  entered: { id: number; name: string; teamId: number | null; withdrawn: boolean }[];
}

/** The league as anybody sees it: no account, so nothing but what is public. */
export async function publicLeague(id: number): Promise<LeagueView> {
  const res = await fetch(`${url}/api/team-leagues/${id}`);
  return ((await res.json()) as { league: LeagueView }).league;
}

/** A league of teams set up by the club's manager, through the API (setup): its id. */
export async function setUpLeague(manager: Actor, club: Club, over: Record<string, unknown> = {}): Promise<number> {
  const stamp = Date.now().toString(36);
  const made = await manager.api("POST", "/api/admin/team-leagues", {
    venueId: club.venueId,
    name: `Shah Alam League ${stamp}`,
    sport: "badminton",
    legs: 1,
    startsOn: dayOffset(0),
    endsOn: dayOffset(150),
    courtIds: club.courtIds,
    ...over,
  });
  if (made.status !== 201) throw new Error(`league: ${made.status} ${JSON.stringify(made.body)}`);
  return (made.body.league as { id: number }).id;
}

/** A team entered by its captain with everybody on it, through the API (setup): its place in the league. */
export async function enterLeague(team: MyTeam, leagueId: number, extra: { homeCourtId?: number; blackouts?: string[] } = {}): Promise<number> {
  const ids = Object.values(await rosterIds(team.captain, team.id));
  const r = await team.captain.api("POST", `/api/team-leagues/${leagueId}`, { action: "enter", teamId: team.id, memberIds: ids, ...extra });
  if (r.status !== 201) throw new Error(`${team.name} enters: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body.league as LeagueView).entered.find((e) => e.teamId === team.id)!.id;
}

/** The fixture list made by the manager, through the API (setup), on `count` weekly nights starting today. */
export async function makeFixtures(manager: Actor, leagueId: number, count: number, startMin = 19 * 60): Promise<LeagueView> {
  const nights = Array.from({ length: count }, (_, i) => ({ date: dayOffset(i * 7), startMin }));
  const r = await manager.api("POST", `/api/admin/team-leagues/${leagueId}`, { action: "generate", nights });
  if (r.status !== 200) throw new Error(`fixtures: ${r.status} ${JSON.stringify(r.body)}`);
  return publicLeague(leagueId);
}

/** A date `days` ahead, in Malaysia. */
export function dayOffset(days: number): string {
  return new Date(Date.now() + 8 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);
}

// ------------------------------------------------------------ what the app emailed

export interface Mail {
  subject: string;
  text: string;
}

/** The emails the app sent to one address, from its output (`[outbox] email → <to>`, the subject, then the text). */
export function emailsTo(address: string): Mail[] {
  if (!serverLog || !fs.existsSync(serverLog)) return [];
  return fs
    .readFileSync(serverLog, "utf8")
    .split("[outbox] ")
    .filter((chunk) => chunk.startsWith(`email → ${address}\n`))
    .map((chunk) => {
      const lines = chunk.split("\n").slice(1);
      const end = lines.findIndex((l, i) => i > 0 && l.startsWith("["));
      const body = (end < 0 ? lines : lines.slice(0, end)).join("\n").trim();
      return { subject: lines[0], text: body.slice(lines[0].length).trim() };
    });
}

/**
 * The messages waiting to go out are sent when somebody opens a venue's messages (or the platform's, for the owner): the
 * scenario's servers run no scheduler. `who` is signed in to the dashboard (through the API or the page).
 */
export async function sendWaiting(who: Actor, venueId: number | "platform"): Promise<void> {
  const r = await who.api("GET", venueId === "platform" ? "/api/admin/messages?platform=1" : `/api/admin/messages?venueId=${venueId}`);
  if (r.status !== 200) throw new Error(`messages: ${r.status}`);
}

/** The one email to this address whose subject matches, once it has gone out; `n` how many there must be (default one). */
export async function emailed(who: Actor, venueId: number | "platform", address: string, subject: RegExp, opts: { n?: number; timeout?: number } = {}): Promise<Mail> {
  const deadline = Date.now() + (opts.timeout ?? 25_000);
  for (;;) {
    await sendWaiting(who, venueId);
    const found = emailsTo(address).filter((m) => subject.test(m.subject));
    if (found.length === (opts.n ?? 1)) return found.at(-1)!;
    if (found.length > (opts.n ?? 1)) throw new Error(`${found.length} emails to ${address} match ${subject}: ${found.map((m) => m.subject).join(" | ")}`);
    if (Date.now() > deadline) throw new Error(`No email to ${address} matching ${subject} (found: ${emailsTo(address).map((m) => m.subject).join(" | ") || "none"})`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** The link in an email that leads into this site, whose path matches. */
export function linkIn(mail: Mail, path: RegExp): string {
  const links = [...mail.text.matchAll(/https?:\/\/[^\s)]+/g)].map((m) => m[0].replace(/[.,]$/, ""));
  const ours = links.filter((l) => l.startsWith(`${url}/`) && path.test(new URL(l).pathname));
  if (ours.length < 1) throw new Error(`Expected a ${path} link in "${mail.subject}", found: ${links.join(", ") || "none"}`);
  return ours[0];
}

// ------------------------------------------------------------ the venue's own booking page

/**
 * What the venue's own booking page shows for one court on a day, from the page itself (what a customer would see): the start
 * times of the cells of its grid that are free, and of those that are taken (a booking, a block, a league's hold).
 */
export async function boardCells(page: Page, venueId: number, date: string, courtName: string): Promise<{ free: number[]; taken: number[] }> {
  await page.goto(`${url}/venue/${venueId}?date=${date}&sport=badminton`);
  const row = page
    .locator("tbody tr")
    .filter({ hasText: new RegExp(`^\\s*${courtName}(?!\\d)`) })
    .first();
  await row.waitFor();
  return row.evaluate((tr) => {
    const minutes = Array.from(tr.closest("table")!.querySelectorAll("thead th[data-minute]")).map((th) => Number((th as HTMLElement).dataset.minute));
    const out = { free: [] as number[], taken: [] as number[] };
    Array.from(tr.querySelectorAll("td"))
      .slice(1)
      .forEach((td, i) => {
        const text = (td.textContent ?? "").trim();
        (text === "+" || text === "—" ? out.taken : out.free).push(minutes[i]);
      });
    return out;
  });
}

/** A fixture's court time is taken for a customer, and free again once it is gone: from the availability the venue's page itself reads. */
export async function startsOn(venueId: number, date: string, courtId: number): Promise<number[]> {
  const res = await fetch(`${url}/api/availability?venueId=${venueId}&date=${date}&sport=badminton`);
  const { availability } = (await res.json()) as { availability: { court: { id: number }; starts: { minute: number; maxLength: number }[] }[] };
  return availability.find((c) => c.court.id === courtId)?.starts.map((s) => s.minute) ?? [];
}

/** Nothing on the page is cut off by the screen's width. */
export async function noSideScroll(page: Page): Promise<void> {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, "the page is wider than the screen").toBeLessThanOrEqual(0);
}
