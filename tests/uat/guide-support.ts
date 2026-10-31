import { expect } from "vitest";
import type { Page } from "playwright-core";
import { dayAhead, url, type Actor } from "./harness";
import { STAFF_PASSWORD } from "./families";

/**
 * What the venue-guide scenarios (tests/uat/guide*.uat.ts) share, none of it
 * their subject: an operator who signs a venue up through the real form, the
 * guide's own tab and views, reading a playbook off the screen, and a venue
 * with a manager and a front desk made through the app's API.
 */

/** Only a marketplace takes sign-ups (the UAT server runs as one); against a deployment that is not, the scenarios that sign a venue up are skipped. */
export const marketplace = (await fetch(`${url}/list-your-venue`)).status !== 404;

export const stamp = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

/**
 * An operator signs a venue up on the marketplace's own form (/list-your-venue,
 * as tests/uat/venue-setup.uat.ts does), is shown the account is ready and signs
 * in to the dashboard; the venue is a draft only they can see. `fit` is the
 * address the public guide hands over (`?fit=types:a~activities:b`), kept when
 * given. Returns the venue's id.
 */
export async function signUpVenue(operator: Actor, venueName: string, opts: { fit?: string; area?: string; here?: boolean } = {}): Promise<number> {
  const page = operator.page;
  await operator.context.grantPermissions(["geolocation"], { origin: url });
  await operator.context.setGeolocation({ latitude: 3.1073, longitude: 101.6067 });
  if (!opts.here) await page.goto(`${url}/list-your-venue${opts.fit ? `?fit=${opts.fit}` : ""}`);
  await page.getByRole("button", { name: "Zoom in" }).waitFor();
  await page.getByLabel("Venue name").fill(venueName);
  await page.getByLabel("Area").fill(opts.area ?? "Petaling Jaya");
  await page.getByLabel("Venue phone").fill("03-7955 1234");
  await page.getByLabel("Address", { exact: true }).fill("12 Jalan 14/22, Seksyen 14, Petaling Jaya");
  await page.getByRole("button", { name: "I'm at the venue: use my location" }).click();
  await page.getByText("Pinned. Drag the pin if it isn't quite right.").waitFor();
  await page.getByLabel("Your name").fill("Operator Tester");
  await page.getByLabel("Your email").fill(operator.email);
  await page.getByLabel("Choose a password").fill(operator.password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await page.getByText("Your account is ready").waitFor({ timeout: 15_000 });
  await page.getByRole("link", { name: "Go to your dashboard" }).click();
  await page.getByLabel("Email").fill(operator.email);
  await page.getByLabel("Password").fill(operator.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
  const href = await page.getByRole("link", { name: "See your page ↗" }).getAttribute("href");
  return Number(/\/venue\/(\d+)/.exec(href ?? "")![1]);
}

/** The guide's tab, and one of its views: what an operator clicks. */
export async function openGuide(page: Page, view: "Set up" | "How to run it" | "Discover" | null = null): Promise<void> {
  await page.getByRole("button", { name: "Guide", exact: true }).click();
  await page.getByRole("heading", { name: "Venue guide" }).waitFor();
  if (view) await page.getByRole("navigation", { name: "Guide sections" }).getByRole("button", { name: view, exact: true }).click();
}

/** The whole playbook as the page holds it (every section open, as the print view has it), as one string of text. */
export async function playbookText(page: Page): Promise<string> {
  await page.locator("[data-playbook-print] [data-section]").first().waitFor({ state: "attached" });
  const all = page.getByRole("button", { name: "Open every section" });
  if (await all.count()) await all.click();
  // The text of the document, without the print stylesheet it carries in a <style>.
  return page.locator("[data-playbook-print]").first().evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("style").forEach((s) => s.remove());
    return copy.textContent ?? "";
  });
}

/** A section heading of the playbook, as a table-of-contents entry names it. */
export const sectionTitles = (page: Page): Promise<string[]> => page.locator("[data-playbook-print] section[data-section] > h2 > button > span:first-child").allTextContents();

/** A venue made by the platform's owner through the API, with a manager and a front desk (setup, not a scenario's subject). */
export interface MadeVenue {
  venueId: number;
  name: string;
  courtIds: number[];
  manager: { email: string; name: string };
  desk: { email: string; name: string };
}

export async function madeVenue(
  owner: Actor,
  label: string,
  courts: { sport: string; name: string; offPeakRate: number; peakRate: number; capacity?: number; maxPlayers?: number }[]
): Promise<MadeVenue> {
  const id = stamp();
  const name = `${label} ${id}`;
  const made = await owner.api("POST", "/api/admin/venues", { name, area: "Ampang", address: "2 Jalan Ampang Hilir, Ampang", phone: "03-4251 7788" });
  if (made.status !== 201) throw new Error(`venue: ${JSON.stringify(made.body)}`);
  const venueId = (made.body.venue as { id: number }).id;
  const courtIds: number[] = [];
  for (const court of courts) {
    const c = await owner.api("POST", "/api/admin/courts", { venueId, capacity: 1, deposit: 0, ...court });
    if (c.status >= 300) throw new Error(`court: ${JSON.stringify(c.body)}`);
    courtIds.push(((c.body.courts as { id: number }[] | undefined)?.[0] ?? (c.body.court as { id: number })).id);
  }
  const staff = {
    manager: { email: `guide-manager-${id}@uat.mysenam.test`, name: `${label} Manager` },
    desk: { email: `guide-desk-${id}@uat.mysenam.test`, name: `${label} Desk` },
  };
  for (const role of ["manager", "desk"] as const) {
    const r = await owner.api("POST", "/api/admin/admins", { name: staff[role].name, email: staff[role].email, password: STAFF_PASSWORD, venueId, role });
    if (r.status >= 300) throw new Error(`${role}: ${JSON.stringify(r.body)}`);
  }
  return { venueId, name, courtIds, ...staff };
}

/** A coach of a venue, taking lessons every day 9 to 5 (or none, to leave them without hours), and their private link's token (setup, not a scenario's subject). */
export async function addCoach(manager: Actor, venueId: number, name: string, sport: string, opts: { hours?: boolean } = {}): Promise<{ id: number; token: string }> {
  const hours = opts.hours === false ? [] : [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: 9 * 60, until: 17 * 60 }));
  const made = await manager.api("POST", "/api/admin/coaches", { venueId, name, bio: "A coach.", sports: [sport], rate: 60, hours });
  if (made.status >= 300) throw new Error(`coach: ${JSON.stringify(made.body)}`);
  const id = (made.body.coach as { id: number }).id;
  const linked = await manager.api("POST", "/api/admin/coaches", { venueId, id, action: "link", on: true });
  const pageUrl = (linked.body.link as { pageUrl: string } | null)?.pageUrl;
  if (!pageUrl) throw new Error(`coach link: ${JSON.stringify(linked.body)}`);
  return { id, token: pageUrl.split("/coach/")[1] };
}

/** The role's guide as the server answers it (what the route says, beside what the screen shows). */
export async function playbookApi(a: Actor, venueId: number, as?: string) {
  return a.api("GET", `/api/admin/guide/playbook?venueId=${venueId}${as ? `&as=${as}` : ""}`);
}

/**
 * A court's first free hour from the venue's own availability, for a booking made as setup. A draft venue's
 * availability is for its staff only, so `as` is the signed-in operator; omitted, it is read as a customer does.
 */
export async function freeHourAt(venueId: number, sport: string, as: Actor | null = null, from = 2): Promise<{ courtId: number; date: string; hour: number }> {
  for (let d = from; d <= from + 8; d++) {
    const date = dayAhead(d);
    const path = `/api/availability?venueId=${venueId}&date=${date}&sport=${sport}`;
    const got = as ? await as.api("GET", path) : { status: (await fetch(`${url}${path}`)).status, body: await (await fetch(`${url}${path}`)).json().catch(() => ({})) };
    if (got.status !== 200) continue;
    const { availability } = got.body as { availability: { court: { id: number }; starts: { minute: number; maxLength: number }[] }[] };
    for (const c of availability)
      for (const st of c.starts) if (st.minute % 60 === 0 && st.minute >= 10 * 60 && st.minute <= 19 * 60 && st.maxLength >= 60) return { courtId: c.court.id, date, hour: st.minute / 60 };
  }
  throw new Error(`Nothing free at venue ${venueId}`);
}

/**
 * What no guide holds whatever the venue: a credential's value (the stand-in's keys, a password typed in a form), an email
 * address or a person's number. Guides count people and settings; they name only the venue. (The words "password" and "API
 * key" are in the text as the names of screens and of what staff do: it is values that are checked.)
 */
export function expectNoPrivate(text: string, ...values: string[]): void {
  expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  expect(text).not.toMatch(/uat-stand-in|uat_collection|\b0\d{9,10}\b/);
  for (const v of values) if (v) expect(text, `the guide holds "${v}"`).not.toContain(v);
}

/**
 * What an operator says to the discovery questions, by the words on the
 * screen: the choices to tick for a list, the one to pick for the others.
 * A question that is not named is left alone (and a venue whose saved settings
 * answer it is not asked it at all).
 */
export interface Answers {
  types?: string[];
  activities?: string[];
  customersDo?: string[];
  resources?: string;
  branches?: string;
  staffing?: string;
  channels?: string[];
  memberships?: string[];
  discounts?: "Yes" | "No";
  coaching?: "Yes" | "No";
  children?: "Yes" | "No";
  competitions?: "Yes" | "No";
  audience?: string;
}

/**
 * Walks the questions one by one as an operator does (Save and continue, until
 * the plan opens) and answers each from `answers`; returns the ids of the
 * questions it was asked, in order, so a scenario can say which were not.
 */
export async function answerDiscovery(page: Page, answers: Answers): Promise<string[]> {
  const asked: string[] = [];
  for (let guard = 0; guard < 20; guard++) {
    const question = page.locator("[data-question]").first();
    // The plan has opened when no question is on screen.
    if (!(await question.waitFor({ timeout: 4000 }).then(() => true, () => false))) break;
    const id = (await question.getAttribute("data-question"))!;
    asked.push(id);
    const a = (answers as Record<string, string | string[] | undefined>)[id];
    if (id === "activities" && Array.isArray(a)) {
      for (const name of a) {
        const box = page.getByRole("checkbox", { name: new RegExp(`(^|\\s)${name}(\\s|$)`) }).first();
        if (!(await box.isVisible())) await page.getByText(/^(More|All) activities$/).click();
        await box.check();
      }
    } else if (Array.isArray(a)) {
      for (const label of a) await question.getByLabel(label, { exact: true }).check();
    } else if (typeof a === "string") {
      await question.getByLabel(a, { exact: true }).check();
    }
    await page.getByRole("button", { name: /^Save and (continue|finish)$/ }).click();
    // The next question has the next id, or the plan is there.
    await page.waitForFunction((was) => document.querySelector("[data-question]")?.getAttribute("data-question") !== was, id, { timeout: 15_000 }).catch(() => undefined);
  }
  return asked;
}

/** A step's card of the setup plan. */
export const stepCard = (page: Page, id: string) => page.locator(`li[data-step="${id}"]`);

/** Opens a step's *Do it here* panel, the existing editor run inside the card. */
export async function doItHere(page: Page, id: string) {
  const card = stepCard(page, id);
  await card.scrollIntoViewIfNeeded();
  const toggle = card.getByRole("button", { name: "Do it here" });
  if (await toggle.count()) await toggle.click();
  return card;
}

/** The ids of every step the plan shows. */
export const planSteps = (page: Page): Promise<string[]> => page.locator("li[data-step]").evaluateAll((els) => els.map((e) => e.getAttribute("data-step")!));
