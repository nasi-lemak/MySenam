import fs from "fs";
import type { Locator, Page } from "playwright-core";
import { expect, inject } from "vitest";
import { dayAhead, openDashboardTab, signUp, url, type Actor, type Scenario } from "./harness";

/**
 * What the tournament-format and tournament-day scenarios share (setup, not
 * their subject): a venue of its own with badminton courts, a manager and a
 * front desk; signing staff in on the dashboard and opening a tournament;
 * players made and entered through the API; reading a tournament as the public
 * page's own API gives it; and entering a result on the dashboard's list of
 * matches, the way staff do.
 */

export const STAFF_PASSWORD = "a tournament organiser's long password";

export interface FormatsVenue {
  venueId: number;
  name: string;
  courtIds: number[];
  manager: { email: string; name: string };
  desk: { email: string; name: string };
}

/**
 * A live venue with `courts` badminton courts, made by the platform's owner, with a manager and a front-desk
 * account. `hours` sets its opening hours (the tournament-day scenario runs on the real day, whatever time it is).
 */
export async function formatsVenue(owner: Actor, label: string, opts: { courts?: number; openMin?: number; closeMin?: number } = {}): Promise<FormatsVenue> {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`;
  const name = `${label} ${stamp}`;
  const made = await owner.api("POST", "/api/admin/venues", { name, area: "Shah Alam", address: "8 Jalan Kristal 7/71, Shah Alam", phone: "03-5510 7000" });
  if (made.status !== 201) throw new Error(`venue: ${JSON.stringify(made.body)}`);
  const venueId = (made.body.venue as { id: number }).id;
  const courtIds: number[] = [];
  for (let i = 1; i <= (opts.courts ?? 2); i++) {
    const c = await owner.api("POST", "/api/admin/courts", { venueId, sport: "badminton", name: `Court ${i}`, offPeakRate: 15, peakRate: 22, capacity: 1, deposit: 0 });
    if (c.status >= 300) throw new Error(`court: ${JSON.stringify(c.body)}`);
    courtIds.push(((c.body.courts as { id: number }[] | undefined)?.[0] ?? (c.body.court as { id: number })).id);
  }
  if (opts.openMin !== undefined || opts.closeMin !== undefined) {
    const hours = await owner.api("PATCH", `/api/admin/venues/${venueId}`, { openMin: opts.openMin ?? 8 * 60, closeMin: opts.closeMin ?? 23 * 60 });
    if (hours.status >= 300) throw new Error(`hours: ${JSON.stringify(hours.body)}`);
  }
  const staff = {
    manager: { email: `organiser-${stamp}@uat.mysenam.test`, name: `${label} Organiser` },
    desk: { email: `desk-${stamp}@uat.mysenam.test`, name: `${label} Desk` },
  };
  for (const role of ["manager", "desk"] as const) {
    const r = await owner.api("POST", "/api/admin/admins", { name: staff[role].name, email: staff[role].email, password: STAFF_PASSWORD, venueId, role });
    if (r.status >= 300) throw new Error(`${role}: ${JSON.stringify(r.body)}`);
  }
  return { venueId, name, courtIds, ...staff };
}

/** Staff signed in through the API (setup); their browser then carries the session. */
export async function staffApi(a: Actor, email: string): Promise<Actor> {
  const res = await a.api("POST", "/api/admin/auth/login", { email, password: STAFF_PASSWORD });
  if (res.status !== 200) throw new Error(`staff sign-in: ${res.status} ${JSON.stringify(res.body)}`);
  return a;
}

/** Signed in to the dashboard on its page, on the Tournaments tab; every confirmation the screen asks is answered yes. */
export async function staffOnTournaments(a: Actor, email: string, base: string = url): Promise<void> {
  a.page.on("dialog", (d) => void d.accept());
  await a.page.goto(`${base}/admin`);
  // Already signed in (through the API, as setup)? Then there is no form to fill.
  const emailField = a.page.getByLabel("Email");
  const signOut = a.page.getByRole("button", { name: /sign out/i });
  await emailField.or(signOut).first().waitFor();
  if ((await emailField.count()) > 0) {
    await emailField.fill(email);
    await a.page.getByLabel("Password").fill(STAFF_PASSWORD);
    await a.page.getByRole("button", { name: "Sign in" }).click();
  }
  await signOut.waitFor({ timeout: 15_000 });
  await openDashboardTab(a.page, "Tournaments");
  await a.page.getByRole("heading", { name: "Tournaments", exact: true }).waitFor();
}

/** A tournament opened from the dashboard's list (from the tab, or back from another tournament). */
export async function openTournament(page: Page, name: string): Promise<void> {
  const back = page.getByRole("button", { name: /^← |Back to/ });
  if ((await back.count()) > 0) await back.first().click();
  await page.locator("li").filter({ hasText: name }).getByRole("button", { name: "Open", exact: true }).click();
  await page.getByRole("heading", { name: new RegExp(`^${escape(name)}`) }).waitFor();
}

export const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ------------------------------------------------------------ what the public page's data says

export interface Match {
  id: number;
  stage: string;
  bracket: string;
  round: number;
  position: number;
  placement: number | null;
  a: number | null;
  b: number | null;
  winner: number | null;
  status: string;
  score: string | null;
  date: string | null;
  minute: number | null;
  minutes: number;
  courtId: number | null;
  courtName: string | null;
  groupNo: number | null;
}

export interface Detail {
  id: number;
  name: string;
  status: string;
  startsOn: string;
  entries: { id: number; name: string; status: string; seed?: number | null }[];
  matches: Match[];
  issues: { id: number; status: string; wrongEntry: number; rightEntry: number | null }[];
  placings: { entryId: number; place: number }[] | null;
  drawOrder?: number[] | null;
  corrections: { kind: string; reason: string }[];
  swiss?: {
    seed?: number | null;
    roundsTotal: number;
    rounds: { round: number; complete: boolean; notes: { kind: string; a: number; b: number | null; float?: boolean }[] }[];
    standings: { entryId: number; rank: number; points: number; buchholz: number; medianBuchholz: number; byes: number; won: number; lost: number }[];
    tiebreaks: string[];
    nextRound: number | null;
    blocked: string | null;
  } | null;
}

/** A tournament as anybody's browser gets it from the public API. */
export async function publicDetail(id: number, base: string = url): Promise<Detail> {
  const res = await fetch(`${base}/api/tournaments/${id}`);
  return ((await res.json()) as { tournament: Detail }).tournament;
}

/** A tournament as its staff see it (managers: the same, with what only staff see). */
export async function staffDetail(a: Actor, id: number): Promise<Detail> {
  const res = await a.api("GET", `/api/admin/tournaments/${id}`);
  if (res.status !== 200) throw new Error(`tournament ${id}: ${JSON.stringify(res.body)}`);
  return res.body.tournament as Detail;
}

/** The score of a straight win for `winner`, written from side A's view as every score is. */
export const straightWin = (m: Pick<Match, "a">, winner: number | null, games = ["21-15", "21-17"]) =>
  (winner === m.a ? games : games.map((g) => g.split("-").reverse().join("-"))).join(", ");

/** A name on a page: entries are "<First> Tester" for the people made by `players`. */
export const nameOf = (d: Pick<Detail, "entries">, id: number | null): string => (id === null ? "" : (d.entries.find((e) => e.id === id)?.name ?? "?"));
export const firstName = (full: string) => full.split(" ")[0];

// ------------------------------------------------------------ the dashboard's list of matches

/** A fixture on the dashboard's list of matches, by who plays in it. */
export function staffRow(page: Page, a: string, b: string): Locator {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Matches", exact: true }) })
    .locator("li")
    .filter({ hasText: a })
    .filter({ hasText: b });
}

/** A result entered on the dashboard: the score, side A's first, then who won. Waits until the list says it is in. */
export async function enterOnDashboard(page: Page, a: string, b: string, score: string, winner: string): Promise<void> {
  // Not a row already decided between the same two (a replay, a rematch): the one still to play.
  const row = staffRow(page, a, b).filter({ hasNot: page.getByText("✓") }).first();
  await row.getByPlaceholder("21-15, 18-21, 21-10").fill(score);
  await row.getByRole("button", { name: `${firstName(winner)} won`, exact: true }).click();
  await staffRow(page, a, b).filter({ hasText: `✓ ${score}` }).first().waitFor();
}

/** The next match whose two sides are known and which is still to play, in the order the draw made it, by an entry's name. */
export function playable(d: Detail, filter: (m: Match) => boolean = () => true): Match | undefined {
  return d.matches
    .filter((m) => m.status === "scheduled" && m.a !== null && m.b !== null && (m.stage === "group" || m.stage === "knockout") && filter(m))
    .sort((x, y) => (x.date ?? "").localeCompare(y.date ?? "") || (x.minute ?? 0) - (y.minute ?? 0) || x.id - y.id)[0];
}

// ------------------------------------------------------------ players

/**
 * Players made through the sign-up flow, each in a browser of their own, entered in a tournament (setup). Their names are
 * "<name> Tester", so give names no first name of which is another's.
 */
export async function players(s: Scenario, names: string[], tournamentId: number, device: "desktop" | "phone" = "desktop"): Promise<Actor[]> {
  const actors: Actor[] = [];
  for (const n of names) actors.push(await s.actor(n, device));
  // One after another: a sign-up takes a fraction of a second, and sign-ups at once can leave a queued email unsent where no scheduler runs.
  for (const a of actors) await signUp(a);
  for (const p of actors) {
    const r = await p.api("POST", `/api/tournaments/${tournamentId}`, { action: "enter" });
    if (r.status !== 201) throw new Error(`entry for ${p.name}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return actors;
}

/** The actor whose entry in this tournament is `entryName`. */
export const playerOf = (people: Actor[], entryName: string): Actor => {
  const found = people.find((p) => entryName === `${p.name} Tester`);
  if (!found) throw new Error(`Nobody called ${entryName}`);
  return found;
};

/** A tournament's day, as the venue's own staff read it, `days` ahead in Malaysia (the harness's dayAhead). */
export const dayOf = (days: number) => dayAhead(days);

/** Seed: the entry an actor made, by name (setup; seeds put byes where the scenario wants them). */
export async function seed(manager: Actor, tournamentId: number, entryName: string, n: number): Promise<void> {
  const d = await staffDetail(manager, tournamentId);
  const entry = d.entries.find((e) => e.name === entryName);
  if (!entry) throw new Error(`No entry for ${entryName}`);
  const r = await manager.api("POST", `/api/admin/tournaments/${tournamentId}/entries/${entry.id}`, { seed: n });
  if (r.status !== 200) throw new Error(`seed ${entryName}: ${r.status} ${JSON.stringify(r.body)}`);
}

/** People signed up through the sign-up flow, all at once (setup); entered in tournaments by `enterAll`. */
export async function accounts(s: Scenario, names: string[], device: "desktop" | "phone" = "desktop"): Promise<Actor[]> {
  const actors: Actor[] = [];
  for (const n of names) actors.push(await s.actor(n, device));
  for (const a of actors) await signUp(a);
  return actors;
}

/** People who already have accounts, entered in another tournament through the API (setup). */
export async function enterAll(people: Actor[], tournamentId: number): Promise<void> {
  for (const p of people) {
    const r = await p.api("POST", `/api/tournaments/${tournamentId}`, { action: "enter" });
    if (r.status !== 201) throw new Error(`entry for ${p.name}: ${r.status} ${JSON.stringify(r.body)}`);
  }
}

/** The tournament a form made, by its name, from the staff list. */
export async function tournamentNamed(a: Actor, venueId: number, name: string): Promise<number> {
  const list = await a.api("GET", `/api/admin/tournaments?venueId=${venueId}`);
  const found = (list.body.tournaments as { id: number; name: string }[]).find((t) => t.name === name);
  if (!found) throw new Error(`No tournament called ${name}`);
  return found.id;
}

/**
 * The venue's queued messages sent. The acceptance server has no scheduler and sends 25 messages whenever its outbox is
 * opened, oldest first: a tournament queues a message for everybody at every draw and result, so what a scenario leaves
 * would stand in front of the sign-up emails of the scenarios after it. Opening the venue's messages as staff runs the outbox.
 */
export async function drainOutbox(staff: Actor, venueId: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const res = await staff.api("GET", `/api/admin/messages?venueId=${venueId}`);
    if (res.status !== 200) throw new Error(`messages: ${res.status}`);
    if (((res.body.summary as { queued: number } | null)?.queued ?? 0) === 0) return;
  }
  throw new Error("The venue's messages did not drain.");
}

// ------------------------------------------------------------ phones

/** Nothing on the page is wider than the screen: nobody has to scroll sideways. */
export async function fits(page: Page): Promise<void> {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, `the page is ${over}px wider than the screen`).toBeLessThanOrEqual(0);
}

// ------------------------------------------------------------ the emails the server sent

const serverLog = inject("uatServerLog");

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** The emails the app has sent so far, from its output (`[outbox] email → <to>`, the subject, then the text), in order. */
export function sentEmails(output?: () => string): Mail[] {
  const text = output ? output() : serverLog && fs.existsSync(serverLog) ? fs.readFileSync(serverLog, "utf8") : "";
  return text
    .split("[outbox] ")
    .filter((chunk) => chunk.startsWith("email → "))
    .map((chunk) => {
      const lines = chunk.split("\n");
      const to = lines[0].slice("email → ".length).trim();
      const end = lines.findIndex((l, i) => i > 1 && l.startsWith("["));
      const body = (end < 0 ? lines.slice(1) : lines.slice(1, end)).join("\n").trim();
      const subject = lines[1] ?? "";
      return { to, subject, text: body.slice(subject.length).trim() };
    });
}

/** The emails to one address whose subject or text matches, once at least `count` of them have gone out (sending is not awaited by every path). */
export async function emailsTo(address: string, match: RegExp, count = 1, timeout = 20_000, output?: () => string): Promise<Mail[]> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = sentEmails(output).filter((m) => m.to === address && match.test(`${m.subject}\n${m.text}`));
    if (found.length >= count) return found;
    if (Date.now() > deadline) throw new Error(`Expected ${count} email(s) to ${address} matching ${match}, found ${found.length}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
