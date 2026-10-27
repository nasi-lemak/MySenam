import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

/** The request the page is rendered for: its host (a storefront or not) and its cookies. */
const request: { host: string; cookies: Record<string, string> } = { host: "book.example.my", cookies: {} };
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: request.host }),
  cookies: async () => ({
    get: (name: string) => (name in request.cookies ? { name, value: request.cookies[name] } : undefined),
  }),
}));

import QRCode from "qrcode";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { createVenue } from "../src/lib/store";
import { saveStorefront } from "../src/lib/storefront";
import { setWaiver } from "../src/lib/waivers";
import PosterPage from "../src/app/venue/[id]/poster/page";
import WaiverPage from "../src/app/venue/[id]/waiver/page";

/**
 * The two pages a venue hands out by address rather than through the venue
 * page: the printable booking poster (its QR code and link) and its waiver in
 * its own words. Both are the venue's to show only while it is live, or to its
 * own staff while it is a draft; a storefront shows its own venues only.
 */

const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });
const poster = async (id: number | string) => renderToStaticMarkup(await PosterPage(params(id)));
const waiver = async (id: number | string) => renderToStaticMarkup(await WaiverPage(params(id)));
/** next/navigation's notFound(): the page answers 404. */
const NOT_FOUND = { digest: expect.stringContaining("404") };

const WORDS = "I take part at my own risk, follow the safety instructions of the staff and report any injury at the counter at once.";

let live: number;
let draft: number;
let other: number;
let ownerCookie: string;
let otherDeskCookie: string;

async function venue(name: string, published: boolean): Promise<number> {
  const made = await createVenue({ name, area: "PJ", address: "1 Jalan Ujian", phone: "0377770000" });
  if (!made.ok) throw new Error(made.error);
  await getDb()
    .prepare(`UPDATE venues SET published_at = ${published ? "datetime('now')" : "NULL"} WHERE id = ?`)
    .run(made.venue.id);
  return made.venue.id;
}

beforeAll(async () => {
  live = await venue("Poster Hall", true);
  draft = await venue("Draft Arena", false);
  other = await venue("Other Courts", true);
  await ensureBootstrapAdmin();
  const owner = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!;
  ownerCookie = (await createAdminSession(owner.id)).token;
  const desk = await createAdmin({ name: "Desk", email: "poster-desk@venue.my", password: "desk-password-1", venueId: other });
  if (!desk.ok) throw new Error(desk.error);
  otherDeskCookie = (await createAdminSession(desk.admin.id)).token;
});

beforeEach(() => {
  request.host = "book.example.my";
  request.cookies = {};
});

describe("the booking poster", () => {
  it("prints the venue's name, its booking link and a QR code of that link", async () => {
    const html = await poster(live);
    expect(html).toContain("Poster Hall");
    expect(html).toContain("Book your court online");
    expect(html).toContain("Tempah gelanggang anda dalam talian");
    expect(html).toContain(`https://book.example.my/venue/${live}`);
    // The QR code is the link itself, nothing else.
    const qr = await QRCode.toString(`https://book.example.my/venue/${live}`, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#0f172a", light: "#ffffff" },
    });
    expect(html).toContain(qr);
    expect(html).toContain("Print this poster");
  });

  it("points at the venue's own storefront where it has one", async () => {
    const saved = await saveStorefront({ hostname: "posterhall.my", name: "Poster Hall", venueIds: [live] });
    if (!saved.ok) throw new Error(saved.error);
    try {
      const html = await poster(live);
      expect(html).toContain(`https://posterhall.my/venue/${live}`);
      expect(html).not.toContain(`https://book.example.my/venue/${live}`);
    } finally {
      await getDb().prepare("DELETE FROM storefront_venues WHERE storefront_id = ?").run(saved.storefront.id);
      await getDb().prepare("DELETE FROM storefronts WHERE id = ?").run(saved.storefront.id);
    }
  });

  it("is nobody's for a draft but its own staff's", async () => {
    await expect(poster(draft)).rejects.toMatchObject(NOT_FOUND);
    // Another venue's front desk is not its staff.
    request.cookies = { [ADMIN_SESSION_COOKIE]: otherDeskCookie };
    await expect(poster(draft)).rejects.toMatchObject(NOT_FOUND);
    request.cookies = { [ADMIN_SESSION_COOKIE]: ownerCookie };
    expect(await poster(draft)).toContain("Draft Arena");
  });

  it("is not found for a venue that does not exist or an address that is not a number", async () => {
    await expect(poster(999999)).rejects.toMatchObject(NOT_FOUND);
    await expect(poster("abc")).rejects.toMatchObject(NOT_FOUND);
  });
});

describe("the waiver page", () => {
  it("says a venue asks for none until it writes one", async () => {
    const html = await waiver(other);
    expect(html).toContain("Other Courts asks for no waiver.");
  });

  it("shows the waiver in force, in the venue's words, and from when", async () => {
    const set = await setWaiver(live, WORDS);
    if (!set.ok || !set.waiver) throw new Error("waiver");
    const html = await waiver(live);
    expect(html).toContain("Waiver: Poster Hall");
    expect(html).toContain(WORDS);
    expect(html).toContain(`In force since ${set.waiver.createdAt.slice(0, 10)}.`);
    expect(html).toContain(`href="/venue/${live}"`);
  });

  it("shows only the newest words once the venue changes them, and none once it removes them", async () => {
    const newer = `${WORDS} Children under 12 play with an adult present.`;
    await setWaiver(live, newer);
    let html = await waiver(live);
    expect(html).toContain("Children under 12 play with an adult present.");
    expect(html.split(WORDS).length - 1).toBe(1);
    await setWaiver(live, "");
    html = await waiver(live);
    expect(html).toContain("Poster Hall asks for no waiver.");
    expect(html).not.toContain(WORDS);
    await setWaiver(live, WORDS);
  });

  it("is in the customer's language", async () => {
    request.cookies = { ms_lang: "ms" };
    const html = await waiver(live);
    expect(html).toContain("Penepian: Poster Hall");
    expect(html).toContain(WORDS);
  });

  it("is not shown for a draft except to its own staff, nor on another venue's storefront", async () => {
    await setWaiver(draft, WORDS);
    await expect(waiver(draft)).rejects.toMatchObject(NOT_FOUND);
    request.cookies = { [ADMIN_SESSION_COOKIE]: otherDeskCookie };
    await expect(waiver(draft)).rejects.toMatchObject(NOT_FOUND);
    request.cookies = { [ADMIN_SESSION_COOKIE]: ownerCookie };
    expect(await waiver(draft)).toContain(WORDS);

    const saved = await saveStorefront({ hostname: "othercourts.my", name: "Other Courts", venueIds: [other] });
    if (!saved.ok) throw new Error(saved.error);
    request.cookies = {};
    request.host = "othercourts.my";
    expect(await waiver(other)).toContain("Other Courts asks for no waiver.");
    await expect(waiver(live)).rejects.toMatchObject(NOT_FOUND);
    await expect(waiver(999999)).rejects.toMatchObject(NOT_FOUND);
  });
});
