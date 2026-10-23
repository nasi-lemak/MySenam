import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import {
  adminCancelBooking,
  blockSlots,
  cancelBooking,
  cancelSeries,
  createBooking,
  createBookingSeries,
  findBooking,
  createCourt,
  getAvailability,
  listBookingsForDate,
  countNoShows,
  listAreas,
  listVenues,
  setNoShow,
  updateVenue,
  getVenue,
  paySeries,
  searchAvailability,
  setPaymentStatus,
  unblockSlots,
  updateCourt,
} from "../src/lib/store";
import { getDb } from "../src/lib/db";
import { addDays, isPeakMinute, todayISO } from "../src/lib/time";
import { MAX_HOURS_PER_BOOKING } from "../src/lib/types";

const PHONE = "0123456789";

function futureDate(offset = 3): string {
  return addDays(todayISO(), offset);
}

function expectedPrice(
  court: { offPeakRate: number; peakRate: number },
  date: string,
  hours: number[]
): number {
  return hours.reduce(
    (sum, h) => sum + (isPeakMinute(date, h * 60) ? court.peakRate : court.offPeakRate),
    0
  );
}

describe("seed data", () => {
  it("creates venues that all have something bookable", async () => {
    const venues = await listVenues();
    expect(venues.length).toBeGreaterThanOrEqual(3);
    for (const venue of venues) expect(venue.courts.length).toBeGreaterThan(0);
  });

  it("includes a shared resource and one that goes out on a deposit", async () => {
    const courts = (await listVenues()).flatMap((v) => v.courts);
    expect(courts.some((c) => c.capacity > 1)).toBe(true);
    expect(courts.some((c) => c.deposit > 0)).toBe(true);
    // A court stays put, so nothing exclusive should carry a deposit.
    expect(courts.filter((c) => c.deposit > 0).every((c) => c.sport === "kayak")).toBe(true);
  });
});

describe("createBooking", () => {
  it("books consecutive hours and computes the price server-side", async () => {
    const court = (await listVenues())[0].courts[0];
    const date = futureDate(3);
    const result = await createBooking({
      courtId: court.id,
      date,
      hours: [10, 11],
      name: "Test User",
      phone: PHONE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.booking.code).toMatch(/^MS-[A-Z2-9]{6}$/);
    expect(result.booking.startHour).toBe(10);
    expect(result.booking.endHour).toBe(12);
    expect(result.booking.totalPrice).toBe(expectedPrice(court, date, [10, 11]));
    expect(result.booking.seriesCode).toBeNull();
  });

  it("charges peak rate on weekends and weekday evenings", async () => {
    const court = (await listVenues())[0].courts[1];
    // find a weekend day and a weekday within the window
    let weekend = "";
    let weekday = "";
    for (let i = 1; i <= 7; i++) {
      const d = futureDate(i);
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      if ((dow === 0 || dow === 6) && !weekend) weekend = d;
      if (dow >= 1 && dow <= 5 && !weekday) weekday = d;
    }
    const wk = await createBooking({ courtId: court.id, date: weekend, hours: [10], name: "AB", phone: PHONE });
    expect(wk.ok && wk.booking.totalPrice).toBe(court.peakRate);
    const wdMorning = await createBooking({ courtId: court.id, date: weekday, hours: [10], name: "AB", phone: PHONE });
    expect(wdMorning.ok && wdMorning.booking.totalPrice).toBe(court.offPeakRate);
    const wdEvening = await createBooking({ courtId: court.id, date: weekday, hours: [20], name: "AB", phone: PHONE });
    expect(wdEvening.ok && wdEvening.booking.totalPrice).toBe(court.peakRate);
  });

  it("rejects invalid selections", async () => {
    const court = (await listVenues())[0].courts[2];
    const date = futureDate(4);
    const base = { courtId: court.id, date, name: "Test", phone: PHONE };

    expect(await createBooking({ ...base, hours: [] })).toMatchObject({ ok: false });
    expect(await createBooking({ ...base, hours: [10, 12] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("consecutive"),
    });
    expect(
      await createBooking({ ...base, hours: Array.from({ length: MAX_HOURS_PER_BOOKING + 1 }, (_, i) => 10 + i) })
    ).toMatchObject({ ok: false, error: expect.stringContaining("Maximum") });
    expect(await createBooking({ ...base, hours: [7] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("operating hours"),
    });
    expect(await createBooking({ ...base, hours: [23] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("operating hours"),
    });
    expect(
      await createBooking({ ...base, date: addDays(todayISO(), -1), hours: [10] })
    ).toMatchObject({ ok: false, error: expect.stringContaining("window") });
    expect(
      await createBooking({ ...base, date: addDays(todayISO(), 30), hours: [10] })
    ).toMatchObject({ ok: false, error: expect.stringContaining("window") });
    expect(await createBooking({ ...base, courtId: 9999, hours: [10] })).toMatchObject({
      ok: false,
      error: "Court not found.",
    });
  });

  it("prevents double-booking of any overlapping hour", async () => {
    const court = (await listVenues())[1].courts[0];
    const date = futureDate(5);
    const first = await createBooking({ courtId: court.id, date, hours: [14, 15], name: "A", phone: PHONE });
    expect(first.ok).toBe(true);
    const overlap = await createBooking({ courtId: court.id, date, hours: [15, 16], name: "B", phone: "0111111111" });
    expect(overlap).toMatchObject({ ok: false, error: expect.stringContaining("booked") });
    // adjacent hours still fine
    const adjacent = await createBooking({ courtId: court.id, date, hours: [16], name: "C", phone: "0122222222" });
    expect(adjacent.ok).toBe(true);
  });
});

describe("availability", () => {
  it("marks booked and blocked slots unavailable", async () => {
    const venue = (await listVenues())[2];
    const court = venue.courts[0];
    const date = futureDate(6);
    await createBooking({ courtId: court.id, date, hours: [12], name: "A", phone: PHONE });
    await blockSlots(court.id, date, [13], "maintenance");

    const grid = (await getAvailability(venue.id, date)).find((a) => a.court.id === court.id)!;
    const byHour = Object.fromEntries(grid.slots.map((s) => [s.hour, s.available]));
    expect(byHour[12]).toBe(false);
    expect(byHour[13]).toBe(false);
    expect(byHour[14]).toBe(true);
    await unblockSlots(court.id, date, [13]);
  });
});

describe("cancellation", () => {
  it("cancels with matching code+phone and frees the slots", async () => {
    const court = (await listVenues())[0].courts[3];
    const date = futureDate(7);
    const created = await createBooking({ courtId: court.id, date, hours: [10], name: "A", phone: PHONE });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(await cancelBooking(created.booking.code, "0999999999")).toMatchObject({ ok: false });
    const cancelled = await cancelBooking(created.booking.code, PHONE);
    expect(cancelled).toMatchObject({ ok: true, booking: { status: "cancelled" } });
    expect(await cancelBooking(created.booking.code, PHONE)).toMatchObject({
      ok: false,
      error: expect.stringContaining("already cancelled"),
    });
    // slot is free again
    const rebook = await createBooking({ courtId: court.id, date, hours: [10], name: "B", phone: PHONE });
    expect(rebook.ok).toBe(true);
  });

  it("admin cancel works without a phone and shows up in the day list", async () => {
    const court = (await listVenues())[0].courts[0];
    const date = futureDate(8);
    const created = await createBooking({ courtId: court.id, date, hours: [9], name: "A", phone: PHONE });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(await adminCancelBooking(created.booking.code)).toMatchObject({ ok: true });
    const rows = await listBookingsForDate(date);
    expect(rows.find((r) => r.code === created.booking.code)?.status).toBe("cancelled");
  });
});

describe("slot blocks", () => {
  it("blocks free hours, refuses booking them, and never covers booked hours", async () => {
    const court = (await listVenues())[1].courts[1];
    const date = futureDate(9);
    await createBooking({ courtId: court.id, date, hours: [10], name: "A", phone: PHONE });

    const blocked = await blockSlots(court.id, date, [10, 11], "resurfacing");
    expect(blocked).toMatchObject({ ok: true, changed: 1 }); // hour 10 is booked, only 11 blocks

    const attempt = await createBooking({ courtId: court.id, date, hours: [11], name: "B", phone: PHONE });
    expect(attempt).toMatchObject({ ok: false, error: expect.stringContaining("maintenance") });

    expect(await unblockSlots(court.id, date, [11])).toMatchObject({ ok: true, changed: 1 });
    expect((await createBooking({ courtId: court.id, date, hours: [11], name: "B", phone: PHONE })).ok).toBe(true);
  });
});

describe("recurring series", () => {
  it("books the same slot weekly with one series code and per-week pricing", async () => {
    const court = (await listVenues())[2].courts[1];
    const date = futureDate(2);
    const result = await createBookingSeries({
      courtId: court.id,
      date,
      hours: [20, 21],
      weeks: 4,
      name: "League",
      phone: PHONE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bookings).toHaveLength(4);
    expect(result.seriesCode).toMatch(/^SR-[A-Z2-9]{6}$/);
    expect(result.skipped).toHaveLength(0);
    result.bookings.forEach((b, i) => {
      expect(b.date).toBe(addDays(date, i * 7));
      expect(b.seriesCode).toBe(result.seriesCode);
      expect(b.totalPrice).toBe(expectedPrice(court, b.date, [20, 21]));
    });
  });

  it("skips conflicting weeks when asked, else rejects the series", async () => {
    const court = (await listVenues())[2].courts[2];
    const date = futureDate(2);
    const clashDate = addDays(date, 7);
    await createBooking({ courtId: court.id, date: clashDate, hours: [18], name: "X", phone: "0100000000" });

    const strict = await createBookingSeries({
      courtId: court.id, date, hours: [18], weeks: 3, name: "L", phone: PHONE,
    });
    expect(strict).toMatchObject({ ok: false, error: expect.stringContaining(clashDate) });

    const lenient = await createBookingSeries({
      courtId: court.id, date, hours: [18], weeks: 3, name: "L", phone: PHONE, skipConflicts: true,
    });
    expect(lenient.ok).toBe(true);
    if (!lenient.ok) return;
    expect(lenient.bookings).toHaveLength(2);
    expect(lenient.skipped).toEqual([{ date: clashDate, reason: "already booked" }]);
  });

  it("rejects invalid week counts and fully-conflicting series", async () => {
    const court = (await listVenues())[2].courts[3];
    const date = futureDate(2);
    expect(
      await createBookingSeries({ courtId: court.id, date, hours: [9], weeks: 99, name: "L", phone: PHONE })
    ).toMatchObject({ ok: false, error: expect.stringContaining("Weeks") });

    await createBooking({ courtId: court.id, date, hours: [9], name: "X", phone: "0100000000" });
    expect(
      await createBookingSeries({
        courtId: court.id, date, hours: [9], weeks: 1, name: "L", phone: PHONE, skipConflicts: true,
      })
    ).toMatchObject({ ok: false });
  });

  it("cancels all future sessions in a series by code+phone", async () => {
    const court = (await listVenues())[0].courts[1];
    const date = futureDate(2);
    const created = await createBookingSeries({
      courtId: court.id, date, hours: [21], weeks: 3, name: "L", phone: PHONE,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(await cancelSeries(created.seriesCode!, "0999999999")).toMatchObject({ ok: false });
    expect(await cancelSeries(created.seriesCode!, PHONE)).toMatchObject({ ok: true, cancelled: 3 });
    expect(await cancelSeries(created.seriesCode!, PHONE)).toMatchObject({ ok: false });
    // slots are free again
    expect((await createBooking({ courtId: court.id, date, hours: [21], name: "B", phone: PHONE })).ok).toBe(true);
  });
});

describe("cross-venue search", () => {
  const date = futureDate(12);

  it("lists the distinct venue areas", async () => {
    const areas = await listAreas();
    expect(areas).toContain("Bangsar");
    expect(areas).toContain("Petaling Jaya");
    expect([...areas].sort()).toEqual(areas);
  });

  it("finds free slots for one sport across several venues", async () => {
    const results = await searchAvailability({ sport: "tennis", date, fromHour: 9, toHour: 9 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.court.sport === "tennis")).toBe(true);
    expect(results.every((r) => r.startHour === 9 && r.endHour === 10)).toBe(true);
    // tennis is offered by more than one venue in the seed data
    expect(new Set(results.map((r) => r.venue.id)).size).toBeGreaterThan(1);
  });

  it("honours the time window and returns results in time-then-price order", async () => {
    const results = await searchAvailability({ sport: "badminton", date, fromHour: 19, toHour: 21 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.startHour >= 19 && r.startHour <= 21)).toBe(true);
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1];
      const cur = results[i];
      expect(
        prev.startHour < cur.startHour ||
          (prev.startHour === cur.startHour && prev.totalPrice <= cur.totalPrice)
      ).toBe(true);
    }
  });

  it("only offers starts with enough consecutive free hours", async () => {
    const court = (await listVenues())[2].courts[0];
    await createBooking({ courtId: court.id, date, hours: [15], name: "A", phone: PHONE });

    const oneHour = await searchAvailability({ sport: court.sport, date, fromHour: 14, toHour: 14 });
    expect(oneHour.some((r) => r.court.id === court.id)).toBe(true);

    // a 2-hour block starting at 14:00 would run into the booked 15:00
    const twoHours = await searchAvailability({
      sport: court.sport, date, fromHour: 14, toHour: 14, duration: 2,
    });
    expect(twoHours.some((r) => r.court.id === court.id)).toBe(false);

    // the booked hour itself is never offered
    const booked = await searchAvailability({ sport: court.sport, date, fromHour: 15, toHour: 15 });
    expect(booked.some((r) => r.court.id === court.id)).toBe(false);
  });

  it("excludes blocked hours and filters by area", async () => {
    const venue = (await listVenues())[2];
    const court = venue.courts[1];
    await blockSlots(court.id, date, [11], "maintenance");
    const blocked = await searchAvailability({ sport: court.sport, date, fromHour: 11, toHour: 11 });
    expect(blocked.some((r) => r.court.id === court.id)).toBe(false);
    await unblockSlots(court.id, date, [11]);

    const inArea = await searchAvailability({ sport: court.sport, date, area: venue.area });
    expect(inArea.length).toBeGreaterThan(0);
    expect(inArea.every((r) => r.venue.area === venue.area)).toBe(true);

    expect(await searchAvailability({ sport: court.sport, date, area: "Nowhere" })).toEqual([]);
  });

  it("prices each result with the peak rules for its hours", async () => {
    const results = await searchAvailability({ sport: "futsal", date, fromHour: 20, toHour: 20, duration: 2 });
    for (const r of results) {
      expect(r.totalPrice).toBe(expectedPrice(r.court, date, [r.startHour, r.startHour + 1]));
    }
  });
});

describe("cancellation cutoff", () => {
  it("blocks a customer cancel inside the venue's cutoff but lets admin override", async () => {
    const venue = (await listVenues())[0];
    // 48h cutoff makes a booking 3 days out cancellable, one tomorrow not
    await updateVenue(venue.id, { cancelCutoffHours: 48 });

    const far = await createBooking({
      courtId: venue.courts[0].id, date: futureDate(4), hours: [8], name: "Far", phone: PHONE,
    });
    const near = await createBooking({
      courtId: venue.courts[0].id, date: futureDate(1), hours: [8], name: "Near", phone: PHONE,
    });
    expect(far.ok && near.ok).toBe(true);
    if (!far.ok || !near.ok) return;

    expect(await cancelBooking(far.booking.code, PHONE)).toMatchObject({ ok: true });

    const refused = await cancelBooking(near.booking.code, PHONE);
    expect(refused).toMatchObject({
      ok: false,
      error: expect.stringContaining("48 hours before"),
    });

    // staff can still cancel on the customer's behalf
    expect(await adminCancelBooking(near.booking.code)).toMatchObject({ ok: true });
    await updateVenue(venue.id, { cancelCutoffHours: 2 });
  });

  it("stores the cutoff on the venue and defaults to 2 hours", async () => {
    const venue = (await listVenues())[1];
    expect(venue.cancelCutoffHours).toBe(2);
    expect(await updateVenue(venue.id, { cancelCutoffHours: 12 })).toMatchObject({
      ok: true,
      venue: { cancelCutoffHours: 12 },
    });
    expect((await getVenue(venue.id))?.cancelCutoffHours).toBe(12);
    await updateVenue(venue.id, { cancelCutoffHours: 2 });
  });

  it("cancels only the series sessions still outside the cutoff", async () => {
    const venue = (await listVenues())[2];
    await updateVenue(venue.id, { cancelCutoffHours: 48 });
    const series = await createBookingSeries({
      courtId: venue.courts[0].id,
      date: futureDate(1), // inside the cutoff
      hours: [21],
      weeks: 3,
      name: "Liga",
      phone: PHONE,
    });
    expect(series.ok).toBe(true);
    if (!series.ok) return;

    // week 1 is too close; weeks 2 and 3 are far enough out
    const result = await cancelSeries(series.seriesCode!, PHONE);
    expect(result).toMatchObject({ ok: true, cancelled: 2 });
    await updateVenue(venue.id, { cancelCutoffHours: 2 });
  });
});

describe("no-show tracking", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses to flag a booking that has not started, or an unknown code", async () => {
    const court = (await listVenues())[0].courts[2];
    const future = await createBooking({
      courtId: court.id, date: futureDate(3), hours: [8], name: "Future", phone: "0170000001",
    });
    expect(future.ok).toBe(true);
    if (!future.ok) return;
    expect(future.booking.noShow).toBe(false);

    expect(await setNoShow(future.booking.code, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining("not started"),
    });
    expect(await setNoShow("MS-NOSUCH", true)).toMatchObject({ ok: false });
  });

  it("flags a passed booking, is reversible, and counts repeats per phone", async () => {
    const court = (await listVenues())[1].courts[4];
    const phone = "0170000002";
    const date = futureDate(3);
    expect(await countNoShows(phone)).toBe(0);

    const first = await createBooking({ courtId: court.id, date, hours: [9], name: "Repeat", phone });
    const second = await createBooking({ courtId: court.id, date, hours: [11], name: "Repeat", phone });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // travel past both slots so they can be judged
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${date}T16:00:00+08:00`));

    expect(await setNoShow(first.booking.code, true)).toMatchObject({
      ok: true,
      booking: { noShow: true },
    });
    expect(await countNoShows(phone)).toBe(1);

    // flagging twice is refused
    expect(await setNoShow(first.booking.code, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Already marked"),
    });

    expect(await setNoShow(second.booking.code, true)).toMatchObject({ ok: true });
    expect(await countNoShows(phone)).toBe(2);

    // the desk sees the history on the day list, excluding the row itself
    const rows = (await listBookingsForDate(date)).filter((r) => r.phone === phone);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.noShow).toBe(true);
      expect(row.priorNoShows).toBe(1);
    }
    // Another venue's staff do not see what this number did here, however it is typed there.
    const elsewhere = await createBooking({ courtId: (await listVenues())[0].courts[0].id, date, hours: [20], name: "Repeat", phone: "+60170000002" });
    if (!elsewhere.ok) throw new Error(elsewhere.error);
    expect((await listBookingsForDate(date)).find((r) => r.code === elsewhere.booking.code)!.priorNoShows).toBe(0);

    // a mistake can be undone
    expect(await setNoShow(second.booking.code, false)).toMatchObject({
      ok: true,
      booking: { noShow: false },
    });
    expect(await countNoShows(phone)).toBe(1);
  });

  it("never flags a cancelled booking", async () => {
    const court = (await listVenues())[1].courts[5];
    const phone = "0170000003";
    const booking = await createBooking({
      courtId: court.id, date: futureDate(3), hours: [10], name: "Gone", phone,
    });
    expect(booking.ok).toBe(true);
    if (!booking.ok) return;

    await cancelBooking(booking.booking.code, phone);
    expect(await setNoShow(booking.booking.code, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining("cancelled"),
    });
    expect(await countNoShows(phone)).toBe(0);
  });
});

describe("payments", () => {
  it("starts unpaid, toggles paid/unpaid, and refuses no-op or cancelled bookings", async () => {
    const court = (await listVenues())[1].courts[2];
    const date = futureDate(10);
    const created = await createBooking({ courtId: court.id, date, hours: [9], name: "A", phone: PHONE });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.booking.paymentStatus).toBe("unpaid");
    expect(created.booking.paidAt).toBeNull();

    const paid = await setPaymentStatus(created.booking.code, true);
    expect(paid).toMatchObject({ ok: true, booking: { paymentStatus: "paid" } });
    expect(paid.ok && paid.booking.paidAt).toBeTruthy();

    // marking paid twice is refused
    expect(await setPaymentStatus(created.booking.code, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining("already marked paid"),
    });

    // reverting works and clears the timestamp
    const reverted = await setPaymentStatus(created.booking.code, false);
    expect(reverted).toMatchObject({ ok: true, booking: { paymentStatus: "unpaid", paidAt: null } });

    expect(await setPaymentStatus("MS-NOSUCH", true)).toMatchObject({ ok: false });

    await adminCancelBooking(created.booking.code);
    expect(await setPaymentStatus(created.booking.code, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining("cancelled"),
    });
  });

  it("pays a whole series at once and reports it in the day's totals", async () => {
    const court = (await listVenues())[1].courts[3];
    const date = futureDate(2);
    const series = await createBookingSeries({
      courtId: court.id, date, hours: [15], weeks: 3, name: "Liga", phone: PHONE,
    });
    expect(series.ok).toBe(true);
    if (!series.ok) return;

    expect(await paySeries(series.seriesCode!)).toMatchObject({ ok: true, paid: 3 });
    // nothing left unpaid, so a second call is refused
    expect(await paySeries(series.seriesCode!)).toMatchObject({ ok: false });
    expect(await paySeries("SR-NOSUCH")).toMatchObject({ ok: false });

    const firstSession = (await listBookingsForDate(date)).find((b) => b.code === series.bookings[0].code);
    expect(firstSession?.paymentStatus).toBe("paid");
    expect(firstSession?.paidAt).toBeTruthy();
  });
});

describe("court management", () => {
  let newCourtId: number;

  beforeAll(async () => {
    const venue = (await listVenues())[0];
    const created = await createCourt({
      venueId: venue.id,
      name: "Test Court",
      sport: "tennis",
      offPeakRate: 33,
      peakRate: 44,
    });
    expect(created.ok).toBe(true);
    if (created.ok) newCourtId = created.court.id;
  });

  it("creates courts that appear in availability with their rates", async () => {
    const venue = (await listVenues())[0];
    const grid = await getAvailability(venue.id, futureDate(3), "tennis");
    const found = grid.find((a) => a.court.id === newCourtId);
    expect(found).toBeDefined();
  });

  it("updates rates and names, rejecting unknown courts", async () => {
    const updated = await updateCourt(newCourtId, { offPeakRate: 35, name: "Renamed Court" });
    expect(updated).toMatchObject({
      ok: true,
      court: { offPeakRate: 35, peakRate: 44, name: "Renamed Court" },
    });
    expect(await updateCourt(99999, { peakRate: 10 })).toMatchObject({ ok: false });
  });
});

describe("the rename from MudahTempah", () => {
  it("still resolves a booking code issued under the old MT- prefix", async () => {
    const court = (await listVenues())[0].courts[0];
    const made = await createBooking({
      courtId: court.id,
      date: futureDate(9),
      hours: [10],
      name: "Legacy",
      phone: PHONE,
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;

    // Rewrite it to the prefix codes carried before the rename.
    const legacy = "MT-LEGACY";
    await getDb().prepare("UPDATE bookings SET code = ? WHERE id = ?").run(legacy, made.booking.id);

    // Lookup matches the whole code, never the prefix, so it still resolves.
    expect((await findBooking(legacy, PHONE))?.id).toBe(made.booking.id);
    expect((await findBooking(legacy.toLowerCase(), PHONE))?.id).toBe(made.booking.id);
  });

  it("issues new codes under the MS- prefix", async () => {
    const court = (await listVenues())[0].courts[0];
    const made = await createBooking({
      courtId: court.id,
      date: futureDate(9),
      hours: [11],
      name: "Fresh",
      phone: PHONE,
    });
    expect(made.ok).toBe(true);
    if (made.ok) expect(made.booking.code).toMatch(/^MS-[A-Z2-9]{6}$/);
  });
});
