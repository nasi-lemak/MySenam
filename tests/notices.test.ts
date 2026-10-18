import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { createNotice, internalLink, listNotices, MAX_DAYS, showingFor, siteNotice } from "../src/lib/notices";
import { listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/** A venue's own notices, on its own pages; the platform's one, on the front page. */

let ownerId: number;
let ownerCookie: string;
let venueIds: number[];
const today = todayISO();

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(ownerId)).token}`;
  venueIds = (await listVenues()).map((v) => v.id);
});

describe("a notice", () => {
  it("links only to a page on this site", () => {
    expect(internalLink("/tournaments/12")).toBe("/tournaments/12");
    expect(internalLink(" /search?sport=badminton ")).toBe("/search?sport=badminton");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "tournaments/1", "/a b"])
      expect(internalLink(bad)).toBeNull();
    expect(internalLink("")).toBeNull();
  });

  it("is short, dated, and for a while only", async () => {
    const base = { venueId: venueIds[0], startsOn: today, endsOn: addDays(today, 6) };
    expect(await createNotice({ ...base, text: "x" }, ownerId)).toMatchObject({ ok: false });
    expect(await createNotice({ ...base, text: "y".repeat(161) }, ownerId)).toMatchObject({ ok: false });
    expect(await createNotice({ ...base, text: "Raya Open", link: "https://elsewhere.example" }, ownerId)).toMatchObject({ ok: false, error: expect.stringContaining("page on this site") });
    expect(await createNotice({ ...base, text: "Raya Open", endsOn: addDays(today, -1), startsOn: addDays(today, -3) }, ownerId)).toMatchObject({ ok: false });
    expect(await createNotice({ ...base, text: "Raya Open", endsOn: addDays(today, MAX_DAYS) }, ownerId)).toMatchObject({ ok: false });
    expect(await createNotice({ ...base, text: "Raya Open", startsOn: "soon" }, ownerId)).toMatchObject({ ok: false });
    const made = await createNotice({ ...base, text: "  Raya   Open, 12–14 Nov  ", link: "/tournaments/1" }, ownerId);
    expect(made).toMatchObject({ ok: true, value: { text: "Raya Open, 12–14 Nov", link: "/tournaments/1" } });
  });

  it("shows on its own venue while it runs, newest first, and never as the site's", async () => {
    const later = await createNotice({ venueId: venueIds[1], text: "Coming soon", startsOn: addDays(today, 3), endsOn: addDays(today, 5) }, ownerId);
    expect(later.ok).toBe(true);
    await createNotice({ venueId: venueIds[1], text: "Older one", startsOn: today, endsOn: addDays(today, 5) }, ownerId);
    await createNotice({ venueId: venueIds[1], text: "Newer one", startsOn: today, endsOn: addDays(today, 5) }, ownerId);
    const showing = await showingFor([venueIds[1], venueIds[2]]);
    expect(showing.map((n) => n.text)).toEqual(["Newer one"]);
    expect(await showingFor([])).toEqual([]);
    expect((await listNotices(venueIds[1])).map((n) => n.text)).toEqual(["Older one", "Newer one", "Coming soon"]);
    expect(await siteNotice()).toBeNull();
  });
});

describe("the routes", () => {
  it("let a venue's staff manage only its notices, and only the owner the site's", async () => {
    const desk = await createAdmin({ name: "Desk", email: "desk@notices.my", password: "desk-password", venueId: venueIds[2] });
    if (!desk.ok) throw new Error(desk.error);
    const deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const list = await import("../src/app/api/admin/notices/route");
    const post = (cookie: string, body: object) =>
      list.POST(new NextRequest("http://localhost/api/admin/notices", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    const notice = { text: "Ladies night every Tuesday", startsOn: today, endsOn: addDays(today, 10) };

    expect((await post(deskCookie, { ...notice, venueId: venueIds[0] })).status).toBe(403);
    expect((await post(deskCookie, { ...notice, venueId: "site" })).status).toBe(403);
    expect((await post(deskCookie, { ...notice, venueId: "nope" })).status).toBe(400);
    expect((await post(deskCookie, { ...notice, venueId: venueIds[2], link: "https://x.example" })).status).toBe(400);
    const mine = await post(deskCookie, { ...notice, venueId: venueIds[2] });
    expect(mine.status).toBe(201);
    const id = (await mine.json()).notice.id;
    expect((await list.GET(new NextRequest(`http://localhost/api/admin/notices?venueId=${venueIds[2]}`, { headers: { cookie: deskCookie } }))).status).toBe(200);
    expect((await list.GET(new NextRequest("http://localhost/api/admin/notices", { headers: { cookie: deskCookie } }))).status).toBe(403);

    const site = await post(ownerCookie, { ...notice, text: "National Sports Day: courts free 9–12", venueId: "site" });
    expect(site.status).toBe(201);
    expect((await siteNotice())?.text).toBe("National Sports Day: courts free 9–12");
    const siteId = (await site.json()).notice.id;

    const one = await import("../src/app/api/admin/notices/[id]/route");
    const del = (cookie: string, nid: number) =>
      one.DELETE(new NextRequest(`http://localhost/api/admin/notices/${nid}`, { method: "DELETE", headers: { cookie } }), { params: Promise.resolve({ id: String(nid) }) });
    expect((await del(deskCookie, siteId)).status).toBe(403);
    expect((await del(deskCookie, 999999)).status).toBe(404);
    expect((await del(deskCookie, id)).status).toBe(200);
    expect((await del(ownerCookie, siteId)).status).toBe(200);
    expect(await siteNotice()).toBeNull();
  });
});
