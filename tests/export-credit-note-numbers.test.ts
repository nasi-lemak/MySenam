import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { journalCsv, summaryCsv } from "../src/lib/accounting";
import { toCsv } from "../src/lib/export";
import { cancelBooking, createBooking, createCourt, createVenue, setPaymentStatus } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Audit 9, G2: the accounting export. A credit note's amounts are negative; `toCsv` puts an apostrophe in front of any
 * cell that starts with "-" (to stop a formula), so in Excel/Sheets every credit note is text ("'-40.00"), not a number:
 * a column sum, a pivot or an import into SQL Accounting / AutoCount leaves the credit notes out or fails.
 */
let venueId: number;
let courtId: number;

beforeAll(async () => {
  const v = await createVenue({ name: "Csv Hall", area: "PJ", address: "1", phone: "0312345644" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "C1", sport: "badminton", offPeakRate: 40, peakRate: 40 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
});

describe("the sales journal as a spreadsheet", () => {
  it("has the credit note's amounts as numbers", async () => {
    const b = await createBooking({ courtId, date: addDays(todayISO(), 6), hours: [9], name: "Cn", phone: "0197774444" });
    if (!b.ok) throw new Error(JSON.stringify(b));
    expect((await setPaymentStatus(b.booking.code, true, "cash")).ok).toBe(true);
    expect(await cancelBooking(b.booking.code, "0197774444")).toMatchObject({ ok: true });
    const csv = await journalCsv(venueId, todayISO(), addDays(todayISO(), 6));
    const creditLine = csv.split("\r\n").find((l) => l.includes("Credit note"))!;
    expect(creditLine).toBeTruthy();
    expect(creditLine).toContain('"-40.00"');
    expect(creditLine).not.toContain("'-");
    const summary = await summaryCsv(venueId, todayISO(), addDays(todayISO(), 6));
    expect(summary).not.toContain("'-");
  });
});

describe("the formula guard in a spreadsheet export", () => {
  it("guards text that starts a formula and writes numbers as numbers", () => {
    const csv = toCsv(
      ["Name", "Amount", "Change", "Text amount"],
      [
        ["=HYPERLINK(\"x\")", -40, -12.5, "-40.00"],
        ["-1+1", 0, 3, "+5"],
        ["@SUM(A1)", "-0.50", "1e3", "-5 - 3"],
      ]
    );
    expect(csv).toContain('"\'=HYPERLINK(""x"")","-40","-12.5","-40.00"');
    // Only a lone number is a number: a formula that happens to start with a minus is still guarded.
    expect(csv).toContain('"\'-1+1","0","3","\'+5"');
    expect(csv).toContain('"\'@SUM(A1)","-0.50","1e3","\'-5 - 3"');
  });

  it("writes the other exports' negative amounts as numbers too (a price adjustment in the bookings list)", () => {
    expect(toCsv(["Price adjusted"], [["-10.00"]])).toContain('"-10.00"');
  });
});
