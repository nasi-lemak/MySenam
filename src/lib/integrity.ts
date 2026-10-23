import { getDb } from "./db";
import { rangeLiteral } from "./interval";
import { addDays, todayISO } from "./time";
import { venueZoneOf } from "./zones";

/**
 * Do the bookings and what they hold still agree? The claims are what keeps
 * two bookings off one court (ADR 0009); a booking without its claim can be
 * double-booked, and a claim without its booking keeps a court empty for
 * nobody. Every write keeps the two together in one transaction, so this
 * finds nothing unless something went round the code — a hand-edited row, a
 * restore of half a backup, a defect. It looks at what has not happened yet
 * (from yesterday on), where a mismatch can still hurt somebody.
 */

export type IntegrityKind =
  /** A live booking holds no court time: anybody else can book over it. (A place in a class is held by the class.) */
  | "booking_unheld"
  /** A booking holds a different court or time from the one it says. */
  | "booking_mistimed"
  /** A cancelled booking still holds its court. */
  | "claim_orphaned"
  /** A booking is for an activity its court no longer offers. */
  | "activity_not_offered"
  /** A cancelled lesson still holds its coach. */
  | "coach_orphaned"
  /** A scheduled class holds no court time. */
  | "class_unheld"
  /** A cancelled class still holds its court. */
  | "class_orphaned";

export interface IntegrityProblem {
  kind: IntegrityKind;
  venueId: number;
  bookingId?: number;
  classId?: number;
  detail: string;
}

/** At most this many of each kind: enough to act on, never a page that will not load. */
const EACH = 50;

export async function checkIntegrity(): Promise<IntegrityProblem[]> {
  const db = getDb();
  const from = addDays(todayISO(), -1);
  const problems: IntegrityProblem[] = [];

  const unheld = (await db
    .prepare(
      `SELECT b.id, c.venue_id, b.code, b.date FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE b.status = 'confirmed' AND b.class_id IS NULL AND b.date >= ?
          AND NOT EXISTS (SELECT 1 FROM claims cl WHERE cl.booking_id = b.id AND cl.active)
        ORDER BY b.date, b.id LIMIT ${EACH}`
    )
    .all(from)) as { id: number; venue_id: number; code: string; date: string }[];
  for (const b of unheld)
    problems.push({ kind: "booking_unheld", venueId: b.venue_id, bookingId: b.id, detail: `${b.code} on ${b.date} holds no court time` });

  // Where and when each live booking's claims are, against where and when it says.
  const held = (await db
    .prepare(
      `SELECT b.id, c.venue_id, b.code, b.date, b.start_min, b.end_min, b.court_id, cl.court_id AS claim_court,
              lower(cl.during) AS lo, upper(cl.during) AS hi, v.time_zone, v.lat, v.lng
         FROM bookings b
         JOIN courts c ON c.id = b.court_id
         JOIN claims cl ON cl.booking_id = b.id AND cl.active
         JOIN venues v ON v.id = c.venue_id
        WHERE b.status = 'confirmed' AND b.class_id IS NULL AND b.date >= ?
        ORDER BY b.date, b.id`
    )
    .all(from)) as {
    id: number;
    venue_id: number;
    code: string;
    date: string;
    start_min: number;
    end_min: number;
    court_id: number;
    claim_court: number;
    lo: Date | string;
    hi: Date | string | null;
    time_zone: string | null;
    lat: number | null;
    lng: number | null;
  }[];
  const mistimed = new Set<number>();
  for (const r of held) {
    if (mistimed.has(r.id) || mistimed.size >= EACH) continue;
    const zone = venueZoneOf(r);
    const want = rangeLiteral(r.date, r.start_min, r.end_min, zone);
    const got = r.hi === null ? null : `[${new Date(r.lo).toISOString()},${new Date(r.hi).toISOString()})`;
    if (r.claim_court !== r.court_id || got !== want) {
      mistimed.add(r.id);
      problems.push({
        kind: "booking_mistimed",
        venueId: r.venue_id,
        bookingId: r.id,
        detail: `${r.code} says court ${r.court_id} ${want}; holds court ${r.claim_court} ${got ?? "open-ended"}`,
      });
    }
  }

  const orphaned = (await db
    .prepare(
      `SELECT DISTINCT b.id, cl.venue_id, b.code, b.date FROM claims cl JOIN bookings b ON b.id = cl.booking_id
        WHERE cl.active AND b.status <> 'confirmed' AND b.date >= ? ORDER BY b.date, b.id LIMIT ${EACH}`
    )
    .all(from)) as { id: number; venue_id: number; code: string; date: string }[];
  for (const b of orphaned)
    problems.push({ kind: "claim_orphaned", venueId: b.venue_id, bookingId: b.id, detail: `${b.code} on ${b.date} is cancelled but still holds its court` });

  const notOffered = (await db
    .prepare(
      `SELECT b.id, c.venue_id, b.code, b.date, b.sport, c.name FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE b.status = 'confirmed' AND b.date >= ?
          AND NOT EXISTS (SELECT 1 FROM court_activities ca WHERE ca.court_id = b.court_id AND ca.sport = b.sport)
        ORDER BY b.date, b.id LIMIT ${EACH}`
    )
    .all(from)) as { id: number; venue_id: number; code: string; date: string; sport: string; name: string }[];
  for (const b of notOffered)
    problems.push({ kind: "activity_not_offered", venueId: b.venue_id, bookingId: b.id, detail: `${b.code} on ${b.date} is ${b.sport}, which ${b.name} no longer offers` });

  const coach = (await db
    .prepare(
      `SELECT DISTINCT b.id, c.venue_id, b.code, b.date FROM coach_claims cc JOIN bookings b ON b.id = cc.booking_id JOIN courts c ON c.id = b.court_id
        WHERE cc.active AND b.status <> 'confirmed' AND b.date >= ? ORDER BY b.date, b.id LIMIT ${EACH}`
    )
    .all(from)) as { id: number; venue_id: number; code: string; date: string }[];
  for (const b of coach)
    problems.push({ kind: "coach_orphaned", venueId: b.venue_id, bookingId: b.id, detail: `${b.code} on ${b.date} is cancelled but still holds its coach` });

  const classUnheld = (await db
    .prepare(
      `SELECT k.id, c.venue_id, k.name AS title, k.date FROM classes k JOIN courts c ON c.id = k.court_id
        WHERE k.status = 'scheduled' AND k.date >= ?
          AND NOT EXISTS (SELECT 1 FROM claims cl WHERE cl.class_id = k.id AND cl.active)
        ORDER BY k.date, k.id LIMIT ${EACH}`
    )
    .all(from)) as { id: number; venue_id: number; title: string; date: string }[];
  for (const k of classUnheld)
    problems.push({ kind: "class_unheld", venueId: k.venue_id, classId: k.id, detail: `${k.title} on ${k.date} holds no court time` });

  const classOrphaned = (await db
    .prepare(
      `SELECT DISTINCT k.id, cl.venue_id, k.name AS title, k.date FROM claims cl JOIN classes k ON k.id = cl.class_id
        WHERE cl.active AND k.status <> 'scheduled' AND k.date >= ? ORDER BY k.date, k.id LIMIT ${EACH}`
    )
    .all(from)) as { id: number; venue_id: number; title: string; date: string }[];
  for (const k of classOrphaned)
    problems.push({ kind: "class_orphaned", venueId: k.venue_id, classId: k.id, detail: `${k.title} on ${k.date} is cancelled but still holds its court` });

  return problems;
}

/** Once a day from the scheduler: the platform owner hears of any mismatch. */
export async function checkIntegrityIfDue(now = new Date()): Promise<IntegrityProblem[] | null> {
  const db = getDb();
  const last = (await db.prepare("SELECT value FROM settings WHERE key = 'integrity_checked_at'").get()) as { value: string } | undefined;
  if (last && now.getTime() - Date.parse(last.value) < 86_400_000) return null;
  await db
    .prepare("INSERT INTO settings (key, value) VALUES ('integrity_checked_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(now.toISOString());
  return await checkIntegrity();
}
