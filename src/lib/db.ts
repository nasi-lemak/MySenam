import Database from "better-sqlite3";
import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

let db: Database.Database | null = null;

/**
 * Where the database lives, without opening it.
 *
 * MYSENAM_DB overrides the location (tests use ":memory:"). MUDAHTEMPAH_DB is
 * the name this variable had before the rename, still honoured so an existing
 * deployment does not silently start on an empty database.
 */
export function databaseFile(): string {
  const configured = process.env.MYSENAM_DB ?? process.env.MUDAHTEMPAH_DB;
  if (configured) return configured;

  const dataDir = path.join(process.cwd(), "data");
  const file = path.join(dataDir, "mysenam.db");
  // Pick up a database written under the old name rather than seeding a fresh
  // one beside it.
  const legacy = path.join(dataDir, "mudahtempah.db");
  return fs.existsSync(file) || !fs.existsSync(legacy) ? file : legacy;
}

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = databaseFile();
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS venues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      area TEXT NOT NULL,
      address TEXT NOT NULL,
      phone TEXT NOT NULL,
      -- Customers may cancel until this many hours before start.
      cancel_cutoff_hours INTEGER NOT NULL DEFAULT 2,
      -- Trading hours: first bookable hour starts at open_hour, the last one
      -- ends at close_hour.
      open_hour INTEGER NOT NULL DEFAULT 8,
      close_hour INTEGER NOT NULL DEFAULT 23,
      -- When somebody is actually behind the counter. NULL for both means
      -- always staffed, which is every venue until it says otherwise. Equal
      -- values mean never staffed. Anything outside the window is an
      -- unstaffed hour: the same gym floor is staffed at 10am and not at
      -- midnight, which is how these places really run.
      staffed_from INTEGER,
      staffed_to INTEGER,
      -- Shown to anyone letting themselves in, on the screen they are already
      -- looking at while standing inside the building.
      emergency_phone TEXT,
      emergency_info TEXT
    );

    -- Whole days a venue is shut: a public holiday, a private hire, a refit.
    CREATE TABLE IF NOT EXISTS venue_closures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      reason TEXT,
      UNIQUE (venue_id, date)
    );

    -- A bookable resource. Despite the table name this is not always a court:
    -- capacity 1 means exclusive use (a badminton court), capacity > 1 means a
    -- shared facility where that many people may hold the same hour (a gym
    -- floor, a pool, a class).
    CREATE TABLE IF NOT EXISTS courts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venue_id INTEGER NOT NULL REFERENCES venues(id),
      name TEXT NOT NULL,
      -- The activity vocabulary is validated in lib/types.ts so it can grow
      -- without rebuilding this table.
      sport TEXT NOT NULL,
      off_peak_rate INTEGER NOT NULL,
      peak_rate INTEGER NOT NULL,
      -- What a member pays instead. NULL means members pay the public rate on
      -- this court, so a venue can discount only some of them.
      member_off_peak_rate INTEGER,
      member_peak_rate INTEGER,
      capacity INTEGER NOT NULL DEFAULT 1,
      -- What the desk holds while the kit is out, in ringgit. 0 means this
      -- resource is not handed over at all: a court stays where it is.
      deposit INTEGER NOT NULL DEFAULT 0,
      -- Nobody is at the door for this resource: the customer lets themselves
      -- in with a code. Per resource rather than per venue, because a centre
      -- can leave its courts on a keypad overnight while the kayak counter,
      -- which cannot run itself, keeps someone standing at it.
      unmanned INTEGER NOT NULL DEFAULT 0,
      -- What is currently set on that door. MySenam only relays it; the lock
      -- is the source of truth, so staff type in what they programmed.
      access_code TEXT,
      access_code_changed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      court_id INTEGER NOT NULL REFERENCES courts(id),
      date TEXT NOT NULL,
      start_hour INTEGER NOT NULL,
      end_hour INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      total_price INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','cancelled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      check_in_token TEXT,
      -- 1 if the demo seeder invented this booking. It is what lets the demo
      -- be reloaded onto today's date, and what stops that ever happening once
      -- a real customer has booked.
      demo INTEGER NOT NULL DEFAULT 0
    );

    -- One row per booked hour per place taken. The seat column is which of the
    -- resource's capacity places this booking holds (0-based, always 0 for an
    -- exclusive court), so the UNIQUE constraint is still what makes
    -- overbooking impossible under concurrent requests.
    CREATE TABLE IF NOT EXISTS booking_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      court_id INTEGER NOT NULL REFERENCES courts(id),
      date TEXT NOT NULL,
      hour INTEGER NOT NULL,
      seat INTEGER NOT NULL DEFAULT 0,
      UNIQUE (court_id, date, hour, seat)
    );

    -- An instructor-led session held on a resource. While it runs the resource
    -- is reserved: the only way in is to enrol, which creates a normal booking
    -- carrying this class_id.
    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      court_id INTEGER NOT NULL REFERENCES courts(id),
      name TEXT NOT NULL,
      instructor TEXT NOT NULL,
      date TEXT NOT NULL,
      start_hour INTEGER NOT NULL,
      end_hour INTEGER NOT NULL,
      capacity INTEGER NOT NULL,
      price INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
      series_code TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Somebody waiting for a place that is currently full. A row targets
    -- either a class, or a specific court + date + hour window. When a place
    -- frees up the earliest waiter is offered it for a short hold; if they do
    -- not claim in time the offer expires and passes to the next.
    CREATE TABLE IF NOT EXISTS waitlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
      court_id INTEGER REFERENCES courts(id),
      date TEXT,
      start_hour INTEGER,
      end_hour INTEGER,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      user_id INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'waiting'
        CHECK (status IN ('waiting','offered','claimed','expired','cancelled')),
      offered_at TEXT,
      offer_token TEXT UNIQUE,
      -- The language this person was reading when they joined, so the offer
      -- reaches them in it. Somebody else's cancellation is what writes the
      -- offer, so it cannot be taken from the request that triggers it.
      locale TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Hours a court is closed for maintenance/private events; blocked hours
    -- never appear as bookable.
    CREATE TABLE IF NOT EXISTS slot_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      court_id INTEGER NOT NULL REFERENCES courts(id),
      date TEXT NOT NULL,
      hour INTEGER NOT NULL,
      reason TEXT,
      -- How many places are out of service. NULL is the whole resource, which
      -- is the only thing a capacity-1 court can mean. A number takes that
      -- many places off a shared one: two kayaks in for repair, not the fleet.
      places INTEGER,
      UNIQUE (court_id, date, hour)
    );

    -- Arrival at the front desk. One per booking; checked_out_at is optional
    -- because most people just leave, so a booking is also treated as departed
    -- once its last hour ends.
    CREATE TABLE IF NOT EXISTS check_ins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
      checked_in_at TEXT NOT NULL DEFAULT (datetime('now')),
      checked_out_at TEXT
    );

    -- A person has been shown round this venue by staff, in person: rules,
    -- the emergency button, what not to do on a rack with nobody watching.
    -- Identity and age are checked at the same time, which is why this is
    -- recorded by an operator and never self-declared.
    CREATE TABLE IF NOT EXISTS inductions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
      -- Stored normalised, so the country code cannot split one person in two.
      phone TEXT NOT NULL,
      name TEXT NOT NULL,
      -- Which operator saw them, so a waved-through induction has a name on it.
      admin_id INTEGER REFERENCES admins(id),
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT,
      UNIQUE (venue_id, phone)
    );

    -- Every time a door code was shown to a customer. Append-only, one row
    -- per look, because when a court is found trashed on Tuesday night the
    -- only useful question is who had the code.
    CREATE TABLE IF NOT EXISTS access_reveals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      revealed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_access_reveals_booking ON access_reveals(booking_id);

    -- Kit handed over the counter: a kayak, a paddle set, a racquet. One per
    -- booking. The deposit is cash or a card imprint held at the desk rather
    -- than account credit, so this table records the state of the hold, not a
    -- movement of money. A row with returned_at still NULL is kit that is
    -- physically out.
    CREATE TABLE IF NOT EXISTS hire_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
      deposit INTEGER NOT NULL CHECK (deposit >= 0),
      taken_at TEXT NOT NULL DEFAULT (datetime('now')),
      returned_at TEXT,
      -- Kept back out of the deposit. NULL until the kit comes back.
      withheld INTEGER CHECK (withheld IS NULL OR withheld >= 0),
      condition TEXT CHECK (condition IS NULL OR condition IN ('ok','damaged','lost')),
      note TEXT
    );

    -- Small facts about the installation itself, not about anybody: when
    -- housekeeping last ran, and anything else that is one row by nature.
    -- Messages waiting to go out to a customer: a booking confirmation, a
    -- cancellation, a waitlist offer. Queued here rather than sent inline so
    -- that a booking is never lost to a mail server being down, and so that
    -- staff can see whether the customer actually heard from us.
    --
    -- A message holds its own finished text rather than a template and some
    -- ids, because it was written in the language the customer was reading at
    -- the time, and a later edit to the wording must not rewrite what somebody
    -- was already sent.
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
      venue_id INTEGER NOT NULL REFERENCES venues(id),
      kind TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('whatsapp','email')),
      recipient TEXT NOT NULL,
      locale TEXT NOT NULL DEFAULT 'en',
      subject TEXT,
      body TEXT NOT NULL,
      -- What filled the body, as JSON: WhatsApp sends these as a template's
      -- parameters rather than the finished text.
      params TEXT,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','sent','failed','abandoned')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT,
      -- What this message is about, when saying it twice would be wrong: a
      -- waitlist offer token, a booking code. The unique index is what makes
      -- queuing idempotent, so a sweep can run as often as it likes.
      dedupe_key TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_due ON messages(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_messages_venue ON messages(venue_id, id);
    CREATE INDEX IF NOT EXISTS idx_messages_booking ON messages(booking_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- A venue's own payment gateway account, so a customer's money goes
    -- straight to the venue and never through the platform. The two keys are
    -- sealed (lib/secrets.ts): this file is what gets backed up and copied.
    CREATE TABLE IF NOT EXISTS venue_payment_accounts (
      venue_id INTEGER PRIMARY KEY REFERENCES venues(id),
      provider TEXT NOT NULL DEFAULT 'billplz' CHECK (provider IN ('billplz')),
      api_key TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      x_signature_key TEXT NOT NULL,
      sandbox INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- One bill a customer was sent to pay, and what it settles.
    CREATE TABLE IF NOT EXISTS online_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      bill_id TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      venue_id INTEGER REFERENCES venues(id),
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
      payer_name TEXT,
      payer_phone TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at TEXT,
      -- Owed back for bookings cancelled after paying, and what staff have
      -- since refunded in the gateway.
      refund_due REAL NOT NULL DEFAULT 0,
      refunded REAL NOT NULL DEFAULT 0,
      -- 'booking': a customer paying a venue, into the venue's account.
      -- 'invoice': a venue paying the marketplace its fee, into the platform's.
      purpose TEXT NOT NULL DEFAULT 'booking' CHECK (purpose IN ('booking','invoice')),
      invoice_id INTEGER REFERENCES venue_invoices(id)
    );

    -- A marketplace venue's monthly fee, one row per venue per month.
    CREATE TABLE IF NOT EXISTS venue_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venue_id INTEGER NOT NULL REFERENCES venues(id),
      period TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due','paid','void')),
      issued_on TEXT NOT NULL,
      due_on TEXT NOT NULL,
      paid_at TEXT,
      paid_via TEXT CHECK (paid_via IN ('online','manual')),
      UNIQUE (venue_id, period)
    );
    CREATE INDEX IF NOT EXISTS idx_online_payments_venue ON online_payments(venue_id, id);

    -- Venues asking to join a marketplace. The password their first operator
    -- chose is held hashed until the application is decided, and dropped if it
    -- is turned down.
    CREATE TABLE IF NOT EXISTS venue_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_name TEXT NOT NULL,
      area TEXT NOT NULL,
      address TEXT NOT NULL,
      venue_phone TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      email TEXT NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      reason TEXT,
      venue_id INTEGER REFERENCES venues(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT,
      decided_by INTEGER REFERENCES admins(id)
    );

    -- A venue's own website on the marketplace: a domain, a name and colour,
    -- and the venues it shows (lib/storefront.ts).
    CREATE TABLE IF NOT EXISTS storefronts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hostname TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      tagline TEXT,
      accent_color TEXT,
      logo_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS storefront_venues (
      storefront_id INTEGER NOT NULL REFERENCES storefronts(id) ON DELETE CASCADE,
      venue_id INTEGER NOT NULL REFERENCES venues(id),
      PRIMARY KEY (storefront_id, venue_id)
    );
    CREATE INDEX IF NOT EXISTS idx_storefront_venues_venue ON storefront_venues(venue_id);

    CREATE TABLE IF NOT EXISTS online_payment_bookings (
      payment_id INTEGER NOT NULL REFERENCES online_payments(id) ON DELETE CASCADE,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      PRIMARY KEY (payment_id, booking_id)
    );
    CREATE INDEX IF NOT EXISTS idx_online_payment_bookings_booking ON online_payment_bookings(booking_id);

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      phone TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Stored credit, as an append-only ledger: the balance is the sum of the
    -- entries, so every movement keeps its reason and can be audited. Positive
    -- credits the wallet (top-up, refund); negative debits it (payment).
    -- Amounts are whole ringgit, like every other price in the app.
    CREATE TABLE IF NOT EXISTS wallet_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      booking_id INTEGER REFERENCES bookings(id),
      admin_id INTEGER REFERENCES admins(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Membership of one venue, held against a phone number so a member who
    -- books as a guest still gets their rate.
    CREATE TABLE IF NOT EXISTS memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
      holder_name TEXT NOT NULL,
      holder_phone TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      -- Inclusive: the membership is live on both of these dates.
      starts_on TEXT NOT NULL,
      expires_on TEXT NOT NULL,
      price INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
      admin_id INTEGER REFERENCES admins(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- A discount a venue advertises: "RAYA20" for 20% off, "NEWBIE5" for RM5.
    CREATE TABLE IF NOT EXISTS promo_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
      -- NULL means it works on any sport at that venue.
      sport TEXT,
      description TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('percent','amount')),
      -- Percent 1-100, or whole ringgit off.
      value INTEGER NOT NULL,
      -- Smallest booking it applies to, so "3 hours or more" is expressible.
      min_hours INTEGER NOT NULL DEFAULT 1,
      -- Inclusive dates the booking itself must fall within.
      valid_from TEXT NOT NULL,
      valid_to TEXT NOT NULL,
      -- NULL means unlimited.
      max_uses INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
      admin_id INTEGER REFERENCES admins(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      -- One code per venue, matched case-insensitively.
      UNIQUE (venue_id, code)
    );

    -- One row per booking that used a code. The use count is COUNT(*) of
    -- these, so a cancelled booking gives its use back by deletion and the
    -- count can never drift from the bookings that justify it.
    CREATE TABLE IF NOT EXISTS promo_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      promo_id INTEGER NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      discount INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (booking_id)
    );

    -- A block of entries bought up front: "10 hours of badminton at PJ".
    -- One entry covers one booked hour.
    CREATE TABLE IF NOT EXISTS passes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      venue_id INTEGER NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
      -- NULL means the pass is good for any sport at that venue.
      sport TEXT,
      name TEXT NOT NULL,
      entries INTEGER NOT NULL,
      price INTEGER NOT NULL,
      holder_name TEXT NOT NULL,
      holder_phone TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      -- Inclusive: the pass is still good on this date.
      expires_on TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
      admin_id INTEGER REFERENCES admins(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Append-only, like wallet_entries: remaining = entries + SUM(delta).
    -- A spend is negative, a refund positive.
    CREATE TABLE IF NOT EXISTS pass_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pass_id INTEGER NOT NULL REFERENCES passes(id) ON DELETE CASCADE,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      booking_id INTEGER REFERENCES bookings(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );

    -- Venue operators. venue_id NULL means a platform owner who sees every venue.
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      venue_id INTEGER REFERENCES venues(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);
    -- One venue's bookings over a period, without reading every venue's.
    CREATE INDEX IF NOT EXISTS idx_bookings_court_date ON bookings(court_id, date);
    -- The no-show count the day list shows against every booking.
    CREATE INDEX IF NOT EXISTS idx_bookings_phone ON bookings(phone);
    -- Joining an hour back to its booking, and the cascade when one is deleted.
    CREATE INDEX IF NOT EXISTS idx_slots_booking ON booking_slots(booking_id);
    CREATE INDEX IF NOT EXISTS idx_slots_court_date ON booking_slots(court_id, date);
    CREATE INDEX IF NOT EXISTS idx_blocks_court_date ON slot_blocks(court_id, date);
    CREATE INDEX IF NOT EXISTS idx_classes_court_date ON classes(court_id, date);
    CREATE INDEX IF NOT EXISTS idx_waitlist_class ON waitlist(class_id, status);
    CREATE INDEX IF NOT EXISTS idx_waitlist_slot ON waitlist(court_id, date, status);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_wallet_user ON wallet_entries(user_id);
    CREATE INDEX IF NOT EXISTS idx_wallet_booking ON wallet_entries(booking_id);
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions(admin_id);
    CREATE INDEX IF NOT EXISTS idx_memberships_phone ON memberships(holder_phone);
    CREATE INDEX IF NOT EXISTS idx_memberships_venue ON memberships(venue_id);
    CREATE INDEX IF NOT EXISTS idx_promo_venue ON promo_codes(venue_id);
    CREATE INDEX IF NOT EXISTS idx_promo_uses_promo ON promo_uses(promo_id);
    CREATE INDEX IF NOT EXISTS idx_passes_phone ON passes(holder_phone);
    CREATE INDEX IF NOT EXISTS idx_passes_user ON passes(user_id);
    CREATE INDEX IF NOT EXISTS idx_pass_entries_pass ON pass_entries(pass_id);
    CREATE INDEX IF NOT EXISTS idx_pass_entries_booking ON pass_entries(booking_id);
  `);

  migrate(db);

  seedIfEmpty(db);
  return db;
}

// Additive migrations for databases created before a column existed.
function migrate(db: Database.Database) {
  const bookingCols = db.prepare("PRAGMA table_info(bookings)").all() as { name: string }[];
  if (!bookingCols.some((c) => c.name === "user_id")) {
    db.exec("ALTER TABLE bookings ADD COLUMN user_id INTEGER REFERENCES users(id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id)");
  }
  if (!bookingCols.some((c) => c.name === "series_code")) {
    db.exec("ALTER TABLE bookings ADD COLUMN series_code TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_bookings_series ON bookings(series_code)");
  }
  // courts: add capacity and drop the sport CHECK. Both need a table
  // rebuild, so copy through a new table with foreign keys briefly off.
  const courtCols = db.prepare("PRAGMA table_info(courts)").all() as { name: string }[];
  if (courtCols.length > 0 && !courtCols.some((c) => c.name === "capacity")) {
    rebuild(db, () => {
      db.exec(`
        CREATE TABLE courts_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          venue_id INTEGER NOT NULL REFERENCES venues(id),
          name TEXT NOT NULL,
          sport TEXT NOT NULL,
          off_peak_rate INTEGER NOT NULL,
          peak_rate INTEGER NOT NULL,
          capacity INTEGER NOT NULL DEFAULT 1
        );
        INSERT INTO courts_new (id, venue_id, name, sport, off_peak_rate, peak_rate, capacity)
          SELECT id, venue_id, name, sport, off_peak_rate, peak_rate, 1 FROM courts;
        DROP TABLE courts;
        ALTER TABLE courts_new RENAME TO courts;
      `);
    });
  }

  // Member rates. Added after the rebuild above, which recreates the table
  // from a fixed column list and would drop them.
  const ratedCols = db.prepare("PRAGMA table_info(courts)").all() as { name: string }[];
  if (ratedCols.length > 0 && !ratedCols.some((c) => c.name === "member_off_peak_rate")) {
    db.exec("ALTER TABLE courts ADD COLUMN member_off_peak_rate INTEGER");
    db.exec("ALTER TABLE courts ADD COLUMN member_peak_rate INTEGER");
  }

  // Hire deposits. Same ordering rule as the member rates above.
  const depositCols = db.prepare("PRAGMA table_info(courts)").all() as { name: string }[];
  if (depositCols.length > 0 && !depositCols.some((c) => c.name === "deposit")) {
    db.exec("ALTER TABLE courts ADD COLUMN deposit INTEGER NOT NULL DEFAULT 0");
  }

  const staffCols = db.prepare("PRAGMA table_info(venues)").all() as { name: string }[];
  if (staffCols.length > 0 && !staffCols.some((c) => c.name === "staffed_from")) {
    // NULL on every existing row: every venue is staffed until it says so.
    db.exec("ALTER TABLE venues ADD COLUMN staffed_from INTEGER");
    db.exec("ALTER TABLE venues ADD COLUMN staffed_to INTEGER");
    db.exec("ALTER TABLE venues ADD COLUMN emergency_phone TEXT");
    db.exec("ALTER TABLE venues ADD COLUMN emergency_info TEXT");
  }

  // Unmanned access. Same ordering rule again.
  const doorCols = db.prepare("PRAGMA table_info(courts)").all() as { name: string }[];
  if (doorCols.length > 0 && !doorCols.some((c) => c.name === "unmanned")) {
    db.exec("ALTER TABLE courts ADD COLUMN unmanned INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE courts ADD COLUMN access_code TEXT");
    db.exec("ALTER TABLE courts ADD COLUMN access_code_changed_at TEXT");
  }

  // Which language somebody joined a waitlist in. The offer is written when
  // somebody else cancels, so the request that triggers it belongs to a
  // different person — the language has to have been recorded up front.
  const waitCols = db.prepare("PRAGMA table_info(waitlist)").all() as { name: string }[];
  if (waitCols.length > 0 && !waitCols.some((c) => c.name === "locale")) {
    db.exec("ALTER TABLE waitlist ADD COLUMN locale TEXT NOT NULL DEFAULT 'en'");
  }

  const blockCols = db.prepare("PRAGMA table_info(slot_blocks)").all() as { name: string }[];
  if (blockCols.length > 0 && !blockCols.some((c) => c.name === "places")) {
    // NULL on every existing row, which is exactly the old meaning.
    db.exec("ALTER TABLE slot_blocks ADD COLUMN places INTEGER");
  }

  // booking_slots: add seat and widen the UNIQUE constraint to include it.
  const slotCols = db.prepare("PRAGMA table_info(booking_slots)").all() as { name: string }[];
  if (slotCols.length > 0 && !slotCols.some((c) => c.name === "seat")) {
    rebuild(db, () => {
      db.exec(`
        CREATE TABLE booking_slots_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
          court_id INTEGER NOT NULL REFERENCES courts(id),
          date TEXT NOT NULL,
          hour INTEGER NOT NULL,
          seat INTEGER NOT NULL DEFAULT 0,
          UNIQUE (court_id, date, hour, seat)
        );
        INSERT INTO booking_slots_new (id, booking_id, court_id, date, hour, seat)
          SELECT id, booking_id, court_id, date, hour, 0 FROM booking_slots;
        DROP TABLE booking_slots;
        ALTER TABLE booking_slots_new RENAME TO booking_slots;
        CREATE INDEX IF NOT EXISTS idx_slots_court_date ON booking_slots(court_id, date);
      `);
    });
  }

  // A per-booking secret so a customer can check themselves in by QR without
  // the code alone being enough (codes are short and appear on receipts).
  if (!bookingCols.some((c) => c.name === "check_in_token")) {
    db.exec("ALTER TABLE bookings ADD COLUMN check_in_token TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_bookings_checkin_token ON bookings(check_in_token)");
    const rows = db.prepare("SELECT id FROM bookings WHERE check_in_token IS NULL").all() as {
      id: number;
    }[];
    const setToken = db.prepare("UPDATE bookings SET check_in_token = ? WHERE id = ?");
    db.transaction(() => {
      for (const row of rows) setToken.run(randomBytes(16).toString("hex"), row.id);
    })();
  }

  // An enrolment is a booking that points at the class it belongs to.
  if (!bookingCols.some((c) => c.name === "class_id")) {
    db.exec("ALTER TABLE bookings ADD COLUMN class_id INTEGER REFERENCES classes(id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_bookings_class ON bookings(class_id)");
  }

  if (!bookingCols.some((c) => c.name === "no_show")) {
    db.exec("ALTER TABLE bookings ADD COLUMN no_show INTEGER NOT NULL DEFAULT 0");
  }
  const venueCols = db.prepare("PRAGMA table_info(venues)").all() as { name: string }[];
  if (!venueCols.some((c) => c.name === "open_hour")) {
    db.exec("ALTER TABLE venues ADD COLUMN open_hour INTEGER NOT NULL DEFAULT 8");
    db.exec("ALTER TABLE venues ADD COLUMN close_hour INTEGER NOT NULL DEFAULT 23");
  }
  if (!venueCols.some((c) => c.name === "cancel_cutoff_hours")) {
    db.exec(
      "ALTER TABLE venues ADD COLUMN cancel_cutoff_hours INTEGER NOT NULL DEFAULT 2"
    );
  }
  if (!bookingCols.some((c) => c.name === "payment_status")) {
    db.exec(
      "ALTER TABLE bookings ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid'))"
    );
    db.exec("ALTER TABLE bookings ADD COLUMN paid_at TEXT");
  }

  // Which bookings the demo seeder invented. Everything already in a database
  // that predates this column is real by definition, so the default of 0 is
  // the right answer for every existing row.
  if (!bookingCols.some((c) => c.name === "demo")) {
    db.exec("ALTER TABLE bookings ADD COLUMN demo INTEGER NOT NULL DEFAULT 0");
  }

  // How a paid booking was paid, where that is not the counter: 'online' for
  // the venue's gateway. NULL for everything already paid, which was paid by
  // hand, from credit or with a pass.
  if (!bookingCols.some((c) => c.name === "paid_via")) {
    db.exec("ALTER TABLE bookings ADD COLUMN paid_via TEXT");
  }

  // Whose credit a ledger line is: the venue it was bought at or spent at,
  // when credit is per venue (lib/mode.ts). NULL is credit spendable at any
  // venue — which is everything written before this column existed.
  // What a marketplace venue pays, and from when. NULL fee: the default;
  // NULL start: not billed — every venue that predates billing.
  if (!venueCols.some((c) => c.name === "monthly_fee")) {
    db.exec("ALTER TABLE venues ADD COLUMN monthly_fee REAL");
    db.exec("ALTER TABLE venues ADD COLUMN billing_starts_on TEXT");
  }

  const paymentCols = db.prepare("PRAGMA table_info(online_payments)").all() as { name: string }[];
  if (paymentCols.length > 0 && !paymentCols.some((c) => c.name === "purpose")) {
    db.exec(
      "ALTER TABLE online_payments ADD COLUMN purpose TEXT NOT NULL DEFAULT 'booking' CHECK (purpose IN ('booking','invoice'))"
    );
    db.exec("ALTER TABLE online_payments ADD COLUMN invoice_id INTEGER REFERENCES venue_invoices(id)");
  }

  const walletCols = db.prepare("PRAGMA table_info(wallet_entries)").all() as { name: string }[];
  if (walletCols.length > 0 && !walletCols.some((c) => c.name === "venue_id")) {
    db.exec("ALTER TABLE wallet_entries ADD COLUMN venue_id INTEGER REFERENCES venues(id)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_wallet_user_venue ON wallet_entries(user_id, venue_id)");
  }

  const messageCols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  if (messageCols.length > 0 && !messageCols.some((c) => c.name === "dedupe_key")) {
    db.exec("ALTER TABLE messages ADD COLUMN dedupe_key TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedupe ON messages(dedupe_key)");
  }
  if (messageCols.length > 0 && !messageCols.some((c) => c.name === "params")) {
    db.exec("ALTER TABLE messages ADD COLUMN params TEXT");
  }
}

/**
 * Run a table rebuild. PRAGMA foreign_keys is a no-op inside a transaction, so
 * it is toggled outside one while the copy itself stays atomic.
 */
function rebuild(db: Database.Database, work: () => void): void {
  const hadForeignKeys = db.pragma("foreign_keys", { simple: true }) === 1;
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(work)();
  } finally {
    if (hadForeignKeys) db.pragma("foreign_keys = ON");
  }
}

function seedIfEmpty(db: Database.Database) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM venues").get() as { n: number };
  if (count.n > 0) return;

  const insertVenue = db.prepare(
    "INSERT INTO venues (name, area, address, phone, open_hour, close_hour) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insertCourt = db.prepare(
    "INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate, capacity, deposit) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const court = (
    venueId: number,
    name: string,
    sport: string,
    offPeak: number,
    peak: number,
    capacity = 1,
    deposit = 0
  ) => insertCourt.run(venueId, name, sport, offPeak, peak, capacity, deposit);

  const seed = db.transaction(() => {
    const arena = insertVenue.run(
      "Arena MySenam @ Petaling Jaya",
      "Petaling Jaya",
      "12 Jalan SS2/61, 47300 Petaling Jaya, Selangor",
      "+60 3-1234 5678",
      8,
      23
    ).lastInsertRowid as number;

    for (let i = 1; i <= 4; i++) court(arena, `Badminton Court ${i}`, "badminton", 15, 25, 1);
    for (let i = 1; i <= 2; i++) court(arena, `Pickleball Court ${i}`, "pickleball", 20, 30, 1);
    court(arena, "Futsal Pitch A", "futsal", 80, 120, 1);
    // Shared-capacity facilities: many people hold the same hour.
    court(arena, "Gym Floor", "gym", 5, 8, 40);

    const sunway = insertVenue.run(
      "SmashPoint Sports Centre",
      "Subang Jaya",
      "8 Persiaran Kewajipan, USJ 1, 47600 Subang Jaya, Selangor",
      "+60 3-8765 4321",
      // The lap pool opens for the before-work swim.
      7,
      22
    ).lastInsertRowid as number;

    for (let i = 1; i <= 6; i++) court(sunway, `Badminton Court ${i}`, "badminton", 12, 22, 1);
    for (let i = 1; i <= 2; i++) court(sunway, `Tennis Court ${i}`, "tennis", 25, 40, 1);
    court(sunway, "Lap Pool", "swimming", 4, 6, 25);

    const bangsar = insertVenue.run(
      "Bangsar Racquet Club",
      "Bangsar",
      "3 Jalan Maarof, Bangsar, 59000 Kuala Lumpur",
      "+60 3-2222 3333",
      9,
      22
    ).lastInsertRowid as number;

    for (let i = 1; i <= 3; i++) court(bangsar, `Tennis Court ${i}`, "tennis", 30, 45, 1);
    for (let i = 1; i <= 4; i++) court(bangsar, `Pickleball Court ${i}`, "pickleball", 18, 28, 1);

    const lakeside = insertVenue.run(
      "Putrajaya Lakeside Watersports",
      "Putrajaya",
      "Presint 5, Persiaran Perdana, 62000 Putrajaya",
      "+60 3-8888 1234",
      // Off the water before the afternoon storms.
      8,
      19
    ).lastInsertRowid as number;

    // A fleet, not a court: eight hulls share the hour, and each one goes out
    // of the building, so the desk holds a deposit against it.
    court(lakeside, "Kayak Fleet", "kayak", 15, 20, 8, 50);
  });

  seed();
}
