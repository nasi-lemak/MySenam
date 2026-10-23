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
import { createSession, registerUser, SESSION_COOKIE, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import {
  askToJoin,
  closeGame,
  decide,
  findGames,
  leaveGame,
  MAX_NO_SHOWS,
  myGames,
  openGame,
  setPlayerLevel,
  suggestedShare,
} from "../src/lib/games";
import { savePaymentSettings, settleBill, startBookingPayment, startSharePayment } from "../src/lib/payments";
import { eraseCustomer } from "../src/lib/privacy";
import { adminCancelBooking, cancelBooking, createBooking, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/** Player matching: open a booking to others, who ask to join and pay their share to the venue. */

let n = 0;
let courtId: number;
let venueId: number;
let slot = 0;

async function player(name = "Player"): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} ${n}`, email: `p${n}@game.my`, phone: `01230${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

/** A booking of the host's own, a few days out, at an hour nobody else has. */
async function booking(host: User) {
  slot++;
  const made = await createBooking({
    courtId,
    date: addDays(todayISO(), 2 + (slot % 10)),
    hours: [8 + Math.floor(slot / 10)],
    name: host.name,
    phone: host.phone,
    userId: host.id,
  });
  if (!made.ok) throw new Error("booking");
  return made.booking;
}

async function hostGame(over: Partial<Parameters<typeof openGame>[1]> = {}) {
  const host = await player("Host");
  const b = await booking(host);
  const made = await openGame(host.id, { bookingCode: b.code, spots: 2, level: null, share: 10, autoAccept: false, ...over });
  if (!made.ok) throw new Error(made.error);
  return { host, booking: b, game: made.game };
}

/** A Billplz that hands out bills. */
let billNumber = 0;
function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `share${++billNumber}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}
const lastBill = () => `share${billNumber}`;

beforeAll(async () => {
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courtId = venue.courts[0].id;
});

afterEach(() => vi.unstubAllGlobals());

describe("opening a game", () => {
  it("is for your own upcoming booking, once", async () => {
    const host = await player();
    const other = await player();
    const b = await booking(host);
    const input = { bookingCode: b.code, spots: 3, level: "intermediate" as const, share: 6, autoAccept: false };
    expect(await openGame(other.id, input)).toMatchObject({ ok: false, status: 404 });
    expect(await openGame(host.id, { ...input, spots: 0 })).toMatchObject({ ok: false });
    expect(await openGame(host.id, { ...input, share: 9999 })).toMatchObject({ ok: false });
    const made = await openGame(host.id, input);
    expect(made).toMatchObject({ ok: true, game: { spots: 3, level: "intermediate", share: 6, joined: 0, status: "open" } });
    expect(await openGame(host.id, input)).toMatchObject({ ok: false, error: "That booking is already open to other players." });
  });

  it("suggests a share that splits the court evenly", () => {
    expect(suggestedShare(30, 3)).toBe(7.5);
    expect(suggestedShare(25, 2)).toBe(8.5);
  });
});

describe("joining", () => {
  it("is asking; the host says yes or no; full is full", async () => {
    const { host, game } = await hostGame({ spots: 1 });
    const a = await player();
    const b = await player();
    sent.length = 0;
    expect((await askToJoin(a, game.id)).ok).toBe(true);
    expect(sent.at(-1)?.to).toBe(host.email);
    expect(await askToJoin(a, game.id)).toMatchObject({ ok: false, error: "You have asked already." });
    expect((await askToJoin(b, game.id)).ok).toBe(true);

    const { hosting } = await myGames(host.id);
    const asked = hosting.find((g) => g.id === game.id)!.players!;
    expect(asked.map((p) => p.status)).toEqual(["requested", "requested"]);
    // Only first names, never a phone number.
    expect(JSON.stringify(asked)).not.toContain(a.phone);
    expect(asked[0].name).toBe("Player");

    expect((await decide(host.id, asked[0].id, "accept")).ok).toBe(true);
    expect(sent.at(-1)?.to).toBe(a.email);
    expect(await decide(host.id, asked[1].id, "accept")).toMatchObject({ ok: false, error: "The game is full." });
    expect((await decide(host.id, asked[1].id, "decline")).ok).toBe(true);
    // Somebody else's game is not theirs to decide.
    expect(await decide(a.id, asked[1].id, "accept")).toMatchObject({ ok: false, status: 404 });

    // Full games are not listed.
    expect((await findGames({})).some((g) => g.id === game.id)).toBe(false);
  });

  it("is straight in where the host lets everybody in, and out again by leaving", async () => {
    const { game } = await hostGame({ autoAccept: true });
    const a = await player();
    expect((await askToJoin(a, game.id)).ok && (await myGames(a.id)).playing[0].mine?.status).toBe("accepted");
    expect((await leaveGame(a.id, game.id)).ok).toBe(true);
    expect((await askToJoin(a, game.id)).ok).toBe(true);
  });

  it("is not for the host, nor once the host has closed it", async () => {
    const { host, game } = await hostGame();
    expect(await askToJoin(host, game.id)).toMatchObject({ ok: false, error: "It is your own game." });
    expect((await closeGame(host.id, game.id)).ok).toBe(true);
    expect(await askToJoin(await player(), game.id)).toMatchObject({ ok: false });
  });

  it(`stops after ${MAX_NO_SHOWS} no-shows`, async () => {
    const flake = await player("Flake");
    for (let i = 0; i < MAX_NO_SHOWS; i++) {
      const { host, game, booking: b } = await hostGame({ autoAccept: true });
      expect((await askToJoin(flake, game.id)).ok).toBe(true);
      // The game has been and gone.
      await getDb().prepare("UPDATE bookings SET date = ? WHERE id = ?").run(addDays(todayISO(), -1), b.id);
      const me = (await myGames(host.id)).hosting.find((g) => g.id === game.id)!.players![0];
      expect((await decide(host.id, me.id, "no_show")).ok).toBe(true);
    }
    const { game } = await hostGame();
    expect(await askToJoin(flake, game.id)).toMatchObject({ ok: false, error: expect.stringContaining("missed") });
  });
});

describe("finding games", () => {
  it("by sport, level and distance, saying which are yours", async () => {
    const { host, game } = await hostGame({ level: "advanced" });
    const listed = await findGames({ forUser: host.id });
    expect(listed.find((g) => g.id === game.id)?.yours).toBe(true);
    expect((await findGames({ level: "beginner" })).some((g) => g.id === game.id)).toBe(false);
    expect((await findGames({ level: "advanced" })).some((g) => g.id === game.id)).toBe(true);
    await setPlayerLevel(host.id, (await findGames({})).find((g) => g.id === game.id)!.sport, "advanced");
    expect((await findGames({})).find((g) => g.id === game.id)?.hostLevel).toBe("advanced");
    // Near the venue, and not near Kota Kinabalu.
    const v = (await listVenues()).find((x) => x.id === venueId)!;
    expect((await findGames({ near: { lat: v.lat!, lng: v.lng!, km: 5 } })).some((g) => g.id === game.id)).toBe(true);
    expect((await findGames({ near: { lat: 5.98, lng: 116.07, km: 50 } })).some((g) => g.id === game.id)).toBe(false);
  });
});

describe("shares", () => {
  it("are paid to the venue towards the booking; the host owes the rest", async () => {
    await savePaymentSettings(venueId, { apiKey: "key-123", collectionId: "col-123", xSignatureKey: "sig-123", sandbox: true, enabled: true });
    fakeBillplz();
    const { host, game, booking: b } = await hostGame({ autoAccept: true, share: 5 });
    const a = await player();
    expect(await startSharePayment(a, game.id)).toMatchObject({ ok: false, status: 404 });
    await askToJoin(a, game.id);
    const started = await startSharePayment(a, game.id);
    expect(started).toMatchObject({ ok: true, amount: 5 });
    await settleBill({ billId: lastBill(), paid: true, paidAt: null });
    expect((await myGames(a.id)).playing[0].mine?.paid).toBe(true);
    expect(await startSharePayment(a, game.id)).toMatchObject({ ok: false, error: "Your share is paid already." });

    // The host pays what is left, not the whole court.
    const hostPays = await startBookingPayment({ codes: [b.code], phone: host.phone });
    expect(hostPays).toMatchObject({ ok: true, amount: b.totalPrice - 5 });
  });

  it("are owed back when the player leaves or the booking goes", async () => {
    fakeBillplz();
    const { host, game, booking: b } = await hostGame({ autoAccept: true, share: 4 });
    const [a, c] = [await player(), await player()];
    for (const p of [a, c]) {
      await askToJoin(p, game.id);
      await startSharePayment(p, game.id);
      await settleBill({ billId: lastBill(), paid: true, paidAt: null });
    }
    await leaveGame(a.id, game.id);
    sent.length = 0;
    expect((await cancelBooking(b.code, host.phone)).ok).toBe(true);
    const owed = (await getDb()
      .prepare("SELECT SUM(refund_due)::float AS owed FROM online_payments WHERE purpose = 'share' AND venue_id = ? AND bill_id IN (?, ?)")
      .get(venueId, `share${billNumber - 1}`, `share${billNumber}`)) as { owed: number };
    expect(owed.owed).toBe(8);
    // The player still in heard it is off; the one who left did not need to.
    expect(sent.map((m) => m.to)).toEqual([c.email]);
    expect((await findGames({})).some((g) => g.id === game.id)).toBe(false);
  });

  it("handed back to a player who leaves, are owed by the host again", async () => {
    fakeBillplz();
    const { host, game, booking: b } = await hostGame({ autoAccept: true, share: 6 });
    const a = await player();
    await askToJoin(a, game.id);
    await startSharePayment(a, game.id);
    await settleBill({ billId: lastBill(), paid: true, paidAt: null });
    expect(await startBookingPayment({ codes: [b.code], phone: host.phone })).toMatchObject({ ok: true, amount: b.totalPrice - 6 });
    await leaveGame(a.id, game.id);
    // The venue gives the 6 back, so it is not off the host's part any more.
    expect(await startBookingPayment({ codes: [b.code], phone: host.phone })).toMatchObject({ ok: true, amount: b.totalPrice });
  });

  it("handed back after the host paid the rest online, leave the host owing just that share", async () => {
    fakeBillplz();
    const { host, game, booking: b } = await hostGame({ autoAccept: true, share: 6 });
    const a = await player();
    await askToJoin(a, game.id);
    await startSharePayment(a, game.id);
    await settleBill({ billId: lastBill(), paid: true, paidAt: null });
    const rest = b.totalPrice - 6;
    expect(await startBookingPayment({ codes: [b.code], phone: host.phone })).toMatchObject({ ok: true, amount: rest });
    await settleBill({ billId: lastBill(), paid: true, paidAt: null });
    const hostBill = lastBill();

    await leaveGame(a.id, game.id);
    // The venue handed the 6 back, so the booking is 6 short: the host owes it, and only it.
    const row = (await getDb()
      .prepare("SELECT payment_status, (total_price - shares_paid)::float AS due FROM bookings WHERE id = ?")
      .get(b.id)) as { payment_status: string; due: number };
    expect(row).toEqual({ payment_status: "unpaid", due: 6 });
    expect(await startBookingPayment({ codes: [b.code], phone: host.phone })).toMatchObject({ ok: true, amount: 6 });
    // What the host did pay stays on the books, on a receipt of its own.
    const hostPayment = (await getDb().prepare("SELECT id FROM online_payments WHERE bill_id = ?").get(hostBill)) as { id: number };
    const receipt = (await getDb()
      .prepare("SELECT total::float AS total FROM receipts WHERE kind = 'receipt' AND source = ?")
      .get(`booking-part:${b.id}:${hostPayment.id}`)) as { total: number } | undefined;
    expect(receipt?.total).toBe(rest);

    // Called off now: the host's part is owed back, and its receipt credited.
    expect((await cancelBooking(b.code, host.phone)).ok).toBe(true);
    const owed = (await getDb().prepare("SELECT refund_due::float AS due FROM online_payments WHERE id = ?").get(hostPayment.id)) as { due: number };
    expect(owed.due).toBe(rest);
    const credited = (await getDb()
      .prepare("SELECT COUNT(*)::int AS n FROM receipts WHERE kind = 'credit_note' AND credits_ref = (SELECT number FROM receipts WHERE source = ?)")
      .get(`booking-part:${b.id}:${hostPayment.id}`)) as { n: number };
    expect(credited.n).toBe(1);
  });

  it("arriving after the player left is owed back at once", async () => {
    fakeBillplz();
    const { game } = await hostGame({ autoAccept: true, share: 3 });
    const a = await player();
    await askToJoin(a, game.id);
    await startSharePayment(a, game.id);
    await leaveGame(a.id, game.id);
    await settleBill({ billId: lastBill(), paid: true, paidAt: null });
    const row = (await getDb().prepare("SELECT refund_due::float AS due FROM online_payments WHERE bill_id = ?").get(lastBill())) as { due: number };
    expect(row.due).toBe(3);
  });

  it("covering the whole court leave nothing for the host to pay", async () => {
    fakeBillplz();
    const { game, booking: b } = await hostGame({ autoAccept: true, spots: 1 });
    await getDb().prepare("UPDATE open_games SET share = ? WHERE id = ?").run(b.totalPrice, game.id);
    const a = await player();
    await askToJoin(a, game.id);
    await startSharePayment(a, game.id);
    await settleBill({ billId: lastBill(), paid: true, paidAt: null });
    const row = (await getDb().prepare("SELECT payment_status FROM bookings WHERE id = ?").get(b.id)) as { payment_status: string };
    expect(row.payment_status).toBe("paid");
  });
});

describe("leaving the platform", () => {
  it("takes a player out of games to come, and their own games with their bookings", async () => {
    const { host, game } = await hostGame({ autoAccept: true });
    const a = await player();
    await askToJoin(a, game.id);
    sent.length = 0;
    expect((await eraseCustomer(a.id)).ok).toBe(true);
    expect(sent.map((m) => m.to)).toEqual([host.email]);

    const second = await hostGame({ autoAccept: true });
    const b = await player();
    await askToJoin(b, second.game.id);
    sent.length = 0;
    expect((await eraseCustomer(second.host.id)).ok).toBe(true);
    expect(sent.map((m) => m.to)).toEqual([b.email]);
  });
});

describe("staff cancelling the booking", () => {
  it("calls the game off too", async () => {
    const { game, booking: b } = await hostGame();
    expect((await adminCancelBooking(b.code)).ok).toBe(true);
    expect((await findGames({})).some((g) => g.id === game.id)).toBe(false);
  });
});

describe("the routes", () => {
  it("need an account to join, and say where you stand", async () => {
    const { game } = await hostGame();
    const a = await player();
    const cookie = `${SESSION_COOKIE}=${(await createSession(a.id)).token}`;
    const route = await import("../src/app/api/games/[id]/route");
    const post = (headers: Record<string, string>, action: string) =>
      route.POST(
        new NextRequest(`http://localhost/api/games/${game.id}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "10.8.0.1", ...headers },
          body: JSON.stringify({ action }),
        }),
        { params: Promise.resolve({ id: String(game.id) }) }
      );
    expect((await post({}, "join")).status).toBe(401);
    expect((await post({ cookie }, "dance")).status).toBe(400);
    expect((await post({ cookie }, "join")).status).toBe(200);

    const list = await import("../src/app/api/games/route");
    const res = await list.GET(new NextRequest("http://localhost/api/games", { headers: { cookie } }));
    const body = await res.json();
    expect(body.signedIn).toBe(true);
    expect(body.games.find((g: { id: number }) => g.id === game.id).mine.status).toBe("requested");
  });
});
