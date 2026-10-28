import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

const sent: { to: string; subject: string; text: string }[] = [];
// Programme emails (lib/outbox.ts, emailPlayer) and emails to the venue's staff (emailPlain) are queued; each one queued is also noted here, as sent.
vi.mock("../src/lib/outbox", async (original) => {
  const real = await original<typeof import("../src/lib/outbox")>();
  return {
    ...real,
    emailPlayer: async (input: Parameters<typeof real.emailPlayer>[0]) => {
      await real.emailPlayer(input);
      const { getDb } = await import("../src/lib/db");
      const queued = (await getDb()
        .prepare("SELECT recipient, subject, body FROM messages WHERE kind = 'programme' ORDER BY id DESC LIMIT 1")
        .get()) as { recipient: string; subject: string; body: string } | undefined;
      if (queued) sent.push({ to: queued.recipient, subject: queued.subject, text: queued.body });
    },
    emailPlain: async (input: Parameters<typeof real.emailPlain>[0]) => {
      const queued = await real.emailPlain(input);
      sent.push({ to: input.to, subject: input.subject, text: input.text });
      return queued;
    },
  };
});

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { SESSION_COOKIE, createSession, registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { setPlayerLevel } from "../src/lib/games";
import {
  closeLeague,
  confirmResult,
  createLeague,
  flipScore,
  listLeagues,
  planSeason,
  setPlacePaid,
  decideResult,
  disputeResult,
  endSeason,
  join,
  leagueDetail,
  leagueHousekeeping,
  leave,
  myLeague,
  publicLeagues,
  reportResult,
  setStartBox,
  startSeason,
  type LeagueInput,
} from "../src/lib/leagues";
import { savePaymentSettings, settleBill, startLeaguePayment } from "../src/lib/payments";
import { createVenue, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/** Box leagues: seasons of boxes, results the players report, and up and down for the next. */

let venueId: number;
let ownerId: number;
let n = 0;
const today = todayISO();

async function player(): Promise<User> {
  n++;
  const made = await registerUser({ name: `Player ${n}`, email: `l${n}@box.my`, phone: `01350${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

async function league(over: Partial<LeagueInput> = {}) {
  const made = await createLeague(
    { venueId, name: `Ladder ${n}`, sport: "badminton", teamSize: 1, level: null, fee: 30, startsOn: addDays(today, 1), ...over },
    ownerId
  );
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

async function joined(leagueId: number, count: number) {
  const out: { user: User; playerId: number }[] = [];
  for (let i = 0; i < count; i++) {
    const user = await player();
    const made = await join(user, leagueId);
    if (!made.ok) throw new Error(made.error);
    out.push({ user, playerId: made.value.id });
  }
  return out;
}

async function started(leagueId: number) {
  const s = await startSeason(leagueId, { startsOn: today }, today);
  if (!s.ok) throw new Error(s.error);
  return s.value;
}

/** Every match in a box, the better-placed player (by order of joining) winning. */
async function playAll(leagueId: number, users: Map<number, User>) {
  const d = (await leagueDetail(leagueId))!;
  for (const m of d.matches.filter((x) => x.status === "unplayed")) {
    const winner = Math.min(m.a, m.b);
    const r = await reportResult(users.get(m.a)!.id, m.id, { winner, score: winner === m.a ? "21-10, 21-12" : "10-21, 12-21" });
    if (!r.ok) throw new Error(r.error);
    const c = await confirmResult(users.get(m.b)!.id, m.id);
    if (!c.ok) throw new Error(c.error);
  }
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  venueId = (await listVenues())[0].id;
});

afterEach(() => vi.unstubAllGlobals());

describe("setting one up", () => {
  it("checks what it is given, and opens its first season for players to join", async () => {
    const base = { venueId, name: "Odd Ladder", sport: "badminton" as const, teamSize: 1 as const, level: null, fee: 0 };
    expect(await createLeague({ ...base, startsOn: today }, ownerId)).toMatchObject({ ok: false });
    expect(await createLeague({ ...base, startsOn: addDays(today, 3), boxSize: 8 }, ownerId)).toMatchObject({ ok: false });
    expect(await createLeague({ ...base, startsOn: addDays(today, 3), seasonDays: 7 }, ownerId)).toMatchObject({ ok: false });
    const l = await league();
    expect(l.current).toMatchObject({ number: 1, status: "forming", startsOn: addDays(today, 1), endsOn: addDays(today, 28) });
    expect((await publicLeagues()).some((x) => x.id === l.id)).toBe(true);
  });
});

describe("players", () => {
  it("join once, name a partner for doubles, and come back as themselves", async () => {
    const l = await league();
    const p = await player();
    sent.length = 0;
    const first = await join(p, l.id);
    expect(first.ok).toBe(true);
    expect(sent[0].subject).toContain("You're in");
    expect(await join(p, l.id)).toMatchObject({ ok: false, error: "You are in this league already." });
    if (!first.ok) return;
    await leave(first.value.id);
    const again = await join(p, l.id);
    expect(again).toMatchObject({ ok: true, value: { id: first.value.id, status: "active" } });

    const pairs = await league({ teamSize: 2 });
    expect(await join(p, pairs.id)).toMatchObject({ ok: false, error: "Name your partner." });
    expect(await join(p, pairs.id, { partnerName: "Aminah" })).toMatchObject({ ok: true, value: { name: `${p.name} / Aminah` } });
  });
});

describe("a season", () => {
  it("needs three players, then boxes them by level, with every match to play", async () => {
    const l = await league();
    const field = await joined(l.id, 2);
    expect(await startSeason(l.id, {}, today)).toMatchObject({ ok: false, error: "At least 3 players are needed." });
    field.push(...(await joined(l.id, 7)));
    // The last two to join say they are the best.
    await setPlayerLevel(field[8].user.id, "badminton", "competitive");
    await setPlayerLevel(field[7].user.id, "badminton", "advanced");
    sent.length = 0;
    const d = await started(l.id);
    expect(d.boxes.map((b) => b.table.length)).toEqual([5, 4]);
    expect(d.places.filter((p) => p.boxNo === 1).map((p) => p.playerId)).toEqual(
      expect.arrayContaining([field[8].playerId, field[7].playerId, field[0].playerId])
    );
    expect(d.places.find((p) => p.playerId === field[6].playerId)?.boxNo).toBe(2);
    expect(d.matches).toHaveLength(10 + 6);
    expect(sent.filter((m) => m.subject.includes("Season 1 has started"))).toHaveLength(9);
    expect(sent.find((m) => m.to === field[8].user.email)?.subject).toContain("box 1");
  });

  it("shows box-mates each other's numbers, and nobody else's", async () => {
    const l = await league();
    const field = await joined(l.id, 8);
    await started(l.id);
    const mine = (await myLeague(field[0].user.id, l.id))!;
    expect(mine.place?.boxNo).toBe(1);
    expect(mine.contacts).toHaveLength(3);
    expect(mine.contacts[0].phone).toMatch(/^01350/);
    expect(mine.contacts[0].whatsapp).toMatch(/^601350/);
    const box2 = new Set((await leagueDetail(l.id))!.places.filter((p) => p.boxNo === 2).map((p) => p.playerId));
    expect(mine.contacts.some((c) => box2.has(c.playerId))).toBe(false);
  });
});

describe("results", () => {
  it("are reported by one side, own games first, and confirmed by the other", async () => {
    const l = await league();
    const [a, b, c] = await joined(l.id, 3);
    const d = await started(l.id);
    const m = d.matches.find((x) => x.a === a.playerId && x.b === b.playerId)!;
    expect(await reportResult(c.user.id, m.id, { winner: c.playerId, score: "21-0" })).toMatchObject({ ok: false, error: "That is not your match." });
    expect(await reportResult(b.user.id, m.id, { winner: b.playerId, score: "10-21, 12-21" })).toMatchObject({
      ok: false,
      error: "That score says the other side won.",
    });
    sent.length = 0;
    // b won, and writes their own games first; it is kept with a's first.
    const r = await reportResult(b.user.id, m.id, { winner: b.playerId, score: "21-15, 19-21, 21-17" });
    expect(r).toMatchObject({ ok: true, value: { status: "reported", score: "15-21, 21-19, 17-21", winner: b.playerId } });
    expect(sent[0].to).toBe(a.user.email);
    expect(await confirmResult(b.user.id, m.id)).toMatchObject({ ok: false });
    expect(await reportResult(a.user.id, m.id, { winner: a.playerId, score: "21-0, 21-0" })).toMatchObject({ ok: false });
    expect(await confirmResult(a.user.id, m.id)).toMatchObject({ ok: true, value: { status: "confirmed" } });
    const table = (await leagueDetail(l.id))!.boxes[0].table;
    expect(table[0]).toMatchObject({ entryId: b.playerId, won: 1, setDiff: 1 });
    expect(await reportResult(a.user.id, m.id, { winner: a.playerId, score: "21-0, 21-0" })).toMatchObject({
      ok: false,
      error: "This result is settled. Ask the venue if it is wrong.",
    });
  });

  it("disputed, go to the venue, whose staff decide", async () => {
    const l = await league();
    const [a, b] = await joined(l.id, 3);
    const d = await started(l.id);
    const m = d.matches.find((x) => x.a === a.playerId && x.b === b.playerId)!;
    await reportResult(a.user.id, m.id, { winner: a.playerId, score: "21-19, 21-19" });
    const desk = await createAdmin({ name: "Front Desk", email: "desk@ladder.my", password: "desk-password", venueId });
    if (!desk.ok) throw new Error(desk.error);
    sent.length = 0;
    expect(await disputeResult(b.user.id, m.id, "I won the second 21-19")).toMatchObject({ ok: true, value: { status: "disputed" } });
    expect(sent.find((x) => x.subject.includes("disputed"))?.to).toBe("desk@ladder.my");
    expect(await reportResult(b.user.id, m.id, { winner: b.playerId, score: "21-0" })).toMatchObject({ ok: false, error: "The venue is deciding this one." });
    expect((await leagueDetail(l.id))!.matches.find((x) => x.id === m.id)?.disputeNote).toBeUndefined();
    expect((await leagueDetail(l.id, { forStaff: true }))!.matches.find((x) => x.id === m.id)?.disputeNote).toBe("I won the second 21-19");
    expect(await decideResult(m.id, ownerId, { winner: a.playerId, score: "21-19, 19-21, 21-15" })).toMatchObject({
      ok: true,
      value: { status: "confirmed", winner: a.playerId },
    });
  });

  it("stand if nobody answers in three days", async () => {
    const l = await league();
    const [a, b] = await joined(l.id, 3);
    const d = await started(l.id);
    const m = d.matches.find((x) => x.a === a.playerId && x.b === b.playerId)!;
    await reportResult(a.user.id, m.id, { winner: a.playerId, score: "21-5, 21-5" });
    await leagueHousekeeping(today);
    expect((await leagueDetail(l.id))!.matches.find((x) => x.id === m.id)?.status).toBe("reported");
    await getDb().prepare("UPDATE league_matches SET reported_at = datetime('now', '-4 days') WHERE id = ?").run(m.id);
    await leagueHousekeeping(today);
    expect((await leagueDetail(l.id))!.matches.find((x) => x.id === m.id)?.status).toBe("confirmed");
  });
});

describe("the end of a season", () => {
  it("moves the best up and the worst down, and the next season's boxes follow", async () => {
    const l = await league();
    const field = await joined(l.id, 8);
    const users = new Map(field.map((f) => [f.playerId, f.user]));
    await started(l.id);
    await playAll(l.id, users);
    sent.length = 0;
    const ended = await endSeason(l.id, today);
    if (!ended.ok) throw new Error(ended.error);
    const at = (playerId: number) => ended.value.places.find((p) => p.playerId === playerId)!;
    // Box 1 is the first four to join; the fourth finishes last and goes down,
    // the fifth wins box 2 and comes up.
    expect(at(field[3].playerId)).toMatchObject({ boxNo: 1, finish: 4, move: "down" });
    expect(at(field[4].playerId)).toMatchObject({ boxNo: 2, finish: 1, move: "up" });
    expect(at(field[0].playerId)).toMatchObject({ finish: 1, move: "stay" });
    expect(sent.find((m) => m.to === field[4].user.email)?.text).toContain("you go up to box 1");

    const next = ended.value.seasons[0];
    expect(next).toMatchObject({ number: 2, status: "forming", startsOn: addDays(today, 1) });
    // A newcomer staff put straight into box 1.
    const [late] = await joined(l.id, 1);
    await setStartBox(late.playerId, 1);
    const s2 = await started(l.id);
    expect(s2.viewing?.number).toBe(2);
    const box1 = s2.places.filter((p) => p.boxNo === 1).map((p) => p.playerId);
    expect(box1).toEqual(expect.arrayContaining([field[0].playerId, field[4].playerId, late.playerId]));
    expect(box1).not.toContain(field[3].playerId);
    expect(s2.boxes.map((b) => b.table.length)).toEqual([5, 4]);
  });

  it("happens by itself a few days after the last day, and the next one starts on its day", async () => {
    const l = await league();
    await joined(l.id, 3);
    await started(l.id);
    const after = addDays(today, 28 + 4);
    const done = await leagueHousekeeping(after);
    expect(done.ended).toBeGreaterThanOrEqual(1);
    const d = (await leagueDetail(l.id))!;
    expect(d.seasons[1].status).toBe("finished");
    expect(d.current).toMatchObject({ number: 2, status: "forming" });
    await leagueHousekeeping(d.current!.startsOn);
    expect((await leagueDetail(l.id))!.current).toMatchObject({ number: 2, status: "running" });
  });
});

describe("leaving mid-season", () => {
  it("hands every match still to play to the other side", async () => {
    const l = await league();
    const [a, b, c] = await joined(l.id, 3);
    const d = await started(l.id);
    const ab = d.matches.find((x) => x.a === a.playerId && x.b === b.playerId)!;
    await reportResult(a.user.id, ab.id, { winner: b.playerId, score: "5-21, 5-21" });
    await confirmResult(b.user.id, ab.id);
    await leave(a.playerId);
    const after = (await leagueDetail(l.id))!;
    const ac = after.matches.find((x) => x.a === a.playerId && x.b === c.playerId)!;
    expect(ac).toMatchObject({ status: "walkover", winner: c.playerId });
    expect(after.matches.find((x) => x.id === ab.id)?.status).toBe("confirmed");
    expect(after.boxes[0].table.at(-1)?.entryId).toBe(a.playerId);
    expect(await myLeague(a.user.id, l.id)).toBeNull();
  });
});

describe("the fee", () => {
  it("is paid online to the venue, once the boxes are made", async () => {
    await savePaymentSettings(venueId, { apiKey: "key-123", collectionId: "col-123", xSignatureKey: "sig-123", sandbox: true, enabled: true });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "league-bill-1", url: "https://www.billplz-sandbox.com/bills/league-bill-1" })));
    const l = await league();
    const [a] = await joined(l.id, 3);
    expect(await startLeaguePayment(a.user, l.id)).toMatchObject({ ok: false, status: 404 });
    await started(l.id);
    expect(await startLeaguePayment(a.user, l.id)).toMatchObject({ ok: true, amount: 30 });
    await settleBill({ billId: "league-bill-1", paid: true, paidAt: null });
    expect((await myLeague(a.user.id, l.id))?.place?.paid).toBe(true);
    expect(await startLeaguePayment(a.user, l.id)).toMatchObject({ ok: false, status: 409 });
  });

  it("paid online after the player left: owed back in full, with no receipt and the place not marked paid", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "league-bill-left", url: "https://www.billplz-sandbox.com/bills/league-bill-left" })));
    const l = await league();
    const [a] = await joined(l.id, 3);
    await started(l.id);
    expect(await startLeaguePayment(a.user, l.id)).toMatchObject({ ok: true });
    // They leave while the payment page is still open, then pay it.
    await leave(a.playerId);
    await settleBill({ billId: "league-bill-left", paid: true, paidAt: null });
    const payment = (await getDb().prepare("SELECT id, amount::float AS amount, refund_due::float AS due FROM online_payments WHERE bill_id = 'league-bill-left'").get()) as {
      id: number;
      amount: number;
      due: number;
    };
    expect(payment.due).toBe(payment.amount);
    expect(await getDb().prepare("SELECT 1 FROM receipts WHERE source = ?").get(`payment:${payment.id}`)).toBeUndefined();
    const place = (await getDb().prepare("SELECT paid_at FROM league_places WHERE player_id = ?").get(a.playerId)) as { paid_at: string | null };
    expect(place.paid_at).toBeNull();
  });
});

describe("a player closing their account", () => {
  it("leaves their leagues, and their name comes off the boxes", async () => {
    const { eraseCustomer, exportCustomerData } = await import("../src/lib/privacy");
    const l = await league();
    const [a, b] = await joined(l.id, 3);
    await started(l.id);
    expect((await exportCustomerData(a.user.id))?.leagues).toHaveLength(1);
    expect((await eraseCustomer(a.user.id)).ok).toBe(true);
    const d = (await leagueDetail(l.id))!;
    expect(d.people.some((p) => p.name === a.user.name)).toBe(false);
    expect(d.matches.find((m) => m.a === a.playerId && m.b === b.playerId)).toMatchObject({ status: "walkover", winner: b.playerId });
  });
});

describe("the routes", () => {
  it("are for the venue's own staff; players need an account, and report only their own matches", async () => {
    const l = await league();
    const [a, , c] = await joined(l.id, 4);
    const d = await started(l.id);
    const other = await createVenue({ name: "Box Hall", area: "Klang", address: "9 Jalan Kotak", phone: "0331113333" });
    if (!other.ok) throw new Error("venue");
    const desk = await createAdmin({ name: "Desk", email: "desk@boxhall.my", password: "desk-password", venueId: other.venue.id });
    if (!desk.ok) throw new Error(desk.error);
    const staffCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const staff = await import("../src/app/api/admin/leagues/[id]/route");
    const denied = await staff.POST(
      new NextRequest(`http://localhost/api/admin/leagues/${l.id}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: staffCookie },
        body: JSON.stringify({ action: "end" }),
      }),
      { params: Promise.resolve({ id: String(l.id) }) }
    );
    expect(denied.status).toBe(403);

    const pub = await import("../src/app/api/leagues/[id]/route");
    const asGuest = await pub.POST(
      new NextRequest(`http://localhost/api/leagues/${l.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "join" }),
      }),
      { params: Promise.resolve({ id: String(l.id) }) }
    );
    expect(asGuest.status).toBe(401);

    const cookie = `${SESSION_COOKIE}=${(await createSession(a.user.id)).token}`;
    const shown = await pub.GET(new NextRequest(`http://localhost/api/leagues/${l.id}`, { headers: { cookie } }), {
      params: Promise.resolve({ id: String(l.id) }),
    });
    const body = await shown.json();
    expect(body.mine.contacts.length).toBeGreaterThan(0);
    expect(body.league.people[0].userId).toBeUndefined();

    const notMine = d.matches.find((m) => m.a !== a.playerId && m.b !== a.playerId && (m.a === c.playerId || m.b === c.playerId))!;
    const matches = await import("../src/app/api/leagues/[id]/matches/[matchId]/route");
    const res = await matches.POST(
      new NextRequest(`http://localhost/api/leagues/${l.id}/matches/${notMine.id}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ action: "report", winner: c.playerId, score: "21-0, 21-0" }),
      }),
      { params: Promise.resolve({ id: String(l.id), matchId: String(notMine.id) }) }
    );
    expect(res.status).toBe(409);
  });
});

describe("staff", () => {
  const admin = async () => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(ownerId)).token}`;
  const call = async (handler: (req: NextRequest, ctx: never) => Promise<Response>, url: string, body: object, params: Record<string, string>) =>
    handler(
      new NextRequest(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", cookie: await admin() }, body: JSON.stringify(body) }),
      { params: Promise.resolve(params) } as never
    );

  it("set one up, move its start, run its season, and put results right", async () => {
    const list = await import("../src/app/api/admin/leagues/route");
    const made = await call(list.POST, "/api/admin/leagues", { venueId, name: "Staff Ladder", sport: "badminton", fee: 25, startsOn: addDays(today, 5), boxSize: 3, moves: 1, seasonDays: 21 }, {});
    expect(made.status).toBe(201);
    const id = String((await made.json()).league.id);
    const shown = await list.GET(new NextRequest(`http://localhost/api/admin/leagues?venueId=${venueId}`, { headers: { cookie: await admin() } }));
    expect((await shown.json()).leagues.some((x: { id: number }) => String(x.id) === id)).toBe(true);

    const one = await import("../src/app/api/admin/leagues/[id]/route");
    expect((await call(one.POST, `/api/admin/leagues/${id}`, { action: "plan", startsOn: addDays(today, 2) }, { id })).status).toBe(200);
    expect((await listLeagues([venueId])).find((x) => String(x.id) === id)?.current).toMatchObject({ startsOn: addDays(today, 2), endsOn: addDays(today, 22) });
    expect((await call(one.POST, `/api/admin/leagues/${id}`, { action: "nonsense" }, { id })).status).toBe(400);

    const field = await joined(Number(id), 4);
    const players = await import("../src/app/api/admin/leagues/[id]/players/[playerId]/route");
    expect((await call(players.POST, "", { startBox: 1 }, { id, playerId: String(field[3].playerId) })).status).toBe(200);
    expect((await call(players.POST, "", { startBox: 0 }, { id, playerId: String(field[3].playerId) })).status).toBe(409);
    expect((await call(players.POST, "", {}, { id, playerId: String(field[3].playerId) })).status).toBe(400);
    expect((await call(players.POST, "", { remove: true }, { id, playerId: String(field[2].playerId) })).status).toBe(200);

    const start = await call(one.POST, `/api/admin/leagues/${id}`, { action: "start" }, { id });
    expect(start.status).toBe(200);
    const d = (await start.json()).league;
    // "Start it now" means today, not the planned day.
    expect(d.viewing.startsOn).toBe(today);
    // Placed in box 1 by staff, ahead of the two who joined first.
    expect(d.boxes).toHaveLength(1);
    expect(d.boxes[0].table).toHaveLength(3);

    const places = await import("../src/app/api/admin/leagues/[id]/places/[placeId]/route");
    const place = d.places[0];
    // A fee taken at the counter says how (X1-2): refused without, receipted with it.
    expect((await call(places.POST, "", { paid: true }, { id, placeId: String(place.id) })).status).toBe(400);
    expect((await call(places.POST, "", { paid: true, via: "cash" }, { id, placeId: String(place.id) })).status).toBe(200);
    expect((await call(places.POST, "", { paid: "yes" }, { id, placeId: String(place.id) })).status).toBe(400);
    expect(await setPlacePaid(999999, true)).toMatchObject({ ok: false });

    const matches = await import("../src/app/api/admin/leagues/[id]/matches/[matchId]/route");
    const m = d.matches[0];
    const mid = String(m.id);
    expect((await call(matches.POST, "", { winner: m.a }, { id, matchId: mid })).status).toBe(409);
    expect((await call(matches.POST, "", { winner: 1, walkover: true }, { id, matchId: mid })).status).toBe(409);
    expect((await call(matches.POST, "", { winner: m.b, score: "21-10, 21-10" }, { id, matchId: mid })).status).toBe(409);
    expect((await call(matches.POST, "", { winner: m.a, walkover: true }, { id, matchId: mid })).status).toBe(200);
    expect((await call(matches.POST, "", { void: true }, { id, matchId: mid })).status).toBe(200);
    const cleared = await call(matches.POST, "", { clear: true }, { id, matchId: mid });
    expect((await cleared.json()).league.matches.find((x: { id: number }) => x.id === m.id).status).toBe("unplayed");

    expect((await call(one.POST, `/api/admin/leagues/${id}`, { action: "close" }, { id })).status).toBe(409);
    expect((await call(one.POST, `/api/admin/leagues/${id}`, { action: "end" }, { id })).status).toBe(200);
    expect(await decideResult(m.id, ownerId, { void: true })).toMatchObject({ ok: false, error: "That season is over." });
    expect(await reportResult(field[0].user.id, m.id, { winner: m.a, score: "21-0" })).toMatchObject({ ok: false, error: "That season is over." });
    expect(await endSeason(Number(id))).toMatchObject({ ok: false });
    const earlier = await one.GET(new NextRequest(`http://localhost/api/admin/leagues/${id}?season=1`, { headers: { cookie: await admin() } }), {
      params: Promise.resolve({ id }),
    });
    expect((await earlier.json()).league.viewing.number).toBe(1);

    sent.length = 0;
    expect((await call(one.POST, `/api/admin/leagues/${id}`, { action: "close" }, { id })).status).toBe(200);
    expect(sent.length).toBe(3);
    expect(await closeLeague(Number(id))).toMatchObject({ ok: false });
    expect(await join(await player(), Number(id))).toMatchObject({ ok: false, error: "That league is not taking players." });
    expect(await planSeason(Number(id), addDays(today, 3))).toMatchObject({ ok: false });
    expect(await startSeason(Number(id))).toMatchObject({ ok: false });
    expect((await publicLeagues()).some((x) => String(x.id) === id)).toBe(false);
  });

  it("refuse what does not make sense", async () => {
    const base = { venueId, name: "Odd", sport: "badminton" as const, teamSize: 1 as const, level: null, fee: 0, startsOn: addDays(today, 3) };
    expect(await createLeague({ ...base, name: "x" }, ownerId)).toMatchObject({ ok: false, error: "Give it a name." });
    expect(await createLeague({ ...base, sport: "curling" as never }, ownerId)).toMatchObject({ ok: false, error: "Unknown sport." });
    expect(await createLeague({ ...base, level: "legend" as never }, ownerId)).toMatchObject({ ok: false, error: "Unknown level." });
    expect(await createLeague({ ...base, moves: 3 }, ownerId)).toMatchObject({ ok: false });
    expect(await createLeague({ ...base, fee: -1 }, ownerId)).toMatchObject({ ok: false, error: "Check the fee." });
    const bare = await createVenue({ name: "Bare Hall", area: "Klang", address: "1 Jalan Kosong", phone: "0331114444" });
    if (!bare.ok) throw new Error("venue");
    expect(await createLeague({ ...base, venueId: bare.venue.id }, ownerId)).toMatchObject({ ok: false, error: "This venue has no courts for that sport." });

    const l = await league();
    expect(await planSeason(l.id, addDays(today, -1))).toMatchObject({ ok: false });
    await joined(l.id, 3);
    expect(await startSeason(l.id, { startsOn: addDays(today, -1) }, today)).toMatchObject({ ok: false });
    expect(await startSeason(l.id, { startsOn: today, endsOn: addDays(today, 3) }, today)).toMatchObject({ ok: false, error: "A season is 1 to 9 weeks." });
    expect(await planSeason(9999999, today)).toMatchObject({ ok: false });
    expect(await leave(9999999)).toMatchObject({ ok: false });
    expect(await setStartBox(9999999, null)).toMatchObject({ ok: false });
    expect(await decideResult(9999999, ownerId, { void: true })).toMatchObject({ ok: false });
    expect(await confirmResult(1, 9999999)).toMatchObject({ ok: false });
    expect(await disputeResult(1, 9999999, "nope")).toMatchObject({ ok: false });
  });

  it("a player answering a report they cannot, or saying too little", async () => {
    const l = await league();
    const [a, b] = await joined(l.id, 3);
    const d = await started(l.id);
    const m = d.matches.find((x) => x.a === a.playerId && x.b === b.playerId)!;
    expect(await confirmResult(b.user.id, m.id)).toMatchObject({ ok: false });
    expect(await disputeResult(b.user.id, m.id, "no")).toMatchObject({ ok: false });
    expect(await reportResult(a.user.id, m.id, { winner: a.playerId, score: "lots" })).toMatchObject({ ok: false });
    expect(await reportResult(a.user.id, m.id, { winner: 12345, score: "21-1" })).toMatchObject({ ok: false });
    await reportResult(a.user.id, m.id, { winner: a.playerId, score: "21-1" });
    // Put right before the other side answers.
    expect(await reportResult(a.user.id, m.id, { winner: a.playerId, score: "21-3" })).toMatchObject({ ok: true, value: { score: "21-3" } });
    expect(await disputeResult(b.user.id, m.id, "no")).toMatchObject({ ok: false, error: "Say what really happened." });
    expect(await disputeResult(a.user.id, m.id, "my own")).toMatchObject({ ok: false });
    expect(flipScore("not a score")).toBe("not a score");
  });

  it("show the public only open leagues, by sport and storefront, and earlier seasons on request", async () => {
    const l = await league({ sport: "badminton" });
    expect((await publicLeagues({ sport: "badminton" })).some((x) => x.id === l.id)).toBe(true);
    expect((await publicLeagues({ sport: "futsal" })).some((x) => x.id === l.id)).toBe(false);
    expect(await publicLeagues({ venueIds: [] })).toEqual([]);
    expect((await publicLeagues({ venueIds: [venueId] })).some((x) => x.id === l.id)).toBe(true);
    expect(await listLeagues([])).toEqual([]);
    const [p] = await joined(l.id, 3);
    expect(await myLeague(p.user.id, l.id)).toMatchObject({ place: null, contacts: [] });
    const pub = await import("../src/app/api/leagues/route");
    expect((await pub.GET(new NextRequest("http://localhost/api/leagues?sport=curling"))).status).toBe(400);
    expect((await (await pub.GET(new NextRequest("http://localhost/api/leagues?sport=badminton"))).json()).leagues.length).toBeGreaterThan(0);
    expect(await leagueDetail(l.id)).toMatchObject({ viewing: null, boxes: [] });
    expect(await leagueDetail(l.id, { season: 1 })).toMatchObject({ viewing: { status: "forming" }, boxes: [] });
    expect(await leagueDetail(9999999)).toBeNull();
  });
});

describe("a league scored by the competition rules", () => {
  /** A season of three under way: one box, three matches, with each player's account. */
  async function running(template: string) {
    const l = await league({ template });
    const people = await joined(l.id, 3);
    const s = await startSeason(l.id, { startsOn: today }, today);
    if (!s.ok) throw new Error(s.error);
    const users = new Map(people.map((p) => [p.playerId, p.user]));
    return { l, matches: s.value.matches, users };
  }

  it("starts from the sport's template, or the one chosen; a performance template is refused", async () => {
    expect((await league()).template).toBe("racket_best_of_3");
    expect((await league({ template: "volleyball_points" })).rules.scoring).toMatchObject({ bestOf: 5, setPoints: { winClear: 3 } });
    expect(await createLeague({ venueId, name: "Swim Ladder", sport: "badminton", teamSize: 1, level: null, fee: 0, startsOn: addDays(today, 1), template: "swimming_heats" }, ownerId)).toMatchObject({
      ok: false,
    });
  });

  it("checks scores by its rules and ranks the box by them: points by set score", async () => {
    const { l, matches, users } = await running("volleyball_points");
    const [first, second, third] = matches;
    // Best of five: six sets are too many, and a score has to agree with the winner.
    expect(await reportResult(users.get(first.a)!.id, first.id, { winner: first.a, score: "25-10, 25-12, 10-25, 12-25, 25-20, 25-20" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/more sets than a best of 5/),
    });
    expect(await reportResult(users.get(first.a)!.id, first.id, { winner: first.a, score: "10-25, 12-25, 20-25" })).toMatchObject({ ok: false });
    // a beats b 3-0 (3 points to 0); the next two go to five sets (2 and 1).
    for (const [m, score] of [
      [first, "25-10, 25-12, 25-20"],
      [second, "25-20, 20-25, 25-23, 23-25, 15-12"],
      [third, "25-20, 20-25, 25-23, 23-25, 15-12"],
    ] as const) {
      expect(await reportResult(users.get(m.a)!.id, m.id, { winner: m.a, score })).toMatchObject({ ok: true });
      expect(await confirmResult(users.get(m.b)!.id, m.id)).toMatchObject({ ok: true });
    }
    const table = (await leagueDetail(l.id))!.boxes[0].table;
    const points = new Map(table.map((s) => [s.entryId, s.points]));
    const expected = new Map<number, number>();
    const add = (id: number, n: number) => expected.set(id, (expected.get(id) ?? 0) + n);
    for (const [id, n] of [[first.a, 3], [first.b, 0], [second.a, 2], [second.b, 1], [third.a, 2], [third.b, 1]] as const) add(id, n);
    expect(points).toEqual(expected);
    expect(table[0].points).toBe(Math.max(...expected.values()));
  });

  it("takes a goals score from either side's view, and refuses a level one", async () => {
    const { l, matches, users } = await running("goals_league");
    const [m] = matches;
    expect(await reportResult(users.get(m.b)!.id, m.id, { winner: m.b, score: "2-2" })).toMatchObject({ ok: false });
    // Side b writes their own goals first: kept with the first-named side's first.
    expect(await reportResult(users.get(m.b)!.id, m.id, { winner: m.b, score: "3-1" })).toMatchObject({ ok: true, value: { score: "1-3" } });
    expect(flipScore("2-2 (penalties 4-3)")).toBe("2-2 (penalties 3-4)");
    expect((await leagueDetail(l.id))!.rules.scoring.kind).toBe("tally");
  });
});
