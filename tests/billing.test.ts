import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

import { NextRequest } from "next/server";
import {
  issueDueInvoices,
  listInvoices,
  markInvoicePaid,
  payInvoiceOnline,
  setVenuePlan,
  startBilling,
  venuePlans,
  voidInvoice,
} from "../src/lib/billing";
import { xSignature } from "../src/lib/billplz";
import { accountForBill, listOnlinePayments, savePaymentSettings, settleBill } from "../src/lib/payments";
import { verifyCallback } from "../src/lib/billplz";
import { createVenue } from "../src/lib/store";
import {
  ADMIN_SESSION_COOKIE,
  createAdmin,
  createAdminSession,
  ensureBootstrapAdmin,
  listAdmins,
} from "../src/lib/admin-auth";

/**
 * What marketplace venues pay: one invoice per full month, into the
 * platform's own account — never a venue's.
 */

const PLATFORM_KEY = "platform-signature-key";
let n = 0;

function venue(): number {
  const made = createVenue({ name: `Billed Venue ${++n}`, area: "PJ", address: "x", phone: "0300000000" });
  if (!made.ok) throw new Error("venue");
  return made.venue.id;
}

// 1 Nov 2026, 09:00 in Kuala Lumpur.
const NOV_1 = new Date("2026-11-01T01:00:00Z");
const OCT_16 = new Date("2026-10-16T01:00:00Z");

beforeAll(() => ensureBootstrapAdmin());

beforeEach(() => {
  process.env.MYSENAM_MARKETPLACE = "on";
  process.env.MYSENAM_VENUE_FEE = "99";
});

afterEach(() => {
  for (const k of ["MYSENAM_MARKETPLACE", "MYSENAM_VENUE_FEE", "MYSENAM_FREE_MONTHS"]) delete process.env[k];
  for (const k of Object.keys(process.env)) if (k.startsWith("BILLPLZ_")) delete process.env[k];
  vi.unstubAllGlobals();
});

describe("issuing invoices", () => {
  it("bills each full month from when billing starts, once", () => {
    const id = venue();
    setVenuePlan(id, { monthlyFee: null, billingStartsOn: "2026-10-16" });

    // Joined mid-October: the rest of October is free.
    expect(issueDueInvoices(OCT_16).filter((i) => i.venueId === id)).toEqual([]);

    const nov = issueDueInvoices(NOV_1).filter((i) => i.venueId === id);
    expect(nov).toHaveLength(1);
    expect(nov[0]).toMatchObject({ period: "2026-11", amount: 99, status: "due", dueOn: "2026-11-15" });

    // However often it runs.
    expect(issueDueInvoices(NOV_1).filter((i) => i.venueId === id)).toEqual([]);
    expect(listInvoices(id)).toHaveLength(1);
  });

  it("charges a venue's own fee over the default, and nothing for a fee of zero", () => {
    const own = venue();
    const free = venue();
    setVenuePlan(own, { monthlyFee: 49, billingStartsOn: "2026-01-01" });
    setVenuePlan(free, { monthlyFee: 0, billingStartsOn: "2026-01-01" });
    const issued = issueDueInvoices(NOV_1);
    expect(issued.find((i) => i.venueId === own)?.amount).toBe(49);
    expect(issued.find((i) => i.venueId === free)).toBeUndefined();
  });

  it("never bills a venue with no start date — every venue from before billing", () => {
    const id = venue();
    expect(issueDueInvoices(NOV_1).find((i) => i.venueId === id)).toBeUndefined();
  });

  it("does nothing on a venue's own copy", () => {
    delete process.env.MYSENAM_MARKETPLACE;
    const id = venue();
    setVenuePlan(id, { monthlyFee: 10, billingStartsOn: "2026-01-01" });
    expect(issueDueInvoices(NOV_1)).toEqual([]);
  });

  it("starts after the free months a newly approved venue is given", () => {
    process.env.MYSENAM_FREE_MONTHS = "3";
    const id = venue();
    startBilling(id, OCT_16);
    expect(venuePlans().find((p) => p.venueId === id)?.billingStartsOn).toBe("2027-01-16");
  });
});

describe("settling by hand", () => {
  it("records a bank transfer, or voids an invoice, once", () => {
    const id = venue();
    setVenuePlan(id, { monthlyFee: 20, billingStartsOn: "2026-01-01" });
    issueDueInvoices(NOV_1);
    const [inv] = listInvoices(id);
    expect(markInvoicePaid(inv.id)).toMatchObject({ ok: true, invoice: { status: "paid", paidVia: "manual" } });
    expect(markInvoicePaid(inv.id).ok).toBe(false);
    expect(voidInvoice(inv.id).ok).toBe(false);
  });
});

describe("paying an invoice online", () => {
  function platform() {
    process.env.BILLPLZ_API_KEY = "platform-api-key";
    process.env.BILLPLZ_COLLECTION_ID = "platformcol";
    process.env.BILLPLZ_X_SIGNATURE_KEY = PLATFORM_KEY;
    process.env.BILLPLZ_SANDBOX = "on";
  }

  it("is not offered until the platform's account is set up", async () => {
    const id = venue();
    setVenuePlan(id, { monthlyFee: 30, billingStartsOn: "2026-01-01" });
    issueDueInvoices(NOV_1);
    const [inv] = listInvoices(id);
    expect(await payInvoiceOnline(inv.id, { name: "Desk", email: "d@x.my" })).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it("goes to the platform's account, is checked with the platform's key, and settles the invoice", async () => {
    platform();
    const id = venue();
    // The venue has its own account for its customers. Its fee must not go there.
    savePaymentSettings(id, {
      apiKey: "venue-api-key",
      collectionId: "venuecol",
      xSignatureKey: "venue-key",
      sandbox: true,
      enabled: true,
    });
    setVenuePlan(id, { monthlyFee: 59, billingStartsOn: "2026-01-01" });
    issueDueInvoices(NOV_1);
    const [inv] = listInvoices(id);

    const sent: { auth: string; form: URLSearchParams }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push({
          auth: (init.headers as Record<string, string>).Authorization,
          form: new URLSearchParams(init.body as string),
        });
        return Response.json({ id: `inv-bill-${inv.id}`, url: `https://www.billplz-sandbox.com/bills/inv-bill-${inv.id}` });
      })
    );
    const opened = await payInvoiceOnline(inv.id, { name: "Desk", email: "desk@venue.my" });
    expect(opened.ok).toBe(true);
    expect(sent[0].auth).toBe(`Basic ${Buffer.from("platform-api-key:").toString("base64")}`);
    expect(sent[0].form.get("collection_id")).toBe("platformcol");
    expect(sent[0].form.get("amount")).toBe("5900");

    const billId = `inv-bill-${inv.id}`;
    const fields: Record<string, string> = { id: billId, paid: "true", paid_at: "2026-11-02 10:00:00 +0800" };
    const account = accountForBill(billId)!;
    // Signed by the venue's key, it is not believed; by the platform's, it is.
    expect(verifyCallback({ ...fields, x_signature: xSignature(fields, "venue-key") }, account.xSignatureKey)).toBeNull();
    const verified = verifyCallback({ ...fields, x_signature: xSignature(fields, PLATFORM_KEY) }, account.xSignatureKey);
    expect(verified).not.toBeNull();
    settleBill(verified!);

    expect(listInvoices(id)[0]).toMatchObject({ status: "paid", paidVia: "online" });
    // The venue's own list of customer payments does not show its fee.
    expect(listOnlinePayments(id).some((p) => p.billId === billId)).toBe(false);
  });
});

describe("the billing route", () => {
  it("shows a venue's staff their own invoices only, and keeps plans to the owner", async () => {
    const mine = venue();
    const theirs = venue();
    setVenuePlan(mine, { monthlyFee: 10, billingStartsOn: "2026-01-01" });
    setVenuePlan(theirs, { monthlyFee: 10, billingStartsOn: "2026-01-01" });
    issueDueInvoices(NOV_1);

    const desk = createAdmin({ name: "Desk", email: `bill-desk${n}@x.my`, password: "desk-password", venueId: mine });
    if (!desk.ok) throw new Error(desk.error);
    const asDesk = `${ADMIN_SESSION_COOKIE}=${createAdminSession(desk.admin.id).token}`;
    const asOwner = `${ADMIN_SESSION_COOKIE}=${createAdminSession(listAdmins().find((a) => a.venueId === null)!.id).token}`;
    const mod = await import("../src/app/api/admin/billing/route");

    const seen = await (await mod.GET(new NextRequest("http://localhost/api/admin/billing", { headers: { cookie: asDesk } }))).json();
    expect(seen.invoices.every((i: { venueId: number }) => i.venueId === mine)).toBe(true);
    expect(seen.plans).toBeUndefined();

    const post = (cookie: string, body: unknown) =>
      mod.POST(
        new NextRequest("http://localhost/api/admin/billing", {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      );
    const theirInvoice = listInvoices(theirs)[0];
    expect((await post(asDesk, { action: "pay", invoiceId: theirInvoice.id })).status).toBe(403);
    expect((await post(asDesk, { action: "markPaid", invoiceId: listInvoices(mine)[0].id })).status).toBe(403);
    expect((await post(asDesk, { action: "setPlan", venueId: mine, monthlyFee: 0 })).status).toBe(403);
    expect((await post(asOwner, { action: "markPaid", invoiceId: theirInvoice.id })).status).toBe(200);
  });
});
