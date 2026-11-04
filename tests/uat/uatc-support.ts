import fs from "fs";
import type { Locator, Page } from "playwright-core";
import { inject } from "vitest";
import { OWNER } from "../e2e/server";
import { dayAhead, signUp, url, type Actor, type Scenario } from "./harness";

/**
 * What the climbing, ladder and rankings scenarios share (setup, not their subject): a venue of their own for one sport with a manager and a
 * front desk, staff signed in on the dashboard, the emails the app sent (read from its output), and a few helpers for the judge's grid.
 */

export const PASSWORD = "an organiser's long password";

export interface Site {
  venueId: number;
  name: string;
  courtIds: number[];
  manager: { email: string; name: string };
  desk: { email: string; name: string };
}

/** A live venue with `courts` courts for one sport, a manager and a front-desk account. Made by the platform's owner. */
export async function site(owner: Pick<Person, "api">, label: string, sport = "badminton", courts = 2): Promise<Site> {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const name = `${label} ${stamp}`;
  const made = await owner.api("POST", "/api/admin/venues", { name, area: "Subang Jaya", address: "12 Jalan SS 15/4, Subang Jaya", phone: "03-5632 1000" });
  if (made.status !== 201) throw new Error(`venue: ${JSON.stringify(made.body)}`);
  const venueId = (made.body.venue as { id: number }).id;
  const courtIds: number[] = [];
  for (let i = 1; i <= courts; i++) {
    const c = await owner.api("POST", "/api/admin/courts", { venueId, sport, name: `Court ${i}`, offPeakRate: 15, peakRate: 22, capacity: 1, deposit: 0 });
    if (c.status >= 300) throw new Error(`court: ${JSON.stringify(c.body)}`);
    courtIds.push(((c.body.courts as { id: number }[] | undefined)?.[0] ?? (c.body.court as { id: number })).id);
  }
  const staff = { manager: { email: `uatc-manager-${stamp}@uat.mysenam.test`, name: `${label} Manager` }, desk: { email: `uatc-desk-${stamp}@uat.mysenam.test`, name: `${label} Desk` } };
  for (const role of ["manager", "desk"] as const) {
    const r = await owner.api("POST", "/api/admin/admins", { name: staff[role].name, email: staff[role].email, password: PASSWORD, venueId, role });
    if (r.status >= 300) throw new Error(`${role}: ${JSON.stringify(r.body)}`);
  }
  return { venueId, name, courtIds, ...staff };
}

/** Signed in on the dashboard's own page; every confirmation the screen asks is answered yes. */
export async function staffSignIn(a: Actor, email: string): Promise<void> {
  a.page.on("dialog", (d) => void d.accept());
  await a.page.goto(`${url}/admin`);
  await a.page.getByLabel("Email").fill(email);
  await a.page.getByLabel("Password").fill(PASSWORD);
  await a.page.getByRole("button", { name: "Sign in" }).click();
  await a.page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
}

/** A dashboard tab opened by its name. */
export async function openTab(page: Page, tab: string, heading: string | null = tab): Promise<void> {
  await page.getByRole("button", { name: tab, exact: true }).click();
  if (heading) await page.getByRole("heading", { name: heading, exact: true }).waitFor();
}

/** An item of a dashboard list (a tournament, a league), opened from its row. */
export async function openListed(page: Page, name: string): Promise<void> {
  await page.locator("li").filter({ hasText: name }).getByRole("button", { name: "Open", exact: true }).click();
  await page.getByRole("heading", { name: new RegExp(`^${name}`) }).waitFor();
}

// ---------------------------------------------------------------- emails

const serverLog = inject("uatServerLog");

/** The emails the app sent to one address, from its output (MYSENAM_SEND=log writes `[outbox] email → <to>`, the subject, then the text). */
export function emailsTo(address: string): { subject: string; text: string }[] {
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

/** Whether the server's output is there to be read (a deployment's is not the acceptance server's). */
export const canReadEmails = (): boolean => !!serverLog && fs.existsSync(serverLog);

/** The email to this address whose subject matches, once it has gone out (the outbox is sent when the manager's messages are opened, as the scheduler would). */
export async function emailed(address: string, subject: RegExp, opts: { nudge?: () => Promise<unknown>; timeout?: number } = {}): Promise<{ subject: string; text: string }> {
  const deadline = Date.now() + (opts.timeout ?? 25_000);
  for (;;) {
    const found = emailsTo(address).filter((m) => subject.test(m.subject));
    if (found.length > 0) return found[0];
    if (Date.now() > deadline) throw new Error(`No email to ${address} matching ${subject}; sent: ${emailsTo(address).map((m) => m.subject).join(" | ") || "none"}`);
    await opts.nudge?.();
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ---------------------------------------------------------------- people

/**
 * A person who only does things through the API: no browser of their own, so nothing for the scenario to record and close (every browser context costs
 * a trace and a video, and closing a dozen of them takes minutes).
 */
export interface Person {
  name: string;
  email: string;
  password: string;
  phone: string;
  id?: number;
  api(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
}

const signUpLog = inject("uatSignUpLog");
let personCounter = 0;
const RUN = Date.now().toString(36);

/** A request-only client with its own cookies and address, as the harness's actors are. */
function client(): Pick<Person, "api"> {
  const jar = new Map<string, string>();
  const ip = `10.${(process.pid % 200) + 20}.${240 + Math.floor(++personCounter / 250)}.${personCounter % 250}`;
  return {
    async api(method, path, body) {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: { "content-type": "application/json", origin: url, "x-forwarded-for": ip, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const eq = pair.indexOf("=");
        jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    },
  };
}

/** Customer accounts made without a browser, all at once (the sign-up emails go out together): the address asked for, the emailed link followed, the rest given there. */
export async function apiPeople(names: string[], opts: { profile?: Record<string, unknown> } = {}): Promise<Record<string, Person>> {
  const made = names.map((name): Person => {
    const n = ++personCounter;
    return { name, email: `uatc-${RUN}-${n}@uat.mysenam.test`, password: "an acceptance-test password", phone: `0139${String(process.pid % 100).padStart(2, "0")}${String(n).padStart(4, "0")}`, ...client() };
  });
  await Promise.all(
    made.map(async (p) => {
      const asked = await p.api("POST", "/api/auth/register", { email: p.email });
      if (asked.status !== 202) throw new Error(`register ${p.name}: ${asked.status}`);
      const deadline = Date.now() + 25_000;
      let token: string | undefined;
      for (;;) {
        const out = signUpLog && fs.existsSync(signUpLog) ? fs.readFileSync(signUpLog, "utf8") : "";
        token = out
          .split("[outbox] ")
          .filter((chunk) => chunk.startsWith(`email → ${p.email}\n`))
          .map((chunk) => /\/register\?token=([A-Za-z0-9_-]+)/.exec(chunk)?.[1])
          .filter(Boolean)
          .at(-1);
        if (token) break;
        if (Date.now() > deadline) throw new Error(`No sign-up link was emailed to ${p.email}`);
        await new Promise((r) => setTimeout(r, 200));
      }
      const done = await p.api("POST", "/api/auth/register/complete", { token, name: `${p.name} Tester`, phone: p.phone, password: p.password });
      if (done.status !== 201) throw new Error(`register ${p.name}: ${done.status} ${JSON.stringify(done.body)}`);
      p.id = (done.body.user as { id: number }).id;
      if (opts.profile) {
        const r = await p.api("PUT", "/api/my/profile", opts.profile);
        if (r.status !== 200) throw new Error(`profile ${p.name}: ${JSON.stringify(r.body)}`);
      }
    })
  );
  return Object.fromEntries(made.map((p) => [p.name, p]));
}

/** A switch that saves when it is clicked: clicked, then waited for to show the state the server has kept. */
export async function setSwitch(box: Locator, on: boolean, timeout = 15_000): Promise<void> {
  if ((await box.isChecked()) === on) return;
  await box.click();
  const deadline = Date.now() + timeout;
  while ((await box.isChecked()) !== on) {
    if (Date.now() > deadline) throw new Error(`The switch did not turn ${on ? "on" : "off"}: ${box}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The platform's owner, signed in through the API (setup), with no browser. */
export async function apiOwner(): Promise<Pick<Person, "api">> {
  const c = client();
  const r = await c.api("POST", "/api/admin/auth/login", OWNER);
  if (r.status !== 200) throw new Error(`owner sign-in: ${r.status}`);
  return c;
}

/** Somebody signed in to the dashboard through the API, with no browser. */
export async function apiStaff(email: string): Promise<Pick<Person, "api">> {
  const c = client();
  const r = await c.api("POST", "/api/admin/auth/login", { email, password: PASSWORD });
  if (r.status !== 200) throw new Error(`staff sign-in: ${r.status}`);
  return c;
}

/** Browsers for several people, each with an account made at the same time (the sign-up emails go out together, so the wait is paid once). */
export async function people(s: Scenario, names: string[], opts: Parameters<typeof signUp>[1] = {}, device: "desktop" | "phone" = "desktop"): Promise<Record<string, Actor>> {
  const actors: Actor[] = [];
  for (const n of names) actors.push(await s.actor(n, device));
  await Promise.all(actors.map((a) => signUp(a, opts)));
  return Object.fromEntries(actors.map((a) => [a.name, a]));
}

/** A player's account, signed in, in a browser of their own. */
export async function player(s: Scenario, name: string, opts: Parameters<typeof signUp>[1] = {}, device: "desktop" | "phone" = "desktop"): Promise<Actor> {
  return signUp(await s.actor(name, device), opts);
}

/** A child a parent acts for, added through the API (setup). */
export async function addChild(parent: Actor, child: string, birthYear = 2014): Promise<{ id: number; name: string }> {
  const r = await parent.api("POST", "/api/my/people", { displayName: child, birthYear, relationship: "parent", authority: true });
  if (r.status !== 201 && r.status !== 200) throw new Error(`child ${child}: ${r.status} ${JSON.stringify(r.body)}`);
  return { id: (r.body.person as { id: number }).id, name: child };
}

/** A day far enough ahead that nothing else of the run is held on it. */
export const farDay = (n: number): string => dayAhead(n);

// ---------------------------------------------------------------- the judge's grid

export interface Count {
  unit: number;
  attempts: number;
  zone?: number | null;
  top?: number | null;
}

/** One boulder's counts for one climber: + for each attempt, Z at the attempt that reached the zone, T at the one that topped it. */
export async function tapBoulder(grid: Locator, name: string, c: Count): Promise<void> {
  const add = grid.getByRole("button", { name: `Add an attempt: ${name}, boulder ${c.unit}`, exact: true });
  const zone = grid.getByRole("button", { name: `Zone reached: ${name}, boulder ${c.unit}`, exact: true });
  const top = grid.getByRole("button", { name: `Top reached: ${name}, boulder ${c.unit}`, exact: true });
  for (let i = 1; i <= c.attempts; i++) {
    await add.click();
    if (c.zone === i && c.top !== i) await zone.click();
    if (c.top === i) await top.click();
  }
}

/** A boulder's counts taken back to nothing: top and zone unmarked, then the attempts taken back. */
export async function clearBoulder(grid: Locator, name: string, unit: number): Promise<void> {
  const top = grid.getByRole("button", { name: `Top reached: ${name}, boulder ${unit}`, exact: true });
  const zone = grid.getByRole("button", { name: `Zone reached: ${name}, boulder ${unit}`, exact: true });
  const sub = grid.getByRole("button", { name: `Take back an attempt: ${name}, boulder ${unit}`, exact: true });
  if ((await top.getAttribute("aria-pressed")) === "true") await top.click();
  if ((await zone.getAttribute("aria-pressed")) === "true") await zone.click();
  while (await sub.isEnabled()) await sub.click();
}

/** The climbers a grid lists, in its order. */
export async function climbersIn(grid: Locator): Promise<string[]> {
  return (await grid.getByRole("rowheader").allTextContents()).map((x) => x.trim());
}

/** One boulder shown at a time, as the grid does on a phone: the buttons are the boulder numbers. */
export async function showBoulder(grid: Locator, unit: number): Promise<void> {
  await grid.getByRole("group", { name: "Boulders in a round" }).getByRole("button", { name: String(unit), exact: true }).click();
}
