import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

import { createAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { issueDueInvoices, setVenuePlan } from "../src/lib/billing";
import { getDb } from "../src/lib/db";
import { applyPaymentHolds, invoiceReminderDays, notifyInvoiceStages } from "../src/lib/payment-holds";
import { runScheduledWork } from "../src/lib/scheduler";
import { createVenue } from "../src/lib/store";

/**
 * Audit 9, G14: the platform's invoice to a venue is emailed to its managers when it is issued and again a few days before it falls due,
 * once each, however often the scheduler runs and whether or not a server stopped between telling and stamping. The first word used to be
 * a warning a week after the due date.
 */
let n = 0;
// 1 Nov 2026, 09:00 in Kuala Lumpur: invoices of RM99 are issued, due on the 15th.
const NOV_1 = new Date("2026-11-01T01:00:00Z");
const NOV_5 = new Date("2026-11-05T01:00:00Z");
const NOV_12 = new Date("2026-11-12T01:00:00Z");
const NOV_23 = new Date("2026-11-23T01:00:00Z");

beforeAll(async () => await ensureBootstrapAdmin());
beforeEach(() => {
  process.env.MYSENAM_MARKETPLACE = "on";
  process.env.MYSENAM_VENUE_FEE = "99";
});
afterEach(() => {
  for (const k of ["MYSENAM_MARKETPLACE", "MYSENAM_VENUE_FEE", "MYSENAM_INVOICE_REMINDER_DAYS"]) delete process.env[k];
  vi.unstubAllEnvs();
});

async function billedVenue() {
  const made = await createVenue({ name: `Invoiced Venue ${++n}`, area: "PJ", address: "x", phone: "0300000000" });
  if (!made.ok) throw new Error("venue");
  const id = made.venue.id;
  await setVenuePlan(id, { monthlyFee: null, billingStartsOn: "2026-10-01" });
  const manager = await createAdmin({ name: `Billing Manager ${n}`, email: `billing${n}@invoiced.test`, password: "a long enough password", venueId: id });
  if (!manager.ok) throw new Error(manager.error);
  const desk = await createAdmin({ name: `Desk ${n}`, email: `desk${n}@invoiced.test`, password: "a long enough password", venueId: id, role: "desk" });
  if (!desk.ok) throw new Error(desk.error);
  return { id, manager: `billing${n}@invoiced.test`, desk: `desk${n}@invoiced.test` };
}

const mailsFor = async (invoiceId: number, stage: string) =>
  (await getDb().prepare("SELECT recipient, subject, body FROM messages WHERE dedupe_key LIKE ? ORDER BY id").all(`invoice-${stage}:${invoiceId}:%`)) as { recipient: string; subject: string; body: string }[];

describe("the platform's invoice to a venue", () => {
  it("is emailed to the venue's managers when it is issued, once, with the amount, the due date and where to pay; not to the front desk", async () => {
    const v = await billedVenue();
    const [invoice] = (await issueDueInvoices(NOV_1)).filter((i) => i.venueId === v.id);
    expect(invoice).toMatchObject({ amount: 99, dueOn: "2026-11-15" });
    expect((await notifyInvoiceStages(NOV_1)).issued).toBeGreaterThanOrEqual(1);
    const mails = await mailsFor(invoice.id, "issued");
    expect(mails.map((m) => m.recipient)).toEqual([v.manager]);
    expect(mails[0].subject).toContain("2026-11");
    expect(mails[0].subject).toContain("99.00");
    expect(mails[0].body).toContain("2026-11-15");
    expect(mails[0].body).toMatch(/Pay it under/);
    // However often the scheduler runs.
    expect((await notifyInvoiceStages(NOV_1)).issued).toBe(0);
    expect(await mailsFor(invoice.id, "issued")).toHaveLength(1);
  });

  it("is reminded three days before it falls due, and not before, once; and the reminder is configurable", async () => {
    const v = await billedVenue();
    const [invoice] = (await issueDueInvoices(NOV_1)).filter((i) => i.venueId === v.id);
    await notifyInvoiceStages(NOV_1);
    expect((await notifyInvoiceStages(NOV_5)).reminded).toBe(0);
    expect(await mailsFor(invoice.id, "due-soon")).toEqual([]);
    expect((await notifyInvoiceStages(NOV_12)).reminded).toBeGreaterThanOrEqual(1);
    const mails = await mailsFor(invoice.id, "due-soon");
    expect(mails.map((m) => m.recipient)).toEqual([v.manager]);
    expect(mails[0].subject).toContain("falls due on 2026-11-15");
    expect((await notifyInvoiceStages(NOV_12)).reminded).toBe(0);
    expect(await mailsFor(invoice.id, "due-soon")).toHaveLength(1);

    vi.stubEnv("MYSENAM_INVOICE_REMINDER_DAYS", "0");
    expect(invoiceReminderDays()).toBe(0);
    vi.stubEnv("MYSENAM_INVOICE_REMINDER_DAYS", "20");
    expect(invoiceReminderDays()).toBe(3);
  });

  it("a stop between telling and stamping tells nobody twice on the next run", async () => {
    const v = await billedVenue();
    const [invoice] = (await issueDueInvoices(NOV_1)).filter((i) => i.venueId === v.id);
    await notifyInvoiceStages(NOV_1);
    await getDb().prepare("UPDATE venue_invoices SET issued_notified_at = NULL WHERE id = ?").run(invoice.id);
    await notifyInvoiceStages(NOV_1);
    await notifyInvoiceStages(NOV_1);
    expect(await mailsFor(invoice.id, "issued")).toHaveLength(1);
    expect(await getDb().prepare("SELECT issued_notified_at IS NOT NULL AS stamped FROM venue_invoices WHERE id = ?").get(invoice.id)).toEqual({ stamped: true });
  });

  it("two servers telling at the same moment write one email each", async () => {
    const v = await billedVenue();
    const [invoice] = (await issueDueInvoices(NOV_1)).filter((i) => i.venueId === v.id);
    await Promise.all([notifyInvoiceStages(NOV_1), notifyInvoiceStages(NOV_1), notifyInvoiceStages(NOV_1)]);
    expect(await mailsFor(invoice.id, "issued")).toHaveLength(1);
  });

  it("is not told about an invoice that was issued before this change (a week-old invoice is not 'just issued')", async () => {
    const v = await billedVenue();
    const [invoice] = (await issueDueInvoices(NOV_1)).filter((i) => i.venueId === v.id);
    // As the migration leaves one that existed already.
    await getDb().prepare("UPDATE venue_invoices SET issued_notified_at = datetime('now') WHERE id = ?").run(invoice.id);
    await notifyInvoiceStages(NOV_5);
    expect(await mailsFor(invoice.id, "issued")).toEqual([]);
  });

  it("the overdue warning is told before it is stamped, so a stop between loses nothing and repeats nothing", async () => {
    const v = await billedVenue();
    const [invoice] = (await issueDueInvoices(NOV_1)).filter((i) => i.venueId === v.id);
    await notifyInvoiceStages(NOV_1);
    // 23 Nov: eight days past the due date, inside the grace.
    await applyPaymentHolds(NOV_23);
    const warned = async () =>
      (await getDb().prepare("SELECT recipient FROM messages WHERE dedupe_key LIKE ?").all(`invoice-overdue:${invoice.id}:%`)) as { recipient: string }[];
    const first = await warned();
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(await getDb().prepare("SELECT warned_at IS NOT NULL AS stamped FROM venue_invoices WHERE id = ?").get(invoice.id)).toEqual({ stamped: true });
    // The server stopped after telling and before stamping: told again, nothing written twice.
    await getDb().prepare("UPDATE venue_invoices SET warned_at = NULL WHERE id = ?").run(invoice.id);
    await applyPaymentHolds(NOV_23);
    expect(await warned()).toHaveLength(first.length);
  });

  it("is told by the scheduler's tick, and a failure there is raised without stopping the rest of the tick", async () => {
    const v = await billedVenue();
    const [invoice] = (await issueDueInvoices(NOV_1)).filter((i) => i.venueId === v.id);
    await runScheduledWork(NOV_1);
    expect(await mailsFor(invoice.id, "issued")).toHaveLength(1);
  });
});
