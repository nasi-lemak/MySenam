import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { occupantsOn, release, releaseBooking, claim } from "../src/lib/claims";
import {
  archiveClaims,
  archiveClaimsIfDue,
  claimsArchiveDays,
  claimsArchiveStatus,
  MAX_BATCHES,
  BATCH_SIZE,
  MIN_ARCHIVE_DAYS,
  READ_THROUGH_DAYS,
} from "../src/lib/claims-archive";
import { getDb } from "../src/lib/db";
import { checkIntegrity } from "../src/lib/integrity";
import { eraseCustomer, exportCustomerData } from "../src/lib/privacy";
import { venueReport, utilisationByDay } from "../src/lib/reports";
import { runScheduledWork } from "../src/lib/scheduler";
import { blockSlots, createBooking, createClassSessions, createCourt, createVenue, getOccupancy, listBookingsForDate } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { moveBookingToDate } from "./helpers/bookings";
import { GET as systemGet } from "../src/app/api/admin/system/route";

/**
 * Archiving past claims (lib/claims-archive.ts; migration 0267; docs/architecture/database.md).
 * Court time that is over, held by something finished or cancelled, moves out of `claims`; nothing that could
 * still matter does; everything that reads the past reads the same before and after.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (n: number) => addDays(todayISO(ZONE), n);
const DAYS = 90;
const db = () => getDb();

let venueId: number;
let courtId: number;
let studioId: number;
let n = 0;
let hour = 7;
const phone = () => `0177771${String(++n).padStart(4, "0")}`;

/** A booking that ended `ago` days ago (made for a day to come, then moved: time passing). */
async function past(ago: number, opts: { court?: number; userId?: number; name?: string } = {}) {
  const court = opts.court ?? courtId;
  const start = hour;
  hour = hour >= 21 ? 7 : hour + 1;
  const made = await createBooking({ courtId: court, date: day(5), start: start * 60, end: (start + 1) * 60, name: opts.name ?? "Past", phone: phone(), userId: opts.userId });
  if (!made.ok) throw new Error(made.error);
  await moveBookingToDate(made.booking.id, day(-ago));
  return made.booking;
}
/** A booking for a day to come. */
async function future(ahead: number, court = courtId) {
  const start = hour;
  hour = hour >= 21 ? 7 : hour + 1;
  const made = await createBooking({ courtId: court, date: day(ahead), start: start * 60, end: (start + 1) * 60, name: "Soon", phone: phone() });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
}
const live = async (bookingId: number) =>
  ((await db().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE booking_id = ?").get(bookingId)) as { n: number }).n;
const archived = async (bookingId: number) =>
  ((await db().prepare("SELECT COUNT(*)::int AS n FROM claims_archive WHERE booking_id = ?").get(bookingId)) as { n: number }).n;
const total = async (table: string) => ((await db().prepare(`SELECT COUNT(*)::int AS n FROM ${table}`).get()) as { n: number }).n;
const run = (extra: { batch?: number; maxBatches?: number } = {}) => archiveClaims({ days: DAYS, ...extra });

beforeAll(async () => {
  const v = await createVenue({ name: "Archive Hall", area: "Ampang", address: "x", phone: "0312340267", openMin: 7 * 60, closeMin: 23 * 60 });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error(c.error);
  courtId = c.court.id;
  const s = await createCourt({ venueId, name: "Studio", sport: "yoga", offPeakRate: 10, peakRate: 10, capacity: 12 });
  if (!s.ok) throw new Error(s.error);
  studioId = s.court.id;
});
afterAll(() => {
  delete process.env.CLAIMS_ARCHIVE_AFTER_DAYS;
});

describe("the setting", () => {
  it("is off unless set, takes a whole number of days from 30, raises a smaller one, and refuses nonsense", () => {
    expect(claimsArchiveDays({})).toEqual({ days: 0, problem: null });
    expect(claimsArchiveDays({ CLAIMS_ARCHIVE_AFTER_DAYS: "" })).toEqual({ days: 0, problem: null });
    expect(claimsArchiveDays({ CLAIMS_ARCHIVE_AFTER_DAYS: "0" })).toEqual({ days: 0, problem: null });
    expect(claimsArchiveDays({ CLAIMS_ARCHIVE_AFTER_DAYS: "90" })).toEqual({ days: 90, problem: null });
    expect(claimsArchiveDays({ CLAIMS_ARCHIVE_AFTER_DAYS: "30" })).toEqual({ days: 30, problem: null });
    expect(claimsArchiveDays({ CLAIMS_ARCHIVE_AFTER_DAYS: "7" })).toEqual({ days: MIN_ARCHIVE_DAYS, problem: "raised" });
    for (const bad of ["-5", "1.5", "ninety", "90 days", "1e3"]) expect(claimsArchiveDays({ CLAIMS_ARCHIVE_AFTER_DAYS: bad })).toEqual({ days: 0, problem: "invalid" });
  });

  it("keeps readers of live claims behind the horizon: they read further back than the job may move", () => {
    expect(READ_THROUGH_DAYS).toBeLessThan(MIN_ARCHIVE_DAYS);
  });

  it("does nothing by default: the scheduler's job is off and a run with no days moves nothing", async () => {
    const b = await past(200);
    delete process.env.CLAIMS_ARCHIVE_AFTER_DAYS;
    expect(await archiveClaimsIfDue()).toBeNull();
    expect(await archiveClaims({ days: 0 })).toEqual({ moved: 0, batches: 0, more: false });
    expect(await live(b.id)).toBeGreaterThan(0);
    expect(await total("claims_archive")).toBe(0);
    expect((await claimsArchiveStatus()).days).toBe(0);
    await db().prepare("DELETE FROM bookings WHERE id = ?").run(b.id);
  });
});

describe("the archive's shape", () => {
  it("has every column of claims, in the same order, and the view lists the same", async () => {
    const cols = async (t: string) =>
      ((await db().prepare("SELECT column_name FROM information_schema.columns WHERE table_name = ? ORDER BY ordinal_position").all(t)) as { column_name: string }[]).map((c) => c.column_name);
    const claims = await cols("claims");
    expect((await cols("claims_archive")).slice(0, claims.length)).toEqual(claims);
    expect(await cols("claims_archive")).toEqual([...claims, "archived_at"]);
    expect(await cols("claims_all")).toEqual(claims);
  });

  it("has no exclusion constraint and no triggers: it holds the past, and decides nothing", async () => {
    const ex = (await db().prepare("SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conrelid = 'claims_archive'::regclass AND contype = 'x'").get()) as { n: number };
    expect(ex.n).toBe(0);
    const tr = (await db().prepare("SELECT COUNT(*)::int AS n FROM pg_trigger WHERE tgrelid = 'claims_archive'::regclass AND NOT tgisinternal").get()) as { n: number };
    expect(tr.n).toBe(0);
  });
});

describe("what moves", () => {
  // Each starts with nothing left over from another that is due.
  beforeEach(async () => {
    await archiveClaims({ days: DAYS, maxBatches: 200 });
  });

  it("moves past, finished claims, and nothing else: not within the horizon, not to come, not held, not open-ended", async () => {
    const old = await past(120);
    const cancelled = await past(130);
    await db().prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(cancelled.id);
    await releaseBooking(cancelled.id);
    const recent = await past(60);
    const yesterday = await past(1);
    const soon = await future(3);
    const held = await past(150);
    await db().prepare("UPDATE bookings SET hold_until = datetime('now', '+10 minutes'), payment_status = 'unpaid' WHERE id = ?").run(held.id);
    const before = await total("claims");
    const archivedBefore = await total("claims_archive");

    const result = await run();
    expect(result.moved).toBe(2);
    expect(result.more).toBe(false);

    expect([await live(old.id), await archived(old.id)]).toEqual([0, 1]);
    expect([await live(cancelled.id), await archived(cancelled.id)]).toEqual([0, 1]);
    for (const kept of [recent, yesterday, soon, held]) expect([await live(kept.id), await archived(kept.id)]).toEqual([1, 0]);
    // Nothing lost, nothing twice: a claim is in one table or the other.
    expect(await total("claims")).toBe(before - 2);
    expect(await total("claims_archive")).toBe(archivedBefore + 2);
    // What moved is as it was.
    const row = (await db().prepare("SELECT kind, active, booking_id, archived_at IS NOT NULL AS stamped FROM claims_archive WHERE booking_id = ?").get(old.id)) as Record<string, unknown>;
    expect(row).toMatchObject({ kind: "booking", active: true, booking_id: old.id, stamped: true });
    const gone = (await db().prepare("SELECT active FROM claims_archive WHERE booking_id = ?").get(cancelled.id)) as { active: boolean };
    expect(gone.active).toBe(false);

    // The held one goes once its hold has ended (paid, or let go and cancelled).
    await db().prepare("UPDATE bookings SET hold_until = NULL, payment_status = 'paid' WHERE id = ?").run(held.id);
    expect((await run()).moved).toBe(1);
    expect(await archived(held.id)).toBe(1);
  });

  it("is safe to run again: a second run moves nothing, and a run after a stop carries on", async () => {
    const a = await past(300);
    const b = await past(301);
    const c = await past(302);
    const first = await run({ batch: 1, maxBatches: 2 });
    expect(first).toEqual({ moved: 2, batches: 2, more: true });
    const second = await run();
    expect(second.moved).toBe(1);
    expect(await run()).toEqual({ moved: 0, batches: 0, more: false });
    for (const x of [a, b, c]) expect([await live(x.id), await archived(x.id)]).toEqual([0, 1]);
  });

  it("moves in batches of a bounded size, oldest first", async () => {
    expect(BATCH_SIZE * MAX_BATCHES).toBeLessThanOrEqual(20_000);
    const oldest = await past(400);
    const middle = await past(399);
    const newest = await past(398);
    const r = await run({ batch: 2, maxBatches: 1 });
    expect(r).toEqual({ moved: 2, batches: 1, more: true });
    expect(await archived(oldest.id)).toBe(1);
    expect(await archived(middle.id)).toBe(1);
    expect(await archived(newest.id)).toBe(0);
    expect((await run()).moved).toBe(1);
  });

  it("moves a class, a block and a bounded outage that are over, and leaves an outage with no last day", async () => {
    const klass = await createClassSessions({ courtId: studioId, name: "Flow", instructor: "Coach", date: day(4), startHour: 18, endHour: 19, capacity: 4, price: 10 });
    if (!klass.ok) throw new Error(klass.error);
    const blocked = await blockSlots(courtId, day(4), [22], "Maintenance");
    if (!blocked.ok) throw new Error("block");
    // Time passes for both: their rows and claims, a hundred and twenty days.
    const ago = `interval '124 days'`;
    await db().prepare(`UPDATE classes SET date = ?, start_min = start_min WHERE id = ?`).run(day(-120), klass.classes[0].id);
    await db().prepare("UPDATE blocks SET date = ? WHERE court_id = ? AND date = ?").run(day(-120), courtId, day(4));
    await db()
      .prepare(
        `UPDATE claims SET during = tstzrange(lower(during) - ${ago}, upper(during) - ${ago}), occupied = tstzrange(lower(occupied) - ${ago}, upper(occupied) - ${ago})
          WHERE class_id = ? OR block_id IN (SELECT id FROM blocks WHERE court_id = ? AND date = ?)`
      )
      .run(klass.classes[0].id, courtId, day(-120));
    // A finished outage, and one still going with no last day.
    const out = (await db().prepare("INSERT INTO court_outages (court_id, starts_on, ends_on, reason) VALUES (?, ?, ?, 'Resurfacing') RETURNING id").get(studioId, day(-130), day(-125))) as { id: number };
    const hall = await createCourt({ venueId, name: "Hall", sport: "yoga", offPeakRate: 10, peakRate: 10, capacity: 12 });
    if (!hall.ok) throw new Error(hall.error);
    const open = (await db().prepare("INSERT INTO court_outages (court_id, starts_on, ends_on, reason) VALUES (?, ?, NULL, 'Closed') RETURNING id").get(hall.court.id, day(-130))) as { id: number };
    await claim({
      court: { id: studioId, venueId, capacity: 12 },
      source: { kind: "outage", outageId: out.id },
      date: day(-130),
      span: { start: 0, end: 1440 },
      zone: ZONE,
      places: 12,
    });
    await claim({
      court: { id: hall.court.id, venueId, capacity: 12 },
      source: { kind: "outage", outageId: open.id },
      date: day(-130),
      span: { start: 0, end: 1440 },
      zone: ZONE,
      places: 12,
      openEnded: true,
    });
    const by = async (col: string, id: number) =>
      ((await db().prepare(`SELECT (SELECT COUNT(*)::int FROM claims WHERE ${col} = ?) AS live, (SELECT COUNT(*)::int FROM claims_archive WHERE ${col} = ?) AS gone`).get(id, id)) as { live: number; gone: number });
    const blockId = ((await db().prepare("SELECT id FROM blocks WHERE court_id = ? AND date = ?").get(courtId, day(-120))) as { id: number }).id;

    await run();
    expect(await by("class_id", klass.classes[0].id)).toEqual({ live: 0, gone: 1 });
    expect(await by("block_id", blockId)).toEqual({ live: 0, gone: 1 });
    expect(await by("outage_id", out.id)).toEqual({ live: 0, gone: 1 });
    expect(await by("outage_id", open.id)).toEqual({ live: 1, gone: 0 });
  });

  it("keeps the claim of a booking whose payment is disputed, until the dispute is won", async () => {
    const b = await past(180);
    const pay = (await db()
      .prepare("INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, status, payer_name) VALUES ('fake', ?, 'x', ?, 20, 'paid', 'P') RETURNING id")
      .get(`bill-${b.id}`, venueId)) as { id: number };
    await db().prepare("INSERT INTO online_payment_bookings (payment_id, booking_id) VALUES (?, ?)").run(pay.id, b.id);
    await db().prepare("INSERT INTO payment_disputes (payment_id, provider_dispute_id, amount, reason, status) VALUES (?, ?, 20, 'fraudulent', 'needs_response')").run(pay.id, `dp-${b.id}`);
    expect((await run()).moved).toBe(0);
    expect(await live(b.id)).toBe(1);
    await db().prepare("UPDATE payment_disputes SET outcome = 'lost', status = 'lost' WHERE payment_id = ?").run(pay.id);
    expect((await run()).moved).toBe(0);
    await db().prepare("UPDATE payment_disputes SET outcome = 'won', status = 'won' WHERE payment_id = ?").run(pay.id);
    expect((await run()).moved).toBe(1);
    expect(await archived(b.id)).toBe(1);
  });

  it("keeps a booking whose payment page may still be paid, until the page is old", async () => {
    const b = await past(181);
    const pay = (await db()
      .prepare("INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, status, payer_name) VALUES ('fake', ?, 'x', ?, 20, 'pending', 'P') RETURNING id")
      .get(`bill-pending-${b.id}`, venueId)) as { id: number };
    await db().prepare("INSERT INTO online_payment_bookings (payment_id, booking_id) VALUES (?, ?)").run(pay.id, b.id);
    expect((await run()).moved).toBe(0);
    await db().prepare("UPDATE online_payments SET created_at = datetime('now', '-45 days') WHERE id = ?").run(pay.id);
    expect((await run()).moved).toBe(1);
  });

  /** An application for the venue by a new account, with its requirement. */
  async function application(extra: { bookingId?: number | null; status?: string; slotStatus?: string | null } = {}) {
    const who = await registerUser({ name: `Applicant ${++n}`, email: `applicant${n}@archive.test`, phone: phone(), password: "a long enough password" });
    if (!who.ok) throw new Error(who.error);
    const requirement =
      ((await db().prepare("SELECT id FROM approval_requirements WHERE venue_id = ? AND sport = 'badminton'").get(venueId)) as { id: number } | undefined) ??
      ((await db().prepare("INSERT INTO approval_requirements (venue_id, sport, declaration) VALUES (?, 'badminton', 'I can play safely.') RETURNING id").get(venueId)) as { id: number });
    return (await db()
      .prepare(
        `INSERT INTO approval_requests (requirement_id, venue_id, sport, user_id, name, phone, status, booking_id, declared_adult, expires_at)
         VALUES (?, ?, 'badminton', ?, 'Applicant', '0100000000', ?, ?, 1, now()) RETURNING id`
      )
      .get(requirement.id, venueId, who.user.id, extra.status ?? "approved", extra.bookingId ?? null)) as { id: number };
  }

  it("keeps the claims of a booking made on an application under a hold, until the hold ends", async () => {
    const b = await past(182);
    const req = await application({ bookingId: b.id });
    await db()
      .prepare(
        `INSERT INTO approval_holds (request_id, venue_id, basis, reason, placed_by_name, placed_by_role, review_by)
         VALUES (?, ?, 'legal', 'A claim is being looked into by the venue.', 'Manager', 'manager', ?)`
      )
      .run(req.id, venueId, day(30));
    expect((await run()).moved).toBe(0);
    expect(await live(b.id)).toBe(1);
    // A hold that has run past its review day protects nothing.
    await db().prepare("UPDATE approval_holds SET review_by = ? WHERE request_id = ?").run(day(-1), req.id);
    expect((await run()).moved).toBe(1);
    expect(await archived(b.id)).toBe(1);
  });

  it("keeps a held slot of an application not yet decided or under a hold, and moves a decided one", async () => {
    const mk = async (status: string, hourOfDay: number) => {
      const req = await application({ status });
      await claim({
        court: { id: courtId, venueId, capacity: 1 },
        source: { kind: "approval", approvalId: req.id },
        date: day(-190),
        span: { start: hourOfDay * 60, end: hourOfDay * 60 + 60 },
        zone: ZONE,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      return req.id;
    };
    const pending = await mk("pending", 8);
    const decided = await mk("rejected", 9);
    const held = await mk("approved", 10);
    await db()
      .prepare(
        `INSERT INTO approval_holds (request_id, venue_id, basis, reason, placed_by_name, placed_by_role, review_by)
         VALUES (?, ?, 'dispute', 'The applicant disputes the decision.', 'Manager', 'manager', ?)`
      )
      .run(held, venueId, day(20));
    const where = async (id: number) =>
      (await db().prepare("SELECT (SELECT COUNT(*)::int FROM claims WHERE approval_id = ?) AS live, (SELECT COUNT(*)::int FROM claims_archive WHERE approval_id = ?) AS gone").get(id, id)) as { live: number; gone: number };
    expect((await run()).moved).toBe(1);
    expect(await where(pending)).toEqual({ live: 1, gone: 0 });
    expect(await where(held)).toEqual({ live: 1, gone: 0 });
    expect(await where(decided)).toEqual({ live: 0, gone: 1 });
    await db().prepare("UPDATE approval_requests SET status = 'withdrawn' WHERE id = ?").run(pending);
    await db().prepare("UPDATE approval_holds SET released_at = now() WHERE request_id = ?").run(held);
    expect((await run()).moved).toBe(2);
  });

  it("keeps a proposed move of an open game not yet decided, and moves one that was", async () => {
    const mk = async (status: string, hourOfDay: number) => {
      const host = await registerUser({ name: `Host ${++n}`, email: `host${n}@archive.test`, phone: phone(), password: "a long enough password" });
      if (!host.ok) throw new Error(host.error);
      const b = await past(195);
      const game = (await db().prepare("INSERT INTO open_games (booking_id, host_id, spots, share) VALUES (?, ?, 3, 5) RETURNING id").get(b.id, host.user.id)) as { id: number };
      const move = (await db()
        .prepare(
          `INSERT INTO game_moves (game_id, booking_id, kind, host_id, from_date, from_start_min, from_end_min, to_date, to_start_min, to_end_min, status, expires_at)
           VALUES (?, ?, 'proposal', ?, ?, 540, 600, ?, ?, ?, ?, now() + interval '1 day') RETURNING id`
        )
        .get(game.id, b.id, host.user.id, day(-195), day(-190), hourOfDay * 60, hourOfDay * 60 + 60, status)) as { id: number };
      await claim({
        court: { id: courtId, venueId, capacity: 1 },
        source: { kind: "move", moveId: move.id },
        date: day(-190),
        span: { start: hourOfDay * 60, end: hourOfDay * 60 + 60 },
        zone: ZONE,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      return move.id;
    };
    const pending = await mk("pending", 12);
    const applied = await mk("expired", 13);
    const where = async (id: number) =>
      (await db().prepare("SELECT (SELECT COUNT(*)::int FROM claims WHERE move_id = ?) AS live, (SELECT COUNT(*)::int FROM claims_archive WHERE move_id = ?) AS gone").get(id, id)) as { live: number; gone: number };
    await run();
    expect(await where(pending)).toEqual({ live: 1, gone: 0 });
    expect(await where(applied)).toEqual({ live: 0, gone: 1 });
  });

  it("keeps a waiting-list offer not yet answered, and moves one that was", async () => {
    const mk = async (status: string) => {
      const w = (await db()
        .prepare("INSERT INTO waitlist (court_id, date, name, phone, status, start_min, end_min) VALUES (?, ?, 'W', ?, ?, 600, 660) RETURNING id")
        .get(courtId, day(-200), phone(), status)) as { id: number };
      await claim({ court: { id: courtId, venueId, capacity: 1 }, source: { kind: "offer", waitlistId: w.id }, date: day(-200), span: { start: 600, end: 660 }, zone: ZONE, expiresAt: new Date(Date.now() + 86_400_000) });
      return w.id;
    };
    const offered = await mk("offered");
    // The first is held by the offer; the second needs another hour of the day: make it not clash.
    await db().prepare("UPDATE claims SET active = false WHERE waitlist_id = ?").run(offered);
    const claimed = await mk("claimed");
    expect((await run()).moved).toBe(1);
    const where = async (id: number) => ((await db().prepare("SELECT (SELECT COUNT(*)::int FROM claims WHERE waitlist_id = ?) AS live, (SELECT COUNT(*)::int FROM claims_archive WHERE waitlist_id = ?) AS gone").get(id, id)) as { live: number; gone: number });
    expect(await where(offered)).toEqual({ live: 1, gone: 0 });
    expect(await where(claimed)).toEqual({ live: 0, gone: 1 });
    // Retention deletes answered waiting-list entries: the archived claim goes with its entry.
    await db().prepare("DELETE FROM waitlist WHERE id = ?").run(claimed);
    expect(await where(claimed)).toEqual({ live: 0, gone: 0 });
    await db().prepare("DELETE FROM waitlist WHERE id = ?").run(offered);
  });
});

describe("what reads the past reads the same", () => {
  it("shows the same day, report, occupancy, bookings, export and integrity before and after, and today and tomorrow are as they were", async () => {
    const who = await registerUser({ name: "Past Player", email: "pastplayer@archive.test", phone: "0177779000", password: "a long enough password" });
    if (!who.ok) throw new Error(who.error);
    const a = await past(250, { userId: who.user.id, name: "Past Player" });
    const b = await past(250, { userId: who.user.id, name: "Past Player" });
    await db().prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(b.id);
    await releaseBooking(b.id);
    const date = day(-250);
    const soon = await future(1);
    const zone = ZONE;
    const court = { id: courtId, venueId, capacity: 1 };
    const read = async () => ({
      day: [...(await occupantsOn([court], date, zone)).entries()],
      tomorrow: [...(await occupantsOn([court], day(1), zone)).entries()],
      today: [...(await occupantsOn([court], day(0), zone)).entries()],
      listed: await listBookingsForDate(date, venueId),
      occupancy: await getOccupancy(venueId, date, 3),
      report: await venueReport(venueId, day(-251), day(-249)),
      utilisation: [...(await utilisationByDay(venueId, day(-251), day(-249))).entries()],
      exported: { ...(await exportCustomerData(who.user.id)), takenAt: null },
      integrity: await checkIntegrity(),
    });
    const before = await read();
    expect(before.day[0][1].length).toBeGreaterThan(0);
    expect(before.integrity).toEqual([]);

    expect((await run()).moved).toBeGreaterThanOrEqual(2);
    expect(await live(a.id)).toBe(0);
    const after = await read();
    expect(after).toEqual(before);
    // The booking for tomorrow still holds its court: nobody can book over it.
    const clash = await createBooking({ courtId, date: day(1), start: ((await db().prepare("SELECT start_min FROM bookings WHERE id = ?").get(soon.id)) as { start_min: number }).start_min, end: ((await db().prepare("SELECT end_min FROM bookings WHERE id = ?").get(soon.id)) as { end_min: number }).end_min, name: "Clash", phone: phone() });
    expect(clash.ok).toBe(false);
  });

  it("reports a period's blocks the same once they are archived", async () => {
    const blocked = await blockSlots(courtId, day(6), [20, 21], "Floor");
    if (!blocked.ok) throw new Error("block");
    const ago = `interval '230 days'`;
    await db().prepare("UPDATE blocks SET date = ? WHERE court_id = ? AND date = ?").run(day(-224), courtId, day(6));
    await db()
      .prepare(
        `UPDATE claims SET during = tstzrange(lower(during) - ${ago}, upper(during) - ${ago}), occupied = tstzrange(lower(occupied) - ${ago}, upper(occupied) - ${ago})
          WHERE block_id IN (SELECT id FROM blocks WHERE court_id = ? AND date = ?)`
      )
      .run(courtId, day(-224));
    const read = async () => JSON.stringify([await venueReport(venueId, day(-226), day(-222)), [...(await utilisationByDay(venueId, day(-226), day(-222))).entries()]]);
    const before = await read();
    expect((await db().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE block_id IN (SELECT id FROM blocks WHERE date = ?)").get(day(-224))) as { n: number }).toMatchObject({ n: expect.any(Number) });
    await run();
    expect(((await db().prepare("SELECT COUNT(*)::int AS n FROM claims WHERE block_id IN (SELECT id FROM blocks WHERE date = ?)").get(day(-224))) as { n: number }).n).toBe(0);
    expect(await read()).toBe(before);
  });

  it("lets a past booking be let go after it was archived, so the archive says what the live table would", async () => {
    const b = await past(260);
    await run();
    expect(await archived(b.id)).toBe(1);
    expect(await release({ kind: "booking", bookingId: b.id })).toBe(0);
    expect(((await db().prepare("SELECT active FROM claims_archive WHERE booking_id = ?").get(b.id)) as { active: boolean }).active).toBe(false);
  });

  it("erases and anonymises as before: the archive holds no names, and what is deleted takes its archived claims with it", async () => {
    const who = await registerUser({ name: "Leaver", email: "leaver@archive.test", phone: "0177779001", password: "a long enough password" });
    if (!who.ok) throw new Error(who.error);
    const b = await past(270, { userId: who.user.id, name: "Leaver" });
    await run();
    expect(await archived(b.id)).toBe(1);
    // A claim carries no name, phone or address: nothing in it to erase.
    const cols = ((await db().prepare("SELECT column_name FROM information_schema.columns WHERE table_name = 'claims_archive'").all()) as { column_name: string }[]).map((c) => c.column_name);
    expect(cols.filter((c) => /name|phone|email|address|token/.test(c))).toEqual([]);
    expect((await eraseCustomer(who.user.id)).ok).toBe(true);
    const booking = (await db().prepare("SELECT name, user_id FROM bookings WHERE id = ?").get(b.id)) as { name: string; user_id: number | null };
    expect(booking.name).toBe("(removed)");
    expect(booking.user_id).toBeNull();
    // The booking is kept for the books, so is its archived time; deleting the booking deletes it.
    expect(await archived(b.id)).toBe(1);
    await db().prepare("DELETE FROM bookings WHERE id = ?").run(b.id);
    expect(await archived(b.id)).toBe(0);
  });

  it("deletes archived time with what held it: a class, a block, an outage and a court", async () => {
    const hall = await createCourt({ venueId, name: "Annex", sport: "yoga", offPeakRate: 10, peakRate: 10, capacity: 12 });
    if (!hall.ok) throw new Error(hall.error);
    const annex = hall.court.id;
    const klass = await createClassSessions({ courtId: annex, name: "Stretch", instructor: "Coach", date: day(4), startHour: 8, endHour: 9, capacity: 4, price: 10 });
    if (!klass.ok) throw new Error(klass.error);
    const blocked = await blockSlots(annex, day(4), [12], "Paint");
    if (!blocked.ok) throw new Error("block");
    const ago = `interval '600 days'`;
    await db().prepare("UPDATE classes SET date = ? WHERE id = ?").run(day(-596), klass.classes[0].id);
    await db().prepare("UPDATE blocks SET date = ? WHERE court_id = ?").run(day(-596), annex);
    await db()
      .prepare(`UPDATE claims SET during = tstzrange(lower(during) - ${ago}, upper(during) - ${ago}), occupied = tstzrange(lower(occupied) - ${ago}, upper(occupied) - ${ago}) WHERE court_id = ?`)
      .run(annex);
    const count = async () => ((await db().prepare("SELECT COUNT(*)::int AS n FROM claims_archive WHERE court_id = ?").get(annex)) as { n: number }).n;
    await run();
    expect(await count()).toBe(2);
    await db().prepare("DELETE FROM classes WHERE id = ?").run(klass.classes[0].id);
    expect(await count()).toBe(1);
    await db().prepare("DELETE FROM blocks WHERE court_id = ?").run(annex);
    expect(await count()).toBe(0);
  });
});

describe("beside bookings (needs a Postgres server: PGlite has one connection)", () => {
  it("lets bookings be made while a run is moving old court time, and every one holds its court", async () => {
    if (db().kind !== "postgres") return;
    const old: number[] = [];
    for (let i = 0; i < 12; i++) old.push((await past(600 + i)).id);
    // Fresh courts, so the new bookings do not queue behind each other: what matters is that they do not queue behind the run.
    const courts: number[] = [];
    for (let i = 0; i < 6; i++) {
      const c = await createCourt({ venueId, name: `Fresh ${i}`, sport: "badminton", offPeakRate: 20, peakRate: 20 });
      if (!c.ok) throw new Error(c.error);
      courts.push(c.court.id);
    }
    const made = await Promise.all([
      archiveClaims({ days: DAYS, batch: 3, maxBatches: 10 }),
      ...courts.map((c, i) => createBooking({ courtId: c, date: day(3), start: (9 + (i % 3)) * 60, end: (10 + (i % 3)) * 60, name: "Meanwhile", phone: phone() })),
    ]);
    expect((made[0] as { moved: number }).moved).toBe(12);
    for (const m of made.slice(1)) expect((m as { ok: boolean }).ok).toBe(true);
    for (const id of old) expect([await live(id), await archived(id)]).toEqual([0, 1]);
    expect(await checkIntegrity()).toEqual([]);
    // And the court time of a booking just made still keeps a second booking off it.
    const first = made[1] as { ok: true; booking: { id: number; startMin: number; endMin: number } };
    const clash = await createBooking({ courtId: courts[0], date: day(3), start: first.booking.startMin, end: first.booking.endMin, name: "Clash", phone: phone() });
    expect(clash.ok).toBe(false);
  });

  it("leaves a claim another transaction is changing for the next run, and never waits for it", async () => {
    if (db().kind !== "postgres") return;
    const busy = await past(650);
    const quiet = await past(651);
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    let finish!: () => void;
    const finished = new Promise<void>((r) => (finish = r));
    const holder = db().transaction(async () => {
      await db().prepare("UPDATE claims SET active = active WHERE booking_id = ?").run(busy.id);
      started();
      await finished;
    })();
    await ready;
    const result = await run();
    expect(result.moved).toBe(1);
    expect([await live(quiet.id), await archived(quiet.id)]).toEqual([0, 1]);
    expect([await live(busy.id), await archived(busy.id)]).toEqual([1, 0]);
    finish();
    await holder;
    expect((await run()).moved).toBe(1);
    expect(await archived(busy.id)).toBe(1);
  });
});

describe("falling behind (needs a Postgres server)", () => {
  it("tells the owners when court time due to move has stayed behind for days, and stops once it has caught up", async () => {
    if (db().kind !== "postgres") return;
    process.env.CLAIMS_ARCHIVE_AFTER_DAYS = String(DAYS);
    await db().prepare("DELETE FROM system_alerts").run();
    await db().prepare("DELETE FROM settings WHERE key LIKE 'claims_archive_%'").run();
    const stuck = await past(700);
    // Working for four days and never caught up, because one claim has been in somebody's hands all the while.
    await db().prepare("INSERT INTO settings (key, value) VALUES ('claims_archive_first_run_at', ?)").run(new Date(Date.now() - 4 * 86_400_000).toISOString());
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    let finish!: () => void;
    const finished = new Promise<void>((r) => (finish = r));
    const holder = db().transaction(async () => {
      await db().prepare("UPDATE claims SET active = active WHERE booking_id = ?").run(stuck.id);
      started();
      await finished;
    })();
    await ready;
    await runScheduledWork(new Date());
    const alert = (await db().prepare("SELECT subject FROM system_alerts WHERE key = 'claims-archive-behind'").get()) as { subject: string } | undefined;
    expect(alert?.subject).toBe("Past court time is not being archived fast enough");
    expect((await claimsArchiveStatus()).behind).toBe(true);
    finish();
    await holder;
    // Free again: the next run moves it, and the job is caught up.
    const caught = await archiveClaimsIfDue(new Date(Date.now() + 2 * 3600_000));
    expect(caught).toMatchObject({ moved: 1, behind: false });
    expect(await archived(stuck.id)).toBe(1);
    expect((await claimsArchiveStatus()).behind).toBe(false);
    delete process.env.CLAIMS_ARCHIVE_AFTER_DAYS;
  });
});

describe("the integrity check", () => {
  it("finds court time in the archive that has not ended, and a clean archive is clean", async () => {
    expect((await checkIntegrity()).filter((p) => p.kind === "claim_archived_early")).toEqual([]);
    // Something went round the code: a booking's claim moved to the archive by hand.
    const soon = await future(2);
    await db().prepare("INSERT INTO claims_archive SELECT c.*, now() FROM claims c WHERE c.booking_id = ?").run(soon.id);
    await db().prepare("DELETE FROM claims WHERE booking_id = ?").run(soon.id);
    const found = (await checkIntegrity()).filter((p) => p.kind === "claim_archived_early");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ venueId, bookingId: soon.id });
    // A manager of another venue is not shown it.
    expect((await checkIntegrity([venueId + 999])).filter((p) => p.kind === "claim_archived_early")).toEqual([]);
    expect((await checkIntegrity([venueId])).filter((p) => p.kind === "claim_archived_early")).toHaveLength(1);
    await db().prepare("INSERT INTO claims SELECT id, venue_id, court_id, space_id, places, kind, booking_id, class_id, block_id, outage_id, waitlist_id, during, occupied, buffer_before, buffer_after, active, expires_at, created_at, move_id, approval_id, separation_before, separation_after, facility_wide FROM claims_archive WHERE booking_id = ?").run(soon.id);
    await db().prepare("DELETE FROM claims_archive WHERE booking_id = ?").run(soon.id);
    expect((await checkIntegrity()).filter((p) => p.kind === "claim_archived_early")).toEqual([]);
  });
});

describe("the scheduled job", () => {
  it("runs when due, then waits an hour, and carries on at once after a run that stopped at its limit", async () => {
    process.env.CLAIMS_ARCHIVE_AFTER_DAYS = String(DAYS);
    await db().prepare("DELETE FROM settings WHERE key LIKE 'claims_archive_%'").run();
    await archiveClaims({ days: DAYS, maxBatches: 200 });
    const now = new Date();
    const one = await past(500);
    const two = await past(501);
    const first = await archiveClaimsIfDue(now, { batch: 1, maxBatches: 1 });
    expect(first).toMatchObject({ moved: 1, more: true });
    // Stopped at its limit: due again at the next tick.
    const next = await archiveClaimsIfDue(new Date(now.getTime() + 60_000));
    expect(next).toMatchObject({ moved: 1 });
    // Nothing left: not looked at again for an hour.
    expect(await archiveClaimsIfDue(new Date(now.getTime() + 120_000))).toBeNull();
    const later = await archiveClaimsIfDue(new Date(now.getTime() + 61 * 60_000));
    expect(later).toMatchObject({ moved: 0, behind: false });
    expect(await archived(one.id)).toBe(1);
    expect(await archived(two.id)).toBe(1);
    const status = await claimsArchiveStatus();
    expect(status).toMatchObject({ days: DAYS, problem: null, totalMoved: 2, behind: false, failure: null });
    expect(status.ranAt).not.toBeNull();
  });

  it("tells the owners, and keeps the failure, when it cannot run; then recovers", async () => {
    process.env.CLAIMS_ARCHIVE_AFTER_DAYS = String(DAYS);
    await db().prepare("DELETE FROM system_alerts").run();
    await archiveClaims({ days: DAYS, maxBatches: 200 });
    const b = await past(510);
    await db().prepare("DELETE FROM settings WHERE key LIKE 'claims_archive_%'").run();
    await db().prepare("ALTER TABLE claims_archive RENAME TO claims_archive_away").run();
    try {
      await runScheduledWork(new Date());
    } finally {
      await db().prepare("ALTER TABLE claims_archive_away RENAME TO claims_archive").run();
    }
    const alert = (await db().prepare("SELECT key, subject FROM system_alerts WHERE key = 'scheduler:claims-archive-failed'").get()) as { key: string; subject: string } | undefined;
    expect(alert?.subject).toBe("Scheduled work failed: archiving past court time");
    const failed = await claimsArchiveStatus();
    expect(failed.failure).not.toBeNull();
    expect(await live(b.id)).toBe(1);
    // Ten minutes on, it tries again and succeeds.
    expect(await archiveClaimsIfDue(new Date(Date.now() + 5 * 60_000))).toBeNull();
    const again = await archiveClaimsIfDue(new Date(Date.now() + 11 * 60_000));
    expect(again).toMatchObject({ moved: 1 });
    expect((await claimsArchiveStatus()).failure).toBeNull();
  });

  it("raises an alert when due court time has waited past the horizon for days and it cannot keep up", async () => {
    process.env.CLAIMS_ARCHIVE_AFTER_DAYS = String(DAYS);
    await db().prepare("DELETE FROM system_alerts").run();
    await db().prepare("DELETE FROM settings WHERE key LIKE 'claims_archive_%'").run();
    await past(520);
    await past(521);
    await past(522);
    const start = new Date();
    // First seen working four days ago, never caught up since; each run moves one.
    await db().prepare("INSERT INTO settings (key, value) VALUES ('claims_archive_first_run_at', ?)").run(new Date(start.getTime() - 4 * 86_400_000).toISOString());
    const tick = await archiveClaimsIfDue(start, { batch: 1, maxBatches: 1 });
    expect(tick).toMatchObject({ moved: 1, behind: true });
    expect((await claimsArchiveStatus()).behind).toBe(true);
    await runScheduledWork(new Date(start.getTime() + 60_000)); // the scheduler's own tick finishes the rest
    // Caught up: no longer behind.
    await archiveClaimsIfDue(new Date(start.getTime() + 2 * 60_000));
    expect((await claimsArchiveStatus()).waiting).toBe(0);
    delete process.env.CLAIMS_ARCHIVE_AFTER_DAYS;
  });

  it("is on the owner's system health answer, owner only", async () => {
    const owner = await createAdmin({ name: "Owner", email: "owner@archive.test", password: "a long enough password", venueId: null, role: "manager" });
    if (!owner.ok) throw new Error(owner.error);
    const session = await createAdminSession(owner.admin.id);
    const call = (token?: string) => systemGet(new NextRequest("http://localhost/api/admin/system", token ? { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` } } : undefined));
    const res = await call(session.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ claimsArchive: { days: 0, problem: null, behind: false } });
    expect((await call()).status).toBe(401);
    const manager = await createAdmin({ name: "Branch", email: "branch@archive.test", password: "a long enough password", venueId, role: "manager" });
    if (!manager.ok) throw new Error(manager.error);
    expect((await call((await createAdminSession(manager.admin.id)).token)).status).toBe(403);
  });
});
