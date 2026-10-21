import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { registerUser, type User } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { documentFor } from "../src/lib/documents";
import { refundsOwed, savePaymentSettings, settleBill } from "../src/lib/payments";
import { createVenue, getWalletBalance } from "../src/lib/store";
import { setVenueTax } from "../src/lib/tax";
import {
  listVouchers,
  redeemVoucher,
  sellVoucher,
  voidVoucher,
  voucherByCode,
  voucherForPage,
  voucherOfPayment,
  voucherToken,
  type Voucher,
} from "../src/lib/vouchers";
import { POST as buy } from "../src/app/api/vouchers/route";

/**
 * Gift vouchers: sold at the counter or online, turned into credit at the
 * venue by whoever holds the code, once, within a year.
 */

let venueId: number;
let adminId: number;
let holder: User;
let n = 0;

async function sold(amount = 50): Promise<Voucher> {
  const made = await sellVoucher({ venueId, amount, buyerName: "Siti Aminah", recipientName: "Farah", adminId, via: "cash" });
  if (!made.ok) throw new Error(made.error);
  return made.voucher;
}

function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `giftbill${++n}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}

const post = (body: Record<string, unknown>) =>
  buy(
    new NextRequest("http://localhost/api/vouchers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ venueId, amount: 80, buyerName: "Siti Aminah", buyerEmail: "siti@example.my", recipientName: "Farah", ...body }),
    })
  );

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = ((await getDb().prepare("SELECT id FROM admins ORDER BY id LIMIT 1").get()) as { id: number }).id;
  const made = await createVenue({ name: "Gift Arena", area: "Shah Alam", address: "1 Jalan Hadiah", phone: "0355550000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  await setVenueTax(venueId, { registered: true, rate: 6, regNo: "W10-1234-56789012" });
  const user = await registerUser({ name: "Farah", email: "farah@example.my", phone: "0193334444", password: "a long enough password" });
  if (!user.ok) throw new Error(user.error);
  holder = user.user;
});

afterEach(() => vi.unstubAllGlobals());

describe("selling at the counter", () => {
  it("makes a voucher good for a year, with an untaxed receipt", async () => {
    const v = await sold(50);
    expect(v).toMatchObject({ status: "active", amount: 50, buyerName: "Siti Aminah", recipientName: "Farah", paidVia: "Cash" });
    expect(v.code).toMatch(/^GV-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const receipt = (await documentFor(`voucher:${v.id}`))!;
    expect(receipt).toMatchObject({ kind: "receipt", total: 50, tax: null, note: "receipt.creditNoTax" });
    expect((await listVouchers(venueId)).map((x) => x.code)).toContain(v.code);
  });

  it("checks what it is given", async () => {
    expect(await sellVoucher({ venueId, amount: 5, buyerName: "Siti", adminId, via: "cash" })).toMatchObject({ ok: false });
    expect(await sellVoucher({ venueId, amount: 50, buyerName: "", adminId, via: "cash" })).toMatchObject({ ok: false });
    expect(await sellVoucher({ venueId, amount: 50, buyerName: "Siti", buyerEmail: "not-an-email", adminId, via: "cash" })).toMatchObject({ ok: false });
  });
});

describe("using one", () => {
  it("turns it into credit at the venue, once", async () => {
    const v = await sold(60);
    const before = await getWalletBalance(holder.id, venueId);
    expect(await redeemVoucher(holder.id, v.code.toLowerCase())).toMatchObject({ ok: true, voucher: { status: "redeemed" } });
    expect(await getWalletBalance(holder.id, venueId)).toBe(before + 60);
    expect(await redeemVoucher(holder.id, v.code)).toMatchObject({ ok: false, code: "VOUCHER_USED" });
    expect(await getWalletBalance(holder.id, venueId)).toBe(before + 60);
    expect((await voucherByCode(v.code))!.redeemedByName).toBe("Farah");
  });

  it("is refused for a code that does not exist, or has expired", async () => {
    expect(await redeemVoucher(holder.id, "GV-NOPE-NOPE")).toMatchObject({ ok: false, code: "VOUCHER_NOT_FOUND" });
    const v = await sold();
    await getDb().prepare("UPDATE gift_vouchers SET expires_on = '2020-01-01' WHERE id = ?").run(v.id);
    expect(await redeemVoucher(holder.id, v.code)).toMatchObject({ ok: false, code: "VOUCHER_EXPIRED", vars: { date: "2020-01-01" } });
  });

  it("can be printed from its signed address only", async () => {
    const v = await sold();
    expect(await voucherForPage(v.code, voucherToken(v.code))).toMatchObject({ code: v.code });
    expect(await voucherForPage(v.code, "x".repeat(24))).toBeNull();
    expect(await voucherForPage(v.code, "short")).toBeNull();
  });
});

describe("cancelling one", () => {
  it("credits its receipt when it was sold at the counter, and not once it is used", async () => {
    const v = await sold(40);
    expect(await voidVoucher(v.id, venueId)).toMatchObject({ ok: true, voucher: { status: "void" } });
    const receipt = (await documentFor(`voucher:${v.id}`))!;
    expect(await documentFor(`credit:${receipt.id}`)).toMatchObject({ kind: "credit_note", total: 40 });
    expect(await redeemVoucher(holder.id, v.code)).toMatchObject({ ok: false, code: "VOUCHER_VOID" });
    const used = await sold();
    await redeemVoucher(holder.id, used.code);
    expect(await voidVoucher(used.id, venueId)).toMatchObject({ ok: false });
  });
});

describe("buying online", () => {
  it("needs the venue to take payment online, and an email to send it to", async () => {
    expect((await post({})).status).toBe(409);
    const saved = await savePaymentSettings(venueId, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true });
    if (!saved.ok) throw new Error(saved.error);
    fakeBillplz();
    expect((await post({ buyerEmail: "" })).status).toBe(400);
  });

  it("is nobody's until paid, then good, receipted and emailed once", async () => {
    fakeBillplz();
    const res = await post({});
    expect(res.status).toBe(200);
    const billId = ((await res.json()).url as string).split("/").pop()!;
    const payment = (await getDb().prepare("SELECT id, voucher_id FROM online_payments WHERE bill_id = ?").get(billId)) as {
      id: number;
      voucher_id: number;
    };
    const pending = (await getDb().prepare("SELECT code FROM gift_vouchers WHERE id = ?").get(payment.voucher_id)) as { code: string };
    expect(await redeemVoucher(holder.id, pending.code)).toMatchObject({ ok: false, code: "VOUCHER_NOT_FOUND" });
    expect((await listVouchers(venueId)).map((v) => v.code)).not.toContain(pending.code);

    await settleBill({ billId, paid: true, paidAt: null });
    await settleBill({ billId, paid: true, paidAt: null });
    const v = (await voucherOfPayment(payment.id))!;
    expect(v).toMatchObject({ status: "active", amount: 80, paidVia: "Online (Billplz)" });
    expect(await documentFor(`payment:${payment.id}`)).toMatchObject({ total: 80, tax: null });
    const mail = (await getDb()
      .prepare("SELECT recipient, channel FROM messages WHERE kind = 'gift_voucher'")
      .all()) as { recipient: string; channel: string }[];
    expect(mail).toEqual([{ recipient: "siti@example.my", channel: "email" }]);
  });

  it("is owed back when staff cancel it", async () => {
    fakeBillplz();
    const billId = ((await (await post({ amount: 30 })).json()).url as string).split("/").pop()!;
    await settleBill({ billId, paid: true, paidAt: null });
    const paymentId = ((await getDb().prepare("SELECT id FROM online_payments WHERE bill_id = ?").get(billId)) as { id: number }).id;
    const v = (await voucherOfPayment(paymentId))!;
    await voidVoucher(v.id, venueId);
    expect((await refundsOwed(venueId)).find((p) => p.id === paymentId)).toMatchObject({ refundOwed: 30 });
  });
});
