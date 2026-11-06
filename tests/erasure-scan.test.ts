import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import { ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { ANONYMOUS, eraseCustomer, exportCustomerData, pruneOldData, retentionDue } from "../src/lib/privacy";
import { createBooking, createCourt, createVenue, setPaymentStatus } from "../src/lib/store";
import { notifyBookingConfirmed } from "../src/lib/notify";
import { addDays, todayISO } from "../src/lib/time";
import { addEndpoint, sweepWebhookEvents } from "../src/lib/webhooks";

/**
 * After "forget me", where does the person still sit in the database? Scans every text column of every table for the account's
 * distinctive email, phone and name (audit 9, G6), and keeps what the law and the books need: the money.
 */
let venueId: number;
let courtId: number;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const v = await createVenue({ name: "Scan Hall", area: "PJ", address: "1", phone: "0312345678" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "C1", sport: "badminton", offPeakRate: 40, peakRate: 40 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
});

const NEEDLES = ["needle.quokka", "Needle Quokka", "Quokka", "98887766"];

async function hitsOf(needles: string[]): Promise<string[]> {
  const db = getDb();
  const cols = (await db
    .prepare(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type IN ('text','character varying','jsonb','json','citext')`
    )
    .all()) as { table_name: string; column_name: string }[];
  const hits: string[] = [];
  for (const { table_name, column_name } of cols) {
    for (const needle of needles) {
      const r = (await db.prepare(`SELECT COUNT(*)::int AS n FROM "${table_name}" WHERE "${column_name}"::text ILIKE ?`).get(`%${needle}%`)) as { n: number };
      if (r.n > 0) hits.push(`${table_name}.${column_name} contains "${needle}" x${r.n}`);
    }
  }
  return hits;
}

describe("erasure leaves no trace of the person", () => {
  it("their email, phone and name are in no table after the account is closed, and the money stays", async () => {
    const email = "needle.quokka@example.my";
    const phone = "0198887766";
    const made = await registerUser({ name: "Needle Quokka", email, phone, password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    const u = made.user;
    const b = await createBooking({ courtId, date: addDays(todayISO(), 5), hours: [10], name: "Needle Quokka", phone, email, userId: u.id });
    if (!b.ok) throw new Error(JSON.stringify(b));
    await setPaymentStatus(b.booking.code, true, "cash");
    // A deposit the customer paid online (as tests/erasure-money.test.ts sets one up).
    const pay = (await getDb()
      .prepare(
        `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, status, payer_name, payer_phone, purpose)
         VALUES ('billplz', 'bp_scan_1', 'https://x', ?, 10, 'paid', 'Needle Quokka', ?, 'booking') RETURNING id`
      )
      .get(venueId, phone)) as { id: number };
    await getDb().prepare("INSERT INTO online_payment_bookings (payment_id, booking_id, amount) VALUES (?, ?, 10)").run(pay.id, b.booking.id);
    // A top-up they made for themselves, and a payment that is not theirs (another customer's, with their own name and number).
    await getDb()
      .prepare(
        `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, status, payer_name, payer_phone, purpose, topup_user_id)
         VALUES ('billplz', 'bp_scan_2', 'https://x', ?, 25, 'paid', 'Needle Quokka', ?, 'topup', ?)`
      )
      .run(venueId, phone, u.id);
    await getDb()
      .prepare(
        `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, status, payer_name, payer_phone, purpose)
         VALUES ('billplz', 'bp_scan_other', 'https://x', ?, 12, 'paid', 'Somebody Else', '0111112222', 'booking')`
      )
      .run(venueId);
    await notifyBookingConfirmed([b.booking], "en", null);
    // A message to their account that has not gone yet: it must never be sent after.
    await getDb()
      .prepare(
        `INSERT INTO messages (kind, channel, recipient, locale, subject, body, status, dedupe_key)
         VALUES ('programme', 'email', ?, 'en', 'Hello Needle Quokka', 'Hi Needle Quokka, see you', 'queued', 'scan-queued-1')`
      )
      .run(email);
    // And a notice of a cancellation by the venue, with their name and number on it.
    await getDb()
      .prepare(
        `INSERT INTO urgent_notices (venue_id, booking_id, kind, name, phone, email, date, start_min, summary, ack_token)
         VALUES (?, ?, 'cancelled', 'Needle Quokka', ?, ?, ?, 600, 'Needle Quokka, 10:00, Court C1', 'scan-ack-1')`
      )
      .run(venueId, b.booking.id, phone, email, addDays(todayISO(), 5));
    await addEndpoint(venueId, "https://example.com/hook");
    await sweepWebhookEvents();
    const sentBefore = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE status = 'sent'").get()) as { n: number }).n;

    expect(await eraseCustomer(u.id)).toMatchObject({ ok: true });

    expect(await hitsOf(NEEDLES)).toEqual([]);
    const db = getDb();
    // The money stays: amounts, the rows, who it was for in the books are not the person.
    const kept = (await db.prepare("SELECT bill_id, amount::float AS amount, payer_name, payer_phone FROM online_payments WHERE bill_id IN ('bp_scan_1', 'bp_scan_2') ORDER BY bill_id").all()) as {
      bill_id: string; amount: number; payer_name: string | null; payer_phone: string | null;
    }[];
    expect(kept).toEqual([
      { bill_id: "bp_scan_1", amount: 10, payer_name: ANONYMOUS, payer_phone: null },
      { bill_id: "bp_scan_2", amount: 25, payer_name: ANONYMOUS, payer_phone: null },
    ]);
    // Somebody else's payment is not touched, and nothing in the erasure sent anything.
    expect(await db.prepare("SELECT payer_name, payer_phone FROM online_payments WHERE bill_id = 'bp_scan_other'").get()).toEqual({ payer_name: "Somebody Else", payer_phone: "0111112222" });
    // The queued message is given up (never sent), the sent ones keep that they were.
    const queued = (await db.prepare("SELECT status, recipient, body FROM messages WHERE dedupe_key = 'scan-queued-1'").get()) as { status: string; recipient: string; body: string };
    expect(queued).toEqual({ status: "abandoned", recipient: ANONYMOUS, body: ANONYMOUS });
    expect(((await db.prepare("SELECT COUNT(*)::int AS n FROM messages WHERE status = 'sent'").get()) as { n: number }).n).toBe(sentBefore);
    expect(((await db.prepare("SELECT COUNT(*)::int AS n FROM messages WHERE status IN ('queued','failed') AND recipient = ?").get(ANONYMOUS)) as { n: number }).n).toBe(0);
    // The notice stays as the venue's record of having told, nobody named on it.
    expect(await db.prepare("SELECT name, phone, email FROM urgent_notices WHERE ack_token = 'scan-ack-1'").get()).toEqual({ name: ANONYMOUS, phone: "", email: null });
  });

  it("webhook deliveries about their bookings: the unsent are dropped, the sent keep only that they were; others' stay", async () => {
    const email = "needle.quokka2@example.my";
    const phone = "0198887711";
    const made = await registerUser({ name: "Webhook Wombat", email, phone, password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    const mine = await createBooking({ courtId, date: addDays(todayISO(), 7), hours: [11], name: "Webhook Wombat", phone, email, userId: made.user.id });
    const other = await createBooking({ courtId, date: addDays(todayISO(), 7), hours: [12], name: "Guest Gecko", phone: "0191112233", email: "gecko@example.my" });
    if (!mine.ok || !other.ok) throw new Error("booking");
    const db = getDb();
    const ep = (await db.prepare("SELECT id FROM webhook_endpoints WHERE venue_id = ? LIMIT 1").get(venueId)) as { id: number };
    const payload = (code: string, name: string) => JSON.stringify({ id: "evt_x", type: "booking.created", created: "2026-01-01T00:00:00Z", data: { booking: { code, name, phone, email } } });
    const add = async (code: string, name: string, sent: boolean) =>
      (await db
        .prepare(`INSERT INTO webhook_deliveries (endpoint_id, event, payload, delivered_at, attempts) VALUES (?, 'booking.created', ?, ${sent ? "datetime('now')" : "NULL"}, ${sent ? 1 : 0}) RETURNING id`)
        .get(ep.id, payload(code, name))) as { id: number };
    const pending = await add(mine.booking.code, "Webhook Wombat", false);
    const delivered = await add(mine.booking.code, "Webhook Wombat", true);
    const others = await add(other.booking.code, "Guest Gecko", false);
    expect(await eraseCustomer(made.user.id)).toMatchObject({ ok: true });
    expect(await db.prepare("SELECT 1 FROM webhook_deliveries WHERE id = ?").get(pending.id)).toBeUndefined();
    const scrubbed = (await db.prepare("SELECT payload FROM webhook_deliveries WHERE id = ?").get(delivered.id)) as { payload: string };
    expect(JSON.parse(scrubbed.payload)).toEqual({ id: "evt_x", type: "booking.created", created: "2026-01-01T00:00:00Z", erased: true });
    expect(((await db.prepare("SELECT payload FROM webhook_deliveries WHERE id = ?").get(others.id)) as { payload: string }).payload).toContain("Guest Gecko");
  });
});

describe("the retention run anonymises the payer of an old online payment, keeping the payment", () => {
  it("after the booking-names period, not before", async () => {
    const db = getDb();
    const row = async (bill: string, age: number) => {
      await db
        .prepare(
          `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, status, payer_name, payer_phone, purpose, created_at)
           VALUES ('billplz', ?, 'https://x', ?, 30, 'paid', 'Old Payer', '0177776666', 'booking', datetime('now', ?))`
        )
        .run(bill, venueId, `-${age} days`);
    };
    await row("bp_old_1", 800);
    await row("bp_new_1", 100);
    const due = (await retentionDue()).find((l) => l.what.includes("Payer names"));
    expect(due?.affected).toBeGreaterThanOrEqual(1);
    await pruneOldData();
    expect(await db.prepare("SELECT payer_name, payer_phone, amount::float AS amount FROM online_payments WHERE bill_id = 'bp_old_1'").get()).toEqual({ payer_name: ANONYMOUS, payer_phone: null, amount: 30 });
    expect(await db.prepare("SELECT payer_name, payer_phone FROM online_payments WHERE bill_id = 'bp_new_1'").get()).toEqual({ payer_name: "Old Payer", payer_phone: "0177776666" });
  });
});

describe("the data export holds the person's payments and what venues' systems were sent", () => {
  it("includes their online payments with the payer, and the deliveries about their bookings", async () => {
    const email = "export.emu@example.my";
    const phone = "0198887722";
    const made = await registerUser({ name: "Export Emu", email, phone, password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    const b = await createBooking({ courtId, date: addDays(todayISO(), 8), hours: [13], name: "Export Emu", phone, email, userId: made.user.id });
    if (!b.ok) throw new Error("booking");
    const db = getDb();
    const pay = (await db
      .prepare(`INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, status, payer_name, payer_phone, purpose) VALUES ('billplz', 'bp_export_1', 'https://x', ?, 15, 'paid', 'Export Emu', ?, 'booking') RETURNING id`)
      .get(venueId, phone)) as { id: number };
    await db.prepare("INSERT INTO online_payment_bookings (payment_id, booking_id, amount) VALUES (?, ?, 15)").run(pay.id, b.booking.id);
    const ep = (await db.prepare("SELECT id FROM webhook_endpoints WHERE venue_id = ? LIMIT 1").get(venueId)) as { id: number };
    await db
      .prepare("INSERT INTO webhook_deliveries (endpoint_id, event, payload) VALUES (?, 'booking.created', ?)")
      .run(ep.id, JSON.stringify({ id: "evt_e", type: "booking.created", data: { booking: { code: b.booking.code, name: "Export Emu" } } }));
    const out = (await exportCustomerData(made.user.id))!;
    expect(out.onlinePayments).toEqual([expect.objectContaining({ bill_id: "bp_export_1", payer_name: "Export Emu", payer_phone: phone, amount: 15 })]);
    expect(out.webhookDeliveries).toHaveLength(1);
    expect(JSON.stringify(out.webhookDeliveries)).toContain(b.booking.code);
  });
});

/**
 * A new table that holds a person's details (an email, a number, a payer, a recipient, a holder's or contact's name, a payload) must be
 * considered for erasure and retention when it is added: it fails here until it is named, with how the person comes out of it.
 * The scan above catches a table that holds the account in the data this test makes; this catches one nobody thought to make data for.
 */
const HOLDS_PEOPLE: Record<string, string> = {
  account_bookers: "erased with the person (lib/privacy.ts eraseCustomer)",
  approval_requests: "erased (lib/approvals.ts eraseApprovals) and by its own retention (lib/approval-retention.ts)",
  bookings: "anonymised on erasure and after bookingIdentityDays",
  coaches: "a venue's staff member's contact, not a customer's",
  concession_proofs: "erased with the person",
  counter_sales: "the venue's counter record: the receipt's names are cleared (lib/receipt-names.ts) with the booking's",
  customer_notes: "erased with the person; a venue's note kept against a number",
  e_invoices: "the buyer's details are the legal record, kept for the statutory period (lib/myinvois.ts), account or not",
  einvoice_settings: "the venue's own details",
  entries: "anonymised on erasure; retention after checkInDays",
  gift_vouchers: "the venue's record of a voucher sold; buyer's details by the venue's own retention",
  guest_invitations: "an invitation by a resident to a guest: lib/guest-invites.ts, short-lived",
  hire_enquiries: "erased with the person; retention after enquiryDays",
  inductions: "a venue's record against a number; withdrawn ones go after revokedInductionDays",
  ladder_players: "off every ladder on erasure (lib/ladders.ts forgetLadderPlayer)",
  league_players: "off every league on erasure (lib/leagues.ts forgetLeaguePlayer)",
  loyalty_rewards: "keyed by a phone key only, no name; goes with the venue",
  marketing_consents: "erased with the person",
  memberships: "holder anonymised on erasure",
  messages: "scrubbed on erasure (lib/erasure-traces.ts); deleted after messageDays",
  online_payments: "payer anonymised on erasure (lib/erasure-traces.ts) and after bookingIdentityDays; the money row stays",
  participant_guardians: "ended on erasure (lib/managed-people.ts)",
  passes: "holder anonymised on erasure",
  password_reset_requests: "a one-use link, deleted when used or expired",
  phone_codes: "deleted after phoneCodeDays",
  player_invitations: "an invitation to play, expires (lib/player-invitations.ts)",
  receipts: "customer names cleared on erasure and after bookingIdentityDays; amounts kept for the books",
  registration_requests: "a one-use link, deleted when used or expired",
  sign_offs: "a venue's record against a number; revoked ones go after revokedInductionDays",
  staff_invitations: "a member of staff's invitation, not a customer's",
  strike_forgiveness: "keyed by a phone key only, no name; goes with the venue",
  team_invitations: "an invitation to a team, expires (lib/teams.ts)",
  tournament_entries: "off every draw by name on erasure",
  urgent_notices: "anonymised on erasure (lib/erasure-traces.ts)",
  user_identities: "deleted with the account",
  users: "deleted on erasure",
  venue_access_list: "a venue's list of who it is for, against a number; an entry's expiry removes it",
  venue_accounts: "a company's account: its contact is the business's, not a customer's",
  venue_applications: "an applicant's, not a customer's; unconfirmed ones go after unconfirmedApplicationDays",
  venue_blocked_phones: "a venue's refusal of a number, with its reason",
  venue_reviews: "erased with the person",
  venues: "the venue's own details",
  waitlist: "off every waiting list on erasure; retention after waitlistDays",
  waiver_signatures: "kept by the venue against a number as its record of what was signed",
  webhook_deliveries: "scrubbed on erasure (lib/erasure-traces.ts); deleted after webhookDeliveryDays",
};

describe("every table that holds a person's details is accounted for", () => {
  it("names how erasure or retention treats each, so a new one cannot be forgotten", async () => {
    const rows = (await getDb()
      .prepare(
        `SELECT DISTINCT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND data_type IN ('text','character varying','jsonb','json','citext')
            AND column_name ~ '(^|_)(email|phone|payer|recipient|holder_name|customer_name|contact_name|contact_phone|guardian_name|payload)'
          ORDER BY 1`
      )
      .all()) as { table_name: string }[];
    const unknown = rows.map((r) => r.table_name).filter((t) => !(t in HOLDS_PEOPLE));
    expect(unknown, "a table with a person's details: say in HOLDS_PEOPLE how erasure and retention treat it, and make them do it").toEqual([]);
    const gone = Object.keys(HOLDS_PEOPLE).filter((t) => !rows.some((r) => r.table_name === t));
    expect(gone, "named here but no longer a table with such columns").toEqual([]);
  });
});
