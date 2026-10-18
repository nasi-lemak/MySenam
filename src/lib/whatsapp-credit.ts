import { getDb } from "./db";
import { createBill } from "./billplz";
import { platformAccount } from "./billing";
import { isMarketplace } from "./mode";
import { baseUrl, chatRepliesOn, transportOverridden } from "./outbox";
import { siteName } from "./site";
import { sendPlainEmail, whatsappConfig } from "./transports";

/**
 * WhatsApp, for the venues that want it, paid for before it is sent.
 *
 * Email is the default: it costs next to nothing, it carries a calendar
 * invite, and the booking code is on the screen the moment a booking is made
 * anyway. A venue can switch WhatsApp on as well. Meta charges the platform
 * for every message, so on a marketplace a venue buys messages in packs
 * first, and each one sent spends one. At zero, nothing more goes on
 * WhatsApp — the customer still has the email and the code on screen — and
 * the venue is told. The platform never sends a message it has not been paid
 * for, so a venue that stops paying costs nothing.
 *
 * A venue's own install has no marketplace to pay: it pays Meta itself, and
 * switching WhatsApp on is all it takes.
 */

/** Messages in a pack (MYSENAM_WHATSAPP_PACK, default 200). */
export function packSize(): number {
  const n = Number(process.env.MYSENAM_WHATSAPP_PACK ?? 200);
  return Number.isInteger(n) && n > 0 && n <= 100_000 ? n : 200;
}

/** What a pack costs, in ringgit (MYSENAM_WHATSAPP_PACK_PRICE, default 20). */
export function packPrice(): number {
  const n = Number(process.env.MYSENAM_WHATSAPP_PACK_PRICE ?? 20);
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : 20;
}

/** When a venue is told its credit is running low. */
export const LOW_CREDIT = 20;

/** Whether WhatsApp is paid for in advance here: on a marketplace, yes. */
export function creditsApply(): boolean {
  return isMarketplace();
}

/** Whether this install can send WhatsApp at all. */
export function whatsappAvailable(): boolean {
  return whatsappConfig() !== null || process.env.MYSENAM_SEND === "log" || transportOverridden();
}

export async function creditBalance(venueId: number): Promise<number> {
  const { n } = (await getDb()
    .prepare("SELECT COALESCE(SUM(delta), 0)::int AS n FROM whatsapp_credit WHERE venue_id = ?")
    .get(venueId)) as { n: number };
  return n;
}

export async function whatsappOn(venueId: number): Promise<boolean> {
  const row = (await getDb().prepare("SELECT whatsapp_on FROM venues WHERE id = ?").get(venueId)) as { whatsapp_on: number } | undefined;
  return row?.whatsapp_on === 1;
}

/** Day-before reminders on WhatsApp as well as email: each costs a message, so the venue chooses. */
export async function whatsappReminders(venueId: number): Promise<boolean> {
  const row = (await getDb().prepare("SELECT whatsapp_reminders FROM venues WHERE id = ?").get(venueId)) as { whatsapp_reminders: number } | undefined;
  return row?.whatsapp_reminders === 1;
}

export async function setWhatsappReminders(venueId: number, on: boolean): Promise<void> {
  await getDb().prepare("UPDATE venues SET whatsapp_reminders = ? WHERE id = ?").run(on ? 1 : 0, venueId);
}

export async function setWhatsappOn(venueId: number, on: boolean): Promise<void> {
  await getDb().prepare("UPDATE venues SET whatsapp_on = ? WHERE id = ?").run(on ? 1 : 0, venueId);
}

/**
 * Whether this venue's messages are written for WhatsApp: switched on and, on
 * a marketplace, with credit left. One written before the site's WhatsApp
 * account is connected waits in the queue, with the reason, like any other.
 */
export async function whatsappReady(venueId: number): Promise<boolean> {
  if (!(await whatsappOn(venueId))) return false;
  return !creditsApply() || (await creditBalance(venueId)) > 0;
}

/** The "Send it to my WhatsApp" button, for this venue's confirmations. */
export async function chatOfferedFor(venueId: number): Promise<boolean> {
  return chatRepliesOn() && whatsappAvailable() && (await whatsappReady(venueId));
}

/**
 * Spend one message, before it is sent. False when there is none to spend,
 * and the message must not go. Not counted at all on a venue's own install.
 */
export async function spendCredit(venueId: number, messageId: number | null): Promise<boolean> {
  if (!creditsApply()) return true;
  const spent = await getDb()
    .prepare(
      `INSERT INTO whatsapp_credit (venue_id, delta, reason, message_id)
       SELECT ?, -1, 'sent', ? WHERE (SELECT COALESCE(SUM(delta), 0) FROM whatsapp_credit WHERE venue_id = ?) > 0`
    )
    .run(venueId, messageId, venueId);
  if (spent.changes === 0) return false;
  const left = await creditBalance(venueId);
  if (left === LOW_CREDIT || left === 0) await warnVenue(venueId, left);
  return true;
}

/** Give back a message that was spent but could not be sent. */
export async function refundCredit(venueId: number, messageId: number | null): Promise<void> {
  if (!creditsApply()) return;
  await getDb()
    .prepare("INSERT INTO whatsapp_credit (venue_id, delta, reason, message_id) VALUES (?, 1, 'not sent', ?)")
    .run(venueId, messageId);
}

/** The venue's staff, told by email that WhatsApp credit is low or gone. */
async function warnVenue(venueId: number, left: number): Promise<void> {
  const db = getDb();
  const venue = (await db.prepare("SELECT name FROM venues WHERE id = ?").get(venueId)) as { name: string } | undefined;
  const staff = (await db
    .prepare(
      `SELECT email FROM admins WHERE venue_id = ?
        OR business_id = (SELECT business_id FROM venues WHERE id = ? AND business_id IS NOT NULL)`
    )
    .all(venueId, venueId)) as { email: string }[];
  const subject =
    left === 0
      ? `${venue?.name ?? "Your venue"}: WhatsApp credit used up`
      : `${venue?.name ?? "Your venue"}: ${left} WhatsApp messages left`;
  const text =
    (left === 0
      ? "Your customers' confirmations now go by email only, and the booking code is still shown on screen. "
      : `Only ${left} WhatsApp messages are left. When they run out, confirmations go by email only. `) +
    `Buy more under Venue details → WhatsApp at ${baseUrl()}/admin.`;
  for (const s of staff) await sendPlainEmail(s.email, subject, text);
}

// ------------------------------------------------------------------- packs

export type PackStatus = "due" | "paid" | "void";

export interface Pack {
  id: number;
  venueId: number;
  messages: number;
  amount: number;
  status: PackStatus;
  createdAt: string;
  paidAt: string | null;
  paidVia: "online" | "manual" | null;
}

interface PackRow {
  id: number;
  venue_id: number;
  messages: number;
  amount: number | string;
  status: PackStatus;
  created_at: string;
  paid_at: string | null;
  paid_via: "online" | "manual" | null;
}

const toPack = (r: PackRow): Pack => ({
  id: r.id,
  venueId: r.venue_id,
  messages: r.messages,
  amount: Number(r.amount),
  status: r.status,
  createdAt: r.created_at,
  paidAt: r.paid_at,
  paidVia: r.paid_via,
});

export async function packById(id: number): Promise<Pack | null> {
  const row = (await getDb().prepare("SELECT * FROM whatsapp_packs WHERE id = ?").get(id)) as PackRow | undefined;
  return row ? toPack(row) : null;
}

export async function listPacks(venueId: number, limit = 20): Promise<Pack[]> {
  return (
    (await getDb().prepare("SELECT * FROM whatsapp_packs WHERE venue_id = ? ORDER BY id DESC LIMIT ?").all(venueId, limit)) as PackRow[]
  ).map(toPack);
}

/** Order a pack, at today's size and price; it is credited once paid. One unpaid at a time. */
export async function orderPack(venueId: number, adminId: number | null): Promise<Pack> {
  const db = getDb();
  const open = (await db.prepare("SELECT * FROM whatsapp_packs WHERE venue_id = ? AND status = 'due' ORDER BY id DESC LIMIT 1").get(venueId)) as
    | PackRow
    | undefined;
  if (open) return toPack(open);
  const info = await db
    .prepare("INSERT INTO whatsapp_packs (venue_id, messages, amount, created_by) VALUES (?, ?, ?, ?)")
    .run(venueId, packSize(), packPrice(), adminId);
  return (await packById(info.lastInsertRowid as number))!;
}

/** Paid: the messages are the venue's. Once, however often it is said. */
export async function settlePack(packId: number, via: "online" | "manual", adminId: number | null = null): Promise<boolean> {
  const db = getDb();
  return db.transaction(async () => {
    const claimed = await db
      .prepare("UPDATE whatsapp_packs SET status = 'paid', paid_at = datetime('now'), paid_via = ? WHERE id = ? AND status = 'due'")
      .run(via, packId);
    if (claimed.changes === 0) return false;
    const pack = (await packById(packId))!;
    await db
      .prepare("INSERT INTO whatsapp_credit (venue_id, delta, reason, pack_id, admin_id) VALUES (?, ?, 'pack', ?, ?)")
      .run(pack.venueId, pack.messages, pack.id, adminId);
    return true;
  })();
}

export async function voidPack(packId: number): Promise<boolean> {
  const done = await getDb().prepare("UPDATE whatsapp_packs SET status = 'void' WHERE id = ? AND status = 'due'").run(packId);
  return done.changes === 1;
}

/** Messages given by the platform owner — a trial, an apology. */
export async function grantCredit(venueId: number, messages: number, adminId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Number.isInteger(messages) || messages === 0 || Math.abs(messages) > 100_000)
    return { ok: false, error: "How many messages? A whole number, not 0." };
  if (messages < 0 && (await creditBalance(venueId)) + messages < 0) return { ok: false, error: "That would take the balance below zero." };
  await getDb()
    .prepare("INSERT INTO whatsapp_credit (venue_id, delta, reason, admin_id) VALUES (?, ?, 'granted', ?)")
    .run(venueId, messages, adminId);
  return { ok: true };
}

export type PayPackResult = { ok: true; url: string } | { ok: false; error: string; status: number };

/** Pay for a pack online, into the platform's own account. */
export async function payPackOnline(packId: number, payer: { name: string; email: string }): Promise<PayPackResult> {
  const pack = await packById(packId);
  if (!pack) return { ok: false, error: "Not found.", status: 404 };
  if (pack.status !== "due") return { ok: false, error: "That pack is not waiting to be paid.", status: 409 };
  const account = platformAccount();
  if (!account) return { ok: false, error: "Paying online is not set up. Pay by bank transfer and ask for the pack to be marked paid.", status: 409 };
  const db = getDb();
  const existing = (await db
    .prepare(
      "SELECT url FROM online_payments WHERE purpose = 'pack' AND pack_id = ? AND status = 'pending' AND created_at > datetime('now', '-1 day') ORDER BY id DESC LIMIT 1"
    )
    .get(packId)) as { url: string } | undefined;
  if (existing) return { ok: true, url: existing.url };
  const venue = (await db.prepare("SELECT name FROM venues WHERE id = ?").get(pack.venueId)) as { name: string };
  let bill;
  try {
    bill = await createBill(account, {
      amount: pack.amount,
      name: payer.name,
      email: payer.email,
      description: `${siteName()}: ${pack.messages} WhatsApp messages for ${venue.name}`,
      callbackUrl: `${baseUrl()}/api/payments/billplz/callback`,
      redirectUrl: `${baseUrl()}/payments/return`,
      reference: { label: "WhatsApp", value: `${venue.name} pack ${pack.id}` },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The payment page could not be opened.", status: 502 };
  }
  await db
    .prepare(
      `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, purpose, pack_id)
       VALUES ('billplz', ?, ?, ?, ?, ?, 'pack', ?)`
    )
    .run(bill.id, bill.url, pack.venueId, pack.amount, payer.name, packId);
  return { ok: true, url: bill.url };
}
