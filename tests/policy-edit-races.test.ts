import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

// A pause the tests control, in the one place a booking (or a class move) asks something after it has been checked and before its
// transaction: the membership check, which every booking asks before it starts writing and a class move asks of each place on its roster.
const pause = vi.hoisted(() => ({
  armed: false,
  reached: () => {},
  until: Promise.resolve(),
}));
vi.mock("../src/lib/entitlements", async (original) => {
  const real = await original<typeof import("../src/lib/entitlements")>();
  return {
    ...real,
    membersOnlyRefusal: async (input: Parameters<typeof real.membersOnlyRefusal>[0]) => {
      if (pause.armed) {
        pause.armed = false;
        pause.reached();
        await pause.until;
      }
      return real.membersOnlyRefusal(input);
    },
  };
});

import { moveClasses } from "../src/lib/class-moves";
import { getDb } from "../src/lib/db";
import * as dated from "../src/lib/dated-changes";
import { setCourtHoursChange, setHoursChange, updatePolicyKeepingBookings } from "../src/lib/dated-changes";
import { updatePolicy } from "../src/lib/booking-policy";
import {
  adminCancelBooking,
  closeVenueDay,
  createBooking,
  createBookingSeries,
  createClassSessions,
  createCourt,
  createVenue,
  enrolInClass,
  getCourt,
  updateVenue,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * ADR 0069 (B14): a manager's edit of the hours or the rules, a closed day, and a booking or a class move made at the same moment.
 * Whatever the order, a booking is never left standing outside hours that were already changed when it was committed, and an edit is
 * never committed over a booking that now falls outside it.
 *
 * "Held" tests pause the booking where it has been checked and has not yet started writing, do the edit, and let it go: the same
 * order a slow request meets on a busy server, made deterministic (they run on PGlite too). The real overlap of two connections
 * runs only against Postgres (TEST_DATABASE_URL).
 */

const postgres = !!process.env.TEST_DATABASE_URL;
let venueId: number;
let n = 0;
const phone = () => `0171133${String(++n).padStart(4, "0")}`;
const at = (h: number) => h * 60;

beforeAll(async () => {
  const made = await createVenue({ name: "Hours Hall", area: "Ipoh", address: "x", phone: "0355552222", openHour: 8, closeHour: 23 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
});

async function newCourt(sport: "badminton" | "gym" = "badminton", capacity = 1) {
  const made = await createCourt({ venueId, name: `Hours Court ${++n}`, sport, offPeakRate: 20, peakRate: 20, capacity });
  if (!made.ok) throw new Error(made.error);
  return made.court;
}

/** Start `run`, which is held where it has been checked and not yet started writing; returns what releases it. */
async function held<T>(run: () => Promise<T>) {
  let release!: () => void;
  let reached!: () => void;
  const waiting = new Promise<void>((r) => (reached = r));
  pause.until = new Promise<void>((r) => (release = r));
  pause.reached = reached;
  pause.armed = true;
  const result = run();
  await Promise.race([waiting, result.then(() => undefined, () => undefined)]);
  if (pause.armed) {
    pause.armed = false;
    throw new Error("the held call never reached its pause");
  }
  return { release, result };
}

const confirmedAt = async (courtId: number, date: string, startMin: number) =>
  ((await getDb()
    .prepare("SELECT COUNT(*)::int AS c FROM bookings WHERE court_id = ? AND date = ? AND start_min = ? AND status = 'confirmed'")
    .get(courtId, date, startMin)) as { c: number }).c;

/** Nothing stands from an earlier test to stop the hours being narrowed in the next, and the hours are the usual ones again. */
afterEach(async () => {
  const left = (await getDb()
    .prepare("SELECT b.code FROM bookings b JOIN courts c ON c.id = b.court_id WHERE c.venue_id = ? AND b.status = 'confirmed' AND b.class_id IS NULL")
    .all(venueId)) as { code: string }[];
  for (const { code } of left) await adminCancelBooking(code);
  await getDb().prepare("DELETE FROM venue_closures WHERE venue_id = ?").run(venueId);
  await getDb().prepare("DELETE FROM venue_hours_changes WHERE venue_id = ?").run(venueId);
  await getDb().prepare("UPDATE venues SET open_min = ?, close_min = ?, week_hours = NULL WHERE id = ?").run(at(8), at(23), venueId);
});

const narrow = (closeHour: number) => updateVenue(venueId, { closeHour });
const reopen = async () => {
  const done = await updateVenue(venueId, { openHour: 8, closeHour: 23 });
  if (!done.ok) throw new Error(done.error);
};

describe("a booking checked against the hours, and the hours narrowed before it is written", () => {
  it("is refused as outside the hours, and nothing is left booked there", async () => {
    const court = await newCourt();
    const date = addDays(todayISO(), 5);
    const who = phone();
    const pending = await held(() => createBooking({ courtId: court.id, date, hours: [20], name: "Late", phone: who }));
    const edit = await narrow(19);
    expect(edit.ok).toBe(true);
    pending.release();
    const made = await pending.result;
    expect(made).toMatchObject({ ok: false, code: "HOURS_OUTSIDE_OPENING" });
    expect(await confirmedAt(court.id, date, at(20))).toBe(0);
    await reopen();
  });

  it("and the other way round, a booking made first stops the narrowing, listing it", async () => {
    const court = await newCourt();
    const date = addDays(todayISO(), 6);
    expect((await createBooking({ courtId: court.id, date, hours: [20], name: "First", phone: phone() })).ok).toBe(true);
    const edit = await narrow(19);
    expect(edit.ok).toBe(false);
    expect(await confirmedAt(court.id, date, at(20))).toBe(1);
    // Nothing was written: the venue still closes at 23:00.
    expect(((await getDb().prepare("SELECT close_min FROM venues WHERE id = ?").get(venueId)) as { close_min: number }).close_min).toBe(at(23));
  });

  it("a manager's override goes ahead where the hours were already narrower when they chose to book (explicit, and recorded)", async () => {
    await narrow(19);
    const court = await newCourt();
    const date = addDays(todayISO(), 7);
    const made = await createBooking({ courtId: court.id, date, hours: [20], name: "Staff", phone: phone(), staff: { override: true } });
    expect(made).toMatchObject({ ok: true });
    const row = (await getDb().prepare("SELECT policy_override FROM bookings WHERE court_id = ?").get(court.id)) as { policy_override: boolean };
    expect(row.policy_override).toBe(true);
    const refused = await createBooking({ courtId: court.id, date: addDays(date, 1), hours: [20], name: "Cust", phone: phone() });
    expect(refused).toMatchObject({ ok: false, code: "HOURS_OUTSIDE_OPENING" });
  });

  it("an override is no way past a day closed meanwhile", async () => {
    const court = await newCourt();
    const date = addDays(todayISO(), 9);
    const pending = await held(() => createBooking({ courtId: court.id, date, hours: [18], name: "Staff", phone: phone(), staff: { override: true } }));
    expect((await closeVenueDay(venueId, date, "Wet")).ok).toBe(true);
    pending.release();
    expect(await pending.result).toMatchObject({ ok: false, code: "VENUE_CLOSED" });
    expect(await confirmedAt(court.id, date, at(18))).toBe(0);
  });
});

describe("a recurring booking and a change of hours for a later week", () => {
  it("the venue's hours changed from a later date: the week that falls under the change is not booked", async () => {
    await reopen();
    const court = await newCourt();
    const date = addDays(todayISO(), 4);
    const pending = await held(() => createBookingSeries({ courtId: court.id, date, hours: [20], weeks: 3, name: "Liga", phone: phone(), skipConflicts: true }));
    const change = await setHoursChange(venueId, { from: addDays(date, 7), openMin: at(8), closeMin: at(19) });
    expect(change.ok).toBe(true);
    pending.release();
    const made = await pending.result;
    if (!made.ok) throw new Error(made.error);
    expect(made.bookings.map((b) => b.date)).toEqual([date]);
    expect(made.skipped.map((s) => s.date)).toEqual([addDays(date, 7), addDays(date, 14)]);
    await getDb().prepare("DELETE FROM venue_hours_changes WHERE venue_id = ?").run(venueId);
  });

  it("the court's own hours changed from a later date, read from the court as it is now, not as it was when the booking was checked", async () => {
    const court = await newCourt();
    const date = addDays(todayISO(), 5);
    const pending = await held(() => createBookingSeries({ courtId: court.id, date, hours: [20], weeks: 2, name: "Liga", phone: phone(), skipConflicts: true }));
    const own = [0, 1, 2, 3, 4, 5, 6].map(() => ({ open: at(8), close: at(19) }));
    const change = await setCourtHoursChange((await getCourt(court.id))!, { from: addDays(date, 7), weekHours: own });
    expect(change.ok).toBe(true);
    pending.release();
    const made = await pending.result;
    if (!made.ok) throw new Error(made.error);
    expect(made.bookings.map((b) => b.date)).toEqual([date]);
    expect(made.skipped).toHaveLength(1);
  });
});

describe("a court's booking rules changed while a booking is being made", () => {
  it("a rule that now refuses the length is applied to the booking, which is refused", async () => {
    const court = await newCourt();
    const date = addDays(todayISO(), 6);
    const pending = await held(() => createBooking({ courtId: court.id, date, hours: [18, 19], name: "Two hours", phone: phone() }));
    expect(await updatePolicy({ court: court.id }, { maxLength: 60 })).toMatchObject({ ok: true });
    pending.release();
    expect(await pending.result).toMatchObject({ ok: false, code: "MAX_HOURS" });
    expect(await confirmedAt(court.id, date, at(18))).toBe(0);
  });

  it("the court's own narrower hours, saved where no booking stands yet, are applied to the booking made at the same moment", async () => {
    const court = await newCourt();
    const date = addDays(todayISO(), 6);
    const own = [0, 1, 2, 3, 4, 5, 6].map(() => ({ open: at(8), close: at(19) }));
    const pending = await held(() => createBooking({ courtId: court.id, date, hours: [20], name: "Late", phone: phone() }));
    expect(await updatePolicyKeepingBookings({ court: court.id }, { weekHours: own }, [venueId])).toMatchObject({ ok: true });
    pending.release();
    expect(await pending.result).toMatchObject({ ok: false, code: "HOURS_OUTSIDE_OPENING" });
    expect(await confirmedAt(court.id, date, at(20))).toBe(0);
  });

  it("and with a booking already standing, the same save is refused with the booking listed and nothing saved", async () => {
    const court = await newCourt();
    const date = addDays(todayISO(), 6);
    expect((await createBooking({ courtId: court.id, date, hours: [20], name: "First", phone: phone() })).ok).toBe(true);
    const own = [0, 1, 2, 3, 4, 5, 6].map(() => ({ open: at(8), close: at(19) }));
    const refused = await updatePolicyKeepingBookings({ court: court.id }, { weekHours: own }, [venueId]);
    expect(refused).toMatchObject({ ok: false, stranded: [{ date, startMin: at(20) }] });
    const second = await createBooking({ courtId: court.id, date: addDays(date, 1), hours: [20], name: "Second", phone: phone() });
    expect(second.ok).toBe(true);
  });
});

describe("a class move and a day closed or hours narrowed after it was planned", () => {
  it("is refused at the new time, and the class stays where it was", async () => {
    await reopen();
    const court = await newCourt("gym", 10);
    const classDate = addDays(todayISO(), 16);
    const created = await createClassSessions({ courtId: court.id, name: "Pilates", instructor: "Aina", date: classDate, startHour: 18, endHour: 19, capacity: 6, price: 20 });
    if (!created.ok) throw new Error(created.error);
    const session = created.classes[0];
    const enrolled = await enrolInClass({ classId: session.id, name: "Member", phone: phone() });
    if (!enrolled.ok) throw new Error(enrolled.error);
    const target = addDays(todayISO(), 18);
    const pending = await held(() => moveClasses({ id: null, name: "Mover" }, session.id, { date: target, start: at(20) }));
    expect((await closeVenueDay(venueId, target, "Closed")).ok).toBe(true);
    pending.release();
    const moved = await pending.result;
    expect(moved).toMatchObject({ ok: false, code: "VENUE_CLOSED" });
    const where = (await getDb().prepare("SELECT date, start_min FROM classes WHERE id = ?").get(session.id)) as { date: string; start_min: number };
    expect(where).toEqual({ date: classDate, start_min: at(18) });
  });

  it("narrowed hours at the new time refuse it the same way", async () => {
    const court = await newCourt("gym", 10);
    const classDate = addDays(todayISO(), 20);
    const created = await createClassSessions({ courtId: court.id, name: "Yoga", instructor: "Aina", date: classDate, startHour: 18, endHour: 19, capacity: 6, price: 20 });
    if (!created.ok) throw new Error(created.error);
    const session = created.classes[0];
    const enrolled = await enrolInClass({ classId: session.id, name: "Member", phone: phone() });
    if (!enrolled.ok) throw new Error(enrolled.error);
    const target = addDays(todayISO(), 21);
    const pending = await held(() => moveClasses({ id: null, name: "Mover" }, session.id, { date: target, start: at(20) }));
    expect((await narrow(19)).ok).toBe(true);
    pending.release();
    expect(await pending.result).toMatchObject({ ok: false, code: "CLSA_MOVE_HOURS" });
    await reopen();
  });
});

describe.skipIf(!postgres)("two connections at once (Postgres)", () => {
  it("hours narrowed while a booking commits: the narrowing is refused with the booking listed, or the booking is refused; never both stand", async () => {
    await reopen();
    const court = await newCourt();
    const date = addDays(todayISO(), 5);
    let edited!: () => void;
    const editReads = new Promise<void>((r) => (edited = r));
    let letEditGo!: () => void;
    const editMayWrite = new Promise<void>((r) => (letEditGo = r));
    const original = dated.strandedByHours;
    let first = true;
    const spy = vi.spyOn(dated, "strandedByHours").mockImplementation(async (...args: Parameters<typeof original>) => {
      const found = await original(...args);
      if (first) {
        first = false;
        edited();
        await editMayWrite;
      }
      return found;
    });
    try {
      // The edit has read what is booked (nothing) inside its transaction and is about to write; the booking commits in that gap.
      const edit = narrow(19);
      await editReads;
      const made = await createBooking({ courtId: court.id, date, hours: [20], name: "Gap", phone: phone() });
      expect(made.ok).toBe(true);
      letEditGo();
      const done = await edit;
      // The edit was run again on seeing the booking, and refused.
      expect(done.ok).toBe(false);
      expect(await confirmedAt(court.id, date, at(20))).toBe(1);
      expect(((await getDb().prepare("SELECT close_min FROM venues WHERE id = ?").get(venueId)) as { close_min: number }).close_min).toBe(at(23));
    } finally {
      spy.mockRestore();
    }
  });

  it("rounds of a narrowing and a booking together: afterwards no confirmed booking stands outside the hours", async () => {
    for (let round = 0; round < 8; round++) {
      await reopen();
      const court = await newCourt();
      const date = addDays(todayISO(), 3 + round);
      const [edit, made] = await Promise.all([narrow(19), createBooking({ courtId: court.id, date, hours: [20], name: "Race", phone: phone() })]);
      const closeNow = ((await getDb().prepare("SELECT close_min FROM venues WHERE id = ?").get(venueId)) as { close_min: number }).close_min;
      const stands = await confirmedAt(court.id, date, at(20));
      // Hours narrowed to 19:00 and a booking until 21:00 cannot both stand.
      expect(edit.ok && made.ok && closeNow === at(19) && stands === 1).toBe(false);
      if (edit.ok) expect(stands).toBe(0);
      else expect(closeNow).toBe(at(23));
    }
    await reopen();
  });
});
