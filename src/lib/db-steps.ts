import { venueZoneOf } from "./zones.ts";
import { minuteOfDay } from "./interval.ts";
import { syncBuiltinActivities } from "./activities.ts";

/**
 * Work a migration needs from the application, run straight after that
 * migration's SQL in the same transaction (lib/db.ts `migrate`): a step that
 * throws undoes the migration with it.
 *
 * Steps are for what SQL cannot do alone, such as working out a venue's time
 * zone from its pin. They read and write through the migration's own
 * connection, never `getDb()`.
 */

export interface StepRunner {
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const STEPS: Record<string, (db: StepRunner) => Promise<void>> = {
  "0089_interval_schema": stageVenueZones,
  "0090_interval_claims": verifyClaims,
  // The built-ins in full, over the stand-ins 0092 wrote for whatever was named already.
  "0092_activities": syncBuiltinActivities,
};

export async function runStep(version: string, db: StepRunner): Promise<void> {
  await STEPS[version]?.(db);
}

/** Each venue's zone, as the app works it out, for 0090 to turn local times into moments. */
async function stageVenueZones(db: StepRunner): Promise<void> {
  const venues = (await db.query("SELECT id, time_zone, lat, lng FROM venues", [])).rows as {
    id: number;
    time_zone: string | null;
    lat: number | null;
    lng: number | null;
  }[];
  for (const v of venues)
    await db.query("INSERT INTO migration_venue_zones (venue_id, zone) VALUES ($1, $2)", [v.id, venueZoneOf(v)]);
}

/**
 * The old diary and the new claims hold the same: for every court and half
 * hour the old one had anything in, the same booking and block time is
 * claimed, and the claims' moments come back to the minutes they were made
 * from. Classes and outages are claimed more widely than the diary showed
 * them (a class always held its court; an outage now takes whole days), so
 * they are checked to be there, not to match.
 */
async function verifyClaims(db: StepRunner): Promise<void> {
  const q = async <T>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[];
  const zones = new Map(
    (await q<{ venue_id: number; zone: string }>("SELECT venue_id, zone FROM migration_venue_zones")).map((r) => [r.venue_id, r.zone])
  );
  const courts = new Map(
    (await q<{ id: number; venue_id: number; capacity: number }>("SELECT id, venue_id, capacity FROM courts")).map((c) => [c.id, c])
  );
  const spacesOf = new Map<number, number[]>();
  for (const r of await q<{ court_id: number; space_id: number }>("SELECT court_id, space_id FROM court_spaces"))
    spacesOf.set(r.court_id, [...(spacesOf.get(r.court_id) ?? []), r.space_id]);

  // What the old diary held: exclusive courts, half hours taken (bookings with
  // their shadows, blocks with those carried across links); shared ones,
  // places taken.
  const old = new Map<string, number>();
  const add = (court: number, date: string, hour: number, places: number) => {
    const key = `${court}|${date}|${Math.round(Number(hour) * 60)}`;
    old.set(key, (old.get(key) ?? 0) + places);
  };
  for (const s of await q<{ court_id: number; date: string; hour: number }>(
    `SELECT s.court_id, s.date, s.hour FROM booking_slots s JOIN bookings b ON b.id = s.booking_id WHERE b.class_id IS NULL`
  ))
    add(s.court_id, s.date, s.hour, 1);
  const links = await q<{ court_id: number; other: number }>(
    `SELECT whole_id AS court_id, part_id AS other FROM court_links
     UNION ALL SELECT part_id, whole_id FROM court_links
     UNION ALL SELECT a.whole_id, o.whole_id FROM court_links a JOIN court_links o ON o.part_id = a.part_id AND o.whole_id <> a.whole_id`
  );
  for (const b of await q<{ court_id: number; date: string; hour: number; places: number | null }>(
    "SELECT court_id, date, hour, places FROM slot_blocks"
  )) {
    const court = courts.get(b.court_id)!;
    add(b.court_id, b.date, b.hour, court.capacity === 1 ? 1 : (b.places ?? court.capacity));
    if (court.capacity === 1)
      for (const l of links.filter((x) => x.other === b.court_id)) add(l.court_id, b.date, b.hour, 1);
  }

  // What the claims hold, on the same half hours.
  const claims = await q<{ court_id: number; space_id: number | null; places: number | null; lo: Date; hi: Date | null }>(
    `SELECT court_id, space_id, places, lower(during) AS lo, upper(during) AS hi FROM claims WHERE active AND kind IN ('booking', 'block')`
  );
  const held = (court: number, date: string, minute: number): number => {
    const c = courts.get(court)!;
    const zone = zones.get(c.venue_id)!;
    const mine = spacesOf.get(court) ?? [];
    let n = 0;
    for (const k of claims) {
      if (c.capacity === 1 ? k.space_id === null || !mine.includes(k.space_id) : k.court_id !== court) continue;
      const start = minuteOfDay(new Date(k.lo), date, zone);
      const end = k.hi === null ? Infinity : minuteOfDay(new Date(k.hi), date, zone);
      if (start <= minute && minute + 30 <= end) n += c.capacity === 1 ? 1 : (k.places ?? 0);
      else if (start < minute + 30 && minute < end) throw new Error(`Claim on court ${court} cuts the half hour ${date} ${minute} in two`);
    }
    return n;
  };
  for (const [key, places] of old) {
    const [court, date, minute] = key.split("|");
    const c = courts.get(Number(court))!;
    const want = c.capacity === 1 ? 1 : places;
    const got = held(Number(court), date, Number(minute));
    if (c.capacity === 1 ? got < 1 : got !== want)
      throw new Error(`Court ${court} on ${date} at minute ${minute}: the diary held ${want}, the claims hold ${got}`);
  }
  // And nothing claimed that the diary did not hold.
  const total = (await q<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM claims WHERE active AND kind IN ('booking', 'block')`
  ))[0].n;
  const expected = (await q<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM bookings b JOIN court_spaces cs ON cs.court_id = b.court_id
              WHERE b.class_id IS NULL AND EXISTS (SELECT 1 FROM booking_slots s WHERE s.booking_id = b.id AND s.shadow = 0))
          + (SELECT COUNT(*) FROM bookings b JOIN courts c ON c.id = b.court_id
              WHERE c.capacity > 1 AND b.class_id IS NULL AND EXISTS (SELECT 1 FROM booking_slots s WHERE s.booking_id = b.id AND s.shadow = 0))
          + (SELECT COUNT(*) FROM blocks k JOIN court_spaces cs ON cs.court_id = k.court_id)
          + (SELECT COUNT(*) FROM blocks k JOIN courts c ON c.id = k.court_id WHERE c.capacity > 1) AS n`
  ))[0].n;
  if (Number(total) !== Number(expected)) throw new Error(`${total} booking and block claims, ${expected} expected`);

  const classes = await q<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM classes k WHERE k.status = 'scheduled' AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.class_id = k.id)`
  );
  if (Number(classes[0].n) > 0) throw new Error(`${classes[0].n} scheduled classes hold no court`);
  const outages = await q<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM court_outages o WHERE NOT EXISTS (SELECT 1 FROM claims c WHERE c.outage_id = o.id)`
  );
  if (Number(outages[0].n) > 0) throw new Error(`${outages[0].n} outages hold no court`);
}
