import { getDb } from "./db";
import { addDays, todayISO } from "./time";

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
  /** A booking stops naming anybody after this, but its money stays. */
  bookingIdentityDays: 730,
  /** Withdrawn out-of-hours access, kept a while in case it is disputed. */
  revokedInductionDays: 365,
} as const;

export interface RetentionLine {
  what: string;
  /** Days after which the record, or the person inside it, goes. */
  days: number;
  /** What actually happens when the clock runs out. */
  action: "deleted" | "anonymised";
  affected: number;
}

/** What a prune would do right now, without doing it. */
export function retentionDue(): RetentionLine[] {
  const db = getDb();
  const today = todayISO();
  const before = (days: number) => addDays(today, -days);

  const count = (sql: string, ...args: unknown[]) =>
    (db.prepare(sql).get(...args) as { n: number }).n;

  return [
    {
      what: "Door codes shown",
      days: RETENTION.accessRevealDays,
      action: "deleted",
      affected: count(
        "SELECT COUNT(*) AS n FROM access_reveals WHERE date(revealed_at) < ?",
        before(RETENTION.accessRevealDays)
      ),
    },
    {
      what: "Arrivals at the desk",
      days: RETENTION.checkInDays,
      action: "deleted",
      affected: count(
        "SELECT COUNT(*) AS n FROM check_ins WHERE date(checked_in_at) < ?",
        before(RETENTION.checkInDays)
      ),
    },
    {
      what: "Settled waiting-list entries",
      days: RETENTION.waitlistDays,
      action: "deleted",
      affected: count(
        `SELECT COUNT(*) AS n FROM waitlist
         WHERE status IN ('claimed','expired','cancelled') AND date(created_at) < ?`,
        before(RETENTION.waitlistDays)
      ),
    },
    {
      what: "Names and numbers on old bookings",
      days: RETENTION.bookingIdentityDays,
      action: "anonymised",
      affected: count(
        `SELECT COUNT(*) AS n FROM bookings
         WHERE date < ? AND name <> ?`,
        before(RETENTION.bookingIdentityDays),
        ANONYMOUS
      ),
    },
    {
      what: "Withdrawn out-of-hours access",
      days: RETENTION.revokedInductionDays,
      action: "deleted",
      affected: count(
        "SELECT COUNT(*) AS n FROM inductions WHERE revoked_at IS NOT NULL AND date(revoked_at) < ?",
        before(RETENTION.revokedInductionDays)
      ),
    },
    {
      what: "Expired sign-in sessions",
      days: 0,
      action: "deleted",
      affected:
        count("SELECT COUNT(*) AS n FROM sessions WHERE expires_at < datetime('now')") +
        count("SELECT COUNT(*) AS n FROM admin_sessions WHERE expires_at < datetime('now')"),
    },
  ];
}

/** What a booking's customer is called once nobody is entitled to know. */
export const ANONYMOUS = "(removed)";

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
export function pruneOldData(): PruneResult {
  const db = getDb();
  const today = todayISO();
  const before = (days: number) => addDays(today, -days);
  const lines = retentionDue();

  db.transaction(() => {
    db.prepare("DELETE FROM access_reveals WHERE date(revealed_at) < ?").run(
      before(RETENTION.accessRevealDays)
    );
    db.prepare("DELETE FROM check_ins WHERE date(checked_in_at) < ?").run(
      before(RETENTION.checkInDays)
    );
    db.prepare(
      `DELETE FROM waitlist
       WHERE status IN ('claimed','expired','cancelled') AND date(created_at) < ?`
    ).run(before(RETENTION.waitlistDays));
    // The booking survives — its price is the venue's record. The person in it
    // does not.
    db.prepare(
      `UPDATE bookings SET name = ?, phone = '', email = NULL, check_in_token = NULL
       WHERE date < ? AND name <> ?`
    ).run(ANONYMOUS, before(RETENTION.bookingIdentityDays), ANONYMOUS);
    db.prepare("DELETE FROM inductions WHERE revoked_at IS NOT NULL AND date(revoked_at) < ?").run(
      before(RETENTION.revokedInductionDays)
    );
    db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
    db.prepare("DELETE FROM admin_sessions WHERE expires_at < datetime('now')").run();
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('retention_last_run', datetime('now'))" +
        " ON CONFLICT(key) DO UPDATE SET value = datetime('now')"
    ).run();
  })();

  return {
    ranAt: new Date().toISOString(),
    lines,
    total: lines.reduce((n, l) => n + l.affected, 0),
  };
}

/** When the policy was last applied, or null if it never has been. */
export function retentionLastRun(): string | null {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = 'retention_last_run'")
    .get() as { value: string } | undefined;
  return row?.value ?? null;
}

/** Run it if a day has passed, and say whether it did. */
export function pruneIfDue(): PruneResult | null {
  const last = retentionLastRun();
  if (last !== null && Date.now() - Date.parse(`${last.replace(" ", "T")}Z`) < 86_400_000)
    return null;
  return pruneOldData();
}

/* ---------------- What one person can ask for ---------------- */

export interface CustomerExport {
  takenAt: string;
  account: { id: number; name: string; email: string; phone: string; createdAt: string | null };
  bookings: unknown[];
  wallet: { balance: number; entries: unknown[] };
  passes: unknown[];
  memberships: unknown[];
  doorCodesShown: unknown[];
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
export function exportCustomerData(userId: number): CustomerExport | null {
  const db = getDb();
  const account = db
    .prepare("SELECT id, name, email, phone, created_at FROM users WHERE id = ?")
    .get(userId) as
    | { id: number; name: string; email: string; phone: string; created_at: string | null }
    | undefined;
  if (!account) return null;

  const all = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args);

  return {
    takenAt: new Date().toISOString(),
    account: {
      id: account.id,
      name: account.name,
      email: account.email,
      phone: account.phone,
      createdAt: account.created_at ?? null,
    },
    bookings: all(
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
        db
          .prepare("SELECT COALESCE(SUM(amount), 0) AS balance FROM wallet_entries WHERE user_id = ?")
          .get(userId) as { balance: number }
      ).balance,
      entries: all(
        "SELECT amount, reason, created_at FROM wallet_entries WHERE user_id = ? ORDER BY id",
        userId
      ),
    },
    passes: all(
      `SELECT p.code, p.name, p.entries, p.price, p.expires_on, p.status, v.name AS venue
       FROM passes p JOIN venues v ON v.id = p.venue_id
       WHERE p.user_id = ?`,
      userId
    ),
    memberships: all(
      `SELECT m.code, m.starts_on, m.expires_on, m.price, m.status, v.name AS venue
       FROM memberships m JOIN venues v ON v.id = m.venue_id
       WHERE m.user_id = ?`,
      userId
    ),
    doorCodesShown: all(
      `SELECT r.revealed_at, b.code AS booking, c.name AS court
       FROM access_reveals r
       JOIN bookings b ON b.id = r.booking_id
       JOIN courts c ON c.id = b.court_id
       WHERE b.user_id = ?
       ORDER BY r.revealed_at DESC`,
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
export function eraseCustomer(userId: number): EraseResult {
  const db = getDb();
  const account = db.prepare("SELECT id FROM users WHERE id = ?").get(userId) as
    | { id: number }
    | undefined;
  if (!account) return { ok: false, error: "Account not found." };

  const { balance } = db
    .prepare("SELECT COALESCE(SUM(amount), 0) AS balance FROM wallet_entries WHERE user_id = ?")
    .get(userId) as { balance: number };
  if (balance > 0)
    return {
      ok: false,
      error: `You still hold RM${balance} in credit. Spend it, or ask a venue to refund it, and then close the account.`,
    };

  const today = todayISO();
  const { live } = db
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

  db.transaction(() => {
    // Nothing should still be held for somebody who is leaving. Only what is
    // provably theirs: a booking that merely shares a phone number may belong
    // to the person who used the counter before them.
    const upcoming = db
      .prepare(
        `SELECT id FROM bookings
         WHERE user_id = ? AND status = 'confirmed' AND date >= ?`
      )
      .all(userId, today) as { id: number }[];
    for (const booking of upcoming) {
      db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(booking.id);
      db.prepare("DELETE FROM booking_slots WHERE booking_id = ?").run(booking.id);
      cancelled++;
    }

    const result = db
      .prepare(
        `UPDATE bookings SET name = ?, phone = '', email = NULL, check_in_token = NULL, user_id = NULL
         WHERE user_id = ?`
      )
      .run(ANONYMOUS, userId);
    bookingsAnonymised = result.changes;

    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    // Spent passes and lapsed memberships keep their money but lose the name.
    db.prepare(
      "UPDATE passes SET holder_name = ?, holder_phone = '', user_id = NULL WHERE user_id = ?"
    ).run(ANONYMOUS, userId);
    db.prepare(
      "UPDATE memberships SET holder_name = ?, holder_phone = '', user_id = NULL WHERE user_id = ?"
    ).run(ANONYMOUS, userId);
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  })();

  return { ok: true, bookingsAnonymised, cancelled };
}
