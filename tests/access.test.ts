import { afterEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import {
  accessCodeFor,
  adminCancelBooking,
  courtAccess,
  createBooking,
  createCourt,
  listAccessReveals,
  listVenues,
  setPaymentStatus,
  updateCourt,
} from "../src/lib/store";
import { todayISO } from "../src/lib/time";
import { ACCESS_CODE_STALE_DAYS } from "../src/lib/types";

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
  it("gives a paid customer the code inside their hour, and checks them in", () => {
    const open = unmannedCourt("7788");
    const booking = bookRunningNow(open.id, "0160000001");
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
    setPaymentStatus(booking.code, true);
    adminCancelBooking(booking.code);

    const got = accessCodeFor(booking.code, "0160000004")!;
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe("cancelled");
  });

  it("says plainly that a staffed court has no code", () => {
    const staffed = court();
    const booking = bookRunningNow(staffed.id, "0160000005");
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
    setPaymentStatus(booking.code, true);

    expect(accessCodeFor(booking.code, "0169999999")).toBeNull();
    expect(accessCodeFor("MS-NOSUCH", "0160000006")).toBeNull();
    // The booking code is not case-sensitive, the way it is read off a phone.
    expect(accessCodeFor(booking.code.toLowerCase(), "0160000006")!.ok).toBe(true);
  });

  it("logs every look, not just the first", () => {
    const open = unmannedCourt();
    const booking = bookRunningNow(open.id, "0160000007");
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
    accessCodeFor(booking.code, "0160000008");
    expect(listAccessReveals(VENUE().id).filter((r) => r.bookingCode === booking.code)).toHaveLength(0);
  });
});
