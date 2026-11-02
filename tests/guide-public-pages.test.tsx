// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

let lang: string | undefined;
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: (name: string) => (name === "ms_lang" && lang ? { value: lang } : undefined) }),
}));

import { getDb } from "../src/lib/db";
import { BUSINESS_TYPE_IDS, BUSINESS_TYPES } from "../src/lib/guide/business-types";
import { translator } from "../src/lib/i18n";
import ForVenuesPage, { generateMetadata as indexMetadata } from "../src/app/for-venues/page";
import ForVenueTypePage, { generateMetadata as typeMetadata } from "../src/app/for-venues/[type]/page";
import sitemap from "../src/app/sitemap";

/**
 * The public guide's pages (docs/features/venue-guide.md#the-public-guide):
 * a marketplace's own, server-rendered in the visitor's language, the choice
 * in the address and reflected on the page, one indexable page for each kind
 * of business, and nothing written by looking at any of it.
 */

const ENV = process.env.MYSENAM_MARKETPLACE;
afterEach(() => {
  if (ENV === undefined) delete process.env.MYSENAM_MARKETPLACE;
  else process.env.MYSENAM_MARKETPLACE = ENV;
  lang = undefined;
});
const marketplace = (on: boolean) => {
  if (on) process.env.MYSENAM_MARKETPLACE = "on";
  else delete process.env.MYSENAM_MARKETPLACE;
};

const html = (el: unknown) => renderToStaticMarkup(el as never);
const dom = (markup: string) => new DOMParser().parseFromString(`<!doctype html><body>${markup}</body>`, "text/html");
const index = async (params: Record<string, string | string[]> = {}) => dom(html(await ForVenuesPage({ searchParams: Promise.resolve(params) })));
const typePage = async (type: string, params: Record<string, string | string[]> = {}) => dom(html(await ForVenueTypePage({ params: Promise.resolve({ type }), searchParams: Promise.resolve(params) })));

async function isNotFound(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise;
    return false;
  } catch (e) {
    return String((e as { digest?: string }).digest ?? e).includes("404") || String(e).includes("NEXT_NOT_FOUND");
  }
}

describe("the picker page", () => {
  it("is the marketplace's, and a business's own copy has none", async () => {
    marketplace(false);
    expect(await isNotFound(ForVenuesPage({ searchParams: Promise.resolve({}) }))).toBe(true);
    expect(await isNotFound(ForVenueTypePage({ params: Promise.resolve({ type: "swimming" }), searchParams: Promise.resolve({}) }))).toBe(true);
    marketplace(true);
    expect(await isNotFound(ForVenuesPage({ searchParams: Promise.resolve({}) }))).toBe(false);
  });

  it("with no choice shows the picker and the thirteen kinds of business, and none of the explanation", async () => {
    marketplace(true);
    const d = await index();
    expect(d.querySelectorAll("h1").length).toBe(1);
    expect(d.querySelector("h1")!.textContent).toBe("How MySenam fits your business");
    const boxes = [...d.querySelectorAll('input[name="types"]')] as HTMLInputElement[];
    expect(boxes.map((b) => b.value)).toEqual([...BUSINESS_TYPE_IDS]);
    expect(boxes.some((b) => b.hasAttribute("checked"))).toBe(false);
    // Each kind has a page of its own to read.
    const links = [...d.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    for (const id of BUSINESS_TYPE_IDS) expect(links).toContain(`/for-venues/${id}`);
    expect(d.querySelector("#day")).toBeNull();
    // It is a form that asks the same page again, so it works with no script.
    const form = d.querySelector("form")!;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/for-venues");
    expect(d.querySelectorAll('input[name="activities"]').length).toBeGreaterThan(20);
  });

  it("reflects the choice in the address: types ticked, the explanation shown, and what does not exist ignored", async () => {
    marketplace(true);
    const d = await index({ types: "badminton-and-pickleball,gym-and-fitness,bogus", activities: "yoga,curling" });
    const checked = [...d.querySelectorAll('input[name="types"]')].filter((b) => b.hasAttribute("checked")).map((b) => (b as HTMLInputElement).value);
    expect(checked).toEqual(["badminton-and-pickleball", "gym-and-fitness"]);
    const acts = [...d.querySelectorAll('input[name="activities"]')].filter((b) => b.hasAttribute("checked")).map((b) => (b as HTMLInputElement).value);
    expect(acts).toEqual(["yoga"]);
    expect(d.querySelector("#day")).not.toBeNull();
    expect(d.querySelector("#combined")).not.toBeNull();
    expect(d.body.textContent).toContain("Badminton and pickleball centre and Gym or fitness centre");
    // A form's repeated boxes mean the same as a comma list.
    const again = await index({ types: ["badminton-and-pickleball", "gym-and-fitness"] });
    expect([...again.querySelectorAll('input[name="types"]')].filter((b) => b.hasAttribute("checked")).length).toBe(2);
    // Nothing valid in the address is no choice.
    const none = await index({ types: "bogus,constructor", activities: "curling" });
    expect(none.querySelector("#day")).toBeNull();
  });

  it("has one h1, the sections as h2 in order, the steps as h4 under journeys as h3, and labelled boxes", async () => {
    marketplace(true);
    const d = await index({ types: "badminton-and-pickleball" });
    expect(d.querySelectorAll("h1").length).toBe(1);
    const h2 = [...d.querySelectorAll("h2")].map((h) => h.id);
    // Then, at the foot of the guide, using MySenam from an AI assistant (docs/integrations/mcp.md#connecting).
    expect(h2).toEqual(["day-h", "setup-h", "available-h", "know-h", "not-h", "start-h", "ai-h"]);
    expect(d.querySelector("#ai")!.textContent).toContain("/api/mcp");
    expect(d.querySelectorAll("h3").length).toBeGreaterThan(5);
    expect(d.querySelectorAll("h4").length).toBeGreaterThan(10);
    // Landmarks and jump links that land on a section.
    for (const a of d.querySelectorAll("nav a")) expect(d.querySelector(a.getAttribute("href")!), a.getAttribute("href")!).not.toBeNull();
    // Every box is inside the label that names it.
    for (const box of d.querySelectorAll("input")) expect(box.closest("label"), box.getAttribute("value") ?? "").not.toBeNull();
    // With no script every step is open on the page, and nothing is hidden.
    expect(d.querySelectorAll("[hidden]").length).toBe(0);
    expect(d.querySelectorAll("button").length).toBe(1);
  });

  it("is indexed bare, and a choice points back to it without asking to be indexed", async () => {
    marketplace(true);
    const bare = await indexMetadata({ searchParams: Promise.resolve({}) });
    expect(bare.title).toBe("How MySenam fits your business");
    expect(bare.alternates?.canonical).toBe("https://book.example.my/for-venues");
    expect(bare.robots).toBeUndefined();
    const chosen = await indexMetadata({ searchParams: Promise.resolve({ types: "swimming" }) });
    expect(chosen.alternates?.canonical).toBe("https://book.example.my/for-venues");
    expect(chosen.robots).toEqual({ index: false, follow: true });
  });
});

describe("a page for each kind of business", () => {
  it("renders every one, with its own title, description and canonical address, and the whole explanation", async () => {
    marketplace(true);
    const t = translator("en");
    for (const type of BUSINESS_TYPES) {
      const name = t(type.titleKey);
      const d = await typePage(type.id);
      expect(d.querySelectorAll("h1").length, type.id).toBe(1);
      expect(d.querySelector("h1")!.textContent, type.id).toBe(`${name}: how MySenam fits your business`);
      for (const id of ["day", "setup", "available", "know", "not", "start"]) expect(d.querySelector(`#${id}`), `${type.id}: #${id}`).not.toBeNull();
      expect(d.querySelectorAll("h4").length, type.id).toBeGreaterThanOrEqual(6);
      // The way on carries what was chosen to the form.
      const apply = [...d.querySelectorAll("a")].map((a) => a.getAttribute("href")).filter((h) => h?.startsWith("/list-your-venue"));
      expect(apply, type.id).toEqual([`/list-your-venue?fit=types:${type.id}`]);
      expect(d.querySelector('a[href="/pricing"]'), type.id).not.toBeNull();
      const meta = await typeMetadata({ params: Promise.resolve({ type: type.id }), searchParams: Promise.resolve({}) });
      expect(meta.title, type.id).toBe(`${name}: how MySenam fits your business`);
      expect(String(meta.description), type.id).toContain(name);
      expect(meta.alternates?.canonical, type.id).toBe(`https://book.example.my/for-venues/${type.id}`);
      expect(meta.robots, type.id).toBeUndefined();
    }
  });

  it("is not there for a kind that does not exist, or when the install is not a marketplace", async () => {
    marketplace(true);
    expect(await isNotFound(ForVenueTypePage({ params: Promise.resolve({ type: "spaceport" }), searchParams: Promise.resolve({}) }))).toBe(true);
    expect(await isNotFound(ForVenueTypePage({ params: Promise.resolve({ type: "__proto__" }), searchParams: Promise.resolve({}) }))).toBe(true);
    const meta = await typeMetadata({ params: Promise.resolve({ type: "spaceport" }), searchParams: Promise.resolve({}) });
    expect(meta.robots).toEqual({ index: false, follow: false });
    marketplace(false);
    expect((await typeMetadata({ params: Promise.resolve({ type: "swimming" }), searchParams: Promise.resolve({}) })).robots).toEqual({ index: false, follow: false });
  });

  it("refines by activity from the address, and says what the catalogue says of it", async () => {
    marketplace(true);
    const d = await typePage("badminton-and-pickleball", { activities: "archery,kayak" });
    expect(d.querySelector("#know")!.textContent).toContain("Not built: scheduling a range officer for each session");
    expect(d.querySelector("#know")!.textContent).toContain("Basic support");
    expect(d.querySelector("#not")!.textContent).toContain("Scheduling a range officer for each session");
    expect(d.querySelector("#not")!.textContent).toContain("Book lanes by the hour with a range briefing as a sign-off");
    expect(d.querySelector("#day")!.textContent).toContain("Hiring equipment with a deposit");
    // Bowling is sold by the game now: nothing about it is "not built".
    const bowling = await typePage("badminton-and-pickleball", { activities: "bowling" });
    expect(bowling.querySelector("#know")?.textContent ?? "").not.toContain("Not built");
    expect(bowling.querySelector("#not")?.textContent ?? "").not.toContain("Selling bowling by the game");
    // The catalogue's own English note is marked as English.
    expect(d.querySelector('#know [lang="en"]')).not.toBeNull();
  });

  it("is said in the visitor's own language, headings, steps and limits", async () => {
    marketplace(true);
    const expected: Record<string, RegExp> = { ms: /bagaimana MySenam/, zh: /MySenam 如何适合/, ta: /MySenam உங்கள் தொழிலுக்கு/ };
    for (const [code, h1] of Object.entries(expected)) {
      lang = code;
      const d = await typePage("gym-and-fitness");
      expect(d.querySelector("h1")!.textContent, code).toMatch(h1);
      expect(d.querySelector("h2#day-h")!.textContent, code).not.toBe("Your day in MySenam");
      expect(d.body.textContent, code).not.toMatch(/\bfit\.[a-z]/);
      expect((await typeMetadata({ params: Promise.resolve({ type: "gym-and-fitness" }), searchParams: Promise.resolve({}) })).title, code).toMatch(h1);
    }
  });

  it("states a supervised range's limit plainly and gives the alternative, offers a gym entry without booking, and never shows swimming an unstaffed door", async () => {
    marketplace(true);
    const range = await typePage("archery-and-supervised");
    expect(range.querySelector("#not")!.textContent).toContain("Scheduling a range officer for each session");
    expect(range.querySelector("#not")!.textContent).toContain("Book lanes by the hour with a range briefing as a sign-off");
    const gym = await typePage("gym-and-fitness");
    // Built now (entry with no set time): never listed as something MySenam does not do.
    expect(gym.querySelector("#not")?.textContent ?? "").not.toContain("Gym entry without booking a session");
    expect(gym.body.textContent).toContain("Entry when nobody is at the desk");
    const swim = await typePage("swimming");
    expect(swim.body.textContent).not.toContain("Entry when nobody is at the desk");
    expect(swim.querySelector("#not")!.textContent).toContain("Not supported for any venue");
  });
});

describe("looking at the guide writes nothing", () => {
  it("leaves every table as it was: rows counted before and after every page, its metadata and the sitemap", async () => {
    marketplace(true);
    const db = getDb();
    const tables = ((await db.prepare("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1").all()) as { name: string }[]).map((r) => r.name);
    expect(tables.length).toBeGreaterThan(50);
    const count = async () => {
      const out: Record<string, number> = {};
      for (const name of tables) out[name] = ((await db.prepare(`SELECT COUNT(*)::int AS n FROM "${name}"`).get()) as { n: number }).n;
      return out;
    };
    const before = await count();
    await index();
    await index({ types: "badminton-and-pickleball,mixed", activities: "yoga,gym,bowling" });
    for (const id of BUSINESS_TYPE_IDS) await typePage(id);
    await indexMetadata({ searchParams: Promise.resolve({ types: "swimming" }) });
    for (const id of BUSINESS_TYPE_IDS) await typeMetadata({ params: Promise.resolve({ type: id }), searchParams: Promise.resolve({}) });
    await sitemap();
    lang = "ms";
    await typePage("swimming");
    expect(await count()).toEqual(before);
  });

  it("sets no cookie and reads none beyond the language the visitor already chose", async () => {
    marketplace(true);
    const setter = vi.fn();
    const jar = { get: () => undefined, set: setter, delete: setter };
    const headers = await import("next/headers");
    const spy = vi.spyOn(headers, "cookies").mockResolvedValue(jar as never);
    await index({ types: "swimming" });
    await typePage("swimming");
    expect(setter).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("the sitemap", () => {
  beforeAll(() => marketplace(true));

  it("lists the guide and each kind of business in a marketplace, and nothing of it otherwise", async () => {
    marketplace(true);
    const on = (await sitemap()).map((e) => e.url);
    expect(on).toContain("https://book.example.my/for-venues");
    for (const id of BUSINESS_TYPE_IDS) expect(on).toContain(`https://book.example.my/for-venues/${id}`);
    marketplace(false);
    const off = (await sitemap()).map((e) => e.url);
    expect(off.filter((u) => u.includes("/for-venues"))).toEqual([]);
    expect(off).toContain("https://book.example.my/search");
  });
});
