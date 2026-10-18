import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

// The class routes read the customer's language from a cookie.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("../src/lib/transports", async (original) => ({
  ...(await original<typeof import("../src/lib/transports")>()),
  sendPlainEmail: async () => true,
}));

import { NextRequest } from "next/server";
import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { askToJoin, findGames, openGame } from "../src/lib/games";
import { createLeague, join } from "../src/lib/leagues";
import { exportCustomerData } from "../src/lib/privacy";
import { resetRateLimits } from "../src/lib/rate-limit";
import { createBooking, createClassSessions, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { createTournament, enter } from "../src/lib/tournaments";
import { allows, categoryRefusal, setPlayerGender, type Gender } from "../src/lib/who";

/** Women-only and men-only: games, tournament categories, leagues and classes. */

let n = 0;
let slot = 0;
let venueId: number;
let courtId: number;
let ownerId: number;

async function player(gender?: Gender): Promise<User> {
  n++;
  const made = await registerUser({ name: `Player ${n}`, email: `w${n}@who.my`, phone: `01240${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  if (gender) await setPlayerGender(made.user.id, gender);
  return made.user;
}

async function bookingFor(host: User) {
  slot++;
  const made = await createBooking({ courtId, date: addDays(todayISO(), 2 + (slot % 10)), hours: [8 + Math.floor(slot / 10)], name: host.name, phone: host.phone, userId: host.id });
  if (!made.ok) throw new Error("booking");
  return made.booking;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courtId = venue.courts[0].id;
});

describe("the rules", () => {
  it("let anyone into anything open, and only who it says into the rest", async () => {
    expect(allows("anyone", null)).toBe(true);
    expect(allows("women", "woman")).toBe(true);
    expect(allows("women", "unsaid")).toBe(false);
    expect(allows("men", "woman")).toBe(false);
    const woman = await player("woman");
    const man = await player("man");
    const never = await player();
    expect(await categoryRefusal(never.id, "women", null)).toMatchObject({ code: "GENDER_NEEDED" });
    expect(await categoryRefusal(woman.id, "open", null)).toBeNull();
    expect(await categoryRefusal(woman.id, "women", null)).toBeNull();
    expect(await categoryRefusal(woman.id, "women", { partnerGender: "man" })).toMatchObject({ code: "WHO_WOMEN" });
    expect(await categoryRefusal(woman.id, "women", { partnerGender: null })).toMatchObject({ code: "PARTNER_GENDER" });
    expect(await categoryRefusal(man.id, "men", { partnerGender: "man" })).toBeNull();
    expect(await categoryRefusal(woman.id, "mixed", { partnerGender: "man" })).toBeNull();
    expect(await categoryRefusal(man.id, "mixed", { partnerGender: "man" })).toMatchObject({ code: "WHO_MIXED" });
    const unsaid = await player("unsaid");
    expect(await categoryRefusal(unsaid.id, "mixed", { partnerGender: "man" })).toMatchObject({ code: "WHO_MIXED" });
  });
});

describe("open games", () => {
  it("women-only is opened by a woman and joined only by women, and can be looked for", async () => {
    const man = await player("man");
    expect(await openGame(man.id, { bookingCode: (await bookingFor(man)).code, spots: 2, level: null, share: 5, autoAccept: true, who: "women" })).toMatchObject({
      ok: false,
      code: "WHO_WOMEN",
    });
    const newcomer = await player();
    expect(
      await openGame(newcomer.id, { bookingCode: (await bookingFor(newcomer)).code, spots: 2, level: null, share: 5, autoAccept: true, who: "women" })
    ).toMatchObject({ ok: false, code: "GENDER_NEEDED" });

    const host = await player("woman");
    const opened = await openGame(host.id, { bookingCode: (await bookingFor(host)).code, spots: 2, level: null, share: 5, autoAccept: true, who: "women" });
    if (!opened.ok) throw new Error(opened.error);
    expect(opened.game.who).toBe("women");
    expect(await askToJoin(man, opened.game.id)).toMatchObject({ ok: false, code: "WHO_WOMEN", status: 403 });
    expect(await askToJoin(await player("unsaid"), opened.game.id)).toMatchObject({ ok: false, code: "WHO_WOMEN" });
    expect(await askToJoin(await player(), opened.game.id)).toMatchObject({ ok: false, code: "GENDER_NEEDED" });
    expect(await askToJoin(await player("woman"), opened.game.id)).toMatchObject({ ok: true });

    const anyone = await player();
    const open = await openGame(anyone.id, { bookingCode: (await bookingFor(anyone)).code, spots: 2, level: null, share: 5, autoAccept: true });
    if (!open.ok) throw new Error(open.error);
    expect(await askToJoin(man, open.game.id)).toMatchObject({ ok: true });

    const womenOnly = await findGames({ who: "women" });
    expect(womenOnly.map((g) => g.id)).toContain(opened.game.id);
    expect(womenOnly.every((g) => g.who === "women")).toBe(true);
    expect((await findGames({})).some((g) => g.id === open.game.id)).toBe(true);
  });

  it("through the routes: asking says what to do next", async () => {
    resetRateLimits();
    const host = await player("woman");
    const opened = await openGame(host.id, { bookingCode: (await bookingFor(host)).code, spots: 2, level: null, share: 5, autoAccept: true, who: "women" });
    if (!opened.ok) throw new Error(opened.error);
    const newcomer = await player();
    const cookie = `${SESSION_COOKIE}=${(await createSession(newcomer.id)).token}`;
    const route = await import("../src/app/api/games/[id]/route");
    const ask = () =>
      route.POST(
        new NextRequest(`http://localhost/api/games/${opened.game.id}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ action: "join" }) }),
        { params: Promise.resolve({ id: String(opened.game.id) }) }
      );
    const first = await ask();
    expect(first.status).toBe(403);
    expect(await first.json()).toMatchObject({ code: "GENDER_NEEDED" });

    const about = await import("../src/app/api/my/about/route");
    const post = (body: object) =>
      about.POST(new NextRequest("http://localhost/api/my/about", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    expect((await post({ gender: "other" })).status).toBe(400);
    expect((await post({ gender: "woman" })).status).toBe(200);
    expect(await (await about.GET(new NextRequest("http://localhost/api/my/about", { headers: { cookie } }))).json()).toEqual({ gender: "woman" });
    expect((await about.GET(new NextRequest("http://localhost/api/my/about"))).status).toBe(401);
    expect((await ask()).status).toBe(200);
    expect((await exportCustomerData(newcomer.id))?.account.playsIn).toBe("woman");

    const list = await import("../src/app/api/games/route");
    expect((await list.GET(new NextRequest("http://localhost/api/games?who=nobody"))).status).toBe(400);
    const found = await (await list.GET(new NextRequest("http://localhost/api/games?who=women"))).json();
    expect(found.games.every((g: { who: string }) => g.who === "women")).toBe(true);
  });
});

describe("tournament categories", () => {
  let day = 20;
  const tournament = async (over: object) => {
    const date = addDays(todayISO(), day++);
    const made = await createTournament(
      { venueId, name: `Cup ${day}`, sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 0, maxEntries: 16, startsOn: date, endsOn: date, startHour: 9, endHour: 21, courtIds: [courtId], ...over },
      ownerId
    );
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };

  it("take only who the event is for, mixed doubles a woman and a man", async () => {
    const ws = await tournament({ category: "women" });
    expect(ws.category).toBe("women");
    expect(await enter(await player("man"), ws.id)).toMatchObject({ ok: false, code: "WHO_WOMEN" });
    expect(await enter(await player("woman"), ws.id)).toMatchObject({ ok: true });

    const xd = await tournament({ category: "mixed", teamSize: 2 });
    const her = await player("woman");
    expect(await enter(her, xd.id, { partnerName: "Ali Hassan" })).toMatchObject({ ok: false, code: "PARTNER_GENDER" });
    expect(await enter(her, xd.id, { partnerName: "Siti Nur", partnerGender: "woman" })).toMatchObject({ ok: false, code: "WHO_MIXED" });
    expect(await enter(her, xd.id, { partnerName: "Ali Hassan", partnerGender: "man" })).toMatchObject({ ok: true });

    const md = await tournament({ category: "men", teamSize: 2 });
    expect(await enter(await player("man"), md.id, { partnerName: "Raj Kumar", partnerGender: "man" })).toMatchObject({ ok: true });
    expect(await enter(await player("man"), md.id, { partnerName: "Mei Ling", partnerGender: "woman" })).toMatchObject({ ok: false, code: "WHO_MEN" });

    expect(await createTournament(
      { venueId, name: "Odd Mixed", sport: "badminton", format: "knockout", teamSize: 1, category: "mixed", level: null, entryFee: 0, maxEntries: 8, startsOn: addDays(todayISO(), 40), endsOn: addDays(todayISO(), 40), startHour: 9, endHour: 12, courtIds: [courtId] },
      ownerId
    )).toMatchObject({ ok: false, error: expect.stringContaining("Mixed is doubles") });
    expect(await createTournament(
      { venueId, name: "Odd Cat", sport: "badminton", format: "knockout", teamSize: 1, category: "kids" as never, level: null, entryFee: 0, maxEntries: 8, startsOn: addDays(todayISO(), 41), endsOn: addDays(todayISO(), 41), startHour: 9, endHour: 12, courtIds: [courtId] },
      ownerId
    )).toMatchObject({ ok: false });
  });
});

describe("leagues", () => {
  it("women-only takes women", async () => {
    const made = await createLeague(
      { venueId, name: "Ladies Ladder", sport: "badminton", teamSize: 1, who: "women", level: null, fee: 0, startsOn: addDays(todayISO(), 3) },
      ownerId
    );
    if (!made.ok) throw new Error(made.error);
    expect(made.value.who).toBe("women");
    expect(await join(await player("man"), made.value.id)).toMatchObject({ ok: false, code: "WHO_WOMEN" });
    expect(await join(await player("woman"), made.value.id)).toMatchObject({ ok: true });
    expect(await createLeague({ venueId, name: "Odd", sport: "badminton", teamSize: 1, who: "kids" as never, level: null, fee: 0, startsOn: addDays(todayISO(), 3) }, ownerId)).toMatchObject({ ok: false });
  });
});

describe("classes", () => {
  it("women-only takes a woman's account, or a guest who says so", async () => {
    resetRateLimits();
    const court = (await listVenues())[0].courts.find((c) => c.capacity > 1)!;
    const made = await createClassSessions({
      courtId: court.id,
      name: "Ladies Aerobics",
      instructor: "Kak Ros",
      date: addDays(todayISO(), 5),
      startHour: 9,
      endHour: 10,
      capacity: 10,
      price: 15,
      who: "women",
    });
    if (!made.ok) throw new Error(made.error);
    const session = made.classes[0];
    expect(session.who).toBe("women");
    const route = await import("../src/app/api/classes/enrol/route");
    const enrol = (body: object, cookie?: string) =>
      route.POST(
        new NextRequest("http://localhost/api/classes/enrol", {
          method: "POST",
          headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
          body: JSON.stringify({ classId: session.id, name: "Guest Person", ...body }),
        })
      );
    const guest = await enrol({ phone: "0125550001" });
    expect(guest.status).toBe(403);
    expect(await guest.json()).toMatchObject({ code: "WHO_CONFIRM_WOMEN" });
    expect((await enrol({ phone: "0125550001", confirmWho: true })).status).toBe(201);

    const man = await player("man");
    const manCookie = `${SESSION_COOKIE}=${(await createSession(man.id)).token}`;
    expect((await enrol({ phone: man.phone, confirmWho: true }, manCookie)).status).toBe(403);
    const woman = await player("woman");
    const womanCookie = `${SESSION_COOKIE}=${(await createSession(woman.id)).token}`;
    expect((await enrol({ phone: woman.phone }, womanCookie)).status).toBe(201);

    expect(await createClassSessions({ courtId: court.id, name: "Odd", instructor: "X", date: addDays(todayISO(), 6), startHour: 9, endHour: 10, capacity: 5, price: 10, who: "kids" as never })).toMatchObject({ ok: false });

    // The waiting list asks the same.
    const waitlist = await import("../src/app/api/waitlist/route");
    const queued = await waitlist.POST(
      new NextRequest("http://localhost/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: manCookie },
        body: JSON.stringify({ classId: session.id, name: man.name, phone: man.phone }),
      })
    );
    expect(queued.status).toBe(403);
  });
});
