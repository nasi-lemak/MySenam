import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import {
  addonById,
  addonsFor,
  attachAddons,
  createAddon,
  hasAddons,
  listAddons,
  MAX_ADDONS,
  offered,
  priceChoice,
  readAddonInput,
  readChosen,
  updateAddon,
} from "../src/lib/addons";
import { createBooking, createClassSessions, issuePass, listBookingsForDate, listVenues, payBookingWithPass } from "../src/lib/store";
import { getDb } from "../src/lib/db";
import { addDays, todayISO } from "../src/lib/time";
import type { Court } from "../src/lib/types";

/** Rackets to hire and shuttles to buy, added to a booking or a class. */

const day = addDays(todayISO(), 3);
let venueId: number;
let otherVenueId: number;
let court: Court;
let court2: Court;
let ownerId: number;
let ip = 0;

function req(path: string, method = "GET", body?: unknown, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": `10.9.0.${++ip}` };
  if (cookie) headers.cookie = cookie;
  return new NextRequest(`http://localhost${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function book(hours: number[], phone: string, date = day, on = court) {
  const made = await createBooking({ courtId: on.id, date, hours, name: "Aisyah", phone });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins()).find((a) => a.venueId === null)!.id;
  const venues = await listVenues();
  const v = venues.find((x) => x.courts.filter((c) => c.sport === "badminton" && c.capacity === 1).length >= 2)!;
  venueId = v.id;
  [court, court2] = v.courts.filter((c) => c.sport === "badminton" && c.capacity === 1);
  otherVenueId = venues.find((x) => x.id !== venueId)!.id;
});

describe("a venue's extras", () => {
  it("are named, priced and counted sensibly", async () => {
    const base = { name: "Racket", kind: "rental" as const, price: 5 };
    expect(await createAddon(venueId, { ...base, name: "x" })).toMatchObject({ ok: false });
    expect(await createAddon(venueId, { ...base, kind: "loan" as never })).toMatchObject({ ok: false });
    expect(await createAddon(venueId, { ...base, price: -1 })).toMatchObject({ ok: false });
    expect(await createAddon(venueId, { ...base, price: NaN })).toMatchObject({ ok: false });
    expect(await createAddon(venueId, { ...base, stock: 0 })).toMatchObject({ ok: false });
    expect(await createAddon(venueId, { ...base, stock: 1.5 })).toMatchObject({ ok: false });
    expect(await createAddon(venueId, { ...base, sport: "curling" as never })).toMatchObject({ ok: false });
    // A sale has no stock to run out of.
    const tube = await createAddon(venueId, { name: " Shuttle tube ", kind: "sale", price: 18.555, stock: 9 });
    expect(tube).toMatchObject({ ok: true, value: { name: "Shuttle tube", price: 18.56, stock: null, active: true } });
  });

  it("are retired, not deleted, and only so many at once", async () => {
    const extra = await createAddon(otherVenueId, { name: "Towel", kind: "sale", price: 3 });
    if (!extra.ok) throw new Error(extra.error);
    const retired = await updateAddon(extra.value.id, { ...extra.value, active: false });
    expect(retired).toMatchObject({ ok: true, value: { active: false } });
    expect(await listAddons(otherVenueId, { activeOnly: true })).toEqual([]);
    for (let i = 0; i < MAX_ADDONS; i++) expect((await createAddon(otherVenueId, { name: `Drink ${i}`, kind: "sale", price: 2 })).ok).toBe(true);
    expect(await createAddon(otherVenueId, { name: "One more", kind: "sale", price: 2 })).toMatchObject({ ok: false });
    // Bringing one back counts too.
    expect(await updateAddon(extra.value.id, { ...extra.value, active: true })).toMatchObject({ ok: false });
    expect(await updateAddon(999999, { ...extra.value })).toMatchObject({ ok: false });
    expect(await updateAddon(extra.value.id, { ...extra.value, name: "" })).toMatchObject({ ok: false });
  });

  it("read from a request", () => {
    expect(readChosen(undefined)).toEqual([]);
    expect(readChosen(null)).toEqual([]);
    expect(readChosen("racket")).toBeNull();
    expect(readChosen([{ addonId: "x", quantity: 1 }])).toBeNull();
    expect(readChosen(Array.from({ length: MAX_ADDONS + 1 }, (_, i) => ({ addonId: i, quantity: 1 })))).toBeNull();
    expect(readChosen([{ addonId: 3, quantity: 2 }, { addonId: 4, quantity: 0 }])).toEqual([{ addonId: 3, quantity: 2 }]);
    expect(readAddonInput({ name: "Bibs", kind: "rental", price: "4", stock: "", sport: "futsal" })).toEqual({
      name: "Bibs",
      kind: "rental",
      price: 4,
      stock: null,
      sport: "futsal",
      active: true,
    });
    expect(Number.isNaN(readAddonInput({ price: "" }).price)).toBe(true);
    expect(readAddonInput({ stock: 7, active: false })).toMatchObject({ stock: 7, sport: null, active: false });
  });
});

describe("choosing extras", () => {
  let racket: number;
  let tube: number;
  let futsalBibs: number;

  beforeAll(async () => {
    const r = await createAddon(venueId, { name: "Racket", kind: "rental", price: 5, stock: 3 });
    const b = await createAddon(venueId, { name: "Bibs", kind: "rental", price: 4, sport: "futsal" });
    if (!r.ok || !b.ok) throw new Error("setup");
    racket = r.value.id;
    futsalBibs = b.value.id;
    tube = (await listAddons(venueId)).find((a) => a.name === "Shuttle tube")!.id;
  });

  it("offers only this sport's and says how many rentals are left", async () => {
    const list = await offered(venueId, "badminton", day, [18, 19]);
    expect(list.map((a) => a.name).sort()).toEqual(["Racket", "Shuttle tube"]);
    expect(list.find((a) => a.id === racket)!.left).toBe(3);
    expect(list.find((a) => a.id === tube)!.left).toBeNull();
  });

  it("prices a choice and refuses what is not on offer", async () => {
    const at = { venueId, sport: "badminton" as const, date: day, hours: [18] };
    expect(await priceChoice([{ addonId: racket, quantity: 2 }, { addonId: tube, quantity: 1 }], at)).toMatchObject({ ok: true, total: 28.56 });
    expect(await priceChoice([{ addonId: racket, quantity: 0 }], at)).toMatchObject({ ok: false, code: "ADDON_QUANTITY" });
    expect(await priceChoice([{ addonId: racket, quantity: 21 }], at)).toMatchObject({ ok: false, code: "ADDON_QUANTITY" });
    expect(await priceChoice([{ addonId: racket, quantity: 1 }, { addonId: racket, quantity: 1 }], at)).toMatchObject({ ok: false });
    expect(await priceChoice([{ addonId: futsalBibs, quantity: 1 }], at)).toMatchObject({ ok: false, code: "ADDON_NOT_OFFERED" });
    expect(await priceChoice([{ addonId: 999999, quantity: 1 }], at)).toMatchObject({ ok: false, code: "ADDON_NOT_OFFERED" });
    expect(await priceChoice([{ addonId: racket, quantity: 4 }], at)).toMatchObject({ ok: false, code: "ADDON_FEW_LEFT", vars: { n: 3, name: "racket" } });
  });

  it("adds them to the booking's price, and holds rentals for its hours", async () => {
    const first = await book([18, 19], "0130000001");
    const added = await attachAddons(first.id, [{ addonId: racket, quantity: 2 }, { addonId: tube, quantity: 1 }]);
    expect(added).toMatchObject({ ok: true, total: 28.56 });
    const row = (await getDb().prepare("SELECT total_price FROM bookings WHERE id = ?").get(first.id)) as { total_price: string | number };
    expect(Number(row.total_price)).toBe(first.totalPrice + 28.56);
    expect(await hasAddons(first.id)).toBe(true);
    expect((await addonsFor([first.id])).get(first.id)).toEqual([
      { addonId: racket, name: "Racket", kind: "rental", quantity: 2, unitPrice: 5 },
      { addonId: tube, name: "Shuttle tube", kind: "sale", quantity: 1, unitPrice: 18.56 },
    ]);
    expect(await addonsFor([])).toEqual(new Map());

    // One racket left at 19:00, three again at 20:00.
    expect((await offered(venueId, "badminton", day, [19])).find((a) => a.id === racket)!.left).toBe(1);
    expect((await offered(venueId, "badminton", day, [20])).find((a) => a.id === racket)!.left).toBe(3);

    // Another court, the same rackets.
    const second = await book([19], "0130000002", day, court2);
    expect(await attachAddons(second.id, [{ addonId: racket, quantity: 2 }])).toMatchObject({ ok: false, code: "ADDON_FEW_LEFT" });
    // Refused as a whole: the booking stands at its own price, with nothing on it.
    expect(await hasAddons(second.id)).toBe(false);
    expect(await attachAddons(second.id, [{ addonId: racket, quantity: 1 }])).toMatchObject({ ok: true });
    expect((await offered(venueId, "badminton", day, [19])).find((a) => a.id === racket)!.left).toBe(0);
    const third = await book([19], "0130000003", addDays(day, 1));
    // Another day is another stock.
    expect(await attachAddons(third.id, [{ addonId: racket, quantity: 3 }])).toMatchObject({ ok: true });

    expect(await attachAddons(first.id, [])).toEqual({ ok: true, lines: [], total: 0 });
    expect(await attachAddons(999999, [{ addonId: tube, quantity: 1 }])).toMatchObject({ ok: false, code: "BOOKING_NOT_FOUND" });

    // A cancelled booking gives its rackets back.
    await getDb().prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(second.id);
    expect((await offered(venueId, "badminton", day, [19])).find((a) => a.id === racket)!.left).toBe(1);

    // The desk sees them on the day's list.
    const desk = await listBookingsForDate(day, venueId);
    expect(desk.find((b) => b.id === first.id)!.addons).toHaveLength(2);
    expect(desk.find((b) => b.id === second.id)!.addons).toEqual([{ addonId: racket, name: "Racket", kind: "rental", quantity: 1, unitPrice: 5 }]);
  });

  it("keeps a pass for court time", async () => {
    const phone = "0130000009";
    const pass = await issuePass({
      venueId,
      sport: "badminton",
      name: "5 hours",
      entries: 5,
      price: 50,
      holderName: "Aisyah",
      holderPhone: phone,
      expiresOn: addDays(todayISO(), 60),
      adminId: ownerId,
    });
    if (!pass.ok) throw new Error(pass.error);
    const withExtras = await book([8], phone);
    await attachAddons(withExtras.id, [{ addonId: tube, quantity: 1 }]);
    expect(await payBookingWithPass(withExtras.id, pass.pass.code)).toMatchObject({ ok: false, code: "PASS_NOT_FOR_EXTRAS" });
    const plain = await book([9], phone);
    expect(await payBookingWithPass(plain.id, pass.pass.code)).toMatchObject({ ok: true, spent: 1 });
  });
});

describe("the routes", () => {
  let racket: number;
  let deskCookie: string;
  let ownerCookie: string;

  beforeAll(async () => {
    racket = (await listAddons(venueId)).find((a) => a.name === "Racket")!.id;
    const desk = await createAdmin({ name: "Desk", email: "desk@addons.my", password: "desk-password", venueId: otherVenueId });
    if (!desk.ok) throw new Error(desk.error);
    deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(ownerId)).token}`;
  });

  it("list what is offered for a court, a venue and sport, or a class", async () => {
    const mod = await import("../src/app/api/addons/route");
    const byCourt = await (await mod.GET(req(`/api/addons?courtId=${court.id}&date=${day}&hours=19`))).json();
    expect(byCourt.addons.find((a: { id: number }) => a.id === racket)).toMatchObject({ name: "Racket", left: 1 });
    const byVenue = await (await mod.GET(req(`/api/addons?venueId=${venueId}&sport=futsal&date=${day}`))).json();
    expect(byVenue.addons.map((a: { name: string }) => a.name).sort()).toEqual(["Bibs", "Racket", "Shuttle tube"]);
    expect((await mod.GET(req(`/api/addons?venueId=${venueId}&sport=curling&date=${day}`))).status).toBe(400);
    expect((await mod.GET(req(`/api/addons?courtId=${court.id}&date=soon`))).status).toBe(400);
    expect((await mod.GET(req(`/api/addons?courtId=${court.id}&date=${day}&hours=25`))).status).toBe(400);
    expect((await (await mod.GET(req(`/api/addons?courtId=999999&date=${day}`))).json()).addons).toEqual([]);
    expect((await (await mod.GET(req("/api/addons?classId=999999"))).json()).addons).toEqual([]);

    const made = await createClassSessions({ courtId: court.id, name: "Smash clinic", instructor: "Coach Lee", date: addDays(day, 2), startHour: 10, endHour: 12, capacity: 1, price: 40 });
    if (!made.ok) throw new Error(made.error);
    const byClass = await (await mod.GET(req(`/api/addons?classId=${made.classes[0].id}`))).json();
    expect(byClass.addons.find((a: { id: number }) => a.id === racket)).toMatchObject({ left: 3 });
  });

  it("put extras on a booking, and say plainly when they cannot", async () => {
    const mod = await import("../src/app/api/bookings/route");
    const body = { courtId: court.id, date: addDays(day, 4), hours: [20, 21], name: "Nurul", phone: "0131111111" };
    const bad = await mod.POST(req("/api/bookings", "POST", { ...body, addons: "racket" }));
    expect(bad.status).toBe(400);
    const tooMany = await mod.POST(req("/api/bookings", "POST", { ...body, addons: [{ addonId: racket, quantity: 4 }] }));
    expect(tooMany.status).toBe(409);
    expect((await tooMany.json()).code).toBe("ADDON_FEW_LEFT");
    const pass = await mod.POST(req("/api/bookings", "POST", { ...body, payWithPass: "PS-AAAAAA", addons: [{ addonId: racket, quantity: 1 }] }));
    expect(pass.status).toBe(409);
    expect((await pass.json()).code).toBe("PASS_NOT_FOR_EXTRAS");

    const ok = await mod.POST(req("/api/bookings", "POST", { ...body, addons: [{ addonId: racket, quantity: 2 }] }));
    expect(ok.status).toBe(201);
    const out = await ok.json();
    expect(out.addons).toEqual([{ addonId: racket, name: "Racket", kind: "rental", quantity: 2, unitPrice: 5 }]);
    expect(out.addonError).toBeNull();
    const courtOnly = out.booking.totalPrice - 10;
    expect(courtOnly).toBeGreaterThan(0);

    // Looked up later, it still says what came with it.
    const look = await (await mod.GET(req(`/api/bookings?code=${out.booking.code}&phone=0131111111`))).json();
    expect(look.addons).toHaveLength(1);
    expect(look.booking.totalPrice).toBe(out.booking.totalPrice);

    // Any court at the venue works the same way.
    const any = await mod.POST(
      req("/api/bookings", "POST", { venueId, sport: "badminton", date: addDays(day, 4), hours: [20], name: "Mei", phone: "0132222222", addons: [{ addonId: racket, quantity: 1 }] })
    );
    expect(any.status).toBe(201);
    expect((await any.json()).addons).toHaveLength(1);
    // And now every racket is out at 20:00.
    const none = await mod.POST(
      req("/api/bookings", "POST", { venueId, sport: "badminton", date: addDays(day, 4), hours: [20], name: "Raj", phone: "0133333333", addons: [{ addonId: racket, quantity: 1 }] })
    );
    expect(none.status).toBe(409);
    expect((await none.json()).code).toBe("ADDON_SOLD_OUT");
  });

  it("put extras on a class enrolment", async () => {
    const mod = await import("../src/app/api/classes/enrol/route");
    const made = await createClassSessions({ courtId: court.id, name: "Footwork", instructor: "Coach Lee", date: addDays(day, 5), startHour: 9, endHour: 10, capacity: 1, price: 30 });
    if (!made.ok) throw new Error(made.error);
    const classId = made.classes[0].id;
    expect((await mod.POST(req("/api/classes/enrol", "POST", { classId, name: "Siti", phone: "0134444444", addons: {} }))).status).toBe(400);
    const tooMany = await mod.POST(req("/api/classes/enrol", "POST", { classId, name: "Siti", phone: "0134444444", addons: [{ addonId: racket, quantity: 9 }] }));
    expect(tooMany.status).toBe(409);
    const res = await mod.POST(req("/api/classes/enrol", "POST", { classId, name: "Siti", phone: "0134444444", addons: [{ addonId: racket, quantity: 1 }] }));
    expect(res.status).toBe(201);
    const out = await res.json();
    expect(out.booking.totalPrice).toBe(35);
    expect(out.addons).toHaveLength(1);
  });

  it("let a venue's staff manage only their own extras", async () => {
    const list = await import("../src/app/api/admin/addons/route");
    const one = await import("../src/app/api/admin/addons/[id]/route");
    const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

    expect((await list.GET(req(`/api/admin/addons?venueId=${venueId}`))).status).toBe(401);
    expect((await list.GET(req(`/api/admin/addons?venueId=${venueId}`, "GET", undefined, deskCookie))).status).toBe(403);
    expect((await list.GET(req("/api/admin/addons?venueId=x", "GET", undefined, deskCookie))).status).toBe(400);
    expect((await list.GET(req(`/api/admin/addons?venueId=${venueId}`, "GET", undefined, ownerCookie))).status).toBe(200);

    expect((await list.POST(req("/api/admin/addons", "POST", { venueId, name: "Grip", kind: "sale", price: 6 }, deskCookie))).status).toBe(403);
    expect((await list.POST(req("/api/admin/addons", "POST", { name: "Grip", kind: "sale", price: 6 }, deskCookie))).status).toBe(400);
    expect((await list.POST(req("/api/admin/addons", "POST", { venueId: otherVenueId, name: "G", kind: "sale", price: 6 }, deskCookie))).status).toBe(400);
    const towel = (await listAddons(otherVenueId)).find((a) => a.name === "Towel")!;
    const retired = (await listAddons(otherVenueId)).find((a) => a.name === "Drink 0")!;
    expect((await one.DELETE(req(`/api/admin/addons/${retired.id}`, "DELETE", undefined, deskCookie), params(retired.id))).status).toBe(200);
    expect((await addonById(retired.id))!.active).toBe(false);
    const back = await one.PATCH(req(`/api/admin/addons/${towel.id}`, "PATCH", { active: true, price: 4 }, deskCookie), params(towel.id));
    expect(back.status).toBe(200);
    expect((await back.json()).addon).toMatchObject({ active: true, price: 4 });
    expect((await one.PATCH(req(`/api/admin/addons/${towel.id}`, "PATCH", { price: -2 }, deskCookie), params(towel.id))).status).toBe(400);
    expect((await one.PATCH(req(`/api/admin/addons/${racket}`, "PATCH", { price: 1 }, deskCookie), params(racket))).status).toBe(403);
    expect((await one.PATCH(req("/api/admin/addons/999999", "PATCH", { price: 1 }, deskCookie), params(999999))).status).toBe(404);
    expect((await one.PATCH(new NextRequest(`http://localhost/api/admin/addons/${towel.id}`, { method: "PATCH", headers: { cookie: deskCookie }, body: "{" }), params(towel.id))).status).toBe(400);
    const made = await list.POST(req("/api/admin/addons", "POST", { venueId: otherVenueId, name: "Grip tape", kind: "sale", price: 6 }, deskCookie));
    expect(made.status).toBe(400); // twenty on the list already
  });
});
