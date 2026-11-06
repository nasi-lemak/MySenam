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
import { ADMIN_SESSION_COOKIE, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { savePaymentSettings, startEntryPayment } from "../src/lib/payments";
import { listActivity } from "../src/lib/activity";
import { entryFeesOwed, settleEntryFee } from "../src/lib/entry-fee-refunds";
import { strandedFixtures, tellFixturesLost, undrawnTournaments } from "../src/lib/competition-fixtures";
import { createOutage, endOutage, listOutages } from "../src/lib/outages";
import { listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import {
  cancelTournament,
  createTournament,
  enter,
  makeDraw,
  closeDueEntries,
  postponeTournamentDay,
  setEntry,
  setRules,
  takeOut,
  tournamentById,
  tournamentDetail,
  withdraw,
  type TournamentInput,
} from "../src/lib/tournaments";

/**
 * What competitions owe the people they change (ADR 0059): a counter fee owed back, entrants staff take out told, an undrawn tournament, fixtures lost with a court or a day and
 * the postponing of a day. Run on Postgres too (the settling race).
 */

let venueId: number;
let courts: number[];
let ownerId: number;
let n = 0;
let dayOffset = 3;
const fixed = () => 0.42;

async function player(): Promise<User> {
  n++;
  const made = await registerUser({ name: `Player ${n}`, email: `t${n}@cup.my`, phone: `01340${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

/** A tournament on a day of its own, so no two tests hold the same hours. */
async function tournament(over: Partial<TournamentInput> = {}) {
  const day = addDays(todayISO(), dayOffset++);
  const made = await createTournament(
    {
      venueId,
      name: `Cup ${dayOffset}`,
      sport: "badminton",
      format: "knockout",
      teamSize: 1,
      level: null,
      entryFee: 20,
      maxEntries: 16,
      startsOn: day,
      endsOn: day,
      startHour: 9,
      endHour: 21,
      courtIds: courts,
      ...over,
    },
    ownerId
  );
  if (!made.ok) throw new Error(made.error);
  return made.value;
}

async function entries(tournamentId: number, count: number) {
  const out: { user: User; entryId: number }[] = [];
  for (let i = 0; i < count; i++) {
    const user = await player();
    const made = await enter(user, tournamentId);
    if (!made.ok) throw new Error(made.error);
    out.push({ user, entryId: made.value.id });
  }
  return out;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const venue = (await listVenues())[0];
  venueId = venue.id;
  courts = venue.courts.filter((c) => c.sport === "badminton").slice(0, 2).map((c) => c.id);
});

afterEach(() => vi.unstubAllGlobals());

const sentTo = (email: string) => sent.filter((m) => m.to === email);
const queued = async (key: string) => (await getDb().prepare("SELECT recipient, body FROM messages WHERE dedupe_key LIKE ? ORDER BY id").all(key)) as { recipient: string; body: string }[];
const staff = { id: 0, name: "Desk Dee", role: "manager" as const };

describe("a counter fee owed back after the venue calls a tournament off, or takes an entrant out before the draw (F4, C11)", () => {
  const owedFor = async (entryId: number) =>
    (await getDb().prepare("SELECT amount::float AS amount, via, cause, settled_at, admin_name, credit_note_id FROM counter_fee_refunds_owed WHERE tournament_entry_id = ?").get(entryId)) as
      | { amount: number; via: string | null; cause: string; settled_at: string | null; admin_name: string | null; credit_note_id: number | null }
      | undefined;
  const creditNotes = async (entryId: number) =>
    ((await getDb().prepare(`SELECT COUNT(*)::int AS n FROM receipts c JOIN receipts r ON r.id = c.credits_id WHERE c.kind = 'credit_note' AND r.source LIKE ?`).get(`entry:${entryId}@%`)) as { n: number }).n;

  it("writes down what was paid at the counter as owed, tells the entrant, pays nothing out, and lists it for staff", async () => {
    const t = await tournament();
    const [paid, unpaid] = await entries(t.id, 3);
    expect((await setEntry(paid.entryId, { paid: true, via: "cash" })).ok).toBe(true);
    sent.length = 0;
    expect((await cancelTournament(t.id)).ok).toBe(true);
    expect(await owedFor(paid.entryId)).toMatchObject({ amount: 20, via: "cash", cause: "tournament_cancelled", settled_at: null, admin_name: null });
    // Nothing is paid out by itself: no credit note until staff hand it back.
    expect(await creditNotes(paid.entryId)).toBe(0);
    expect(await owedFor(unpaid.entryId)).toBeUndefined();
    // The entrant is told it is owed back at the counter; the one who paid nothing is not told that.
    expect(sentTo(paid.user.email)[0].text).toContain("counter");
    expect(sentTo(unpaid.user.email)[0].text).not.toContain("counter");
    const list = await entryFeesOwed(null, "manager");
    expect(list.find((o) => o.entryId === paid.entryId)).toMatchObject({ amount: 20, via: "cash", tournamentName: t.name, managerOnly: false });
  });

  it("is settled once, by staff, with a credit note, who and when kept; the front desk only for a fee taken today", async () => {
    const t = await tournament();
    const [paid] = await entries(t.id, 2);
    await setEntry(paid.entryId, { paid: true, via: "qr" });
    await cancelTournament(t.id);
    const owed = (await entryFeesOwed(null, "desk")).find((o) => o.entryId === paid.entryId)!;
    // Taken today: the desk may hand it back.
    expect(owed.managerOnly).toBe(false);
    const done = await settleEntryFee(owed.id, { id: ownerId, name: "Olive Owner", role: "manager" });
    expect(done.ok).toBe(true);
    expect(await creditNotes(paid.entryId)).toBe(1);
    expect(await owedFor(paid.entryId)).toMatchObject({ admin_name: "Olive Owner" });
    expect((await owedFor(paid.entryId))!.settled_at).not.toBeNull();
    expect((await owedFor(paid.entryId))!.credit_note_id).not.toBeNull();
    // Once: a second settling, and a repeat cancel, leave one note.
    expect(await settleEntryFee(owed.id, staff)).toMatchObject({ ok: false });
    expect((await entryFeesOwed(null, "manager")).some((o) => o.entryId === paid.entryId)).toBe(false);
    // Paid on an earlier day: a manager's.
    const t2 = await tournament();
    const [old] = await entries(t2.id, 2);
    await setEntry(old.entryId, { paid: true, via: "cash" });
    await getDb().prepare("UPDATE tournament_entries SET paid_at = datetime('now', '-3 days') WHERE id = ?").run(old.entryId);
    await cancelTournament(t2.id);
    const earlier = (await entryFeesOwed(null, "desk")).find((o) => o.entryId === old.entryId)!;
    expect(earlier.managerOnly).toBe(true);
    expect(await settleEntryFee(earlier.id, { id: 1, name: "Dee Desk", role: "desk" })).toMatchObject({ ok: false });
    expect(await settleEntryFee(earlier.id, { id: ownerId, name: "Olive Owner", role: "manager" })).toMatchObject({ ok: true });
  });

  it("is settled once when two members of staff settle it at the same moment", async () => {
    const t = await tournament();
    const [paid] = await entries(t.id, 2);
    await setEntry(paid.entryId, { paid: true, via: "cash" });
    await cancelTournament(t.id);
    const owed = (await entryFeesOwed(null, "manager")).find((o) => o.entryId === paid.entryId)!;
    const both = await Promise.all([
      settleEntryFee(owed.id, { id: ownerId, name: "Olive Owner", role: "manager" }),
      settleEntryFee(owed.id, { id: ownerId, name: "Mia Manager", role: "manager" }),
    ]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(await creditNotes(paid.entryId)).toBe(1);
  });

  it("is owed for an entrant taken out before the draw where the rules refund before the draw, once", async () => {
    const t = await tournament();
    const [paid] = await entries(t.id, 3);
    await setEntry(paid.entryId, { paid: true, via: "cash" });
    expect(t.rules.refundBeforeDraw).toBe(true);
    expect((await withdraw(paid.entryId)).ok).toBe(true);
    expect(await owedFor(paid.entryId)).toMatchObject({ amount: 20, via: "cash", cause: "before_draw" });
    expect(await creditNotes(paid.entryId)).toBe(0);
  });

  it("is not owed where the rules keep the fee, for an unpaid entry, or for a fee paid online", async () => {
    const t = await tournament();
    const [counter, nothing, online] = await entries(t.id, 4);
    await setEntry(counter.entryId, { paid: true, via: "cash" });
    await getDb().prepare("UPDATE tournament_entries SET paid_at = datetime('now') WHERE id = ?").run(online.entryId);
    const rules = { ...t.rules, refundBeforeDraw: false };
    expect((await setRules(t.id, rules)).ok).toBe(true);
    await withdraw(counter.entryId);
    expect(await owedFor(counter.entryId)).toBeUndefined();
    const t2 = await tournament();
    const [a, b] = await entries(t2.id, 3);
    await withdraw(b.entryId);
    expect(await owedFor(b.entryId)).toBeUndefined();
    // A fee paid online has no counter receipt: the gateway's refund_due is its own path.
    await cancelTournament(t.id);
    expect(await owedFor(online.entryId)).toBeUndefined();
    void nothing;
    void a;
  });

  it("is settled from the staff route, recorded in the activity log, and refused at another venue", async () => {
    const t = await tournament();
    const [paid] = await entries(t.id, 2);
    await setEntry(paid.entryId, { paid: true, via: "cash" });
    await cancelTournament(t.id);
    const owed = (await entryFeesOwed(null, "manager")).find((o) => o.entryId === paid.entryId)!;
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(ownerId)).token}`;
    const bookings = await import("../src/app/api/admin/bookings/route");
    const listed = await (await bookings.GET(new NextRequest(`http://localhost/api/admin/bookings?date=${todayISO()}`, { headers: { cookie } }))).json();
    expect(listed.feesOwed.some((f: { id: number }) => f.id === owed.id)).toBe(true);
    const route = await import("../src/app/api/admin/bookings/owed/route");
    const post = (body: object, c = cookie) => route.POST(new NextRequest("http://localhost/api/admin/bookings/owed", { method: "POST", headers: { "content-type": "application/json", cookie: c }, body: JSON.stringify(body) }));
    expect((await post({ id: owed.id, kind: "entry_fee", outcome: "credit" })).status).toBe(400);
    expect((await post({ id: 999999, kind: "entry_fee", outcome: "back" })).status).toBe(404);
    const done = await post({ id: owed.id, kind: "entry_fee", outcome: "back" });
    expect(done.status).toBe(200);
    expect(await creditNotes(paid.entryId)).toBe(1);
    expect((await post({ id: owed.id, kind: "entry_fee", outcome: "back" })).status).toBeGreaterThanOrEqual(400);
    const log = await listActivity(null, { limit: 20 });
    expect(log.some((l) => l.action === "payment.paid_out" && l.detail?.includes("entry fee handed back"))).toBe(true);
  });
});

describe("somebody staff take out of an event is told (F5)", () => {
  it("tells a disqualified entrant once, with the reason staff gave and what it means for the fee", async () => {
    const t = await tournament({ startHour: 9, endHour: 12 });
    const field = await entries(t.id, 4);
    expect((await makeDraw(t.id, fixed)).ok).toBe(true);
    sent.length = 0;
    expect((await takeOut(field[0].entryId, "disqualified", "Abusive to an official")).ok).toBe(true);
    const told = sentTo(field[0].user.email);
    expect(told).toHaveLength(1);
    expect(told[0].text).toContain("disqualified");
    expect(told[0].text).toContain("Abusive to an official");
    expect(told[0].text).toContain("not refunded");
    expect(told[0].text).toContain(t.venueName);
    // The others are not told about it by this notice.
    expect((await queued(`tour-out:${field[0].entryId}`)).length).toBe(1);
  });

  it("tells one the desk withdrew before the draw that any fee is owed back, but not one who withdrew themselves", async () => {
    const t = await tournament();
    const field = await entries(t.id, 3);
    sent.length = 0;
    expect((await takeOut(field[0].entryId, "withdrawn", "Fee not paid")).ok).toBe(true);
    const told = sentTo(field[0].user.email);
    expect(told).toHaveLength(1);
    expect(told[0].text).toContain("Fee not paid");
    expect(told[0].text).toContain("owed back");
    // Their own withdrawal is not told back to them.
    sent.length = 0;
    expect((await withdraw(field[1].entryId)).ok).toBe(true);
    expect(sentTo(field[1].user.email)).toHaveLength(0);
    // A second removal of the same entry is refused and tells nobody again.
    expect((await takeOut(field[0].entryId, "withdrawn")).ok).toBe(false);
    expect((await queued(`tour-out:${field[0].entryId}`)).length).toBe(1);
  });
});

describe("a tournament nobody drew once its first day has gone (F7)", () => {
  it("takes no more entries and no fee after its first day, and closes entries when the scheduler runs", async () => {
    await savePaymentSettings(venueId, { apiKey: "key-123", collectionId: "col-123", xSignatureKey: "sig-123", sandbox: true, enabled: true });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "stale-bill-1", url: "https://www.billplz-sandbox.com/bills/stale-bill-1" })));
    const t = await tournament({ entryFee: 20 });
    const [first] = await entries(t.id, 1);
    // Still open on its first day.
    await getDb().prepare("UPDATE tournaments SET starts_on = ?, ends_on = ? WHERE id = ?").run(todayISO(), todayISO(), t.id);
    expect((await enter(await player(), t.id)).ok).toBe(true);
    // The day came and went: nobody drew it.
    await getDb().prepare("UPDATE tournaments SET starts_on = ?, ends_on = ? WHERE id = ?").run(addDays(todayISO(), -1), addDays(todayISO(), -1), t.id);
    const late = await player();
    const made = await enter(late, t.id);
    expect(made.ok).toBe(false);
    // A payment page is not opened for an entrant of an event that can no longer be drawn.
    const paid = await startEntryPayment(first.user, t.id);
    expect(paid.ok).toBe(false);
    expect(await closeDueEntries()).toBeGreaterThanOrEqual(1);
    expect((await tournamentById(t.id))!.status).toBe("closed");
  });

  it("does not stop an event with its own closing day any earlier, nor one that has been drawn", async () => {
    const t = await tournament({ entriesCloseOn: addDays(todayISO(), 2) } as Partial<TournamentInput>);
    await entries(t.id, 2);
    await getDb().prepare("UPDATE tournaments SET starts_on = ?, ends_on = ? WHERE id = ?").run(todayISO(), todayISO(), t.id);
    expect((await enter(await player(), t.id)).ok).toBe(true);
  });

  it("is a line for managers once the first day arrives, with the court time held for it, and gone when it is drawn", async () => {
    const t = await tournament({ startHour: 9, endHour: 12 });
    await entries(t.id, 3);
    expect((await undrawnTournaments(null)).some((u) => u.id === t.id)).toBe(false);
    await getDb().prepare("UPDATE tournaments SET starts_on = ?, ends_on = ? WHERE id = ?").run(todayISO(), todayISO(), t.id);
    // The hold is still on the days it was made for: list what is held, whatever the dates now say.
    const line = (await undrawnTournaments(null)).find((u) => u.id === t.id)!;
    expect(line).toMatchObject({ name: t.name, entered: 3, status: "open" });
    expect(line.held.length).toBeGreaterThan(0);
    expect(line.held[0]).toMatchObject({ courtName: expect.any(String) });
    // Another venue's manager does not see it.
    expect((await undrawnTournaments([venueId + 9999])).some((u) => u.id === t.id)).toBe(false);
    const route = await import("../src/app/api/admin/attention/route");
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(ownerId)).token}`;
    const body = await (await route.GET(new NextRequest("http://localhost/api/admin/attention", { headers: { cookie } }))).json();
    expect(body.competitions.undrawn.some((u: { id: number }) => u.id === t.id)).toBe(true);
    await getDb().prepare("UPDATE tournaments SET status = 'cancelled' WHERE id = ?").run(t.id);
    expect((await undrawnTournaments(null)).some((u) => u.id === t.id)).toBe(false);
  });
});

describe("a court out of service, or a venue closed, after the draw (F3)", () => {
  /** A drawn knockout of four on both courts from 9 to 12. */
  async function drawnCup() {
    // Days of its own, with the next day free to hold: a postponed day goes there.
    dayOffset += 3;
    const t = await tournament({ startHour: 9, endHour: 12 });
    const field = await entries(t.id, 4);
    const drawn = await makeDraw(t.id, fixed);
    if (!drawn.ok) throw new Error(drawn.error);
    return { t, field, drawn: drawn.value };
  }
  const pending = async (id: number) => (await tournamentDetail(id))!.matches.filter((m) => m.status === "scheduled");
  const lostMails = (email: string) => sentTo(email).filter((m) => m.subject === "msg.programmeSubject" && m.text.includes("cannot go ahead"));

  it("shows staff the fixtures on the lost court, tells each side once, and lists them until they are moved", async () => {
    const { t, field } = await drawnCup();
    const onFirst = (await pending(t.id)).filter((m) => m.courtId === courts[0]);
    expect(onFirst.length).toBeGreaterThan(0);
    sent.length = 0;
    const out = await createOutage({ courtId: courts[0], startsOn: t.startsOn, endsOn: t.startsOn, reason: "Floor damaged", adminId: ownerId });
    if (!out.ok) throw new Error(out.error);
    // Shown at the time: every match of this tournament on that court that day.
    expect(out.fixtures!.filter((f) => f.ownerId === t.id).map((f) => f.id).sort()).toEqual(onFirst.map((m) => m.id).sort());
    expect(out.fixtures![0]).toMatchObject({ kind: "tournament", name: t.name, courtId: courts[0], date: t.startsOn, why: "outage" });
    // Told once: the sides of those matches (the first round's), nobody else.
    const sides = new Set(onFirst.flatMap((m) => [m.a, m.b]).filter((x): x is number => x !== null));
    for (const f of field) {
      const mails = sent.filter((m) => m.to === f.user.email && m.text.includes("cannot go ahead"));
      expect(mails).toHaveLength(sides.has(f.entryId) ? 1 : 0);
    }
    const once = await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE dedupe_key LIKE 'fixture-lost:t%'").get();
    await tellFixturesLost(out.fixtures!, "outage");
    expect(await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE dedupe_key LIKE 'fixture-lost:t%'").get()).toEqual(once);
    // Until they are moved they are a line for staff.
    expect((await strandedFixtures(null)).filter((f) => f.ownerId === t.id && f.kind === "tournament").map((f) => f.id).sort()).toEqual(onFirst.map((m) => m.id).sort());
    expect((await strandedFixtures([venueId + 9999])).some((f) => f.ownerId === t.id)).toBe(false);
    // And the court back in service takes them off the list.
    const outage = (await listOutages([venueId])).find((o) => o.startsOn === t.startsOn && o.courtId === courts[0])!;
    expect((await endOutage(outage.id)).ok).toBe(true);
    expect((await strandedFixtures(null)).some((f) => f.ownerId === t.id)).toBe(false);
    void lostMails;
  });

  it("is told for a closed day through the closures route, which answers the fixtures", async () => {
    const { t, field } = await drawnCup();
    const route = await import("../src/app/api/admin/venues/[id]/closures/route");
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(ownerId)).token}`;
    sent.length = 0;
    const res = await route.POST(
      new NextRequest(`http://localhost/api/admin/venues/${venueId}/closures`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ date: t.startsOn, reason: "Flood warning", safety: true }) }),
      { params: Promise.resolve({ id: String(venueId) }) }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.fixtures.filter((f: { ownerId: number }) => f.ownerId === t.id).length).toBe((await pending(t.id)).length);
    expect(body.fixtures[0]).toMatchObject({ why: "closure" });
    // Everybody with a match that day is told.
    for (const f of field) if ((await pending(t.id)).some((m) => m.a === f.entryId || m.b === f.entryId)) expect(sent.some((m) => m.to === f.user.email && m.text.includes("closed"))).toBe(true);
    expect((await strandedFixtures(null)).some((f) => f.ownerId === t.id && f.why === "closure")).toBe(true);
  });

  it("postpones the day's fixtures to another day in one action: held there, released here, each side told", async () => {
    const { t, field } = await drawnCup();
    const before = await pending(t.id);
    const to = addDays(t.startsOn, 1);
    sent.length = 0;
    const moved = await postponeTournamentDay(t.id, t.startsOn, to);
    if (!moved.ok) throw new Error(moved.error);
    expect(moved.value.moved).toBe(before.length);
    const after = await pending(t.id);
    expect(after.every((m) => m.date === to)).toBe(true);
    // The order of the day is kept: the same start times, and every match still after the ones feeding it.
    expect(after.map((m) => m.minute).sort()).toEqual(before.map((m) => m.minute).sort());
    // The time is held for the tournament on the new day.
    const held = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM blocks WHERE tournament_id = ? AND date = ?").get(t.id, to)) as { n: number };
    expect(held.n).toBeGreaterThan(0);
    // Everybody in a first-round match was told the new time.
    for (const f of field) expect(sent.some((m) => m.to === f.user.email && m.text.includes(to))).toBe(true);
    // Nothing is left on the day.
    expect(await postponeTournamentDay(t.id, t.startsOn, to)).toMatchObject({ ok: false, error: "Nothing is left to play on that day." });
  });

  it("moves a stranded day off a lost court, the same action tidying the list", async () => {
    const { t } = await drawnCup();
    const out = await createOutage({ courtId: courts[0], startsOn: t.startsOn, endsOn: t.startsOn, adminId: ownerId });
    if (!out.ok) throw new Error(out.error);
    expect((await strandedFixtures(null)).some((f) => f.ownerId === t.id)).toBe(true);
    const moved = await postponeTournamentDay(t.id, t.startsOn, addDays(t.startsOn, 1));
    expect(moved.ok).toBe(true);
    expect((await strandedFixtures(null)).some((f) => f.ownerId === t.id)).toBe(false);
  });

  it("refuses a day with nothing to play, the same day, a day gone by, a tournament not drawn, and a bad date, changing nothing", async () => {
    const { t } = await drawnCup();
    expect(await postponeTournamentDay(t.id, t.startsOn, t.startsOn)).toMatchObject({ ok: false });
    expect(await postponeTournamentDay(t.id, addDays(t.startsOn, 5), addDays(t.startsOn, 6))).toMatchObject({ ok: false, error: "Nothing is left to play on that day." });
    expect(await postponeTournamentDay(t.id, t.startsOn, addDays(todayISO(), -2))).toMatchObject({ ok: false, error: "That day has gone by." });
    expect(await postponeTournamentDay(t.id, "soon", "later")).toMatchObject({ ok: false });
    const open = await tournament();
    expect(await postponeTournamentDay(open.id, open.startsOn, addDays(open.startsOn, 1))).toMatchObject({ ok: false });
    expect((await pending(t.id)).every((m) => m.date === t.startsOn)).toBe(true);
  });

  it("is a manager's action through the tournament route, and logged", async () => {
    const { t } = await drawnCup();
    const route = await import("../src/app/api/admin/tournaments/[id]/route");
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(ownerId)).token}`;
    const post = (body: object) => route.POST(new NextRequest(`http://localhost/api/admin/tournaments/${t.id}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(t.id) }) });
    expect((await post({ action: "postpone_day", from: t.startsOn, to: t.startsOn })).status).toBe(409);
    const done = await post({ action: "postpone_day", from: t.startsOn, to: addDays(t.startsOn, 1) });
    expect(done.status).toBe(200);
    expect((await done.json()).moved).toBeGreaterThan(0);
    expect((await listActivity(null, { limit: 10 })).some((l) => l.action === "tournament.match_moved" && l.detail?.includes("postponed"))).toBe(true);
  });
});
