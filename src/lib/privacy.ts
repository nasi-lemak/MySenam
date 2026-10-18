import { getDb } from "./db";
import { addDays, todayISO } from "./time";
import { deleteStaleDrafts, STALE_DRAFT_DAYS, staleDrafts } from "./drafts";
import { bookingCancelled, forgetPlayer } from "./games";
import { withdraw } from "./tournaments";
import { forgetLeaguePlayer } from "./leagues";
import { removeVenuePhotoFiles } from "./photos";

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
  /** A booking stops naming anybody after this, but its money stays. */
  bookingIdentityDays: 730,
  /** Withdrawn out-of-hours access, kept a while in case it is disputed. */
  revokedInductionDays: 365,
  /**
   * A venue application whose emailed link was never followed: somebody's
   * name, email and password hash, with nobody shown to want it kept.
   */
  unconfirmedApplicationDays: 7,
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
    what: "Withdrawn out-of-hours access",
    days: RETENTION.revokedInductionDays,
    action: "deleted",
    table: "inductions",
    where: "revoked_at IS NOT NULL AND revoked_at < ?",
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
 * Deliberately not on a timer of its own: this codebase has no scheduler, and
 * a venue that never opens the dashboard is a venue with nothing accumulating
 * either. It runs at most once a day, whenever staff are already here.
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
  tournaments: unknown[];
  /** Leagues joined, and each season's box, finish and fee. */
  leagues: unknown[];
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
    .prepare("SELECT id, name, email, phone, created_at, phone_verified_at, gender FROM users WHERE id = ?")
    .get(userId) as
    | { id: number; name: string; email: string; phone: string; created_at: string | null; phone_verified_at: string | null; gender: string | null }
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
    },
    signIns: await all("SELECT provider, email, created_at FROM user_identities WHERE user_id = ?", userId),
    bookings: await all(
      `SELECT b.code, b.date, b.start_hour, b.end_hour, b.total_price, b.status,
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
      `SELECT b.date, b.start_hour, v.name AS venue, c.sport,
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
    tournaments: await all(
      `SELECT t.name AS tournament, t.starts_on, v.name AS venue, e.name AS entered_as, e.status, e.paid_at
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
    heldAtACounter:
      "A pass, membership, waiting-list place or induction taken at a counter is filed against a phone number rather than this account. Ask the venue for those — they check who you are in person, which this page cannot.",
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
  const account = await db.prepare("SELECT id FROM users WHERE id = ?").get(userId) as
    | { id: number }
    | undefined;
  if (!account) return { ok: false, error: "Account not found." };

  const { balance } = await db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS balance FROM wallet_entries WHERE user_id = ?")
    .get(userId) as { balance: number };
  if (balance > 0)
    return {
      ok: false,
      error: `You still hold RM${balance} in credit. Spend it, or ask a venue to refund it, and then close the account.`,
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
      await db.prepare("DELETE FROM booking_slots WHERE booking_id = ?").run(booking.id);
      // Players in an open game on it hear it is off, and are owed their shares.
      await bookingCancelled(booking.id);
      cancelled++;
    }
    await forgetPlayer(userId);
    // Out of tournaments still to come; and off every draw, past or not, by name.
    const entered = (await db
      .prepare(
        `SELECT e.id FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id
          WHERE e.user_id = ? AND e.status <> 'withdrawn' AND t.status IN ('open', 'closed', 'drawn')`
      )
      .all(userId)) as { id: number }[];
    for (const e of entered) await withdraw(e.id);
    await db
      .prepare("UPDATE tournament_entries SET name = ?, partner_name = NULL, user_id = NULL WHERE user_id = ?")
      .run(ANONYMOUS, userId);
    // Out of leagues too, and off their boxes and tables by name.
    await forgetLeaguePlayer(userId, ANONYMOUS);

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
    await db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  })();

  return { ok: true, bookingsAnonymised, cancelled };
}
