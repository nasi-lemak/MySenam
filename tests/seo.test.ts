import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { setAccessSettings } from "../src/lib/access";
import { createCourt, createVenue, listVenues } from "../src/lib/store";
import { venueIsListed, venueJsonLd } from "../src/lib/seo";
import sitemap from "../src/app/sitemap";
import robots from "../src/app/robots";
import { generateMetadata } from "../src/app/venue/[id]/page";

/** What search engines are given, and what they are kept away from. */

let publicId: number;
let privateId: number;

beforeAll(async () => {
  publicId = (await listVenues())[0].id;
  const priv = await createVenue({ name: "Condo Courts", area: "Mont Kiara", address: "x", phone: "0312345678" });
  if (!priv.ok) throw new Error("venue");
  privateId = priv.venue.id;
  await createCourt({ venueId: privateId, name: "Court 1", sport: "tennis", offPeakRate: 0, peakRate: 0 });
  await setAccessSettings(privateId, { access: "private" });
});

describe("the sitemap", () => {
  it("lists the public pages and the venues a visitor could find, and nothing private", async () => {
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toContain("https://book.example.my");
    expect(urls).toContain("https://book.example.my/search");
    expect(urls).toContain(`https://book.example.my/venue/${publicId}`);
    expect(urls).not.toContain(`https://book.example.my/venue/${privateId}`);
    expect(await venueIsListed(privateId)).toBe(false);
    expect(await venueIsListed(publicId)).toBe(true);
  });
});

describe("robots.txt", () => {
  it("keeps crawlers out of accounts, staff pages and one-person links, and points at the sitemap", async () => {
    const r = await robots();
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    expect(rule.disallow).toEqual(expect.arrayContaining(["/admin", "/api/", "/receipt/", "/account"]));
    expect(r.sitemap).toBe("https://book.example.my/sitemap.xml");
  });
});

describe("a venue page", () => {
  it("has a title, description and canonical address when listed", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ id: String(publicId) }) });
    expect(meta.title).toMatch(/ in /);
    expect(meta.description).toMatch(/^Book /);
    expect(meta.alternates?.canonical).toBe(`https://book.example.my/venue/${publicId}`);
    expect(meta.robots).toBeUndefined();
  });

  it("asks not to be indexed when private, or not there", async () => {
    expect((await generateMetadata({ params: Promise.resolve({ id: String(privateId) }) })).robots).toEqual({ index: false, follow: false });
    expect((await generateMetadata({ params: Promise.resolve({ id: "999999" }) })).robots).toEqual({ index: false, follow: false });
  });

  it("describes itself to schema.org", () => {
    const ld = venueJsonLd({
      name: "Arena",
      address: "12 Jalan SS2/61",
      area: "Petaling Jaya",
      phone: "+60 3-1234 5678",
      openHour: 8,
      closeHour: 23,
      lat: 3.1,
      lng: 101.6,
      url: "https://book.example.my/venue/1",
      image: null,
      sports: ["badminton", "futsal"],
    });
    expect(ld).toMatchObject({
      "@type": "SportsActivityLocation",
      address: { addressLocality: "Petaling Jaya", addressCountry: "MY" },
      geo: { latitude: 3.1 },
      openingHoursSpecification: [{ opens: "08:00", closes: "23:00", dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] }],
      keywords: "Badminton, Futsal",
    });
  });

  it("gives each run of days its own hours, late ones past midnight too, and leaves closed days out", () => {
    const ld = venueJsonLd({
      name: "Late Arena", address: "x", area: "PJ", phone: "1", openHour: 16, closeHour: 24, lat: null, lng: null, url: "https://x", image: null, sports: ["futsal"],
      weekHours: ["closed", null, null, null, null, { open: 16, close: 26 }, { open: 8, close: 26 }],
    });
    expect(ld.openingHoursSpecification).toEqual([
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday"], opens: "16:00", closes: "00:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Friday"], opens: "16:00", closes: "02:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: ["Saturday"], opens: "08:00", closes: "02:00" },
    ]);
  });
});
