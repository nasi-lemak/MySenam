import Database from "better-sqlite3";
import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  // MUDAHTEMPAH_DB overrides the location (tests use ":memory:").
  const dbPath = process.env.MUDAHTEMPAH_DB;
  if (dbPath) {
    db = new Database(dbPath);
  } else {
    const dataDir = path.join(process.cwd(), "data");
    fs.mkdirSync(dataDir, { recursive: true });
    db = new Database(path.join(dataDir, "mudahtempah.db"));
  }
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
      close_hour INTEGER NOT NULL DEFAULT 23
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
      capacity INTEGER NOT NULL DEFAULT 1
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
      check_in_token TEXT
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
    CREATE INDEX IF NOT EXISTS idx_slots_court_date ON booking_slots(court_id, date);
    CREATE INDEX IF NOT EXISTS idx_blocks_court_date ON slot_blocks(court_id, date);
    CREATE INDEX IF NOT EXISTS idx_classes_court_date ON classes(court_id, date);
    CREATE INDEX IF NOT EXISTS idx_waitlist_class ON waitlist(class_id, status);
    CREATE INDEX IF NOT EXISTS idx_waitlist_slot ON waitlist(court_id, date, status);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_wallet_user ON wallet_entries(user_id);
    CREATE INDEX IF NOT EXISTS idx_wallet_booking ON wallet_entries(booking_id);
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions(admin_id);
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
    "INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate, capacity) VALUES (?, ?, ?, ?, ?, ?)"
  );

  const seed = db.transaction(() => {
    const arena = insertVenue.run(
      "Arena MudahTempah @ Petaling Jaya",
      "Petaling Jaya",
      "12 Jalan SS2/61, 47300 Petaling Jaya, Selangor",
      "+60 3-1234 5678",
      8,
      23
    ).lastInsertRowid as number;

    for (let i = 1; i <= 4; i++) insertCourt.run(arena, `Badminton Court ${i}`, "badminton", 15, 25, 1);
    for (let i = 1; i <= 2; i++) insertCourt.run(arena, `Pickleball Court ${i}`, "pickleball", 20, 30, 1);
    insertCourt.run(arena, "Futsal Pitch A", "futsal", 80, 120, 1);
    // Shared-capacity facilities: many people hold the same hour.
    insertCourt.run(arena, "Gym Floor", "gym", 5, 8, 40);

    const sunway = insertVenue.run(
      "SmashPoint Sports Centre",
      "Subang Jaya",
      "8 Persiaran Kewajipan, USJ 1, 47600 Subang Jaya, Selangor",
      "+60 3-8765 4321",
      // The lap pool opens for the before-work swim.
      7,
      22
    ).lastInsertRowid as number;

    for (let i = 1; i <= 6; i++) insertCourt.run(sunway, `Badminton Court ${i}`, "badminton", 12, 22, 1);
    for (let i = 1; i <= 2; i++) insertCourt.run(sunway, `Tennis Court ${i}`, "tennis", 25, 40, 1);
    insertCourt.run(sunway, "Lap Pool", "swimming", 4, 6, 25);

    const bangsar = insertVenue.run(
      "Bangsar Racquet Club",
      "Bangsar",
      "3 Jalan Maarof, Bangsar, 59000 Kuala Lumpur",
      "+60 3-2222 3333",
      9,
      22
    ).lastInsertRowid as number;

    for (let i = 1; i <= 3; i++) insertCourt.run(bangsar, `Tennis Court ${i}`, "tennis", 30, 45, 1);
    for (let i = 1; i <= 4; i++) insertCourt.run(bangsar, `Pickleball Court ${i}`, "pickleball", 18, 28, 1);
  });

  seed();
}
