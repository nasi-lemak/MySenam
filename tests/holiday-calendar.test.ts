import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { calendarUntil, publicHolidays } from "../src/lib/holiday-calendar";
import { fillHolidays, upcomingHolidays } from "../src/lib/peak";
import { createVenue } from "../src/lib/store";

/** Public holidays filled in from the gazetted list, a state's own in Malaysia. */
describe("the public holiday calendar", () => {
  it("gives a state its own days as well as the country's", () => {
    const selangor = publicHolidays("MY", "Selangor", "2027-01-01").map((h) => h.date);
    expect(selangor).toContain("2027-01-22"); // Thaipusam
    expect(selangor).toContain("2027-12-11"); // the Sultan's birthday
    expect(selangor).toContain("2027-08-31");
    expect(selangor).not.toContain("2027-06-01"); // Gawai Dayak is Sarawak's
    const sarawak = publicHolidays("MY", "Sarawak", "2027-01-01").map((h) => h.date);
    expect(sarawak).toContain("2027-06-01");
    expect(sarawak).not.toContain("2027-10-28"); // no Deepavali holiday in Sarawak
  });

  it("without a state, only the days every state keeps", () => {
    const all = publicHolidays("MY", null, "2027-01-01").map((h) => h.date);
    expect(all).toContain("2027-08-31");
    expect(all).not.toContain("2027-01-22");
    expect(all).not.toContain("2027-10-28");
  });

  it("names one holiday a day, from the date asked", () => {
    const perlis = publicHolidays("MY", "Perlis", "2027-05-17");
    expect(perlis[0]).toEqual({ date: "2027-05-17", name: "Hari Raya Haji" });
    expect(new Set(perlis.map((h) => h.date)).size).toBe(perlis.length);
  });

  it("in Singapore, with the Monday after a Sunday holiday", () => {
    const sg = publicHolidays("SG", null, "2027-01-01").map((h) => h.date);
    expect(sg).toEqual(expect.arrayContaining(["2027-02-08", "2027-08-09", "2027-10-28"]));
    expect(calendarUntil("SG")).toBe("2027-12-25");
  });
});

describe("filling a venue's holidays", () => {
  it("adds the coming ones, keeps what the venue named, and does it once", async () => {
    const made = await createVenue({ name: "Gelanggang Shah Alam", area: "Shah Alam", address: "x", phone: "0355550000" });
    if (!made.ok) throw new Error("venue");
    const venueId = made.venue.id;
    expect(await fillHolidays(venueId, "Atlantis")).toMatchObject({ ok: false });
    const first = await fillHolidays(venueId, "Selangor");
    if (!first.ok) throw new Error(first.error);
    expect(first.added).toBeGreaterThan(10);
    const listed = await upcomingHolidays(venueId);
    expect(listed.map((h) => h.date)).toContain("2027-12-11");
    expect(await fillHolidays(venueId, "Selangor")).toEqual({ ok: true, added: 0 });
  });
});
