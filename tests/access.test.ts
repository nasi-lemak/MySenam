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

const VENUE = async () => (await listVenues())[0];

let seq = 0;

async function court(opts: { deposit?: number } = {}) {
  const created = await createCourt({
    venueId: (await VENUE()).id,
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
async function unmannedCourt(code = "4821") {
  const made = await court();
  const opened = await updateCourt(made.id, { unmanned: true, accessCode: code });
  if (!opened.ok) throw new Error(opened.error);
  return opened.court;
}

/** Take the counter away entirely, which is the simplest unstaffed venue. */
async function neverStaffed() {
  const done = await updateVenue((await VENUE()).id, { staffedFrom: 0, staffedTo: 0 });
  if (!done.ok) throw new Error(done.error);
  return done.venue;
}

/** Somebody staff have shown round, which out-of-hours use depends on. */
async function induct(phone: string, name = "Player") {
  const done = await recordInduction({ venueId: (await VENUE()).id, phone, name });
  if (!done.ok) throw new Error(done.error);
  return done.induction;
}

async function bookRunningNow(courtId: number, phone: string, hour = 12) {
  vi.useRealTimers();
  const date = todayISO();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${date}T${String(hour - 1).padStart(2, "0")}:30:00+08:00`));
  const booking = await createBooking({ courtId, date, hours: [hour], name: "Player", phone });
  vi.setSystemTime(new Date(`${date}T${String(hour).padStart(2, "0")}:15:00+08:00`));
  if (!booking.ok) throw new Error(booking.error);
  return booking.booking;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("setting a resource unmanned", () => {
  it("stores the code staff programmed and stamps when it changed", async () => {
    const open = await unmannedCourt("9137");
    expect(open.unmanned).toBe(true);
    const access = await courtAccess(open.id);
    expect(access.code).toBe("9137");
    expect(access.changedAt).not.toBeNull();
    expect(access.stale).toBe(false);
  });

  it("keeps the code out of the court object, which is served publicly", async () => {
    const open = await unmannedCourt("5150");
    expect(JSON.stringify(open)).not.toContain("5150");
    const fromList = (await listVenues())
      .flatMap((v) => v.courts)
      .find((c) => c.id === open.id)!;
    expect(JSON.stringify(fromList)).not.toContain("5150");
    expect(fromList.unmanned).toBe(true);
  });

  it("refuses an unmanned resource with no code", async () => {
    const made = await court();
    const bad = await updateCourt(made.id, { unmanned: true });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("needs a door code");
  });

  it("refuses a code that is too short, too long or full of punctuation", async () => {
    const made = await court();
    expect((await updateCourt(made.id, { accessCode: "12" })).ok).toBe(false);
    expect((await updateCourt(made.id, { accessCode: "1234567890123" })).ok).toBe(false);
    expect((await updateCourt(made.id, { accessCode: "12 34" })).ok).toBe(false);
    expect((await updateCourt(made.id, { accessCode: "1234" })).ok).toBe(true);
  });

  it("will not leave a resource unmanned once its code is cleared", async () => {
    const open = await unmannedCourt();
    const cleared = await updateCourt(open.id, { accessCode: null });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.court.unmanned).toBe(false);
    expect((await courtAccess(open.id)).code).toBeNull();
  });

  it("refuses to leave anything hired out against a deposit unmanned", async () => {
    const fleet = await court({ deposit: 50 });
    const bad = await updateCourt(fleet.id, { unmanned: true, accessCode: "4321" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("someone at the counter");

    // And the other way round: no putting a deposit on an unmanned resource.
    const open = await unmannedCourt();
    const alsoBad = await updateCourt(open.id, { deposit: 50 });
    expect(alsoBad.ok).toBe(false);
  });

  it("only restarts the staleness clock when the code actually changes", async () => {
    const open = await unmannedCourt("1111");
    const first = (await courtAccess(open.id)).changedAt;
    await updateCourt(open.id, { accessCode: "1111", name: "Renamed Court" });
    expect((await courtAccess(open.id)).changedAt).toBe(first);
  });

  it("calls a code stale once it has gone unchanged too long", async () => {
    const open = await unmannedCourt("2222");
    expect((await courtAccess(open.id)).stale).toBe(false);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + (ACCESS_CODE_STALE_DAYS + 1) * 86_400_000));
    expect((await courtAccess(open.id)).stale).toBe(true);
  });
});

describe("being let in", () => {
  // The whole venue runs without a counter, which is the plainest case.
  beforeEach(async () => {
    await neverStaffed();
  });

  it("gives a paid customer the code inside their hour, and checks them in", async () => {
    const open = await unmannedCourt("7788");
    const booking = await bookRunningNow(open.id, "0160000001");
    await induct("0160000001");
    await setPaymentStatus(booking.code, true);

    const got = await accessCodeFor(booking.code, "0160000001");
    expect(got).not.toBeNull();
    expect(got!.ok).toBe(true);
    if (!got!.ok) return;
    expect(got!.accessCode).toBe("7788");
    expect(got!.courtName).toBe(open.name);

    // Opening the door is the arrival, so nobody has to press check in.
    const reveals = await listAccessReveals((await VENUE()).id);
    expect(reveals[0].bookingCode).toBe(booking.code);
    expect(reveals[0].name).toBe("Player");
  });

  it("withholds it until the booking is paid", async () => {
    const open = await unmannedCourt();
    const booking = await bookRunningNow(open.id, "0160000002");
    await induct("0160000002");

    const before = (await accessCodeFor(booking.code, "0160000002"))!;
    expect(before.ok).toBe(false);
    if (!before.ok) {
      expect(before.reason).toBe("unpaid");
      expect(before.message).toContain("Nobody is on site");
    }

    await setPaymentStatus(booking.code, true);
    expect((await accessCodeFor(booking.code, "0160000002"))!.ok).toBe(true);
  });

  it("withholds it before the slot and after it ends", async () => {
    vi.useRealTimers();
    const open = await unmannedCourt();
    const booking = await bookRunningNow(open.id, "0160000003", 14);
    await induct("0160000003");
    await setPaymentStatus(booking.code, true);
    const date = booking.date;

    vi.setSystemTime(new Date(`${date}T08:00:00+08:00`));
    const early = (await accessCodeFor(booking.code, "0160000003"))!;
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toBe("too-early");

    vi.setSystemTime(new Date(`${date}T18:00:00+08:00`));
    const late = (await accessCodeFor(booking.code, "0160000003"))!;
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.reason).toBe("over");
  });

  it("withholds it from a cancelled booking", async () => {
    const open = await unmannedCourt();
    const booking = await bookRunningNow(open.id, "0160000004");
    await induct("0160000004");
    await setPaymentStatus(booking.code, true);
    await adminCancelBooking(booking.code);

    const got = (await accessCodeFor(booking.code, "0160000004"))!;
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe("cancelled");
  });

  it("says plainly that a staffed court has no code", async () => {
    const staffed = await court();
    const booking = await bookRunningNow(staffed.id, "0160000005");
    await induct("0160000005");
    await setPaymentStatus(booking.code, true);

    const got = (await accessCodeFor(booking.code, "0160000005"))!;
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.reason).toBe("not-unmanned");
      expect(got.message).toContain("let you in");
    }
  });

  it("needs the right phone number, and nothing else", async () => {
    const open = await unmannedCourt();
    const booking = await bookRunningNow(open.id, "0160000006");
    await induct("0160000006");
    await setPaymentStatus(booking.code, true);

    expect(await accessCodeFor(booking.code, "0169999999")).toBeNull();
    expect(await accessCodeFor("MS-NOSUCH", "0160000006")).toBeNull();
    // The booking code is not case-sensitive, the way it is read off a phone.
    expect((await accessCodeFor(booking.code.toLowerCase(), "0160000006"))!.ok).toBe(true);
  });

  it("logs every look, not just the first", async () => {
    const open = await unmannedCourt();
    const booking = await bookRunningNow(open.id, "0160000007");
    await induct("0160000007");
    await setPaymentStatus(booking.code, true);

    await accessCodeFor(booking.code, "0160000007");
    await accessCodeFor(booking.code, "0160000007");
    await accessCodeFor(booking.code, "0160000007");

    const mine = (await listAccessReveals((await VENUE()).id)).filter((r) => r.bookingCode === booking.code);
    expect(mine).toHaveLength(3);
  });

  it("logs nothing when the code is withheld", async () => {
    const open = await unmannedCourt();
    const booking = await bookRunningNow(open.id, "0160000008");
    await induct("0160000008");
    await accessCodeFor(booking.code, "0160000008");
    expect((await listAccessReveals((await VENUE()).id)).filter((r) => r.bookingCode === booking.code)).toHaveLength(0);
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

  it("sends the customer to the counter during staffed hours", async () => {
    const open = await unmannedCourt();
    const booking = await bookRunningNow(open.id, "0161000001", 12);
    await induct("0161000001");
    await setPaymentStatus(booking.code, true);

    // Staffed right across the booked hour.
    const staffed = await updateVenue((await VENUE()).id, { staffedFrom: 8, staffedTo: 20 });
    expect(staffed.ok).toBe(true);
    const denied = (await accessCodeFor(booking.code, "0161000001"))!;
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.reason).toBe("staffed-now");
      expect(denied.message).toContain("counter");
    }

    // The same booking, once the counter has shut for the evening.
    await updateVenue((await VENUE()).id, { staffedFrom: 8, staffedTo: 11 });
    expect((await accessCodeFor(booking.code, "0161000001"))!.ok).toBe(true);
  });

  it("wants both ends of the window or neither", async () => {
    // From a venue with no window set, half a window is not a window.
    await updateVenue((await VENUE()).id, { staffedFrom: null, staffedTo: null });
    const half = await updateVenue((await VENUE()).id, { staffedFrom: 9 });
    expect(half.ok).toBe(false);
    if (!half.ok) expect(half.error).toContain("both ends");
    expect((await updateVenue((await VENUE()).id, { staffedFrom: 9, staffedTo: 18 })).ok).toBe(true);
    expect((await updateVenue((await VENUE()).id, { staffedFrom: null, staffedTo: null })).ok).toBe(true);
  });
});

describe("inductions", () => {
  beforeEach(async () => {
    await neverStaffed();
  });

  it("refuses the code to somebody staff have never met", async () => {
    const open = await unmannedCourt();
    const booking = await bookRunningNow(open.id, "0162000001");
    await setPaymentStatus(booking.code, true);

    const denied = (await accessCodeFor(booking.code, "0162000001"))!;
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.reason).toBe("no-induction");
      expect(denied.message).toContain("run-through at the desk");
    }

    await induct("0162000001");
    expect((await accessCodeFor(booking.code, "0162000001"))!.ok).toBe(true);
  });

  it("matches the person however they wrote their number", async () => {
    await induct("012-345 6789", "Aminah");
    expect(await isInducted((await VENUE()).id, "+60 12-345 6789")).toBe(true);
    expect(await isInducted((await VENUE()).id, "0123456789")).toBe(true);
    expect(await isInducted((await VENUE()).id, "0129999999")).toBe(false);
  });

  it("keeps one line per person, and revives it rather than duplicating", async () => {
    const first = await induct("0162000002", "Ravi");
    expect((await recordInduction({ venueId: (await VENUE()).id, phone: "0162000002", name: "Ravi" })).ok).toBe(
      false
    );

    expect((await revokeInduction(first.id)).ok).toBe(true);
    expect(await isInducted((await VENUE()).id, "0162000002")).toBe(false);
    expect((await revokeInduction(first.id)).ok).toBe(false);

    const again = await induct("0162000002", "Ravi");
    expect(again.id).toBe(first.id);
    expect(again.revokedAt).toBeNull();
    expect(
      (await listInductions((await VENUE()).id)).filter((i) => i.phone === "0162000002")
    ).toHaveLength(1);
  });

  it("shuts the door again the moment access is withdrawn", async () => {
    const open = await unmannedCourt();
    const booking = await bookRunningNow(open.id, "0162000003");
    const record = await induct("0162000003");
    await setPaymentStatus(booking.code, true);
    expect((await accessCodeFor(booking.code, "0162000003"))!.ok).toBe(true);

    await revokeInduction(record.id);
    const denied = (await accessCodeFor(booking.code, "0162000003"))!;
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe("no-induction");
  });

  it("is per venue, not per platform", async () => {
    await induct("0162000004", "Chong");
    const here = (await VENUE()).id;
    const other = (await listVenues()).find((v) => v.id !== here)!;
    expect(await isInducted(other.id, "0162000004")).toBe(false);
  });
});

describe("what the door screen carries", () => {
  beforeEach(async () => {
    await neverStaffed();
  });

  it("hands over the emergency details and says who else is inside", async () => {
    await updateVenue((await VENUE()).id, {
      emergencyPhone: "+60 12-999 0000",
      emergencyInfo: "AED on the wall by the main door.",
    });
    const open = await unmannedCourt();
    const booking = await bookRunningNow(open.id, "0163000001");
    await induct("0163000001");
    await setPaymentStatus(booking.code, true);

    const got = (await accessCodeFor(booking.code, "0163000001"))!;
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.emergencyPhone).toBe("+60 12-999 0000");
    expect(got.emergencyInfo).toContain("AED");
    // They are counted, so being on your own reads as one rather than none.
    expect(got.presentNow).toBeGreaterThanOrEqual(1);
  });
});

describe("what can never run itself", () => {
  it("refuses to leave a pool unmanned", async () => {
    const pool = await createCourt({
      venueId: (await VENUE()).id,
      name: "Lap Pool (test)",
      sport: "swimming",
      offPeakRate: 4,
      peakRate: 6,
      capacity: 10,
    });
    if (!pool.ok) throw new Error(pool.error);

    const bad = await updateCourt(pool.court.id, { unmanned: true, accessCode: "1234" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("watching the water");
  });
});
