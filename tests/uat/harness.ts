import fs from "fs";
import path from "path";
import { afterAll, beforeAll, inject, it } from "vitest";
import { chromium, type APIResponse, type Browser, type BrowserContext, type Page } from "playwright-core";
import { OWNER } from "../e2e/server";

/**
 * The visual acceptance harness. A scenario is several people, each an
 * *actor* with a browser context of their own (their own cookies, their own
 * address, so rate limits and sessions behave as for different people),
 * acting through the real pages. Every step is logged with who did it and how
 * long it took, and ends with a screenshot of that actor's screen; every
 * actor's context records a video and a Playwright trace. All of it goes to
 * <UAT_ARTIFACTS or artifacts/uat/<time>>/<scenario>/.
 *
 *   UAT_HEADED=1     a visible browser (needs a display: xvfb-run on a server)
 *   UAT_SLOWMO=250   milliseconds between browser actions, to watch it
 *
 * Setup that is not what the scenario is about (accounts, a venue's own
 * settings, a tournament's draw) goes through the app's own API from the
 * actor's context, so it carries their session; what the scenario is about
 * goes through the pages.
 */

export const url = inject("e2eUrl");
const runDir = inject("uatDir");
let browser: Browser;
let ipCounter = 0;
let emailCounter = 0;
const RUN = Date.now().toString(36);

beforeAll(async () => {
  const local = "/opt/pw-browsers/chromium";
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? (fs.existsSync(local) ? local : undefined),
    headless: process.env.UAT_HEADED !== "1",
    slowMo: Number(process.env.UAT_SLOWMO ?? 0),
  });
});
afterAll(async () => {
  await browser?.close();
});

export interface Actor {
  name: string;
  context: BrowserContext;
  page: Page;
  email: string;
  password: string;
  phone: string;
  id?: number;
  /** A request from this person's browser: their cookies, their address, this site as the origin. */
  api(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
}

interface Step {
  n: number;
  actor: string;
  label: string;
  ms: number;
  ok: boolean;
  screenshot?: string;
  error?: string;
}

/**
 * The screens people use: a laptop at the counter, a phone in the hand (390 ×
 * 844, the most common size in Malaysia), a tablet on the desk (820 × 1180).
 * Phones and tablets are touch screens.
 */
export const DEVICES = {
  desktop: { viewport: { width: 1280, height: 860 } },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  tablet: { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
} as const;
export type Device = keyof typeof DEVICES;

/** Nothing on the page is wider than the screen, so nobody has to scroll sideways. */
export async function fitsScreen(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

export class Scenario {
  readonly dir: string;
  readonly actors: Actor[] = [];
  readonly steps: Step[] = [];
  readonly started = Date.now();

  constructor(readonly title: string) {
    this.dir = path.join(runDir, title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** A person in the scenario, with a browser of their own, on a laptop unless a phone or tablet is said. */
  async actor(name: string, device: Device = "desktop"): Promise<Actor> {
    const ip = `10.${(process.pid % 200) + 20}.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
    const context = await browser.newContext({
      ...DEVICES[device],
      locale: "en-MY",
      extraHTTPHeaders: { "x-forwarded-for": ip },
      recordVideo: { dir: path.join(this.dir, "video", name.toLowerCase()), size: DEVICES[device].viewport },
    });
    await context.tracing.start({ screenshots: true, snapshots: true, title: `${this.title}: ${name}` });
    const page = await context.newPage();
    emailCounter++;
    const actor: Actor = {
      name,
      context,
      page,
      email: `uat-${RUN}-${emailCounter}@uat.mysenam.test`,
      password: "an acceptance-test password",
      phone: `0138${String(process.pid % 100).padStart(2, "0")}${String(emailCounter).padStart(4, "0")}`,
      async api(method, p, body) {
        const res: APIResponse = await context.request.fetch(`${url}${p}`, {
          method,
          headers: { "content-type": "application/json", origin: url },
          data: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status(), body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
      },
    };
    this.actors.push(actor);
    return actor;
  }

  /** One thing one person does, logged, timed and photographed. */
  async step<T>(actor: Actor, label: string, fn: () => Promise<T>): Promise<T> {
    const n = this.steps.length + 1;
    const t0 = Date.now();
    const shot = path.join(this.dir, `${String(n).padStart(2, "0")}-${actor.name.toLowerCase()}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50)}.png`);
    try {
      const result = await fn();
      await actor.page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      this.steps.push({ n, actor: actor.name, label, ms: Date.now() - t0, ok: true, screenshot: path.basename(shot) });
      console.log(`  ✓ ${n}. ${actor.name}: ${label} (${Date.now() - t0} ms)`);
      return result;
    } catch (err) {
      await actor.page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      this.steps.push({ n, actor: actor.name, label, ms: Date.now() - t0, ok: false, screenshot: path.basename(shot), error: String(err).slice(0, 2000) });
      console.log(`  ✗ ${n}. ${actor.name}: ${label}`);
      throw err;
    }
  }

  async close(ok: boolean, error?: unknown) {
    for (const a of this.actors) {
      await a.context.tracing.stop({ path: path.join(this.dir, `trace-${a.name.toLowerCase()}.zip`) }).catch(() => undefined);
      await a.context.close().catch(() => undefined);
    }
    fs.writeFileSync(
      path.join(this.dir, "steps.json"),
      JSON.stringify(
        { scenario: this.title, ok, ms: Date.now() - this.started, url, actors: this.actors.map((a) => a.name), steps: this.steps, error: error ? String(error).slice(0, 2000) : undefined },
        null,
        2
      )
    );
  }
}

/** A scenario, run on its own with `-t "<title>"`. */
export function scenario(title: string, fn: (s: Scenario) => Promise<void>) {
  it(title, async () => {
    const s = new Scenario(title);
    try {
      await fn(s);
      await s.close(true);
    } catch (err) {
      await s.close(false, err);
      throw err;
    }
  });
}

/** A new customer account, signed in in this actor's browser; optionally a playing profile and a level. */
export async function signUp(a: Actor, opts: { profile?: Record<string, unknown>; level?: { sport: string; level: string } } = {}): Promise<Actor> {
  const made = await a.api("POST", "/api/auth/register", { name: `${a.name} Tester`, email: a.email, phone: a.phone, password: a.password });
  if (made.status !== 200 && made.status !== 201) throw new Error(`register ${a.name}: ${made.status} ${JSON.stringify(made.body)}`);
  a.id = (made.body.user as { id: number } | undefined)?.id;
  if (opts.profile) {
    const p = await a.api("PUT", "/api/my/profile", opts.profile);
    if (p.status !== 200) throw new Error(`profile ${a.name}: ${JSON.stringify(p.body)}`);
  }
  if (opts.level) await a.api("PUT", "/api/my/levels", opts.level);
  return a;
}

/** The platform owner, signed in to the dashboard in this actor's browser. */
export async function signInOwner(a: Actor): Promise<Actor> {
  const res = await a.api("POST", "/api/admin/auth/login", OWNER);
  if (res.status !== 200) throw new Error(`owner sign-in: ${res.status}`);
  return a;
}

/** A venue with a court for an activity, from the public list. */
export async function courtFor(sport = "badminton"): Promise<{ venueId: number; courtId: number; venueName: string; area: string; courtIds: number[] }> {
  const { venues } = (await (await fetch(`${url}/api/venues?sport=${sport}`)).json()) as {
    venues: { id: number; name: string; area: string; courts: { id: number; sport: string }[] }[];
  };
  const v = venues.find((x) => x.courts.some((c) => c.sport === sport))!;
  const courts = v.courts.filter((c) => c.sport === sport);
  return { venueId: v.id, courtId: courts[0].id, venueName: v.name, area: v.area, courtIds: courts.map((c) => c.id) };
}

/** A date `days` ahead in Malaysia. */
export function dayAhead(days: number): string {
  return new Date(Date.now() + 8 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);
}

/** A court booked by this actor through the booking API (setup, not the scenario's subject). */
export async function bookCourt(a: Actor, courtId: number, date: string, hour: number, weeks?: number): Promise<{ code: string; totalPrice: number }> {
  const res = await a.api("POST", "/api/bookings", { courtId, date, hours: [hour], name: `${a.name} Tester`, phone: a.phone, ...(weeks ? { weeks } : {}) });
  if (res.status >= 300) throw new Error(`booking for ${a.name}: ${res.status} ${JSON.stringify(res.body)}`);
  const b = (res.body.booking ?? (res.body.bookings as unknown[])?.[0]) as { code: string; totalPrice: number };
  return b;
}

/** Waits until nothing matches (Playwright's own assertions are not Vitest's). */
export async function gone(locator: import("playwright-core").Locator, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while ((await locator.count()) > 0) {
    if (Date.now() > deadline) throw new Error(`Still on the page: ${locator}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const claimed = new Set<string>();

/**
 * A court, day and hour free right now, from the availability the venue page
 * itself shows: what a person would see and pick. Scenarios run against a
 * fresh database or a seeded staging one, so none may assume an hour is free.
 */
export async function freeSlot(opts: { sport?: string; fromDay?: number; toDay?: number; hours?: number[]; venueId?: number; notVenueId?: number } = {}): Promise<{
  venueId: number;
  courtId: number;
  date: string;
  hour: number;
}> {
  const sport = opts.sport ?? "badminton";
  const hours = opts.hours ?? [13, 14, 15, 16, 17, 18, 19, 20, 21];
  const { venues } = (await (await fetch(`${url}/api/venues?sport=${sport}`)).json()) as { venues: { id: number; courts: { id: number; sport: string }[] }[] };
  const candidates = venues.filter((v) => v.courts.some((c) => c.sport === sport) && (opts.venueId === undefined || v.id === opts.venueId) && v.id !== opts.notVenueId);
  for (let d = opts.fromDay ?? 3; d <= (opts.toDay ?? 13); d++) {
    const date = dayAhead(d);
    for (const v of candidates) {
      const res = await fetch(`${url}/api/availability?venueId=${v.id}&date=${date}&sport=${sport}`);
      if (!res.ok) continue;
      const { availability, closure } = (await res.json()) as { availability: { court: { id: number }; starts: { minute: number; maxLength: number }[] }[]; closure: unknown };
      if (closure) continue;
      for (const c of availability)
        for (const st of c.starts) {
          const hour = st.minute / 60;
          const key = `${c.court.id}:${date}:${hour}`;
          if (!Number.isInteger(hour) || !hours.includes(hour) || st.maxLength < 60 || claimed.has(key)) continue;
          claimed.add(key);
          return { venueId: v.id, courtId: c.court.id, date, hour };
        }
    }
  }
  throw new Error(`No free ${sport} court found between days ${opts.fromDay ?? 3} and ${opts.toDay ?? 13}.`);
}
