import { getDb } from "./db";
import { releaseBooking } from "./claims";
import { addDays, todayISO } from "./time";
import { deleteStaleDrafts, STALE_DRAFT_DAYS, staleDrafts } from "./drafts";
import { bookingCancelled, forgetPlayer } from "./games";
import { withdraw } from "./tournaments";
import { forgetLeaguePlayer } from "./leagues";
import { removeVenuePhotoFiles } from "./photos";
import { money } from "./region";

/**
 * Personal data: what is kept, for how long, and how somebody gets it back or
 * gets rid of it.
 *
 * Malaysia's PDPA gives a person the right to see what is held about them and
 * to have it corrected or removed, and it expects data to be kept no longer
 * than the purpose needs. Three obligations follow, and each is a function
 * here: export, erasure, and retention.
 *
 * The hard part is not the deleting. It is that a booking is *also* the
 * venue's accounting record, so "forget me" cannot mean "make the takings
 * disappear". Erasure therefore anonymises rather than deletes: the money and
 * the hour survive, the person does not.
 *
 * The second hard part is deciding what counts as *theirs*. A phone number is
 * not identity here — nothing verifies it, so anybody can register an account
 * claiming any number. Keying on it would let somebody register with a
 * stranger's number and then read that stranger's history, or cancel their
 * courts. So both export and erasure follow `user_id` and nothing else.
 * Anything sold across a counter to a phone number — a pass, a membership, an
 * induction — is reachable through the venue, which checks who it is talking
 * to in person.
 */

/** How long each kind of record lives once it stops being operationally useful. */
export const RETENTION = {
  /**
   * Door codes tie a named person to a time and a building. It is the most
   * sensitive thing here and the least useful once an incident window has
   * passed, so it goes first.
   */
  accessRevealDays: 180,
  /** Arrivals, once the day they belong to is long gone. */
  checkInDays: 365,
  /** Queue entries that were claimed, expired or cancelled. */
  waitlistDays: 90,
  /**
   * WhatsApp and email messages, once sent or given up on. Each one carries a
   * phone number or address and a body that names the customer, and there is
   * one or more for every booking: kept for ever, it is both the biggest
   * table and the most personal. Long enough to answer "did they get it?".
   */
  messageDays: 90,
  /** What was sent to a venue's own systems, delivered or given up on: each carries a booking, name and all. */
  webhookDeliveryDays: 30,
  /** A booking stops naming anybody after this, but its money stays. */
  bookingIdentityDays: 730,
  /** Withdrawn out-of-hours access, kept a while in case it is disputed. */
  revokedInductionDays: 365,
  /**
   * A venue application whose emailed link was never followed: somebody's
   * name, email and password hash, with nobody shown to want it kept.
   */
  unconfirmedApplicationDays: 7,
  /** A private hire enquiry: answered long since, or never will be. */
  enquiryDays: 365,
  /**
   * A phone check's code or link, used or not: a number, and who claimed it.
   * Only the last day's count matters (the daily caps).
   */
  phoneCodeDays: 1,
  /**
   * A supporting document sent with an application to be approved for an
   * activity (a certificate, lib/approvals.ts), once the application is
   * decided: long enough to answer a question about the decision; what was
   * seen stays on the sign-off it wrote.
   */
  approvalDocumentDays: 90,
  /** An application refused, withdrawn or lapsed, or an approval that has run out: its answers and history. */
  approvalRequestDays: 365,
} as const;

export interface RetentionLine {
  what: string;
  /** Days after which the record, or the person inside it, goes. */
  days: number;
  /** What actually happens when the clock runs out. */
  action: "deleted" | "anonymised";
  affected: number;
}

/** What a booking's customer is called once nobody is entitled to know. */
export const ANONYMOUS = "(removed)";

/**
 * One line of the policy: which rows are due, and what happens to them.
 *
 * Counting what is due and acting on it share the same `where`, so the
 * screen that says what a prune will do cannot drift from what it does.
 * Every `where` compares a stored timestamp with a date directly — text in
 * 'YYYY-MM-DD HH:MM:SS' sorts by time, so `< '2026-01-01'` means "before that
 * day" — which lets an index answer it (see db/migrations/0002).
 */
interface Rule {
  what: string;
  days: number;
  action: RetentionLine["action"];
  table: string;
  where: string;
  /** For an anonymising rule: what the matching rows become. */
  set?: string;
}

const RULES: Rule[] = [
  {
    what: "Phone check codes",
    days: RETENTION.phoneCodeDays,
    action: "deleted",
    table: "phone_codes",
    where: "created_at < ?",
  },
  {
    what: "Private hire enquiries",
    days: RETENTION.enquiryDays,
    action: "deleted",
    table: "hire_enquiries",
    where: "created_at < ?",
  },
  {
    what: "Door codes shown",
    days: RETENTION.accessRevealDays,
    action: "deleted",
    table: "access_reveals",
    where: "revealed_at < ?",
  },
  {
    what: "Arrivals at the desk",
    days: RETENTION.checkInDays,
    action: "deleted",
    table: "check_ins",
    where: "checked_in_at < ?",
  },
  {
    what: "Settled waiting-list entries",
    days: RETENTION.waitlistDays,
    action: "deleted",
    table: "waitlist",
    where: "status IN ('claimed','expired','cancelled') AND created_at < ?",
  },
  {
    what: "Messages sent to customers",
    days: RETENTION.messageDays,
    action: "deleted",
    table: "messages",
    // Never one still waiting to go.
    where: "status IN ('sent','abandoned') AND created_at < ?",
  },
  {
    what: "Webhook deliveries to venues' systems",
    days: RETENTION.webhookDeliveryDays,
    action: "deleted",
    table: "webhook_deliveries",
    // Delivered, or tried as often as it will be; never one still to go.
    where: "(delivered_at IS NOT NULL OR attempts >= 8) AND created_at < ?",
  },
  {
    what: "Names and numbers on old bookings",
    days: RETENTION.bookingIdentityDays,
    action: "anonymised",
    table: "bookings",
    // The literal, not a parameter, so the planner can use the partial index
    // that holds only bookings still naming somebody.
    where: `date < ? AND name <> '${ANONYMOUS}'`,
    // The booking survives — its price is the venue's record. The person in
    // it does not.
    set: `name = '${ANONYMOUS}', phone = '', email = NULL, check_in_token = NULL`,
  },
  {
    what: "Names and numbers on old receipts",
    days: RETENTION.bookingIdentityDays,
    action: "anonymised",
    table: "receipts",
    where: `issued_at < ? AND customer_name <> '${ANONYMOUS}'`,
    // Kept for the books, like the bookings: what was sold and the tax on it.
    set: `customer_name = '${ANONYMOUS}', customer_phone = NULL, user_id = NULL`,
  },
  {
    what: "Withdrawn out-of-hours access",
    days: RETENTION.revokedInductionDays,
    action: "deleted",
    table: "inductions",
    where: "revoked_at IS NOT NULL AND revoked_at < ?",
  },
  {
    what: "Withdrawn activity sign-offs",
    days: RETENTION.revokedInductionDays,
    action: "deleted",
    table: "sign_offs",
    where: "revoked_at IS NOT NULL AND revoked_at < ?",
  },
  {
    what: "Documents sent with activity applications, once decided",
    days: RETENTION.approvalDocumentDays,
    action: "deleted",
    table: "approval_documents",
    where: "request_id IN (SELECT id FROM approval_requests WHERE decided_at IS NOT NULL AND decided_at < ?::timestamptz)",
  },
  {
    what: "Activity applications refused, withdrawn or lapsed",
    days: RETENTION.approvalRequestDays,
    action: "deleted",
    table: "approval_requests",
    where: "status IN ('rejected', 'withdrawn', 'expired') AND decided_at < ?::timestamptz",
  },
  {
    what: "Activity approvals that ran out",
    days: RETENTION.approvalRequestDays,
    action: "deleted",
    table: "approval_requests",
    where: "status = 'approved' AND valid_until IS NOT NULL AND valid_until < ?",
  },
  {
    what: "Venue applications never confirmed by email",
    days: RETENTION.unconfirmedApplicationDays,
    action: "deleted",
    table: "venue_applications",
    where: "email_check = 'waiting' AND created_at < ?",
  },
];

/** What a prune would do right now, without doing it. */
export async function retentionDue(): Promise<RetentionLine[]> {
  const db = getDb();
  const today = todayISO();
  const count = async (sql: string, ...args: unknown[]) =>
    (await db.prepare(sql).get(...args) as { n: number }).n;

  const lines: RetentionLine[] = [];
  for (const rule of RULES)
    lines.push({
      what: rule.what,
      days: rule.days,
      action: rule.action,
      affected: await count(`SELECT COUNT(*) AS n FROM ${rule.table} WHERE ${rule.where}`, addDays(today, -rule.days)),
    });
  lines.push({
    what: `Draft venues never live, nobody signed in for ${STALE_DRAFT_DAYS} days`,
    days: STALE_DRAFT_DAYS,
    action: "deleted",
    affected: (await staleDrafts()).length,
  });
  lines.push({
    what: "Expired sign-in sessions",
    days: 0,
    action: "deleted",
    affected:
      (await count("SELECT COUNT(*) AS n FROM sessions WHERE expires_at < datetime('now')")) +
      (await count("SELECT COUNT(*) AS n FROM admin_sessions WHERE expires_at < datetime('now')")),
  });
  return lines;
}

export interface PruneResult {
  ranAt: string;
  lines: RetentionLine[];
  total: number;
}

/**
 * Apply the retention policy.
 *
 * At most once a day: from the scheduler's minute tick (lib/scheduler.ts),
 * and, where that is turned off, whenever staff open the dashboard.
 */
export async function pruneOldData(): Promise<PruneResult> {
  const db = getDb();
  const today = todayISO();
  const lines = await retentionDue();
  let photoKeys: string[] = [];

  await db.transaction(async () => {
    photoKeys = [];
    for (const rule of RULES) {
      const cutoff = addDays(today, -rule.days);
      await db
        .prepare(
          rule.set
            ? `UPDATE ${rule.table} SET ${rule.set} WHERE ${rule.where}`
            : `DELETE FROM ${rule.table} WHERE ${rule.where}`
        )
        .run(cutoff);
    }
    await deleteStaleDrafts(photoKeys);
    await db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
    await db.prepare("DELETE FROM admin_sessions WHERE expires_at < datetime('now')").run();
    // Shared rate-limit windows that have passed.
    await db.prepare("DELETE FROM rate_limits WHERE reset_at <= ?").run(Date.now());
    // Errors, 90 days after they last happened: long enough to see one is fixed.
    await db.prepare("DELETE FROM error_events WHERE last_at < ?").run(`${addDays(todayISO(), -90)} 00:00:00`);
    // The staff activity log: two years, long enough for any dispute or audit.
    await db.prepare("DELETE FROM staff_actions WHERE created_at < ?").run(`${addDays(todayISO(), -730)} 00:00:00`);
    // A guest let into a private venue until a date is not on its list after it.
    await db.prepare("DELETE FROM venue_access_list WHERE expires_on IS NOT NULL AND expires_on < ?").run(todayISO());
    await db.prepare(
      "INSERT INTO settings (key, value) VALUES ('retention_last_run', datetime('now'))" +
        " ON CONFLICT(key) DO UPDATE SET value = datetime('now')"
    ).run();
  })();
  // The photo files of drafts deleted, now the deletion has stuck.
  await removeVenuePhotoFiles(photoKeys);

  return {
    ranAt: new Date().toISOString(),
    lines,
    total: lines.reduce((n, l) => n + l.affected, 0),
  };
}

/** When the policy was last applied, or null if it never has been. */
export async function retentionLastRun(): Promise<string | null> {
  const row = await getDb()
    .prepare("SELECT value FROM settings WHERE key = 'retention_last_run'")
    .get() as { value: string } | undefined;
  return row?.value ?? null;
}

/** Run it if a day has passed, and say whether it did. */
export async function pruneIfDue(): Promise<PruneResult | null> {
  const last = await retentionLastRun();
  if (last !== null && Date.now() - Date.parse(`${last.replace(" ", "T")}Z`) < 86_400_000)
    return null;
  return await pruneOldData();
}

/* ---------------- What one person can ask for ---------------- */

export interface CustomerExport {
  takenAt: string;
  account: {
    id: number;
    name: string;
    email: string;
    phone: string;
    createdAt: string | null;
    phoneCheckedAt: string | null;
    /** Which games they said they play in: woman, man, or prefer not to say. */
    playsIn: string | null;
    /** The language their emails are written in: the one they last used the site in. */
    language: string | null;
  };
  /** Ways of signing in besides a password: which provider, and the email it gave. */
  signIns: unknown[];
  bookings: unknown[];
  wallet: { balance: number; entries: unknown[] };
  passes: unknown[];
  memberships: unknown[];
  doorCodesShown: unknown[];
  /** Open games they hosted or asked to join, and the levels they gave. */
  games: unknown[];
  levels: unknown[];
  /** How they like to play, who they blocked, reports they made, and their community groups. */
  matchmaking: { profile: unknown; blocks: unknown[]; reportsMade: unknown[]; groups: unknown[] };
  tournaments: unknown[];
  /** Leagues joined, and each season's box, finish and fee. */
  leagues: unknown[];
  /** Receipts and credit notes issued to this account. */
  receipts: unknown[];
  waitlist: unknown[];
  /** Gift vouchers turned into credit on this account. */
  vouchers: unknown[];
  /** Reviews of venues written from their bookings. */
  reviews: unknown[];
  /** Venues they agreed to hear from by email, in the words agreed to, and when they stopped. */
  marketing: unknown[];
  /** Concession proof a venue saw at its counter for their number: the fact and until when, no proof itself. */
  concessionProofs: unknown[];
  /** Notes venues' staff keep on their number (lib/customer-notes.ts). */
  staffNotes: unknown[];
  /** Private hire enquiries they sent from their number or address (lib/enquiries.ts). */
  enquiries: unknown[];
  /** Venues' waivers agreed to from their number: kept, as each venue's record of consent (lib/waivers.ts). */
  waivers: unknown[];
  /** Emails and WhatsApp messages about their bookings, or to their address, still kept. */
  messages: unknown[];
  /** Applications to be approved for an activity: answers, declarations, history and documents still held (lib/approvals.ts). */
  approvals: unknown[];
  /** Why this file is not quite everything, in the person's own terms. */
  heldAtACounter: string;
}

/**
 * Everything held about one signed-in customer, in one object.
 *
 * Keyed on the account *and* on the phone number it registered with, because
 * most of what a venue holds — a pass bought at the counter, a membership, an
 * induction — is filed against a number rather than a login.
 */
export async function exportCustomerData(userId: number): Promise<CustomerExport | null> {
  const db = getDb();
  const account = await db
    .prepare("SELECT id, name, email, phone, created_at, phone_verified_at, gender, locale FROM users WHERE id = ?")
    .get(userId) as
    | { id: number; name: string; email: string; phone: string; created_at: string | null; phone_verified_at: string | null; gender: string | null; locale: string | null }
    | undefined;
  if (!account) return null;

  const all = async (sql: string, ...args: unknown[]) => await db.prepare(sql).all(...args);

  return {
    takenAt: new Date().toISOString(),
    account: {
      id: account.id,
      name: account.name,
      email: account.email,
      phone: account.phone,
      createdAt: account.created_at ?? null,
      phoneCheckedAt: account.phone_verified_at ?? null,
      playsIn: account.gender ?? null,
      language: account.locale ?? null,
    },
    signIns: await all("SELECT provider, email, created_at FROM user_identities WHERE user_id = ?", userId),
    bookings: await all(
      `SELECT b.code, b.date, b.start_min, b.end_min, b.total_price, b.status,
              b.payment_status, b.created_at, c.name AS court, v.name AS venue
       FROM bookings b
       JOIN courts c ON c.id = b.court_id
       JOIN venues v ON v.id = c.venue_id
       WHERE b.user_id = ?
       ORDER BY b.date DESC`,
      userId
    ),
    wallet: {
      balance: (
        await db
          .prepare("SELECT COALESCE(SUM(amount), 0) AS balance FROM wallet_entries WHERE user_id = ?")
          .get(userId) as { balance: number }
      ).balance,
      entries: await all(
        "SELECT amount, reason, created_at FROM wallet_entries WHERE user_id = ? ORDER BY id",
        userId
      ),
    },
    passes: await all(
      `SELECT p.code, p.name, p.entries, p.price, p.expires_on, p.status, v.name AS venue
       FROM passes p JOIN venues v ON v.id = p.venue_id
       WHERE p.user_id = ?`,
      userId
    ),
    memberships: await all(
      `SELECT m.code, m.starts_on, m.expires_on, m.price, m.status, v.name AS venue
       FROM memberships m JOIN venues v ON v.id = m.venue_id
       WHERE m.user_id = ?`,
      userId
    ),
    doorCodesShown: await all(
      `SELECT r.revealed_at, b.code AS booking, c.name AS court
       FROM access_reveals r
       JOIN bookings b ON b.id = r.booking_id
       JOIN courts c ON c.id = b.court_id
       WHERE b.user_id = ?
       ORDER BY r.revealed_at DESC`,
      userId
    ),
    games: await all(
      `SELECT b.date, b.start_min, v.name AS venue, b.sport,
              CASE WHEN g.host_id = ? THEN 'host' ELSE p.status END AS role,
              g.share, p.paid_at AS share_paid_at, p.no_show
         FROM open_games g
         JOIN bookings b ON b.id = g.booking_id
         JOIN courts c ON c.id = b.court_id
         JOIN venues v ON v.id = c.venue_id
         LEFT JOIN open_game_players p ON p.game_id = g.id AND p.user_id = ?
        WHERE g.host_id = ? OR p.user_id = ?
        ORDER BY b.date DESC`,
      userId,
      userId,
      userId,
      userId
    ),
    levels: await all("SELECT sport, level, updated_at FROM player_levels WHERE user_id = ?", userId),
    matchmaking: {
      profile: (await all("SELECT * FROM player_profiles WHERE user_id = ?", userId))[0] ?? null,
      blocks: await all("SELECT u.name AS blocked, k.created_at FROM player_blocks k JOIN users u ON u.id = k.blocked_id WHERE k.blocker_id = ?", userId),
      reportsMade: await all("SELECT reason, note, status, created_at FROM player_reports WHERE reporter_id = ?", userId),
      groups: await all(
        "SELECT g.name, g.sport, m.role, m.status, m.created_at FROM group_members m JOIN community_groups g ON g.id = m.group_id WHERE m.user_id = ?",
        userId
      ),
    },
    tournaments: await all(
      `SELECT t.name AS tournament, t.starts_on, v.name AS venue, e.name AS entered_as, e.status, e.paid_at,
              e.birth_date AS declared_birth_date, e.partner_birth_date AS declared_partner_birth_date,
              e.guardian_name, e.guardian_consent_at, e.checked_in_at, e.eligibility_checked_at
         FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id JOIN venues v ON v.id = t.venue_id
        WHERE e.user_id = ? ORDER BY t.starts_on DESC`,
      userId
    ),
    leagues: await all(
      `SELECT l.name AS league, v.name AS venue, p.name AS playing_as, p.status, p.joined_at,
              s.number AS season, s.starts_on, lp.box_no, lp.finish, lp.move, lp.paid_at
         FROM league_players p
         JOIN leagues l ON l.id = p.league_id
         JOIN venues v ON v.id = l.venue_id
         LEFT JOIN league_places lp ON lp.player_id = p.id
         LEFT JOIN league_seasons s ON s.id = lp.season_id
        WHERE p.user_id = ? ORDER BY p.id, s.number`,
      userId
    ),
    receipts: await all(
      `SELECT r.kind, r.number, r.issued_at, r.total, r.lines, r.paid_via, r.customer_name, r.customer_phone, v.name AS venue
         FROM receipts r LEFT JOIN venues v ON v.id = r.venue_id
        WHERE r.user_id = ? ORDER BY r.id`,
      userId
    ),
    waitlist: await all(
      `SELECT w.status, w.date, w.start_min, w.end_min, w.name, w.phone, w.email, w.created_at, k.name AS class
         FROM waitlist w LEFT JOIN classes k ON k.id = w.class_id
        WHERE w.user_id = ? ORDER BY w.id`,
      userId
    ),
    vouchers: await all(
      `SELECT g.code, g.amount, g.redeemed_at, v.name AS venue
         FROM gift_vouchers g JOIN venues v ON v.id = g.venue_id
        WHERE g.redeemed_by = ? ORDER BY g.id`,
      userId
    ),
    reviews: await all(
      `SELECT v.name AS venue, r.author, r.rating, r.body, r.played_on, r.created_at, r.updated_at, r.reply
         FROM venue_reviews r JOIN venues v ON v.id = r.venue_id
        WHERE r.user_id = ? OR r.booking_id IN (SELECT id FROM bookings WHERE user_id = ?) ORDER BY r.id`,
      userId,
      userId
    ),
    marketing: await all(
      `SELECT v.name AS venue, c.email, c.wording, c.source, c.consented_at, c.withdrawn_at
         FROM marketing_consents c JOIN venues v ON v.id = c.venue_id
        WHERE c.user_id = ? OR c.email_key = lower(?) ORDER BY c.id`,
      userId,
      account.email
    ),
    concessionProofs: await all(
      `SELECT v.name AS venue, c.name AS concession, p.seen_on, p.valid_until
         FROM concession_proofs p JOIN concessions c ON c.id = p.concession_id JOIN venues v ON v.id = p.venue_id
        WHERE p.phone_key = phone_key(?) ORDER BY p.seen_on`,
      account.phone
    ),
    staffNotes: await all(
      `SELECT v.name AS venue, n.note, n.updated_at FROM customer_notes n JOIN venues v ON v.id = n.venue_id
        WHERE n.phone_key = phone_key(?) ORDER BY v.name`,
      account.phone
    ),
    enquiries: await all(
      `SELECT v.name AS venue, e.created_at, e.kind, e.wanted_on, e.people, e.message, e.status
         FROM hire_enquiries e JOIN venues v ON v.id = e.venue_id
        WHERE e.phone_key = phone_key(?) OR lower(e.email) = lower(?) ORDER BY e.id`,
      account.phone,
      account.email
    ),
    waivers: await all(
      `SELECT v.name AS venue, s.name, s.signed_at, w.text
         FROM waiver_signatures s JOIN venue_waivers w ON w.id = s.waiver_id JOIN venues v ON v.id = w.venue_id
        WHERE s.phone_key = phone_key(?) ORDER BY s.signed_at`,
      account.phone
    ),
    messages: await all(
      `SELECT m.created_at, m.channel, m.kind, m.recipient, m.status, m.subject, m.body
         FROM messages m
        WHERE m.booking_id IN (SELECT id FROM bookings WHERE user_id = ?) OR (m.channel = 'email' AND lower(m.recipient) = lower(?))
        ORDER BY m.id`,
      userId,
      account.email
    ),
    approvals: await (await import("./approvals")).approvalsExport(userId),
    heldAtACounter:
      "A pass, membership, waiting-list place, induction, sign-off or booking made at a counter is filed against a phone number rather than this account. Ask the venue for those: its manager can give you everything it holds against your number once they have checked who you are in person, which this page cannot.",
  };
}

/* ---------------- What a venue holds against a phone number ---------------- */

export interface PhoneExport {
  takenAt: string;
  phone: string;
  venues: string[];
  bookings: unknown[];
  waitlist: unknown[];
  passes: unknown[];
  memberships: unknown[];
  inductions: unknown[];
  /** Staff sign-offs for an activity: a belay check, a range briefing (lib/sign-offs.ts). */
  signOffs: unknown[];
  /** On the venue's list of who it is for (lib/access.ts). */
  accessList: unknown[];
  blocked: unknown[];
  receipts: unknown[];
  giftVouchers: unknown[];
  reviews: unknown[];
  counterSales: unknown[];
  /** Concession proof seen at the counter: the fact, by whom and until when; no proof itself is kept. */
  concessionProofs: unknown[];
  /** Company or school accounts that list this number as allowed to book on them (lib/accounts.ts). */
  accountBookers: unknown[];
  /** The venue's staff's note on this customer (lib/customer-notes.ts). */
  staffNotes: unknown[];
  /** Private hire enquiries from this number (lib/enquiries.ts). */
  enquiries: unknown[];
  /** The venue's waivers this number agreed to, and when (lib/waivers.ts). */
  waivers: unknown[];
  messages: unknown[];
  /** Applications to be approved for an activity from this number: answers and history; the documents are counted, not copied (lib/approvals.ts). */
  approvals: unknown[];
}

/**
 * Everything these venues hold against a phone number, for a request made in
 * person.
 *
 * The other half of `exportCustomerData`. A pass, a membership or a guest
 * booking is filed against a number, and a number is not proof of who is
 * asking, so this is for a venue's manager to run after checking who is at
 * the counter, never for anybody online. It reaches only the venues that
 * manager runs, and what it finds is that venue's own record of the person.
 */
export async function exportPhoneData(venueIds: number[], phone: string): Promise<PhoneExport> {
  const db = getDb();
  const marks = venueIds.map(() => "?").join(",");
  const all = async (sql: string, ...args: unknown[]) => await db.prepare(sql).all(...args);
  const names = (await all(`SELECT name FROM venues WHERE id IN (${marks}) ORDER BY id`, ...venueIds)) as { name: string }[];
  return {
    takenAt: new Date().toISOString(),
    phone,
    venues: names.map((v) => v.name),
    bookings: await all(
      `SELECT b.code, b.date, b.start_min, b.end_min, b.name, b.phone, b.email, b.total_price, b.status, b.payment_status,
              b.paid_via, b.no_show, b.late_cancelled, b.created_at, c.name AS court, v.name AS venue,
              ci.checked_in_at, ci.checked_out_at
         FROM bookings b JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id
         LEFT JOIN check_ins ci ON ci.booking_id = b.id
        WHERE c.venue_id IN (${marks}) AND b.phone_key = phone_key(?)
        ORDER BY b.date DESC, b.start_min DESC`,
      ...venueIds,
      phone
    ),
    waitlist: await all(
      `SELECT w.status, w.date, w.start_min, w.end_min, w.name, w.phone, w.email, w.created_at, k.name AS class
         FROM waitlist w
         LEFT JOIN classes k ON k.id = w.class_id
         LEFT JOIN courts c ON c.id = COALESCE(w.court_id, k.court_id)
        WHERE c.venue_id IN (${marks}) AND phone_key(w.phone) = phone_key(?)
        ORDER BY w.id`,
      ...venueIds,
      phone
    ),
    passes: await all(
      `SELECT p.code, p.name, p.holder_name, p.holder_phone, p.entries, p.price, p.expires_on, p.status, p.created_at
         FROM passes p WHERE p.venue_id IN (${marks}) AND phone_key(p.holder_phone) = phone_key(?) ORDER BY p.id`,
      ...venueIds,
      phone
    ),
    memberships: await all(
      `SELECT m.code, m.holder_name, m.holder_phone, m.starts_on, m.expires_on, m.price, m.status
         FROM memberships m WHERE m.venue_id IN (${marks}) AND phone_key(m.holder_phone) = phone_key(?) ORDER BY m.id`,
      ...venueIds,
      phone
    ),
    inductions: await all(
      `SELECT name, phone, note, created_at, revoked_at FROM inductions
        WHERE venue_id IN (${marks}) AND phone_key(phone) = phone_key(?) ORDER BY id`,
      ...venueIds,
      phone
    ),
    signOffs: await all(
      `SELECT sport, kind, reference, name, phone, note, expires_on, created_at, revoked_at, revoke_reason FROM sign_offs
        WHERE (venue_id IN (${marks}) OR business_id IN (SELECT business_id FROM venues WHERE id IN (${marks})))
          AND phone_key(phone) = phone_key(?) ORDER BY id`,
      ...venueIds,
      ...venueIds,
      phone
    ),
    accessList: await all(
      `SELECT name, phone, label, kind, expires_on, created_at FROM venue_access_list
        WHERE venue_id IN (${marks}) AND phone_key = phone_key(?) ORDER BY id`,
      ...venueIds,
      phone
    ),
    blocked: await all(
      `SELECT phone, reason, created_at FROM venue_blocked_phones WHERE venue_id IN (${marks}) AND phone_key = phone_key(?)`,
      ...venueIds,
      phone
    ),
    receipts: await all(
      `SELECT kind, number, issued_at, total, lines, paid_via, customer_name, customer_phone FROM receipts
        WHERE venue_id IN (${marks}) AND phone_key(customer_phone) = phone_key(?) ORDER BY id`,
      ...venueIds,
      phone
    ),
    giftVouchers: await all(
      `SELECT code, amount, buyer_name, buyer_email, buyer_phone, recipient_name, message, status, created_at
         FROM gift_vouchers WHERE venue_id IN (${marks}) AND status <> 'pending' AND phone_key(buyer_phone) = phone_key(?) ORDER BY id`,
      ...venueIds,
      phone
    ),
    reviews: await all(
      `SELECT author, rating, body, played_on, created_at, updated_at, reply, hidden_at FROM venue_reviews
        WHERE venue_id IN (${marks}) AND phone_key = phone_key(?) ORDER BY id`,
      ...venueIds,
      phone
    ),
    counterSales: await all(
      `SELECT created_at, customer_name, customer_phone, lines, total, paid_via, voided_at FROM counter_sales
        WHERE venue_id IN (${marks}) AND phone_key(customer_phone) = phone_key(?) ORDER BY id`,
      ...venueIds,
      phone
    ),
    concessionProofs: await all(
      `SELECT v.name AS venue, c.name AS concession, p.seen_on, p.valid_until, a.name AS seen_by
         FROM concession_proofs p JOIN concessions c ON c.id = p.concession_id JOIN venues v ON v.id = p.venue_id
         LEFT JOIN admins a ON a.id = p.seen_by
        WHERE p.venue_id IN (${marks}) AND p.phone_key = phone_key(?) ORDER BY p.seen_on`,
      ...venueIds,
      phone
    ),
    accountBookers: await all(
      `SELECT v.name AS venue, a.name AS account, k.name, k.phone
         FROM account_bookers k JOIN venue_accounts a ON a.id = k.account_id JOIN venues v ON v.id = a.venue_id
        WHERE a.venue_id IN (${marks}) AND k.phone_key = phone_key(?) ORDER BY a.name`,
      ...venueIds,
      phone
    ),
    staffNotes: await all(
      `SELECT v.name AS venue, n.note, n.updated_at FROM customer_notes n JOIN venues v ON v.id = n.venue_id
        WHERE n.venue_id IN (${marks}) AND n.phone_key = phone_key(?)`,
      ...venueIds,
      phone
    ),
    enquiries: await all(
      `SELECT v.name AS venue, e.created_at, e.name, e.phone, e.email, e.kind, e.wanted_on, e.people, e.message, e.status
         FROM hire_enquiries e JOIN venues v ON v.id = e.venue_id
        WHERE e.venue_id IN (${marks}) AND e.phone_key = phone_key(?) ORDER BY e.id`,
      ...venueIds,
      phone
    ),
    waivers: await all(
      `SELECT v.name AS venue, s.name, s.signed_at, w.created_at AS version_of, w.text, a.name AS recorded_by
         FROM waiver_signatures s JOIN venue_waivers w ON w.id = s.waiver_id JOIN venues v ON v.id = w.venue_id
         LEFT JOIN admins a ON a.id = s.recorded_by
        WHERE w.venue_id IN (${marks}) AND s.phone_key = phone_key(?) ORDER BY s.signed_at`,
      ...venueIds,
      phone
    ),
    messages: await all(
      `SELECT created_at, channel, kind, recipient, status, subject, body FROM messages
        WHERE venue_id IN (${marks}) AND channel = 'whatsapp' AND phone_key(recipient) = phone_key(?) ORDER BY id`,
      ...venueIds,
      phone
    ),
    approvals: await (await import("./approvals")).approvalsForPhone(venueIds, phone),
  };
}

export type EraseResult =
  | { ok: true; bookingsAnonymised: number; cancelled: number }
  | { ok: false; error: string };

/**
 * Forget a customer.
 *
 * What survives is deliberate. Past bookings keep their hour and their price
 * because they are the venue's accounting record, and a person cannot erase a
 * business's books by closing an account — but they stop naming anybody.
 * Upcoming bookings are cancelled, because holding a court for somebody who no
 * longer exists helps nobody.
 *
 * It refuses while the customer is owed something. Credit, a live pass or a
 * running membership all represent money the venue holds, and erasing the only
 * record of whose money it is would settle the argument in the venue's favour.
 *
 * It reaches only what the account owns. A booking made as a guest — no
 * account, just a name and a number — is not touched, because a phone number
 * is not proof: numbers are shared, reassigned, and typed in by whoever is at
 * the counter. Cancelling a stranger's court because they once used the same
 * number would be far worse than leaving a guest booking named.
 */
export async function eraseCustomer(userId: number): Promise<EraseResult> {
  const db = getDb();
  const account = await db.prepare("SELECT id, email FROM users WHERE id = ?").get(userId) as
    | { id: number; email: string }
    | undefined;
  if (!account) return { ok: false, error: "Account not found." };

  const { balance } = await db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS balance FROM wallet_entries WHERE user_id = ?")
    .get(userId) as { balance: number };
  if (balance > 0)
    return {
      ok: false,
      error: `You still hold ${money(balance)} in credit. Spend it, or ask a venue to refund it, and then close the account.`,
    };

  const today = todayISO();
  const { live } = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM passes
           WHERE user_id = ? AND status = 'active' AND expires_on >= ?)
       + (SELECT COUNT(*) FROM memberships
           WHERE user_id = ? AND status = 'active' AND expires_on >= ?)
       AS live`
    )
    .get(userId, today, userId, today) as { live: number };
  if (live > 0)
    return {
      ok: false,
      error:
        "You still hold a pass or membership that has not expired. Use it up, or ask the venue to cancel it, and then close the account.",
    };

  let cancelled = 0;
  let bookingsAnonymised = 0;

  await db.transaction(async () => {
    // Nothing should still be held for somebody who is leaving. Only what is
    // provably theirs: a booking that merely shares a phone number may belong
    // to the person who used the counter before them.
    const upcoming = await db
      .prepare(
        `SELECT id FROM bookings
         WHERE user_id = ? AND status = 'confirmed' AND date >= ?`
      )
      .all(userId, today) as { id: number }[];
    for (const booking of upcoming) {
      await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id);
      await releaseBooking(booking.id);
      // Players in an open game on it hear it is off, and are owed their shares.
      await bookingCancelled(booking.id);
      // So are friends who paid a share of it.
      const { splitCancelled } = await import("./splits");
      await splitCancelled(booking.id);
      cancelled++;
    }
    await forgetPlayer(userId);
    // Off every waiting list. A place they were waiting for, or were offered,
    // goes to the next person in line, as if they had left it themselves.
    const { leaveWaitlist } = await import("./store");
    const waiting = (await db
      .prepare("SELECT id, phone FROM waitlist WHERE user_id = ? AND status IN ('waiting', 'offered')")
      .all(userId)) as { id: number; phone: string }[];
    for (const w of waiting) await leaveWaitlist(w.id, w.phone);
    await db.prepare("DELETE FROM waitlist WHERE user_id = ?").run(userId);
    // Out of tournaments still to come; and off every draw, past or not, by name.
    const entered = (await db
      .prepare(
        `SELECT e.id FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id
          WHERE e.user_id = ? AND e.status <> 'withdrawn' AND t.status IN ('open', 'closed', 'drawn')`
      )
      .all(userId)) as { id: number }[];
    for (const e of entered) await withdraw(e.id);
    await db
      .prepare("UPDATE tournament_entries SET name = ?, partner_name = NULL, user_id = NULL, birth_date = NULL, partner_birth_date = NULL, guardian_name = NULL, eligibility_checked_by = NULL WHERE user_id = ?")
      .run(ANONYMOUS, userId);
    // Out of leagues too, and off their boxes and tables by name.
    await forgetLeaguePlayer(userId, ANONYMOUS);
    // Their applications to be approved for an activity: answers, documents and any slot held. A sign-off already given stays the venue's record.
    await (await import("./approvals")).eraseApprovals(userId);
    // Nor a concession proof remembered against the account's number.
    await db.prepare("DELETE FROM concession_proofs WHERE phone_key = phone_key((SELECT phone FROM users WHERE id = ?))").run(userId);
    // Nor their enquiries about private hire.
    await db
      .prepare("DELETE FROM hire_enquiries WHERE phone_key = phone_key((SELECT phone FROM users WHERE id = ?)) OR lower(email) = lower(?)")
      .run(userId, account.email);
    // Nor a note staff kept on that number, or the one proved.
    await db
      .prepare(
        `DELETE FROM customer_notes WHERE phone_key IN (SELECT phone_key(phone) FROM users WHERE id = ?
                                                        UNION SELECT phone_key(verified_phone) FROM users WHERE id = ? AND verified_phone IS NOT NULL)`
      )
      .run(userId, userId);
    // Nor on a company's list of who may book on its account, by that number or the one proved.
    await db
      .prepare(
        `DELETE FROM account_bookers WHERE phone_key IN (SELECT phone_key(phone) FROM users WHERE id = ?
                                                         UNION SELECT phone_key(verified_phone) FROM users WHERE id = ? AND verified_phone IS NOT NULL)`
      )
      .run(userId, userId);
    // Nobody left to send news to.
    await db.prepare("DELETE FROM marketing_consents WHERE user_id = ? OR email_key = lower(?)").run(userId, account.email);
    // Their reviews go: an opinion is theirs, not the venue's record.
    await db
      .prepare("DELETE FROM venue_reviews WHERE user_id = ? OR booking_id IN (SELECT id FROM bookings WHERE user_id = ?)")
      .run(userId, userId);

    const result = await db
      .prepare(
        `UPDATE bookings SET name = ?, phone = '', email = NULL, check_in_token = NULL, user_id = NULL
         WHERE user_id = ?`
      )
      .run(ANONYMOUS, userId);
    bookingsAnonymised = result.changes;

    await db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    // Spent passes and lapsed memberships keep their money but lose the name.
    await db.prepare(
      "UPDATE passes SET holder_name = ?, holder_phone = '', user_id = NULL WHERE user_id = ?"
    ).run(ANONYMOUS, userId);
    await db.prepare(
      "UPDATE memberships SET holder_name = ?, holder_phone = '', user_id = NULL WHERE user_id = ?"
    ).run(ANONYMOUS, userId);
    // So do receipts and credit notes: the venue's books keep what was sold, not to whom.
    await db.prepare(
      "UPDATE receipts SET customer_name = ?, customer_phone = NULL, user_id = NULL WHERE user_id = ?"
    ).run(ANONYMOUS, userId);
    await db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  })();

  return { ok: true, bookingsAnonymised, cancelled };
}
