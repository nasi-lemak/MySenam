import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dataDir = path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(path.join(dataDir, "mudahtempah.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS venues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      area TEXT NOT NULL,
      address TEXT NOT NULL,
      phone TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS courts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venue_id INTEGER NOT NULL REFERENCES venues(id),
      name TEXT NOT NULL,
      sport TEXT NOT NULL CHECK (sport IN ('badminton','tennis','pickleball','futsal')),
      off_peak_rate INTEGER NOT NULL,
      peak_rate INTEGER NOT NULL
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
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- One row per booked hour; the UNIQUE constraint is what makes
    -- double-booking impossible even under concurrent requests.
    CREATE TABLE IF NOT EXISTS booking_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      court_id INTEGER NOT NULL REFERENCES courts(id),
      date TEXT NOT NULL,
      hour INTEGER NOT NULL,
      UNIQUE (court_id, date, hour)
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);
    CREATE INDEX IF NOT EXISTS idx_slots_court_date ON booking_slots(court_id, date);
  `);

  seedIfEmpty(db);
  return db;
}

function seedIfEmpty(db: Database.Database) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM venues").get() as { n: number };
  if (count.n > 0) return;

  const insertVenue = db.prepare(
    "INSERT INTO venues (name, area, address, phone) VALUES (?, ?, ?, ?)"
  );
  const insertCourt = db.prepare(
    "INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate) VALUES (?, ?, ?, ?, ?)"
  );

  const seed = db.transaction(() => {
    const arena = insertVenue.run(
      "Arena MudahTempah @ Petaling Jaya",
      "Petaling Jaya",
      "12 Jalan SS2/61, 47300 Petaling Jaya, Selangor",
      "+60 3-1234 5678"
    ).lastInsertRowid as number;

    for (let i = 1; i <= 4; i++) insertCourt.run(arena, `Badminton Court ${i}`, "badminton", 15, 25);
    for (let i = 1; i <= 2; i++) insertCourt.run(arena, `Pickleball Court ${i}`, "pickleball", 20, 30);
    insertCourt.run(arena, "Futsal Pitch A", "futsal", 80, 120);

    const sunway = insertVenue.run(
      "SmashPoint Sports Centre",
      "Subang Jaya",
      "8 Persiaran Kewajipan, USJ 1, 47600 Subang Jaya, Selangor",
      "+60 3-8765 4321"
    ).lastInsertRowid as number;

    for (let i = 1; i <= 6; i++) insertCourt.run(sunway, `Badminton Court ${i}`, "badminton", 12, 22);
    for (let i = 1; i <= 2; i++) insertCourt.run(sunway, `Tennis Court ${i}`, "tennis", 25, 40);

    const bangsar = insertVenue.run(
      "Bangsar Racquet Club",
      "Bangsar",
      "3 Jalan Maarof, Bangsar, 59000 Kuala Lumpur",
      "+60 3-2222 3333"
    ).lastInsertRowid as number;

    for (let i = 1; i <= 3; i++) insertCourt.run(bangsar, `Tennis Court ${i}`, "tennis", 30, 45);
    for (let i = 1; i <= 4; i++) insertCourt.run(bangsar, `Pickleball Court ${i}`, "pickleball", 18, 28);
  });

  seed();
}
