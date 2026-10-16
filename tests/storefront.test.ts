import { afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://mysenam.my";

import { NextRequest } from "next/server";
import {
  accentCss,
  contrastWithWhite,
  deleteStorefront,
  normalizeHost,
  saveStorefront,
  storefrontForHost,
  storefrontForRequest,
  venueBaseUrl,
} from "../src/lib/storefront";
import { createBooking, listVenues } from "../src/lib/store";
import { notifyBookingConfirmed } from "../src/lib/notify";
import { messagesForBooking } from "../src/lib/outbox";
import {
  ADMIN_SESSION_COOKIE,
  createAdmin,
  createAdminSession,
  ensureBootstrapAdmin,
  listAdmins,
} from "../src/lib/admin-auth";
import { addDays, todayISO } from "../src/lib/time";

/**
 * abc.com showing ABC's venues, under ABC's name, on the same server.
 *
 * The thing to get right is which storefront a request is for: only a
 * hostname the owner registered, matched exactly, and nothing a visitor can
 * put in a header to reach anything a storefront would not show anyway.
 */

let abcVenue: number;
let otherVenue: number;
let abcId: number;

const on = (host: string, path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${path}`, { headers: { host, ...headers } });

beforeAll(() => {
  const [first, second] = listVenues();
  abcVenue = first.id;
  otherVenue = second.id;
  const saved = saveStorefront({
    hostname: "https://www.ABCbadminton.com/",
    name: "ABC Badminton",
    tagline: "Courts in PJ",
    accentColor: "#1d4ed8",
    venueIds: [abcVenue],
  });
  if (!saved.ok) throw new Error(saved.error);
  abcId = saved.storefront.id;
});

afterEach(() => delete process.env.MYSENAM_TRUST_FORWARDED_HOST);

describe("which storefront a request is for", () => {
  it("is the hostname, however it is written", () => {
    expect(normalizeHost("ABCbadminton.com")).toBe("abcbadminton.com");
    expect(normalizeHost("www.abcbadminton.com:443")).toBe("abcbadminton.com");
    expect(normalizeHost("abcbadminton.com.")).toBe("abcbadminton.com");
    expect(storefrontForHost("WWW.AbcBadminton.com:8080")?.name).toBe("ABC Badminton");
  });

  it("is nothing for any hostname the owner did not register", () => {
    expect(storefrontForHost("mysenam.my")).toBeNull();
    expect(storefrontForHost("evil.abcbadminton.com")).toBeNull();
    expect(storefrontForHost("abcbadminton.com.evil.com")).toBeNull();
    expect(storefrontForHost("")).toBeNull();
    expect(storefrontForHost(null)).toBeNull();
  });

  it("ignores X-Forwarded-Host unless the install trusts its proxy", () => {
    const req = on("mysenam.my", "/", { "x-forwarded-host": "abcbadminton.com" });
    expect(storefrontForRequest(req)).toBeNull();
    process.env.MYSENAM_TRUST_FORWARDED_HOST = "on";
    expect(storefrontForRequest(req)?.name).toBe("ABC Badminton");
  });
});

describe("setting one up", () => {
  const base = { name: "XYZ Futsal", venueIds: [] as number[] };

  it("takes a domain and nothing else", () => {
    for (const bad of ["not a domain", "localhost", "abc", "abc..com", "-abc.com"])
      expect(saveStorefront({ ...base, hostname: bad, venueIds: [otherVenue] }).ok, bad).toBe(false);
  });

  it("cannot take the marketplace's own address, or one already taken", () => {
    expect(saveStorefront({ ...base, hostname: "mysenam.my", venueIds: [otherVenue] }).ok).toBe(false);
    expect(saveStorefront({ ...base, hostname: "abcbadminton.com", venueIds: [otherVenue] }).ok).toBe(false);
  });

  it("needs at least one venue that exists", () => {
    expect(saveStorefront({ ...base, hostname: "xyz.my", venueIds: [] }).ok).toBe(false);
    expect(saveStorefront({ ...base, hostname: "xyz.my", venueIds: [999999] }).ok).toBe(false);
  });

  it("refuses a colour too light for white writing on its buttons", () => {
    expect(contrastWithWhite("#ffffff")).toBeCloseTo(1);
    expect(contrastWithWhite("#000000")).toBeCloseTo(21);
    expect(saveStorefront({ ...base, hostname: "xyz.my", accentColor: "#fde047", venueIds: [otherVenue] }).ok).toBe(false);
    expect(saveStorefront({ ...base, hostname: "xyz.my", accentColor: "red", venueIds: [otherVenue] }).ok).toBe(false);
  });

  it("takes a logo only from an https address", () => {
    expect(
      saveStorefront({ ...base, hostname: "xyz.my", logoUrl: "javascript:alert(1)", venueIds: [otherVenue] }).ok
    ).toBe(false);
    expect(
      saveStorefront({ ...base, hostname: "xyz.my", logoUrl: 'https://x.my/a.png" onerror="x', venueIds: [otherVenue] }).ok
    ).toBe(false);
  });

  it("can be changed and removed", () => {
    const made = saveStorefront({ ...base, hostname: "xyz.my", venueIds: [otherVenue] });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const changed = saveStorefront({ ...base, id: made.storefront.id, hostname: "xyzfutsal.my", venueIds: [otherVenue] });
    expect(changed.ok && changed.storefront.hostname).toBe("xyzfutsal.my");
    expect(storefrontForHost("xyz.my")).toBeNull();
    expect(deleteStorefront(made.storefront.id)).toBe(true);
    expect(storefrontForHost("xyzfutsal.my")).toBeNull();
    expect(saveStorefront({ ...base, id: made.storefront.id, hostname: "gone.my", venueIds: [otherVenue] }).ok).toBe(false);
  });
});

describe("its colour", () => {
  it("replaces the teal the whole interface is drawn in", () => {
    const css = accentCss("#1d4ed8");
    expect(css).toContain("--color-teal-600:#1d4ed8;");
    expect(css).toMatch(/--color-teal-50:color-mix\(in oklab, #1d4ed8 8%, white\);/);
    expect(css).toMatch(/--color-teal-900:color-mix\(in oklab, #1d4ed8 56%, black\);/);
  });

  it("writes nothing for anything that is not a colour", () => {
    expect(accentCss("red;}body{display:none")).toBe("");
    expect(accentCss("#12345")).toBe("");
  });
});

describe("what it shows", () => {
  it("lists only its own venues", async () => {
    const { GET } = await import("../src/app/api/venues/route");
    const abc = await (await GET(on("abcbadminton.com", "/api/venues"))).json();
    expect(abc.venues.map((v: { id: number }) => v.id)).toEqual([abcVenue]);
    const all = await (await GET(on("mysenam.my", "/api/venues"))).json();
    expect(all.venues.length).toBeGreaterThan(1);
  });

  it("searches only its own venues and their areas", async () => {
    const { GET } = await import("../src/app/api/search/route");
    const sport = listVenues().find((v) => v.id === abcVenue)!.courts[0].sport;
    const date = addDays(todayISO(), 2);
    const res = await (await GET(on("abcbadminton.com", `/api/search?sport=${sport}&date=${date}`))).json();
    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results.every((r: { venue: { id: number } }) => r.venue.id === abcVenue)).toBe(true);
    expect(res.areas).toEqual([listVenues().find((v) => v.id === abcVenue)!.area]);
  });

  it("answers not found for another venue's availability", async () => {
    const { GET } = await import("../src/app/api/availability/route");
    const date = addDays(todayISO(), 2);
    expect((await GET(on("abcbadminton.com", `/api/availability?venueId=${otherVenue}&date=${date}`))).status).toBe(404);
    expect((await GET(on("abcbadminton.com", `/api/availability?venueId=${abcVenue}&date=${date}`))).status).toBe(200);
    expect((await GET(on("mysenam.my", `/api/availability?venueId=${otherVenue}&date=${date}`))).status).toBe(200);
  });
});

describe("links back", () => {
  it("send a venue's customers to its storefront, and everybody else to the marketplace", () => {
    expect(venueBaseUrl(abcVenue)).toBe("https://abcbadminton.com");
    expect(venueBaseUrl(otherVenue)).toBe("https://mysenam.my");
  });

  it("put the storefront in the confirmation a customer is sent", () => {
    const court = listVenues().find((v) => v.id === abcVenue)!.courts.find((c) => c.capacity === 1)!;
    const made = createBooking({ courtId: court.id, date: addDays(todayISO(), 3), hours: [9], name: "Aina", phone: "0123456780" });
    if (!made.ok) throw new Error(made.error);
    notifyBookingConfirmed([made.booking], "en", null);
    expect(messagesForBooking(made.booking.id)[0].body).toContain("https://abcbadminton.com/my-booking");
  });
});

describe("managing them", () => {
  it("is for the platform owner only", async () => {
    ensureBootstrapAdmin();
    const desk = createAdmin({ name: "Desk", email: "desk-sf@example.com", password: "desk-password", venueId: abcVenue });
    if (!desk.ok) throw new Error(desk.error);
    const { GET } = await import("../src/app/api/admin/storefronts/route");
    const as = (id: number) =>
      new NextRequest("http://localhost/api/admin/storefronts", {
        headers: { cookie: `${ADMIN_SESSION_COOKIE}=${createAdminSession(id).token}` },
      });
    expect(GET(as(desk.admin.id)).status).toBe(403);
    const owner = listAdmins().find((a) => a.venueId === null)!;
    const res = GET(as(owner.id));
    expect(res.status).toBe(200);
    expect((await res.json()).storefronts.some((s: { id: number }) => s.id === abcId)).toBe(true);
  });
});
