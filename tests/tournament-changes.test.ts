import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { savePaymentSettings, startEntryPayment } from "../src/lib/payments";
import { listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { changeTournament, closeEntries, createTournament, enter, makeDraw, myEntry, setEntry, tournamentDetail, type TournamentInput } from "../src/lib/tournaments";
import { PATCH } from "../src/app/api/admin/tournaments/[id]/route";

/**
 * A tournament's details changed before its draw (lib/tournaments.ts
 * `changeTournament`; X1-12): text, entry deadline, places and the fee for
 * new entries. Each entry keeps the fee it was made at (migration 0238):
 * what it owes online and what its counter receipt says.
 */

let venueId: number;
let courts: number[];
let ownerId: number;
let managerCookie: string;
let deskCookie: string;
let n = 0;
let day = 30;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courts = venue.courts.filter((c) => c.sport === "badminton").slice(0, 2).map((c) => c.id);
  const manager = await createAdmin({ name: "Tara Manager", email: "tara-tn@venue.my", password: "manager-pass-1", venueId });
  const desk = await createAdmin({ name: "Tim Desk", email: "tim-tn@venue.my", password: "desk-password-1", venueId, role: "desk" });
  if (!manager.ok || !desk.ok) throw new Error("staff");
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
});

afterEach(() => vi.unstubAllGlobals());

async function player(): Promise<User> {
  n++;
  const made = await registerUser({ name: `Entrant ${n}`, email: `tc${n}@cup.my`, phone: `01350${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

async function tournament(over: Partial<TournamentInput> = {}) {
  const on = addDays(todayISO(), day++);
  const made = await createTournament(
    { venueId, name: `Change Cup ${day}`, sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 20, maxEntries: 4, startsOn: on, endsOn: on, startHour: 9, endHour: 21, courtIds: courts, ...over },
    ownerId
  );
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

async function entrants(id: number, count: number) {
  const out: { user: User; entryId: number; status: string }[] = [];
  for (let i = 0; i < count; i++) {
    const user = await player();
    const made = await enter(user, id);
    if (!made.ok) throw new Error(made.error);
    out.push({ user, entryId: made.value.id, status: made.value.status });
  }
  return out;
}

const patch = (id: number, body: unknown, cookie = managerCookie) =>
  PATCH(new NextRequest(`http://localhost/api/admin/tournaments/${id}`, { method: "PATCH", headers: { cookie }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: String(id) }),
  });

describe("changing a tournament before its draw", () => {
  it("changes the fee for new entries only: an entry owes, pays and is receipted at what it was made at", async () => {
    await savePaymentSettings(venueId, { apiKey: "key-123", collectionId: "col-123", xSignatureKey: "sig-123", sandbox: true, enabled: true });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "change-bill-1", url: "https://www.billplz-sandbox.com/bills/change-bill-1" })));
    const t = await tournament({ maxEntries: 8 });
    const [early, counter] = await entrants(t.id, 2);
    const res = await patch(t.id, { entryFee: 35 });
    expect(res.status).toBe(200);
    const [late] = await entrants(t.id, 1);

    expect((await myEntry(early.user.id, t.id))?.fee).toBe(20);
    expect((await myEntry(late.user.id, t.id))?.fee).toBe(35);
    // Online: the early entrant pays what they entered at.
    expect(await startEntryPayment(early.user, t.id)).toMatchObject({ ok: true, amount: 20 });
    // At the counter: the receipt says the entry's own fee.
    expect((await setEntry(counter.entryId, { paid: true })).ok).toBe(true);
    const receipt = (await getDb().prepare("SELECT total::float AS total FROM receipts WHERE source LIKE ? ORDER BY id DESC LIMIT 1").get(`entry:${counter.entryId}@%`)) as { total: number };
    expect(receipt.total).toBe(20);
    expect((await setEntry(late.entryId, { paid: true })).ok).toBe(true);
    const lateReceipt = (await getDb().prepare("SELECT total::float AS total FROM receipts WHERE source LIKE ? ORDER BY id DESC LIMIT 1").get(`entry:${late.entryId}@%`)) as { total: number };
    expect(lateReceipt.total).toBe(35);

    const entry = (await listActivity([venueId])).find((a) => a.action === "tournament.changed");
    expect(entry?.adminName).toBe("Tara Manager");
    expect(entry?.detail).toContain("(new entries)");
  });

  it("takes entries off the waiting list in order when it takes more, and never fewer than entered", async () => {
    const t = await tournament({ maxEntries: 3 });
    const people = await entrants(t.id, 5);
    expect(people.map((p) => p.status)).toEqual(["entered", "entered", "entered", "waitlisted", "waitlisted"]);
    expect(await changeTournament(t.id, { maxEntries: 2 })).toMatchObject({ ok: false, error: "3 have entered: it cannot take fewer than that." });
    const res = await patch(t.id, { maxEntries: 4 });
    expect((await res.json()).promoted).toBe(1);
    const d = (await tournamentDetail(t.id, { forStaff: true }))!;
    expect(d.entries.find((e) => e.id === people[3].entryId)?.status).toBe("entered");
    expect(d.entries.find((e) => e.id === people[4].entryId)?.status).toBe("waitlisted");
    // The one who came in is told, as when somebody withdraws.
    const told = (await getDb().prepare("SELECT subject FROM messages WHERE kind = 'programme' AND recipient = ? ORDER BY id DESC LIMIT 1").get(people[3].user.email)) as { subject: string } | undefined;
    expect(told?.subject).toContain("You're in");
  });

  it("opens entries again with a new last day, and refuses one in the past or on the day", async () => {
    const t = await tournament();
    expect((await closeEntries(t.id)).ok).toBe(true);
    expect(await changeTournament(t.id, { entriesCloseOn: addDays(todayISO(), -1) })).toMatchObject({ ok: false });
    expect(await changeTournament(t.id, { entriesCloseOn: t.startsOn })).toMatchObject({ ok: false, error: "Entries must close before the first day." });
    const done = await changeTournament(t.id, { entriesCloseOn: addDays(todayISO(), 2) });
    expect(done.ok && done.value.after).toMatchObject({ status: "open", entriesCloseOn: addDays(todayISO(), 2) });
    // Its name and text, the same way.
    const named = await changeTournament(t.id, { name: "Renamed Cup", description: "Shuttles provided." });
    expect(named.ok && named.value.after).toMatchObject({ name: "Renamed Cup", description: "Shuttles provided." });
  });

  it("is refused once the draw is made, and to the front desk", async () => {
    const t = await tournament();
    await entrants(t.id, 2);
    expect((await patch(t.id, { name: "Desk tried" }, deskCookie)).status).toBe(403);
    expect((await makeDraw(t.id, () => 0.42)).ok).toBe(true);
    const res = await patch(t.id, { entryFee: 5 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("A tournament's details are changed before its draw.");
  });
});
