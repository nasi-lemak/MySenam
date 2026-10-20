import { afterEach, beforeEach, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import { invoiceById, issueDueInvoices, setVenuePlan } from "../src/lib/billing";
import { platformTax } from "../src/lib/tax";
import { createVenue } from "../src/lib/store";

/**
 * The platform's own SST or GST on what it invoices venues: added on top of
 * the fee once the operator is registered, kept as it was on the day.
 */

const NOV_1 = new Date("2026-11-01T01:00:00Z");
const DEC_1 = new Date("2026-12-01T01:00:00Z");
let n = 0;

async function venue(): Promise<number> {
  const made = await createVenue({ name: `Billed Hall ${++n}`, area: "PJ", address: "x", phone: "0312345678" });
  if (!made.ok) throw new Error("venue");
  await setVenuePlan(made.venue.id, { monthlyFee: null, billingStartsOn: "2026-10-01" });
  return made.venue.id;
}

beforeEach(() => {
  process.env.MYSENAM_MARKETPLACE = "on";
  process.env.MYSENAM_VENUE_FEE = "99";
});

afterEach(() => {
  for (const k of ["MYSENAM_MARKETPLACE", "MYSENAM_VENUE_FEE", "MYSENAM_TAX_RATE", "MYSENAM_TAX_REG_NO", "MYSENAM_TAX_NAME"]) delete process.env[k];
});

describe("the operator's tax settings", () => {
  it("take a rate and a number, both, or there is no tax", () => {
    expect(platformTax()).toBeNull();
    process.env.MYSENAM_TAX_RATE = "8";
    expect(platformTax()).toBeNull();
    process.env.MYSENAM_TAX_REG_NO = "W10-2401-32000001";
    expect(platformTax()).toEqual({ name: "SST", rate: 8, regNo: "W10-2401-32000001" });
    process.env.MYSENAM_TAX_RATE = "nonsense";
    expect(platformTax()).toBeNull();
  });
});

describe("invoices", () => {
  it("carry no tax before the operator is registered", async () => {
    const id = await venue();
    const [inv] = (await issueDueInvoices(NOV_1)).filter((i) => i.venueId === id);
    expect(inv).toMatchObject({ amount: 99, net: 99, tax: null });
  });

  it("add the tax on top once it is, and keep it as it was on the day", async () => {
    process.env.MYSENAM_TAX_RATE = "8";
    process.env.MYSENAM_TAX_REG_NO = "W10-2401-32000001";
    const id = await venue();
    const [inv] = (await issueDueInvoices(NOV_1)).filter((i) => i.venueId === id);
    expect(inv).toMatchObject({ amount: 106.92, net: 99, tax: { name: "SST", rate: 8, amount: 7.92, regNo: "W10-2401-32000001" } });
    // The rate changes later; November's invoice does not.
    process.env.MYSENAM_TAX_RATE = "10";
    expect(await invoiceById(inv.id)).toMatchObject({ amount: 106.92, tax: { rate: 8 } });
    const [dec] = (await issueDueInvoices(DEC_1)).filter((i) => i.venueId === id);
    expect(dec).toMatchObject({ amount: 108.9, tax: { rate: 10, amount: 9.9 } });
  });

  it("work it out on a business's whole invoice, again as each branch is added", async () => {
    process.env.MYSENAM_TAX_RATE = "9";
    process.env.MYSENAM_TAX_REG_NO = "M90012345X";
    process.env.MYSENAM_TAX_NAME = "GST";
    const db = getDb();
    const { id: businessId } = (await db.prepare("INSERT INTO businesses (name) VALUES ('Smash Group') RETURNING id").get()) as { id: number };
    const a = await venue();
    const b = await venue();
    await db.prepare("UPDATE venues SET business_id = ? WHERE id IN (?, ?)").run(businessId, a, b);
    // One branch billed first; the other joins the same month's invoice later.
    await db.prepare("UPDATE venues SET billing_starts_on = '2026-11-20' WHERE id = ?").run(b);
    const first = (await issueDueInvoices(NOV_1)).find((i) => i.businessId === businessId)!;
    expect(first).toMatchObject({ net: 99, tax: { name: "GST", rate: 9, amount: 8.91 }, amount: 107.91 });
    await db.prepare("UPDATE venues SET billing_starts_on = '2026-10-01' WHERE id = ?").run(b);
    await issueDueInvoices(new Date("2026-11-21T01:00:00Z"));
    const both = (await invoiceById(first.id))!;
    expect(both.lines).toHaveLength(2);
    expect(both).toMatchObject({ net: 198, tax: { amount: 17.82 }, amount: 215.82 });
  });
});
