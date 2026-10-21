import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { journalCsv, salesJournal, summaryCsv, totals, type JournalRow } from "../src/lib/accounting";
import { getDb } from "../src/lib/db";
import {
  adminCancelBooking,
  createBooking,
  createCourt,
  createVenue,
  issuePass,
  payBookingFromWallet,
  payBookingWithPass,
  sellMembership,
  setPaymentStatus,
  topUpWallet,
} from "../src/lib/store";
import { setVenueTax } from "../src/lib/tax";
import { addDays, isPeak, todayISO } from "../src/lib/time";
import { sellVoucher } from "../src/lib/vouchers";

/**
 * The sales journal an accountant keys in: every receipt and credit note,
 * sorted into what it was for, takings told apart from money owed to
 * customers, and a booking paid with a pass left out, since the pass was the
 * sale.
 */

let venueId: number;
let courtId: number;
let adminId: number;
let journal: JournalRow[];
const today = todayISO();
let date = addDays(today, 3);
let hour = 8;

async function booked(userId?: number) {
  const made = await createBooking({ courtId, date, hours: [hour++], name: "Nurul Ain", phone: "0198887777", userId });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = ((await getDb().prepare("SELECT id FROM admins ORDER BY id LIMIT 1").get()) as { id: number }).id;
  const made = await createVenue({ name: "Ledger Hall", area: "PJ", address: "1 Jalan Akaun", phone: "0311110000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 21.2, peakRate: 21.2 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  await setVenueTax(venueId, { registered: true, rate: 6, regNo: "W10-1234-56789012" });
  while (isPeak(date, 9)) date = addDays(date, 1);
  const user = await registerUser({ name: "Nurul Ain", email: "nurul.ledger@example.my", phone: "0198887777", password: "a long enough password" });
  if (!user.ok) throw new Error(user.error);

  const cash = await booked();
  await setPaymentStatus(cash.code, true, "cash");
  const cancelled = await booked();
  await setPaymentStatus(cancelled.code, true, "qr");
  await adminCancelBooking(cancelled.code);
  await topUpWallet({ userId: user.user.id, amount: 50, adminId, venueId });
  const fromCredit = await booked(user.user.id);
  await payBookingFromWallet(fromCredit.id);
  const pass = await issuePass({
    venueId, name: "5-hour pass", entries: 5, price: 100, holderName: "Nurul Ain", holderPhone: "0198887777",
    expiresOn: addDays(today, 60), adminId, userId: user.user.id,
  });
  if (!pass.ok) throw new Error(pass.error);
  const withPass = await booked(user.user.id);
  await payBookingWithPass(withPass.id, pass.pass.code);
  await sellMembership({ venueId, holderName: "Nurul Ain", holderPhone: "0198887777", startsOn: today, expiresOn: addDays(today, 30), price: 80, adminId });
  await sellVoucher({ venueId, amount: 30, buyerName: "Siti", adminId, via: "cash" });

  journal = await salesJournal(venueId, today, today);
});

describe("the sales journal", () => {
  it("has a row for each receipt and credit note, sorted into what it was for", () => {
    const cats = journal.map((r) => `${r.type}:${r.category}`).sort();
    expect(cats).toEqual(
      [
        "Credit note:Court hire",
        "Receipt:Court hire",
        "Receipt:Court hire",
        "Receipt:Court hire",
        "Receipt:Gift vouchers",
        "Receipt:Memberships",
        "Receipt:Passes",
        "Receipt:Stored credit",
      ].sort()
    );
  });

  it("carries the tax inside each sale, and takes it back on a credit note", () => {
    const cash = journal.find((r) => r.category === "Court hire" && r.paidVia === "Cash")!;
    expect(cash).toMatchObject({ gross: 21.2, tax: 1.2, taxRate: 6, revenue: true });
    const credit = journal.find((r) => r.type === "Credit note")!;
    expect(credit).toMatchObject({ gross: -21.2, tax: -1.2 });
  });

  it("tells takings apart from money owed to customers", () => {
    expect(journal.find((r) => r.category === "Stored credit")).toMatchObject({ revenue: false, gross: 50, tax: 0 });
    expect(journal.find((r) => r.category === "Gift vouchers")).toMatchObject({ revenue: false, gross: 30 });
    expect(journal.find((r) => r.category === "Court hire" && r.paidVia === "Stored credit")).toMatchObject({ revenue: true });
  });

  it("leaves out a booking paid with a pass: the pass was the sale", () => {
    expect(journal.filter((r) => r.paidVia === "Pass")).toEqual([]);
    expect(journal.find((r) => r.category === "Passes")).toMatchObject({ gross: 100 });
  });

  it("sums to takings, by category and by how it was received", () => {
    const t = totals(journal);
    // Court hire 3 × 21.20 less one credited, a membership and a pass; not credit or vouchers.
    expect(t.takings.gross).toBe(42.4 + 80 + 100);
    expect(t.byCategory.find((c) => c.category === "Court hire")).toMatchObject({ gross: 42.4, tax: 2.4, net: 40 });
    expect(t.byPaidVia.find((v) => v.paidVia === "Cash")?.gross).toBeGreaterThanOrEqual(21.2 + 30);
  });

  it("covers only the days asked for", async () => {
    expect(await salesJournal(venueId, addDays(today, 1), addDays(today, 5))).toEqual([]);
  });

  it("comes as spreadsheets", async () => {
    const csv = await journalCsv(venueId, today, today);
    expect(csv.split("\r\n")[0]).toContain('"Date","Number","Type","Customer","Description","Category","Takings"');
    expect(csv).toContain('"No, owed to customers until spent"');
    const summary = await summaryCsv(venueId, today, today);
    expect(summary).toContain('"Total takings","","Yes","209.81","12.59","222.40"');
  });
});
