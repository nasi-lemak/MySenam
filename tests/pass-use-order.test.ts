import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { comparePassesForUse } from "../src/lib/pass-rules";
import { createVenue, issuePass, listPassesFor, usablePassesForHolder } from "../src/lib/store";
import { registerUser } from "../src/lib/auth";
import { createAdmin } from "../src/lib/admin-auth";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Which pass is offered first (MEMB D18, ADR 0071): one rule wherever the order decides the default, the pass that ends soonest
 * first, then the older. The counter's list follows it (the booking form and the entry desk use the same comparator and order:
 * tests/entries.test.ts, and the form sorts with `comparePassesForUse`); the account's own list stays newest first, as history.
 */

let venueId: number;
const holder = { name: "Pass Holder", phone: "0124445566" };
let userId: number;
let adminId: number;
const today = todayISO();

const issue = async (name: string, days: number) => {
  const made = await issuePass({
    venueId, name, entries: 5, entryMinutes: null, price: 50, holderName: holder.name, holderPhone: holder.phone,
    expiresOn: addDays(today, days), userId, adminId, paidVia: "Cash",
  });
  if (!made.ok) throw new Error(made.error);
  return made.pass;
};

beforeAll(async () => {
  const v = await createVenue({ name: "Order Hall", area: "Ampang", address: "x", phone: "0344443333" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const u = await registerUser({ name: holder.name, email: "order@pass.test", phone: holder.phone, password: "a long enough password" });
  if (!u.ok) throw new Error(u.error);
  userId = u.user.id;
  const a = await createAdmin({ name: "Dina", email: "desk@order.test", password: "a long enough password", venueId, role: "desk" });
  if (!a.ok) throw new Error(a.error);
  adminId = a.admin.id;
});

describe("the order passes are offered in", () => {
  it("is the soonest to end first, then the older, and the id breaks a tie the same way everywhere", () => {
    const list = [
      { id: 4, expiresOn: "2027-03-01" },
      { id: 2, expiresOn: "2027-02-01" },
      { id: 3, expiresOn: "2027-02-01" },
      { id: 1, expiresOn: "2027-12-31" },
    ];
    expect([...list].sort(comparePassesForUse).map((p) => p.id)).toEqual([2, 3, 4, 1]);
    // A pass with no date given sorts last, never first.
    expect([{ id: 1 }, { id: 2, expiresOn: "2027-01-01" }].sort(comparePassesForUse).map((p) => p.id)).toEqual([2, 1]);
  });

  it("is what the counter lists (it was oldest first), where a customer's own list stays newest first", async () => {
    const later = await issue("Later", 60);
    const sooner = await issue("Sooner", 10);
    const sameA = await issue("Same A", 30);
    const sameB = await issue("Same B", 30);
    expect((await usablePassesForHolder(venueId, holder.phone)).map((p) => p.id)).toEqual([sooner.id, sameA.id, sameB.id, later.id]);
    // Their own list is history, newest first.
    expect((await listPassesFor(userId)).map((p) => p.id)).toEqual([sameB.id, sameA.id, sooner.id, later.id]);
  });
});
