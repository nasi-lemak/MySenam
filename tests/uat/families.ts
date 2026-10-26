import type { Locator, Page } from "playwright-core";
import { expect } from "vitest";
import { signUp, url, type Actor, type Scenario } from "./harness";

/**
 * What the participant and document scenarios share (setup, not their
 * subject): an archery range of their own whose lanes need the venue's
 * sign-off and which takes applications online, with a manager and a front
 * desk; families made through the app's API; signing staff in on the
 * dashboard; and the checks a phone screen is held to.
 */

export const STAFF_PASSWORD = "a range manager's long password";

export interface Range {
  venueId: number;
  name: string;
  laneIds: number[];
  manager: { email: string; name: string };
  desk: { email: string; name: string };
}

/**
 * A live archery range with `lanes` lanes, each a booking of its own, that
 * needs the venue's sign-off and takes applications online (a declaration,
 * and a certificate where `documents`), as a safety assessment, with a
 * manager and a front-desk account. Made by the platform's owner.
 */
export async function archeryRange(owner: Actor, label: string, opts: { lanes?: number; documents?: boolean } = {}): Promise<Range> {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const name = `${label} ${stamp}`;
  const made = await owner.api("POST", "/api/admin/venues", { name, area: "Petaling Jaya", address: "3 Jalan SS 2/24, Petaling Jaya", phone: "03-7877 3000" });
  if (made.status !== 201) throw new Error(`venue: ${JSON.stringify(made.body)}`);
  const venueId = (made.body.venue as { id: number }).id;
  const laneIds: number[] = [];
  for (let i = 1; i <= (opts.lanes ?? 2); i++) {
    const c = await owner.api("POST", "/api/admin/courts", { venueId, sport: "archery", name: `Lane ${i}`, offPeakRate: 20, peakRate: 25, capacity: 1, deposit: 0 });
    if (c.status >= 300) throw new Error(`lane: ${JSON.stringify(c.body)}`);
    laneIds.push(((c.body.courts as { id: number }[] | undefined)?.[0] ?? (c.body.court as { id: number })).id);
  }
  const rules = await owner.api("POST", "/api/admin/booking-policies", { venueId, level: "sport", sport: "archery", settings: { signOff: true } });
  if (rules.status !== 200) throw new Error(`rules: ${JSON.stringify(rules.body)}`);
  const staff = {
    manager: { email: `range-manager-${stamp}@uat.mysenam.test`, name: `${label} Manager` },
    desk: { email: `range-desk-${stamp}@uat.mysenam.test`, name: `${label} Desk` },
  };
  for (const role of ["manager", "desk"] as const) {
    const r = await owner.api("POST", "/api/admin/admins", { name: staff[role].name, email: staff[role].email, password: STAFF_PASSWORD, venueId, role });
    if (r.status >= 300) throw new Error(`${role}: ${JSON.stringify(r.body)}`);
  }
  const asked = await owner.api("POST", "/api/admin/approvals/settings", {
    venueId,
    sport: "archery",
    declaration: "I will follow the range officer's calls at all times and shoot only from the line.",
    ...(opts.documents
      ? { documentLabel: "Archery club safety certificate", documentPurpose: "To see that the archer has passed a club's range safety course." }
      : {}),
    validDays: 365,
    reviewLevel: "safety",
  });
  if (asked.status !== 200) throw new Error(`applications: ${JSON.stringify(asked.body)}`);
  return { venueId, name, laneIds, ...staff };
}

/** A member of staff signed in through the API (setup); their browser then carries the session. */
export async function staffApi(a: Actor, email: string): Promise<Actor> {
  const res = await a.api("POST", "/api/admin/auth/login", { email, password: STAFF_PASSWORD });
  if (res.status !== 200) throw new Error(`staff sign-in: ${res.status} ${JSON.stringify(res.body)}`);
  return a;
}

/** Signed in on the dashboard's own page. */
export async function staffSignIn(a: Actor, email: string): Promise<void> {
  await a.page.goto(`${url}/admin`);
  await a.page.getByLabel("Email").fill(email);
  await a.page.getByLabel("Password").fill(STAFF_PASSWORD);
  await a.page.getByRole("button", { name: "Sign in" }).click();
  await a.page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
}

export interface Child {
  name: string;
  id: number;
}

/** A parent's account (signed in in their browser) and children added on it through the API. */
export async function family(s: Scenario, who: string, children: string[], device: "desktop" | "phone" = "desktop"): Promise<{ parent: Actor; kids: Child[] }> {
  const parent = await signUp(await s.actor(who, device));
  const kids: Child[] = [];
  for (const [i, name] of children.entries()) {
    const r = await parent.api("POST", "/api/my/people", { displayName: name, birthYear: 2014 + i, relationship: "parent", authority: true });
    if (r.status !== 201 && r.status !== 200) throw new Error(`child ${name}: ${r.status} ${JSON.stringify(r.body)}`);
    kids.push({ name, id: (r.body.person as { id: number }).id });
  }
  return { parent, kids };
}

/** An application for a child, by declaration (setup): its id. */
export async function applyFor(parent: Actor, venueId: number, child: Child): Promise<number> {
  const r = await parent.api("POST", "/api/my/approvals", { venueId, sport: "archery", declaration: true, forPerson: child.id, authority: true });
  if (r.status !== 201 && r.status !== 200) throw new Error(`application for ${child.name}: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body.request as { id: number }).id;
}

/** A decision by staff through the API (setup). */
export async function decideApi(staff: Actor, venueId: number, id: number, action: "approve" | "reject" | "ask" | "revoke", reason?: string) {
  const r = await staff.api("POST", "/api/admin/approvals", { venueId, id, action, reason });
  if (r.status !== 200) throw new Error(`${action} ${id}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** The venue's grid at one lane and hour, from a link such as search or an approval gives. */
export function laneLink(venueId: number, courtId: number, date: string, hour: number): string {
  return `${url}/venue/${venueId}?date=${date}&sport=archery&court=${courtId}&start=${hour * 60}&minutes=60`;
}

/** The booking code a confirmation shows. */
export async function confirmedCode(page: Page): Promise<string> {
  await page.getByText("Booking confirmed!").waitFor({ timeout: 15_000 });
  return (await page.getByText(/MS-[A-Z0-9]{4,}/).first().textContent())!.match(/MS-[A-Z0-9]{4,}/)![0];
}

// ------------------------------------------------------------ phone checks

/** Inside the screen from side to side: nobody has to scroll sideways to reach it. */
export async function reachable(page: Page, target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  const width = page.viewportSize()!.width;
  expect(box, `${target} has no box`).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
}

/** A tap target at least 24 CSS pixels high (WCAG 2.2, 2.5.8), inside the screen. */
export async function tappable(page: Page, target: Locator): Promise<void> {
  await reachable(page, target);
  const box = (await target.boundingBox())!;
  expect(box.height, `${target} is ${box.height}px high`).toBeGreaterThanOrEqual(24);
}

/** Text no smaller than 12 CSS pixels: readable on a phone held at arm's length. */
export async function readable(target: Locator): Promise<void> {
  const px = await target.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(px, `${target} is set in ${px}px`).toBeGreaterThanOrEqual(12);
}
