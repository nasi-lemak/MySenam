import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { exportCustomerData, exportPhoneData } from "../src/lib/privacy";
import {
  createBooking,
  createCourt,
  createVenue,
  issuePass,
  sellMembership,
  setPaymentStatus,
  topUpWallet,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { redeemVoucher, sellVoucher } from "../src/lib/vouchers";

/**
 * A person asking a venue, in person, what it holds about them: everything
 * filed against their number there, and nothing from anybody else's venue.
 */

let venueId: number;
let otherVenueId: number;
let courtId: number;
let otherCourtId: number;
let adminId: number;
const PHONE = "012-555 0101";
const date = addDays(todayISO(), 3);

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = (await listAdmins())[0].id;
  const a = await createVenue({ name: "Request Hall", area: "PJ", address: "x", phone: "0300000001" });
  const b = await createVenue({ name: "Elsewhere Hall", area: "KL", address: "y", phone: "0300000002" });
  if (!a.ok || !b.ok) throw new Error("venue");
  venueId = a.venue.id;
  otherVenueId = b.venue.id;
  const c = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  const d = await createCourt({ venueId: otherVenueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok || !d.ok) throw new Error("court");
  courtId = c.court.id;
  otherCourtId = d.court.id;
});

describe("a data request at the counter", () => {
  it("gathers what this venue holds against the number, however it was typed", async () => {
    const here = await createBooking({ courtId, date, hours: [9], name: "Walk In", phone: PHONE });
    const there = await createBooking({ courtId: otherCourtId, date, hours: [9], name: "Walk In", phone: PHONE });
    const stranger = await createBooking({ courtId, date, hours: [10], name: "Somebody Else", phone: "0125550202" });
    if (!here.ok || !there.ok || !stranger.ok) throw new Error("booking");
    await setPaymentStatus(here.booking.code, true, "cash");
    await issuePass({
      venueId, name: "10 hours", entries: 10, price: 150, holderName: "Walk In", holderPhone: "+60125550101",
      expiresOn: addDays(todayISO(), 90), adminId,
    });
    await sellMembership({
      venueId, holderName: "Walk In", holderPhone: "0125550101", startsOn: todayISO(), expiresOn: addDays(todayISO(), 30),
      price: 100, adminId,
    });
    await sellVoucher({ venueId, amount: 30, buyerName: "Walk In", buyerPhone: "0125550101", adminId, via: "cash" });

    const dump = await exportPhoneData([venueId], "+60 12-555 0101");
    expect(dump.venues).toEqual(["Request Hall"]);
    const codes = dump.bookings.map((b) => (b as { code: string }).code);
    expect(codes).toEqual([here.booking.code]);
    expect(dump.passes).toHaveLength(1);
    expect(dump.memberships).toHaveLength(1);
    expect(dump.giftVouchers).toHaveLength(1);
    // The pass's, the membership's and the voucher's, all to this number.
    expect(dump.receipts).toHaveLength(3);
    expect(JSON.stringify(dump)).not.toContain("Somebody Else");
  });

  it("finds nothing for a number the venue has never seen", async () => {
    const dump = await exportPhoneData([venueId], "0199999999");
    expect(dump.bookings).toEqual([]);
    expect(dump.passes).toEqual([]);
  });
});

describe("a signed-in customer's own file", () => {
  it("now carries their receipts, waiting list, vouchers and messages", async () => {
    const made = await registerUser({ name: "Account Holder", email: "holder@example.my", phone: "0125550303", password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    const booking = await createBooking({ courtId, date, hours: [11], name: "Account Holder", phone: "0125550303", userId: made.user.id });
    if (!booking.ok) throw new Error(booking.error);
    // A booking's receipt is drawn from the booking itself; credit bought is a stored one.
    await topUpWallet({ userId: made.user.id, amount: 40, adminId, venueId });
    const voucher = await sellVoucher({ venueId, amount: 25, buyerName: "Friend", adminId, via: "cash" });
    if (!voucher.ok) throw new Error(voucher.error);
    await redeemVoucher(made.user.id, voucher.voucher.code);

    const dump = (await exportCustomerData(made.user.id))!;
    expect(dump.receipts).toEqual([expect.objectContaining({ kind: "receipt", venue: "Request Hall" })]);
    expect(dump.vouchers).toEqual([expect.objectContaining({ code: voucher.voucher.code })]);
    expect(Array.isArray(dump.waitlist)).toBe(true);
    expect(Array.isArray(dump.messages)).toBe(true);
    expect(dump.heldAtACounter).toContain("manager");
  });
});
