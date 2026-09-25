import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import {
  accessCodeFor,
  adminCancelBooking,
  courtAccess,
  createBooking,
  createCourt,
  isInducted,
  listAccessReveals,
  listInductions,
  listVenues,
  recordInduction,
  revokeInduction,
  setPaymentStatus,
  updateCourt,
  updateVenue,
} from "../src/lib/store";
import { todayISO } from "../src/lib/time";
import { ACCESS_CODE_STALE_DAYS, isUnstaffedHour } from "../src/lib/types";

const VENUE = () => listVenues()[0];

let seq = 0;

function court(opts: { deposit?: number } = {}) {
  const created = createCourt({
    venueId: VENUE().id,
    name: `Night Court ${++seq}`,
    sport: "badminton",
    offPeakRate: 15,
    peakRate: 25,
    capacity: 1,
    deposit: opts.deposit ?? 0,
  });
  if (!created.ok) throw new Error(created.error);
  return created.court;
}

/** A court nobody staffs, with a code on the door. */
function unmannedCourt(code = "4821") {
  const made = court();
  const opened = updateCourt(made.id, { unmanned: true, accessCode: code });
  if (!opened.ok) throw new Error(opened.error);
  return opened.court;
}

/** Take the counter away entirely, which is the simplest unstaffed venue. */
function neverStaffed() {
  const done = updateVenue(VENUE().id, { staffedFrom: 0, staffedTo: 0 });
  if (!done.ok) throw new Error(done.error);
  return done.venue;
}

/** Somebody staff have shown round, which out-of-hours use depends on. */
function induct(phone: string, name = "Player") {
  const done = recordInduction({ venueId: VENUE().id, phone, name });
  if (!done.ok) throw new Error(done.error);
  return done.induction;
}

function bookRunningNow(courtId: number, phone: string, hour = 12) {
  vi.useRealTimers();
  const date = todayISO();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${date}T${String(hour - 1).padStart(2, "0")}:30:00+08:00`));
  const booking = createBooking({ courtId, date, hours: [hour], name: "Player", phone });
  vi.setSystemTime(new Date(`${date}T${String(hour).padStart(2, "0")}:15:00+08:00`));
  if (!booking.ok) throw new Error(booking.error);
  return booking.booking;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("setting a resource unmanned", () => {
  it("stores the code staff programmed and stamps when it changed", () => {
    const open = unmannedCourt("9137");
    expect(open.unmanned).toBe(true);
    const access = courtAccess(open.id);
    expect(access.code).toBe("9137");
    expect(access.changedAt).not.toBeNull();
    expect(access.stale).toBe(false);
  });

  it("keeps the code out of the court object, which is served publicly", () => {
    const open = unmannedCourt("5150");
    expect(JSON.stringify(open)).not.toContain("5150");
    const fromList = listVenues()
      .flatMap((v) => v.courts)
      .find((c) => c.id === open.id)!;
    expect(JSON.stringify(fromList)).not.toContain("5150");
    expect(fromList.unmanned).toBe(true);
  });

  it("refuses an unmanned resource with no code", () => {
    const made = court();
    const bad = updateCourt(made.id, { unmanned: true });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("needs a door code");
  });

  it("refuses a code that is too short, too long or full of punctuation", () => {
    const made = court();
    expect(updateCourt(made.id, { accessCode: "12" }).ok).toBe(false);
    expect(updateCourt(made.id, { accessCode: "1234567890123" }).ok).toBe(false);
    expect(updateCourt(made.id, { accessCode: "12 34" }).ok).toBe(false);
    expect(updateCourt(made.id, { accessCode: "1234" }).ok).toBe(true);
  });

  it("will not leave a resource unmanned once its code is cleared", () => {
    const open = unmannedCourt();
    const cleared = updateCourt(open.id, { accessCode: null });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.court.unmanned).toBe(false);
    expect(courtAccess(open.id).code).toBeNull();
  });

  it("refuses to leave anything hired out against a deposit unmanned", () => {
    const fleet = court({ deposit: 50 });
    const bad = updateCourt(fleet.id, { unmanned: true, accessCode: "4321" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("someone at the counter");

    // And the other way round: no putting a deposit on an unmanned resource.
    const open = unmannedCourt();
    const alsoBad = updateCourt(open.id, { deposit: 50 });
    expect(alsoBad.ok).toBe(false);
  });

  it("only restarts the staleness clock when the code actually changes", () => {
    const open = unmannedCourt("1111");
    const first = courtAccess(open.id).changedAt;
    updateCourt(open.id, { accessCode: "1111", name: "Renamed Court" });
    expect(courtAccess(open.id).changedAt).toBe(first);
  });

  it("calls a code stale once it has gone unchanged too long", () => {
    const open = unmannedCourt("2222");
    expect(courtAccess(open.id).stale).toBe(false);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + (ACCESS_CODE_STALE_DAYS + 1) * 86_400_000));
    expect(courtAccess(open.id).stale).toBe(true);
  });
});

describe("being let in", () => {
  // The whole venue runs without a counter, which is the plainest case.
  beforeEach(() => {
    neverStaffed();
  });

  it("gives a paid customer the code inside their hour, and checks them in", () => {
    const open = unmannedCourt("7788");
    const booking = bookRunningNow(open.id, "0160000001");
    induct("0160000001");
    setPaymentStatus(booking.code, true);

    const got = accessCodeFor(booking.code, "0160000001");
    expect(got).not.toBeNull();
    expect(got!.ok).toBe(true);
    if (!got!.ok) return;
    expect(got!.accessCode).toBe("7788");
    expect(got!.courtName).toBe(open.name);

    // Opening the door is the arrival, so nobody has to press check in.
    const reveals = listAccessReveals(VENUE().id);
    expect(reveals[0].bookingCode).toBe(booking.code);
    expect(reveals[0].name).toBe("Player");
  });

  it("withholds it until the booking is paid", () => {
    const open = unmannedCourt();
    const booking = bookRunningNow(open.id, "0160000002");
    induct("0160000002");

    const before = accessCodeFor(booking.code, "0160000002")!;
    expect(before.ok).toBe(false);
    if (!before.ok) {
      expect(before.reason).toBe("unpaid");
      expect(before.message).toContain("Nobody is on site");
    }

    setPaymentStatus(booking.code, true);
    expect(accessCodeFor(booking.code, "0160000002")!.ok).toBe(true);
  });

  it("withholds it before the slot and after it ends", () => {
    vi.useRealTimers();
    const open = unmannedCourt();
    const booking = bookRunningNow(open.id, "0160000003", 14);
    induct("0160000003");
    setPaymentStatus(booking.code, true);
    const date = booking.date;

    vi.setSystemTime(new Date(`${date}T08:00:00+08:00`));
    const early = accessCodeFor(booking.code, "0160000003")!;
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toBe("too-early");

    vi.setSystemTime(new Date(`${date}T18:00:00+08:00`));
    const late = accessCodeFor(booking.code, "0160000003")!;
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.reason).toBe("over");
  });

  it("withholds it from a cancelled booking", () => {
    const open = unmannedCourt();
    const booking = bookRunningNow(open.id, "0160000004");
    induct("0160000004");
    setPaymentStatus(booking.code, true);
    adminCancelBooking(booking.code);

    const got = accessCodeFor(booking.code, "0160000004")!;
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe("cancelled");
  });

  it("says plainly that a staffed court has no code", () => {
    const staffed = court();
    const booking = bookRunningNow(staffed.id, "0160000005");
    induct("0160000005");
    setPaymentStatus(booking.code, true);

    const got = accessCodeFor(booking.code, "0160000005")!;
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.reason).toBe("not-unmanned");
      expect(got.message).toContain("let you in");
    }
  });

  it("needs the right phone number, and nothing else", () => {
    const open = unmannedCourt();
    const booking = bookRunningNow(open.id, "0160000006");
    induct("0160000006");
    setPaymentStatus(booking.code, true);

    expect(accessCodeFor(booking.code, "0169999999")).toBeNull();
    expect(accessCodeFor("MS-NOSUCH", "0160000006")).toBeNull();
    // The booking code is not case-sensitive, the way it is read off a phone.
    expect(accessCodeFor(booking.code.toLowerCase(), "0160000006")!.ok).toBe(true);
  });

  it("logs every look, not just the first", () => {
    const open = unmannedCourt();
    const booking = bookRunningNow(open.id, "0160000007");
    induct("0160000007");
    setPaymentStatus(booking.code, true);

    accessCodeFor(booking.code, "0160000007");
    accessCodeFor(booking.code, "0160000007");
    accessCodeFor(booking.code, "0160000007");

    const mine = listAccessReveals(VENUE().id).filter((r) => r.bookingCode === booking.code);
    expect(mine).toHaveLength(3);
  });

  it("logs nothing when the code is withheld", () => {
    const open = unmannedCourt();
    const booking = bookRunningNow(open.id, "0160000008");
    induct("0160000008");
    accessCodeFor(booking.code, "0160000008");
    expect(listAccessReveals(VENUE().id).filter((r) => r.bookingCode === booking.code)).toHaveLength(0);
  });
});

describe("staffed hours", () => {
  it("reads a plain window, a wrapping one, always and never", () => {
    const always = { staffedFrom: null, staffedTo: null };
    expect(isUnstaffedHour(always, 3)).toBe(false);
    expect(isUnstaffedHour(always, 14)).toBe(false);

    const never = { staffedFrom: 9, staffedTo: 9 };
    expect(isUnstaffedHour(never, 9)).toBe(true);
    expect(isUnstaffedHour(never, 22)).toBe(true);

    // Counter open 9am to 6pm.
    const daytime = { staffedFrom: 9, staffedTo: 18 };
    expect(isUnstaffedHour(daytime, 8)).toBe(true);
    expect(isUnstaffedHour(daytime, 9)).toBe(false);
    expect(isUnstaffedHour(daytime, 17)).toBe(false);
    expect(isUnstaffedHour(daytime, 18)).toBe(true);

    // A counter that opens in the evening and closes after midnight.
    const overnight = { staffedFrom: 22, staffedTo: 6 };
    expect(isUnstaffedHour(overnight, 23)).toBe(false);
    expect(isUnstaffedHour(overnight, 2)).toBe(false);
    expect(isUnstaffedHour(overnight, 12)).toBe(true);
  });

  it("sends the customer to the counter during staffed hours", () => {
    const open = unmannedCourt();
    const booking = bookRunningNow(open.id, "0161000001", 12);
    induct("0161000001");
    setPaymentStatus(booking.code, true);

    // Staffed right across the booked hour.
    const staffed = updateVenue(VENUE().id, { staffedFrom: 8, staffedTo: 20 });
    expect(staffed.ok).toBe(true);
    const denied = accessCodeFor(booking.code, "0161000001")!;
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.reason).toBe("staffed-now");
      expect(denied.message).toContain("counter");
    }

    // The same booking, once the counter has shut for the evening.
    updateVenue(VENUE().id, { staffedFrom: 8, staffedTo: 11 });
    expect(accessCodeFor(booking.code, "0161000001")!.ok).toBe(true);
  });

  it("wants both ends of the window or neither", () => {
    // From a venue with no window set, half a window is not a window.
    updateVenue(VENUE().id, { staffedFrom: null, staffedTo: null });
    const half = updateVenue(VENUE().id, { staffedFrom: 9 });
    expect(half.ok).toBe(false);
    if (!half.ok) expect(half.error).toContain("both ends");
    expect(updateVenue(VENUE().id, { staffedFrom: 9, staffedTo: 18 }).ok).toBe(true);
    expect(updateVenue(VENUE().id, { staffedFrom: null, staffedTo: null }).ok).toBe(true);
  });
});

describe("inductions", () => {
  beforeEach(() => {
    neverStaffed();
  });

  it("refuses the code to somebody staff have never met", () => {
    const open = unmannedCourt();
    const booking = bookRunningNow(open.id, "0162000001");
    setPaymentStatus(booking.code, true);

    const denied = accessCodeFor(booking.code, "0162000001")!;
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.reason).toBe("no-induction");
      expect(denied.message).toContain("run-through at the desk");
    }

    induct("0162000001");
    expect(accessCodeFor(booking.code, "0162000001")!.ok).toBe(true);
  });

  it("matches the person however they wrote their number", () => {
    induct("012-345 6789", "Aminah");
    expect(isInducted(VENUE().id, "+60 12-345 6789")).toBe(true);
    expect(isInducted(VENUE().id, "0123456789")).toBe(true);
    expect(isInducted(VENUE().id, "0129999999")).toBe(false);
  });

  it("keeps one line per person, and revives it rather than duplicating", () => {
    const first = induct("0162000002", "Ravi");
    expect(recordInduction({ venueId: VENUE().id, phone: "0162000002", name: "Ravi" }).ok).toBe(
      false
    );

    expect(revokeInduction(first.id).ok).toBe(true);
    expect(isInducted(VENUE().id, "0162000002")).toBe(false);
    expect(revokeInduction(first.id).ok).toBe(false);

    const again = induct("0162000002", "Ravi");
    expect(again.id).toBe(first.id);
    expect(again.revokedAt).toBeNull();
    expect(
      listInductions(VENUE().id).filter((i) => i.phone === "0162000002")
    ).toHaveLength(1);
  });

  it("shuts the door again the moment access is withdrawn", () => {
    const open = unmannedCourt();
    const booking = bookRunningNow(open.id, "0162000003");
    const record = induct("0162000003");
    setPaymentStatus(booking.code, true);
    expect(accessCodeFor(booking.code, "0162000003")!.ok).toBe(true);

    revokeInduction(record.id);
    const denied = accessCodeFor(booking.code, "0162000003")!;
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("no-induction");
  });

  it("is per venue, not per platform", () => {
    induct("0162000004", "Chong");
    const other = listVenues().find((v) => v.id !== VENUE().id)!;
    expect(isInducted(other.id, "0162000004")).toBe(false);
  });
});

describe("what the door screen carries", () => {
  beforeEach(() => {
    neverStaffed();
  });

  it("hands over the emergency details and says who else is inside", () => {
    updateVenue(VENUE().id, {
      emergencyPhone: "+60 12-999 0000",
      emergencyInfo: "AED on the wall by the main door.",
    });
    const open = unmannedCourt();
    const booking = bookRunningNow(open.id, "0163000001");
    induct("0163000001");
    setPaymentStatus(booking.code, true);

    const got = accessCodeFor(booking.code, "0163000001")!;
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.emergencyPhone).toBe("+60 12-999 0000");
    expect(got.emergencyInfo).toContain("AED");
    // They are counted, so being on your own reads as one rather than none.
    expect(got.presentNow).toBeGreaterThanOrEqual(1);
  });
});

describe("what can never run itself", () => {
  it("refuses to leave a pool unmanned", () => {
    const pool = createCourt({
      venueId: VENUE().id,
      name: "Lap Pool (test)",
      sport: "swimming",
      offPeakRate: 4,
      peakRate: 6,
      capacity: 10,
    });
    if (!pool.ok) throw new Error(pool.error);

    const bad = updateCourt(pool.court.id, { unmanned: true, accessCode: "1234" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("watching the water");
  });
});
