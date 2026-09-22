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
import { addDays, isPeak, todayISO } from "../src/lib/time";
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
    (sum, h) => sum + (isPeak(date, h) ? court.peakRate : court.offPeakRate),
    0
  );
}

describe("seed data", () => {
  it("creates three venues with courts", () => {
    const venues = listVenues();
    expect(venues).toHaveLength(3);
    for (const venue of venues) expect(venue.courts.length).toBeGreaterThan(0);
  });
});

describe("createBooking", () => {
  it("books consecutive hours and computes the price server-side", () => {
    const court = listVenues()[0].courts[0];
    const date = futureDate(3);
    const result = createBooking({
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

  it("charges peak rate on weekends and weekday evenings", () => {
    const court = listVenues()[0].courts[1];
    // find a weekend day and a weekday within the window
    let weekend = "";
    let weekday = "";
    for (let i = 1; i <= 7; i++) {
      const d = futureDate(i);
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      if ((dow === 0 || dow === 6) && !weekend) weekend = d;
      if (dow >= 1 && dow <= 5 && !weekday) weekday = d;
    }
    const wk = createBooking({ courtId: court.id, date: weekend, hours: [10], name: "AB", phone: PHONE });
    expect(wk.ok && wk.booking.totalPrice).toBe(court.peakRate);
    const wdMorning = createBooking({ courtId: court.id, date: weekday, hours: [10], name: "AB", phone: PHONE });
    expect(wdMorning.ok && wdMorning.booking.totalPrice).toBe(court.offPeakRate);
    const wdEvening = createBooking({ courtId: court.id, date: weekday, hours: [20], name: "AB", phone: PHONE });
    expect(wdEvening.ok && wdEvening.booking.totalPrice).toBe(court.peakRate);
  });

  it("rejects invalid selections", () => {
    const court = listVenues()[0].courts[2];
    const date = futureDate(4);
    const base = { courtId: court.id, date, name: "Test", phone: PHONE };

    expect(createBooking({ ...base, hours: [] })).toMatchObject({ ok: false });
    expect(createBooking({ ...base, hours: [10, 12] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("consecutive"),
    });
    expect(
      createBooking({ ...base, hours: Array.from({ length: MAX_HOURS_PER_BOOKING + 1 }, (_, i) => 10 + i) })
    ).toMatchObject({ ok: false, error: expect.stringContaining("Maximum") });
    expect(createBooking({ ...base, hours: [7] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("operating hours"),
    });
    expect(createBooking({ ...base, hours: [23] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("operating hours"),
    });
    expect(
      createBooking({ ...base, date: addDays(todayISO(), -1), hours: [10] })
    ).toMatchObject({ ok: false, error: expect.stringContaining("window") });
    expect(
      createBooking({ ...base, date: addDays(todayISO(), 30), hours: [10] })
    ).toMatchObject({ ok: false, error: expect.stringContaining("window") });
    expect(createBooking({ ...base, courtId: 9999, hours: [10] })).toMatchObject({
      ok: false,
      error: "Court not found.",
    });
  });

  it("prevents double-booking of any overlapping hour", () => {
    const court = listVenues()[1].courts[0];
    const date = futureDate(5);
    const first = createBooking({ courtId: court.id, date, hours: [14, 15], name: "A", phone: PHONE });
    expect(first.ok).toBe(true);
    const overlap = createBooking({ courtId: court.id, date, hours: [15, 16], name: "B", phone: "0111111111" });
    expect(overlap).toMatchObject({ ok: false, error: expect.stringContaining("booked") });
    // adjacent hours still fine
    const adjacent = createBooking({ courtId: court.id, date, hours: [16], name: "C", phone: "0122222222" });
    expect(adjacent.ok).toBe(true);
  });
});

describe("availability", () => {
  it("marks booked and blocked slots unavailable", () => {
    const venue = listVenues()[2];
    const court = venue.courts[0];
    const date = futureDate(6);
    createBooking({ courtId: court.id, date, hours: [12], name: "A", phone: PHONE });
    blockSlots(court.id, date, [13], "maintenance");

    const grid = getAvailability(venue.id, date).find((a) => a.court.id === court.id)!;
    const byHour = Object.fromEntries(grid.slots.map((s) => [s.hour, s.available]));
    expect(byHour[12]).toBe(false);
    expect(byHour[13]).toBe(false);
    expect(byHour[14]).toBe(true);
    unblockSlots(court.id, date, [13]);
  });
});

describe("cancellation", () => {
  it("cancels with matching code+phone and frees the slots", () => {
    const court = listVenues()[0].courts[3];
    const date = futureDate(7);
    const created = createBooking({ courtId: court.id, date, hours: [10], name: "A", phone: PHONE });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(cancelBooking(created.booking.code, "0999999999")).toMatchObject({ ok: false });
    const cancelled = cancelBooking(created.booking.code, PHONE);
    expect(cancelled).toMatchObject({ ok: true, booking: { status: "cancelled" } });
    expect(cancelBooking(created.booking.code, PHONE)).toMatchObject({
      ok: false,
      error: expect.stringContaining("already cancelled"),
    });
    // slot is free again
    const rebook = createBooking({ courtId: court.id, date, hours: [10], name: "B", phone: PHONE });
    expect(rebook.ok).toBe(true);
  });

  it("admin cancel works without a phone and shows up in the day list", () => {
    const court = listVenues()[0].courts[0];
    const date = futureDate(8);
    const created = createBooking({ courtId: court.id, date, hours: [9], name: "A", phone: PHONE });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(adminCancelBooking(created.booking.code)).toMatchObject({ ok: true });
    const rows = listBookingsForDate(date);
    expect(rows.find((r) => r.code === created.booking.code)?.status).toBe("cancelled");
  });
});

describe("slot blocks", () => {
  it("blocks free hours, refuses booking them, and never covers booked hours", () => {
    const court = listVenues()[1].courts[1];
    const date = futureDate(9);
    createBooking({ courtId: court.id, date, hours: [10], name: "A", phone: PHONE });

    const blocked = blockSlots(court.id, date, [10, 11], "resurfacing");
    expect(blocked).toMatchObject({ ok: true, changed: 1 }); // hour 10 is booked, only 11 blocks

    const attempt = createBooking({ courtId: court.id, date, hours: [11], name: "B", phone: PHONE });
    expect(attempt).toMatchObject({ ok: false, error: expect.stringContaining("maintenance") });

    expect(unblockSlots(court.id, date, [11])).toMatchObject({ ok: true, changed: 1 });
    expect(createBooking({ courtId: court.id, date, hours: [11], name: "B", phone: PHONE }).ok).toBe(true);
  });
});

describe("recurring series", () => {
  it("books the same slot weekly with one series code and per-week pricing", () => {
    const court = listVenues()[2].courts[1];
    const date = futureDate(2);
    const result = createBookingSeries({
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

  it("skips conflicting weeks when asked, else rejects the series", () => {
    const court = listVenues()[2].courts[2];
    const date = futureDate(2);
    const clashDate = addDays(date, 7);
    createBooking({ courtId: court.id, date: clashDate, hours: [18], name: "X", phone: "0100000000" });

    const strict = createBookingSeries({
      courtId: court.id, date, hours: [18], weeks: 3, name: "L", phone: PHONE,
    });
    expect(strict).toMatchObject({ ok: false, error: expect.stringContaining(clashDate) });

    const lenient = createBookingSeries({
      courtId: court.id, date, hours: [18], weeks: 3, name: "L", phone: PHONE, skipConflicts: true,
    });
    expect(lenient.ok).toBe(true);
    if (!lenient.ok) return;
    expect(lenient.bookings).toHaveLength(2);
    expect(lenient.skipped).toEqual([{ date: clashDate, reason: "already booked" }]);
  });

  it("rejects invalid week counts and fully-conflicting series", () => {
    const court = listVenues()[2].courts[3];
    const date = futureDate(2);
    expect(
      createBookingSeries({ courtId: court.id, date, hours: [9], weeks: 99, name: "L", phone: PHONE })
    ).toMatchObject({ ok: false, error: expect.stringContaining("Weeks") });

    createBooking({ courtId: court.id, date, hours: [9], name: "X", phone: "0100000000" });
    expect(
      createBookingSeries({
        courtId: court.id, date, hours: [9], weeks: 1, name: "L", phone: PHONE, skipConflicts: true,
      })
    ).toMatchObject({ ok: false });
  });

  it("cancels all future sessions in a series by code+phone", () => {
    const court = listVenues()[0].courts[1];
    const date = futureDate(2);
    const created = createBookingSeries({
      courtId: court.id, date, hours: [21], weeks: 3, name: "L", phone: PHONE,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(cancelSeries(created.seriesCode!, "0999999999")).toMatchObject({ ok: false });
    expect(cancelSeries(created.seriesCode!, PHONE)).toMatchObject({ ok: true, cancelled: 3 });
    expect(cancelSeries(created.seriesCode!, PHONE)).toMatchObject({ ok: false });
    // slots are free again
    expect(createBooking({ courtId: court.id, date, hours: [21], name: "B", phone: PHONE }).ok).toBe(true);
  });
});

describe("cross-venue search", () => {
  const date = futureDate(12);

  it("lists the distinct venue areas", () => {
    const areas = listAreas();
    expect(areas).toContain("Bangsar");
    expect(areas).toContain("Petaling Jaya");
    expect([...areas].sort()).toEqual(areas);
  });

  it("finds free slots for one sport across several venues", () => {
    const results = searchAvailability({ sport: "tennis", date, fromHour: 9, toHour: 9 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.court.sport === "tennis")).toBe(true);
    expect(results.every((r) => r.startHour === 9 && r.endHour === 10)).toBe(true);
    // tennis is offered by more than one venue in the seed data
    expect(new Set(results.map((r) => r.venue.id)).size).toBeGreaterThan(1);
  });

  it("honours the time window and returns results in time-then-price order", () => {
    const results = searchAvailability({ sport: "badminton", date, fromHour: 19, toHour: 21 });
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

  it("only offers starts with enough consecutive free hours", () => {
    const court = listVenues()[2].courts[0];
    createBooking({ courtId: court.id, date, hours: [15], name: "A", phone: PHONE });

    const oneHour = searchAvailability({ sport: court.sport, date, fromHour: 14, toHour: 14 });
    expect(oneHour.some((r) => r.court.id === court.id)).toBe(true);

    // a 2-hour block starting at 14:00 would run into the booked 15:00
    const twoHours = searchAvailability({
      sport: court.sport, date, fromHour: 14, toHour: 14, duration: 2,
    });
    expect(twoHours.some((r) => r.court.id === court.id)).toBe(false);

    // the booked hour itself is never offered
    const booked = searchAvailability({ sport: court.sport, date, fromHour: 15, toHour: 15 });
    expect(booked.some((r) => r.court.id === court.id)).toBe(false);
  });

  it("excludes blocked hours and filters by area", () => {
    const venue = listVenues()[2];
    const court = venue.courts[1];
    blockSlots(court.id, date, [11], "maintenance");
    const blocked = searchAvailability({ sport: court.sport, date, fromHour: 11, toHour: 11 });
    expect(blocked.some((r) => r.court.id === court.id)).toBe(false);
    unblockSlots(court.id, date, [11]);

    const inArea = searchAvailability({ sport: court.sport, date, area: venue.area });
    expect(inArea.length).toBeGreaterThan(0);
    expect(inArea.every((r) => r.venue.area === venue.area)).toBe(true);

    expect(searchAvailability({ sport: court.sport, date, area: "Nowhere" })).toEqual([]);
  });

  it("prices each result with the peak rules for its hours", () => {
    const results = searchAvailability({ sport: "futsal", date, fromHour: 20, toHour: 20, duration: 2 });
    for (const r of results) {
      expect(r.totalPrice).toBe(expectedPrice(r.court, date, [r.startHour, r.startHour + 1]));
    }
  });
});

describe("cancellation cutoff", () => {
  it("blocks a customer cancel inside the venue's cutoff but lets admin override", () => {
    const venue = listVenues()[0];
    // 48h cutoff makes a booking 3 days out cancellable, one tomorrow not
    updateVenue(venue.id, { cancelCutoffHours: 48 });

    const far = createBooking({
      courtId: venue.courts[0].id, date: futureDate(4), hours: [8], name: "Far", phone: PHONE,
    });
    const near = createBooking({
      courtId: venue.courts[0].id, date: futureDate(1), hours: [8], name: "Near", phone: PHONE,
    });
    expect(far.ok && near.ok).toBe(true);
    if (!far.ok || !near.ok) return;

    expect(cancelBooking(far.booking.code, PHONE)).toMatchObject({ ok: true });

    const refused = cancelBooking(near.booking.code, PHONE);
    expect(refused).toMatchObject({
      ok: false,
      error: expect.stringContaining("48 hours before"),
    });

    // staff can still cancel on the customer's behalf
    expect(adminCancelBooking(near.booking.code)).toMatchObject({ ok: true });
    updateVenue(venue.id, { cancelCutoffHours: 2 });
  });

  it("stores the cutoff on the venue and defaults to 2 hours", () => {
    const venue = listVenues()[1];
    expect(venue.cancelCutoffHours).toBe(2);
    expect(updateVenue(venue.id, { cancelCutoffHours: 12 })).toMatchObject({
      ok: true,
      venue: { cancelCutoffHours: 12 },
    });
    expect(getVenue(venue.id)?.cancelCutoffHours).toBe(12);
    updateVenue(venue.id, { cancelCutoffHours: 2 });
  });

  it("cancels only the series sessions still outside the cutoff", () => {
    const venue = listVenues()[2];
    updateVenue(venue.id, { cancelCutoffHours: 48 });
    const series = createBookingSeries({
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
    const result = cancelSeries(series.seriesCode!, PHONE);
    expect(result).toMatchObject({ ok: true, cancelled: 2 });
    updateVenue(venue.id, { cancelCutoffHours: 2 });
  });
});

describe("no-show tracking", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refuses to flag a booking that has not started, or an unknown code", () => {
    const court = listVenues()[0].courts[2];
    const future = createBooking({
      courtId: court.id, date: futureDate(3), hours: [8], name: "Future", phone: "0170000001",
    });
    expect(future.ok).toBe(true);
    if (!future.ok) return;
    expect(future.booking.noShow).toBe(false);

    expect(setNoShow(future.booking.code, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining("not started"),
    });
    expect(setNoShow("MS-NOSUCH", true)).toMatchObject({ ok: false });
  });

  it("flags a passed booking, is reversible, and counts repeats per phone", () => {
    const court = listVenues()[1].courts[4];
    const phone = "0170000002";
    const date = futureDate(3);
    expect(countNoShows(phone)).toBe(0);

    const first = createBooking({ courtId: court.id, date, hours: [9], name: "Repeat", phone });
    const second = createBooking({ courtId: court.id, date, hours: [11], name: "Repeat", phone });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // travel past both slots so they can be judged
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${date}T16:00:00+08:00`));

    expect(setNoShow(first.booking.code, true)).toMatchObject({
      ok: true,
      booking: { noShow: true },
    });
    expect(countNoShows(phone)).toBe(1);

    // flagging twice is refused
    expect(setNoShow(first.booking.code, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Already marked"),
    });

    expect(setNoShow(second.booking.code, true)).toMatchObject({ ok: true });
    expect(countNoShows(phone)).toBe(2);

    // the desk sees the history on the day list, excluding the row itself
    const rows = listBookingsForDate(date).filter((r) => r.phone === phone);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.noShow).toBe(true);
      expect(row.priorNoShows).toBe(1);
    }

    // a mistake can be undone
    expect(setNoShow(second.booking.code, false)).toMatchObject({
      ok: true,
      booking: { noShow: false },
    });
    expect(countNoShows(phone)).toBe(1);
  });

  it("never flags a cancelled booking", () => {
    const court = listVenues()[1].courts[5];
    const phone = "0170000003";
    const booking = createBooking({
      courtId: court.id, date: futureDate(3), hours: [10], name: "Gone", phone,
    });
    expect(booking.ok).toBe(true);
    if (!booking.ok) return;

    cancelBooking(booking.booking.code, phone);
    expect(setNoShow(booking.booking.code, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining("cancelled"),
    });
    expect(countNoShows(phone)).toBe(0);
  });
});

describe("payments", () => {
  it("starts unpaid, toggles paid/unpaid, and refuses no-op or cancelled bookings", () => {
    const court = listVenues()[1].courts[2];
    const date = futureDate(10);
    const created = createBooking({ courtId: court.id, date, hours: [9], name: "A", phone: PHONE });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.booking.paymentStatus).toBe("unpaid");
    expect(created.booking.paidAt).toBeNull();

    const paid = setPaymentStatus(created.booking.code, true);
    expect(paid).toMatchObject({ ok: true, booking: { paymentStatus: "paid" } });
    expect(paid.ok && paid.booking.paidAt).toBeTruthy();

    // marking paid twice is refused
    expect(setPaymentStatus(created.booking.code, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining("already marked paid"),
    });

    // reverting works and clears the timestamp
    const reverted = setPaymentStatus(created.booking.code, false);
    expect(reverted).toMatchObject({ ok: true, booking: { paymentStatus: "unpaid", paidAt: null } });

    expect(setPaymentStatus("MS-NOSUCH", true)).toMatchObject({ ok: false });

    adminCancelBooking(created.booking.code);
    expect(setPaymentStatus(created.booking.code, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining("cancelled"),
    });
  });

  it("pays a whole series at once and reports it in the day's totals", () => {
    const court = listVenues()[1].courts[3];
    const date = futureDate(2);
    const series = createBookingSeries({
      courtId: court.id, date, hours: [15], weeks: 3, name: "Liga", phone: PHONE,
    });
    expect(series.ok).toBe(true);
    if (!series.ok) return;

    expect(paySeries(series.seriesCode!)).toMatchObject({ ok: true, paid: 3 });
    // nothing left unpaid, so a second call is refused
    expect(paySeries(series.seriesCode!)).toMatchObject({ ok: false });
    expect(paySeries("SR-NOSUCH")).toMatchObject({ ok: false });

    const firstSession = listBookingsForDate(date).find((b) => b.code === series.bookings[0].code);
    expect(firstSession?.paymentStatus).toBe("paid");
    expect(firstSession?.paidAt).toBeTruthy();
  });
});

describe("court management", () => {
  let newCourtId: number;

  beforeAll(() => {
    const venue = listVenues()[0];
    const created = createCourt({
      venueId: venue.id,
      name: "Test Court",
      sport: "tennis",
      offPeakRate: 33,
      peakRate: 44,
    });
    expect(created.ok).toBe(true);
    if (created.ok) newCourtId = created.court.id;
  });

  it("creates courts that appear in availability with their rates", () => {
    const venue = listVenues()[0];
    const grid = getAvailability(venue.id, futureDate(3), "tennis");
    const found = grid.find((a) => a.court.id === newCourtId);
    expect(found).toBeDefined();
  });

  it("updates rates and names, rejecting unknown courts", () => {
    const updated = updateCourt(newCourtId, { offPeakRate: 35, name: "Renamed Court" });
    expect(updated).toMatchObject({
      ok: true,
      court: { offPeakRate: 35, peakRate: 44, name: "Renamed Court" },
    });
    expect(updateCourt(99999, { peakRate: 10 })).toMatchObject({ ok: false });
  });
});

describe("the rename from MudahTempah", () => {
  it("still resolves a booking code issued under the old MT- prefix", () => {
    const court = listVenues()[0].courts[0];
    const made = createBooking({
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
    getDb().prepare("UPDATE bookings SET code = ? WHERE id = ?").run(legacy, made.booking.id);

    // Lookup matches the whole code, never the prefix, so it still resolves.
    expect(findBooking(legacy, PHONE)?.id).toBe(made.booking.id);
    expect(findBooking(legacy.toLowerCase(), PHONE)?.id).toBe(made.booking.id);
  });

  it("issues new codes under the MS- prefix", () => {
    const court = listVenues()[0].courts[0];
    const made = createBooking({
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
