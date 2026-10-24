import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

const sent: { to: string; subject: string; text: string }[] = [];
// Programme emails are queued (lib/outbox.ts, emailPlayer); each one queued is also noted here, as sent.
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
  };
});

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { askToJoin, cancelGame, gameById, gameForViewer, invitePlayer, leaveGame, myGames, openGame } from "../src/lib/games";
import { expireMoves, hostMove, keepPlace, previewMove, staffMove, withdrawMove } from "../src/lib/game-moves";
import { savePaymentSettings, settleBill, startSharePayment } from "../src/lib/payments";
import { saveProfile } from "../src/lib/player-profiles";
import { createBooking, getBookingById, listVenues, rescheduleBooking, rescheduleOptions } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as adminReschedule } from "../src/app/api/admin/bookings/reschedule/route";

/**
 * Moving an open game to another time (lib/game-moves.ts): a called-off game
 * stays where it was, a game nobody is in moves with its booking, a game with
 * players moves only when they have all answered (or by the venue, with a
 * reason), and a game that has begun keeps its time.
 */

let n = 0;
let courtId: number;
let venueId: number;
let day = 0;

async function player(name = "Player"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} ${n}`, email: `gm${n}@move.my`, phone: `01450${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

/** A game at a day and hour of its own, a few days out; `players` are let straight in. */
async function gameWith(players = 0, over: Partial<Parameters<typeof openGame>[1]> = {}) {
  const host = await player("Host");
  const k = day++;
  // A day and hour of its own: up to seven days out, morning, afternoon or evening.
  const date = addDays(todayISO(), 3 + (k % 7));
  const hour = [8, 13, 18][Math.floor(k / 7) % 3];
  const made = await createBooking({ courtId, date, hours: [hour], name: host.name, phone: host.phone, userId: host.id });
  if (!made.ok) throw new Error("booking");
  const opened = await openGame(host.id, { bookingCode: made.booking.code, spots: 4, level: null, share: 5, autoAccept: true, ...over });
  if (!opened.ok) throw new Error(opened.error);
  const people: User[] = [];
  for (let i = 0; i < players; i++) {
    const p = await player();
    const joined = await askToJoin(p, opened.game.id);
    if (!joined.ok) throw new Error(joined.error);
    people.push(p);
  }
  return { host, game: opened.game, booking: made.booking, date, at: hour * 60, players: people };
}

/** A start later the same day the booking's court is free for its whole length. */
async function freeLater(code: string, date: string, after: number) {
  const options = (await rescheduleOptions(code, date)).filter((o) => o.courtId === courtId && o.startMin >= after + 120);
  if (options.length === 0) throw new Error("no free time");
  return options[0].startMin;
}

const bookingRow = async (id: number) =>
  (await getDb().prepare("SELECT date, start_min, court_id, status FROM bookings WHERE id = ?").get(id)) as { date: string; start_min: number; court_id: number; status: string };
const holds = async (moveId: number) =>
  ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE move_id = ? AND active").get(moveId)) as { n: number }).n;
const moveRow = async (gameId: number) =>
  (await getDb().prepare("SELECT * FROM game_moves WHERE game_id = ? ORDER BY id DESC LIMIT 1").get(gameId)) as
    | { id: number; status: string; kind: string; reason: string | null; to_start_min: number; outcome: string | null }
    | undefined;

/** A Billplz that hands out bills. */
let billNumber = 0;
function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `move${++billNumber}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}

beforeAll(async () => {
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courtId = venue.courts[0].id;
});

afterEach(() => vi.unstubAllGlobals());

describe("a game that was called off", () => {
  it("does not stop its booking moving, and keeps where and when it was", async () => {
    const { host, game, booking, date, at } = await gameWith(1);
    expect((await cancelGame(host.id, game.id)).ok).toBe(true);
    const start = await freeLater(booking.code, date, at);
    const moved = await rescheduleBooking(booking.code, { date, start }, "customer");
    expect(moved).toMatchObject({ ok: true, to: { startMin: start } });
    expect((await bookingRow(booking.id)).start_min).toBe(start);
    // The called-off game's record is where it was played, not where the booking went.
    const record = (await gameById(game.id))!;
    expect(record).toMatchObject({ status: "cancelled", date, startHour: at / 60 });
  });
});

describe("a game nobody is in yet", () => {
  it("moves with its booking, and whoever asked, was invited or is waiting hears the new time", async () => {
    const { host, game, booking, date, at } = await gameWith(0, { autoAccept: false });
    const asker = await player();
    expect((await askToJoin(asker, game.id)).ok).toBe(true);
    const guest = await player();
    await saveProfile(guest.id, { adult: true, invitable: true });
    expect((await invitePlayer(host.id, game.id, guest.id)).ok).toBe(true);
    const start = await freeLater(booking.code, date, at);
    sent.length = 0;
    const moved = await hostMove(host.id, game.id, { date, start });
    expect(moved).toMatchObject({ ok: true, outcome: "move" });
    const now = (await gameById(game.id))!;
    expect(now.startHour * 60).toBe(start);
    expect(sent.map((s) => s.to).sort()).toEqual([asker.email, guest.email].sort());
    expect(sent.every((s) => s.subject.startsWith("A game has a new time"))).toBe(true);
    // Nothing is waiting: a game that moved as a booking leaves no change behind.
    expect(await moveRow(game.id)).toBeUndefined();
  });

  it("is moved by staff of any role, as any booking is", async () => {
    const { booking, date, at } = await gameWith(0);
    const start = await freeLater(booking.code, date, at);
    const r = await staffMove({ id: 0, role: "desk" }, booking.code, { date, start }, null);
    expect(r).toMatchObject({ ok: true, outcome: "move" });
  });
});

describe("a game with players in it", () => {
  it("is not moved by its booking alone: the customer's change and a staff move without the game workflow are refused", async () => {
    const { booking, date, at } = await gameWith(1);
    const start = await freeLater(booking.code, date, at);
    expect(await rescheduleBooking(booking.code, { date, start }, "customer")).toMatchObject({ ok: false, code: "RESCHEDULE_GAME" });
    expect(await rescheduleBooking(booking.code, { date, start }, "staff")).toMatchObject({ ok: false, code: "RESCHEDULE_GAME" });
    expect((await bookingRow(booking.id)).start_min).toBe(at);
  });

  it("shows its host what a move would do before anything changes", async () => {
    const { game, booking, date, players, at } = await gameWith(2, { autoAccept: true });
    const waiting = await player();
    await getDb().prepare("UPDATE open_games SET auto_accept = 0 WHERE id = ?").run(game.id);
    await askToJoin(waiting, game.id);
    const start = await freeLater(booking.code, date, at);
    const seen = await previewMove(booking.code, { date, start }, "customer");
    expect(seen).toMatchObject({
      ok: true,
      preview: {
        outcome: "proposal",
        gameId: game.id,
        from: { date, startMin: at },
        to: { date, startMin: start, courtId },
        pending: { requested: 1, invited: 0, waitlisted: 0, offered: 0 },
        clashes: 0,
        sharesPaid: 0,
      },
    });
    if (!seen.ok) throw new Error();
    expect(seen.preview.players.map((p) => p.name).sort()).toEqual(players.map((p) => p.name.split(" ")[0]).sort());
    expect(seen.preview.expiresAt).toBeTruthy();
    // A preview changes nothing: no claim, no change, the booking where it was.
    expect((await bookingRow(booking.id)).start_min).toBe(at);
    expect(await moveRow(game.id)).toBeUndefined();
  });

  it("counts players with something else then, without saying who", async () => {
    const { booking, date, players, at } = await gameWith(2);
    const start = await freeLater(booking.code, date, at);
    expect(await previewMove(booking.code, { date, start }, "customer")).toMatchObject({ ok: true, preview: { clashes: 0 } });
    // One player has a court of their own, elsewhere in the venue, at the new time.
    const elsewhere = (await listVenues())[0].courts.find((c) => c.id !== courtId)!;
    const own = await createBooking({ courtId: elsewhere.id, date, hours: [start / 60], name: players[0].name, phone: players[0].phone, userId: players[0].id });
    if (!own.ok) throw new Error("own booking");
    const seen = await previewMove(booking.code, { date, start }, "customer");
    if (!seen.ok) throw new Error(seen.error);
    expect(seen.preview.clashes).toBe(1);
    // How many, never who or what.
    expect(JSON.stringify(seen.preview)).not.toContain(own.booking.code);
  });

  it("moves only once every player has answered, holding the new time meanwhile", async () => {
    const { host, game, booking, date, players, at } = await gameWith(2);
    const [a, b] = players;
    const start = await freeLater(booking.code, date, at);
    sent.length = 0;
    const proposed = await hostMove(host.id, game.id, { date, start });
    expect(proposed).toMatchObject({ ok: true, outcome: "proposal", move: { kind: "proposal", status: "pending", waitingFor: 2, to: { startMin: start } } });
    // Both players are asked, and nothing has moved.
    expect(sent.map((s) => s.to).sort()).toEqual([a.email, b.email].sort());
    expect((await bookingRow(booking.id)).start_min).toBe(at);
    const m = (await moveRow(game.id))!;
    expect(await holds(m.id)).toBeGreaterThan(0);
    // The new time is held: nobody else can book it.
    const stranger = await player();
    expect(await createBooking({ courtId, date, hours: [start / 60], name: stranger.name, phone: stranger.phone, userId: stranger.id })).toMatchObject({ ok: false });
    // Nobody joins while the players are asked, and the booking cannot be moved again.
    expect(await askToJoin(await player(), game.id)).toMatchObject({ ok: false });
    expect(await rescheduleBooking(booking.code, { date, start: start + 60 }, "staff")).toMatchObject({ ok: false, code: "RESCHEDULE_PROPOSED" });
    expect((await gameForViewer(game.id, a.id))?.mine).toMatchObject({ toConfirm: true });

    // One says yes: still waiting for the other.
    expect(await keepPlace(a.id, game.id)).toEqual({ ok: true });
    expect((await moveRow(game.id))!.status).toBe("pending");
    expect((await bookingRow(booking.id)).start_min).toBe(at);
    // The other leaves: that is their answer, and the game moves.
    expect((await leaveGame(b.id, game.id)).ok).toBe(true);
    expect((await moveRow(game.id))!.status).toBe("applied");
    expect((await bookingRow(booking.id)).start_min).toBe(start);
    expect(await holds(m.id)).toBe(0);
    const moved = (await gameForViewer(game.id, a.id))!;
    expect(moved.startHour * 60).toBe(start);
    expect(moved.mine).toMatchObject({ status: "accepted", toConfirm: false });
    // Answers are kept.
    const answers = (await getDb().prepare("SELECT answer FROM game_move_answers WHERE move_id = ? ORDER BY answer").all(m.id)) as { answer: string }[];
    expect(answers.map((x) => x.answer)).toEqual(["left", "yes"]);
    // Joining is open again.
    expect((await askToJoin(await player(), game.id)).ok).toBe(true);
  });

  it("is refused onto a time that is not free, leaving nothing behind", async () => {
    const { host, game, booking, date, at } = await gameWith(1);
    const start = await freeLater(booking.code, date, at);
    const blocker = await player();
    const taken = await createBooking({ courtId, date, hours: [start / 60], name: blocker.name, phone: blocker.phone, userId: blocker.id });
    expect(taken.ok).toBe(true);
    // The host chose that court's time from what was offered before it went.
    const r = await hostMove(host.id, game.id, { date, start, courtId });
    expect(r).toMatchObject({ ok: false, code: "RESCHEDULE_TAKEN" });
    expect(await moveRow(game.id)).toBeUndefined();
    expect((await bookingRow(booking.id)).start_min).toBe(at);
  });

  it("lets its host withdraw a proposal, and runs out when not everybody answers", async () => {
    const first = await gameWith(1);
    const s1 = await freeLater(first.booking.code, first.date, first.at);
    expect((await hostMove(first.host.id, first.game.id, { date: first.date, start: s1 })).ok).toBe(true);
    const m1 = (await moveRow(first.game.id))!;
    expect(await withdrawMove(first.host.id, first.game.id)).toEqual({ ok: true });
    expect((await moveRow(first.game.id))!.status).toBe("withdrawn");
    expect(await holds(m1.id)).toBe(0);
    expect((await gameForViewer(first.game.id, first.players[0].id))?.mine).toMatchObject({ toConfirm: false });

    const second = await gameWith(1);
    const s2 = await freeLater(second.booking.code, second.date, second.at);
    expect((await hostMove(second.host.id, second.game.id, { date: second.date, start: s2 })).ok).toBe(true);
    await getDb().prepare("UPDATE game_moves SET expires_at = now() - interval '1 minute' WHERE game_id = ?").run(second.game.id);
    expect(await expireMoves()).toBe(1);
    const ended = (await moveRow(second.game.id))!;
    expect(ended.status).toBe("expired");
    // Silence is not a yes: the game stays where it was.
    expect((await bookingRow(second.booking.id)).start_min).toBe(second.at);
    expect(await holds(ended.id)).toBe(0);
  });

  it("owes back a paid share to a player who leaves rather than move, and asks the venue for nothing more", async () => {
    await savePaymentSettings(venueId, { apiKey: "key-123", collectionId: "col-123", xSignatureKey: "sig-123", sandbox: true, enabled: true });
    fakeBillplz();
    const { host, game, booking, date, players, at } = await gameWith(1);
    expect((await startSharePayment(players[0], game.id)).ok).toBe(true);
    await settleBill({ billId: `move${billNumber}`, paid: true, paidAt: null });
    const start = await freeLater(booking.code, date, at);
    const seen = await previewMove(booking.code, { date, start }, "customer");
    expect(seen).toMatchObject({ ok: true, preview: { sharesPaid: 5, players: [{ paid: true }] } });
    // A share a game's player paid does not stop its host proposing a time; friends' shares in a split still would.
    expect((await hostMove(host.id, game.id, { date, start })).ok).toBe(true);
    expect((await leaveGame(players[0].id, game.id)).ok).toBe(true);
    const owed = (await getDb().prepare("SELECT refund_due::float AS due FROM online_payments WHERE bill_id = ?").get(`move${billNumber}`)) as { due: number };
    expect(owed.due).toBe(5);
    // Everybody left: the game moved, and the booking owes the share again.
    expect((await bookingRow(booking.id)).start_min).toBe(start);
    expect((await getBookingById(booking.id))!.sharesPaid).toBe(0);
  });

  it("is moved by a venue manager only, with a reason the players are given, and each confirms or leaves", async () => {
    const { game, booking, date, players, at } = await gameWith(2);
    const start = await freeLater(booking.code, date, at);
    const desk = await createAdmin({ name: "Desk", email: `desk${n}@move.my`, password: "desk-password-1", venueId, role: "desk" });
    const manager = await createAdmin({ name: "Manager", email: `mgr${n}@move.my`, password: "manager-password-1", venueId, role: "manager" });
    if (!desk.ok || !manager.ok) throw new Error("admins");
    const call = async (adminId: number, body: object) =>
      adminReschedule(
        new NextRequest("http://localhost/api/admin/bookings/reschedule", {
          method: "POST",
          headers: { cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(adminId)).token}` },
          body: JSON.stringify({ code: booking.code, date, start, ...body }),
        })
      );
    expect((await call(desk.admin.id, { reason: "Roof leak on court 1" })).status).toBe(403);
    expect((await call(manager.admin.id, {})).status).toBe(400);
    // The preview is anybody's, and changes nothing.
    const preview = await call(manager.admin.id, { preview: true });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ preview: { outcome: "venue", players: [{}, {}] } });
    expect((await bookingRow(booking.id)).start_min).toBe(at);

    sent.length = 0;
    const res = await call(manager.admin.id, { reason: "Roof leak on court 1" });
    expect(res.status).toBe(200);
    expect((await bookingRow(booking.id)).start_min).toBe(start);
    expect(await moveRow(game.id)).toMatchObject({ kind: "venue", status: "applied", reason: "Roof leak on court 1" });
    // Each player is told why, and asked to confirm.
    const toPlayers = sent.filter((s) => players.some((p) => p.email === s.to));
    expect(toPlayers).toHaveLength(2);
    expect(toPlayers.every((s) => s.text.includes("Roof leak on court 1"))).toBe(true);
    const hostView = (await myGames(game.hostId)).hosting.find((g) => g.id === game.id)!;
    expect(hostView.players?.filter((p) => p.toConfirm)).toHaveLength(2);
    expect(hostView.move).toMatchObject({ kind: "venue", waitingFor: 2 });
    expect(await keepPlace(players[0].id, game.id)).toEqual({ ok: true });
    expect((await leaveGame(players[1].id, game.id)).ok).toBe(true);
    expect((await myGames(game.hostId)).hosting.find((g) => g.id === game.id)!.move).toBeNull();
    // Recorded in the activity log, reason and all.
    const log = (await getDb().prepare("SELECT detail FROM staff_actions WHERE action = 'booking.rescheduled' AND booking_code = ? ORDER BY id DESC LIMIT 1").get(booking.code)) as { detail: string };
    expect(log.detail).toContain("Roof leak on court 1");
  });

  it("lets a manager's change take the place of a host's proposal still waiting", async () => {
    const { host, game, booking, date, players, at } = await gameWith(1);
    const proposed = await freeLater(booking.code, date, at);
    expect((await hostMove(host.id, game.id, { date, start: proposed })).ok).toBe(true);
    const waiting = (await moveRow(game.id))!;
    const options = (await rescheduleOptions(booking.code, date)).filter((o) => o.courtId === courtId && o.startMin !== proposed && o.startMin >= at + 120);
    const venueTime = options[options.length - 1].startMin;
    const manager = await createAdmin({ name: "Mgr", email: `mgr-s${n}@move.my`, password: "manager-password-1", venueId, role: "manager" });
    if (!manager.ok) throw new Error(manager.error);
    const done = await staffMove({ id: manager.admin.id, role: "manager" }, booking.code, { date, start: venueTime, courtId }, "Lights out on the court");
    expect(done).toMatchObject({ ok: true, outcome: "venue" });
    expect((await getDb().prepare("SELECT status FROM game_moves WHERE id = ?").get(waiting.id)) as { status: string }).toEqual({ status: "withdrawn" });
    expect(await holds(waiting.id)).toBe(0);
    expect((await bookingRow(booking.id)).start_min).toBe(venueTime);
    expect((await gameForViewer(game.id, players[0].id))?.mine).toMatchObject({ toConfirm: true });
    expect((await gameForViewer(game.id, players[0].id))?.move).toMatchObject({ kind: "venue", reason: "Lights out on the court" });
  });

  it("keeps the time of a game that has begun", async () => {
    const { booking } = await gameWith(1);
    // Started an hour ago, ends in an hour.
    const start = new Date(Date.now() - 60 * 60_000);
    const end = new Date(Date.now() + 60 * 60_000);
    await getDb().prepare("UPDATE bookings SET starts_at = ?::timestamptz, ends_at = ?::timestamptz WHERE id = ?").run(start.toISOString(), end.toISOString(), booking.id);
    const zoneDate = todayISO();
    const minuteNow = (() => {
      const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kuala_Lumpur", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
      return Number(parts.find((p) => p.type === "hour")!.value) * 60 + Number(parts.find((p) => p.type === "minute")!.value);
    })();
    await getDb()
      .prepare("UPDATE bookings SET date = ?, start_min = ?, end_min = ? WHERE id = ?")
      .run(zoneDate, Math.max(0, minuteNow - 60), Math.min(24 * 60 - 1, minuteNow + 60), booking.id);
    const r = await staffMove({ id: 0, role: "manager" }, booking.code, { date: addDays(todayISO(), 20), start: 10 * 60 }, "Too late");
    expect(r).toMatchObject({ ok: false, code: "RESCHEDULE_GAME_STARTED" });
  });
});

describe("moving at the same time as something else", () => {
  it("lets one of two moves of the same booking happen, never both", async () => {
    const { booking, date, at } = await gameWith(0);
    const options = (await rescheduleOptions(booking.code, date)).filter((o) => o.courtId === courtId && o.startMin >= at + 120);
    const [x, y] = [options[0].startMin, options[options.length - 1].startMin];
    const results = await Promise.all([
      rescheduleBooking(booking.code, { date, start: x }, "staff"),
      rescheduleBooking(booking.code, { date, start: y }, "staff"),
    ]);
    // Each read the booking where it was; whichever came second finds it moved and is refused.
    const ok = results.filter((r) => r.ok);
    expect(ok).toHaveLength(1);
    const row = await bookingRow(booking.id);
    expect(row.start_min).toBe(ok[0].ok ? ok[0].to.startMin : -1);
    const claims = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE booking_id = ? AND active").get(booking.id)) as { n: number };
    expect(claims.n).toBeGreaterThan(0);
    for (const r of results) if (!r.ok) expect(["RESCHEDULE_CHANGED", "RESCHEDULE_TAKEN", "BUSY"]).toContain(r.code);
  });

  it("lets nobody into a game in the middle of being moved", async () => {
    const { host, game, booking, date, at } = await gameWith(1);
    const start = await freeLater(booking.code, date, at);
    const late = await player();
    const [moved, joined] = await Promise.all([hostMove(host.id, game.id, { date, start }), askToJoin(late, game.id)]);
    // Either the late player got in before the proposal (and is asked too), or was turned away while it waits.
    if (joined.ok) {
      expect(moved.ok).toBe(true);
      const asked = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM open_game_players WHERE game_id = ? AND status = 'accepted' AND move_id IS NOT NULL").get(game.id)) as { n: number };
      const accepted = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM open_game_players WHERE game_id = ? AND status = 'accepted'").get(game.id)) as { n: number };
      expect(asked.n).toBe(accepted.n);
    } else expect(moved.ok).toBe(true);
  });
});
