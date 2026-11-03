import { getDb, withTransaction } from "./db";
import { isConflict } from "./claims";
import { localDateOf } from "./time";
import { venueZoneOf } from "./zones";

/**
 * Linked courts: one floor sold more than one way.
 *
 * A multi-purpose hall can be one futsal pitch or four badminton courts. The
 * venue says which courts the pitch takes (its parts); then booking the pitch
 * takes all four, and booking any one of the four takes the pitch. The four
 * do not take each other, and two wholes over the same court (futsal and
 * netball over the same badminton courts) take each other through it.
 *
 * The database does the holding (ADR 0010): each court that takes one
 * booking at a time is a space, and a whole is the set of its own space and
 * its parts' (`court_spaces`). Booking a court claims every space it covers,
 * so the exclusion constraint that stops two bookings of one court stops a
 * booking across a link, however two requests race, at any depth. Blocks,
 * classes and outages claim spaces the same way.
 *
 * Only exclusive courts link (a shared facility sells places, not the floor),
 * one level deep: a whole is not itself part of something, nor a part a whole.
 */

export interface CourtLink {
  wholeId: number;
  partId: number;
}

export async function courtLinks(venueId: number): Promise<CourtLink[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT l.whole_id, l.part_id FROM court_links l JOIN courts c ON c.id = l.whole_id
        WHERE c.venue_id = ? ORDER BY l.whole_id, l.part_id`
    )
    .all(venueId)) as { whole_id: number; part_id: number }[];
  return rows.map((r) => ({ wholeId: r.whole_id, partId: r.part_id }));
}

/** Every court a booking of this one takes too: its parts, or the wholes it is part of. */
export async function linkedTo(courtId: number): Promise<number[]> {
  const rows = (await getDb()
    .prepare("SELECT part_id AS id FROM court_links WHERE whole_id = ? UNION SELECT whole_id FROM court_links WHERE part_id = ?")
    .all(courtId, courtId)) as { id: number }[];
  return rows.map((r) => r.id).sort((a, b) => a - b);
}

/**
 * Say which courts this one takes when booked: all of them, replacing what it
 * took before. Refused when a link would join two bookings already sold for
 * the same hour, naming the first date, so they can be moved first.
 */
export async function setCourtParts(
  wholeId: number,
  partIds: unknown
): Promise<{ ok: true; parts: number[] } | { ok: false; error: string }> {
  if (!Array.isArray(partIds) || !partIds.every((p) => Number.isInteger(p)))
    return { ok: false, error: "Give the courts this one takes, as a list." };
  const parts = [...new Set(partIds as number[])].sort((a, b) => a - b);
  const db = getDb();
  const whole = (await db.prepare("SELECT id, venue_id, capacity, name FROM courts WHERE id = ?").get(wholeId)) as
    | { id: number; venue_id: number; capacity: number; name: string }
    | undefined;
  if (!whole) return { ok: false, error: "Court not found." };
  if (parts.includes(wholeId)) return { ok: false, error: "A court cannot take itself." };
  if (parts.length > 0) {
    if (whole.capacity !== 1) return { ok: false, error: "Only a court booked whole can take others: this one sells places." };
    const found = (await db
      .prepare(`SELECT id, venue_id, capacity, name FROM courts WHERE id IN (${parts.map(() => "?").join(",")})`)
      .all(...parts)) as { id: number; venue_id: number; capacity: number; name: string }[];
    if (found.length !== parts.length || found.some((c) => c.venue_id !== whole.venue_id))
      return { ok: false, error: "Those courts are not all at this venue." };
    const shared = found.find((c) => c.capacity !== 1);
    if (shared) return { ok: false, error: `${shared.name} sells places, not the whole court, so it cannot be linked.` };
    if (await db.prepare("SELECT 1 FROM court_links WHERE part_id = ?").get(wholeId))
      return { ok: false, error: `${whole.name} is already part of a bigger court. Link from that one instead.` };
    const nested = (await db
      .prepare(`SELECT DISTINCT c.name FROM court_links l JOIN courts c ON c.id = l.whole_id WHERE l.whole_id IN (${parts.map(() => "?").join(",")})`)
      .all(...parts)) as { name: string }[];
    if (nested.length > 0) return { ok: false, error: `${nested[0].name} takes other courts itself, so it cannot be part of this one.` };
  }

  const spaceOf = async (courtId: number) =>
    ((await db.prepare("SELECT id FROM spaces WHERE court_id = ?").get(courtId)) as { id: number } | undefined)?.id;
  const own = await spaceOf(wholeId);
  if (own === undefined) return { ok: false, error: "Court not found." };
  try {
    await withTransaction(async () => {
      const before = (await linkedParts(wholeId)).filter((p) => !parts.includes(p));
      for (const part of before) {
        const space = await spaceOf(part);
        // The whole no longer covers the part: its claims there go with the link.
        if (space !== undefined) {
          await db.prepare("DELETE FROM claims WHERE court_id = ? AND space_id = ?").run(wholeId, space);
          await db.prepare("DELETE FROM claims_archive WHERE court_id = ? AND space_id = ?").run(wholeId, space);
          await db.prepare("DELETE FROM court_spaces WHERE court_id = ? AND space_id = ?").run(wholeId, space);
        }
        await db.prepare("DELETE FROM court_links WHERE whole_id = ? AND part_id = ?").run(wholeId, part);
      }
      const already = await linkedParts(wholeId);
      for (const part of parts.filter((p) => !already.includes(p))) {
        const space = await spaceOf(part);
        if (space === undefined) continue;
        await db.prepare("INSERT INTO court_links (whole_id, part_id) VALUES (?, ?)").run(wholeId, part);
        await db.prepare("INSERT INTO court_spaces (court_id, space_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(wholeId, space);
        // What the whole holds from now on takes the part too, as a new booking would.
        await db
          .prepare(
            `INSERT INTO claims (venue_id, court_id, space_id, kind, booking_id, class_id, block_id, outage_id, waitlist_id, move_id,
                                 during, occupied, buffer_before, buffer_after, separation_before, separation_after, active, expires_at)
             SELECT venue_id, court_id, ?, kind, booking_id, class_id, block_id, outage_id, waitlist_id, move_id,
                    during, occupied, buffer_before, buffer_after, separation_before, separation_after, active, expires_at
               FROM claims
              WHERE court_id = ? AND space_id = ? AND active AND (upper(occupied) IS NULL OR upper(occupied) > now())`
          )
          .run(space, wholeId, own);
      }
    });
  } catch (err) {
    if (!isConflict(err)) throw err;
    // The first time the whole and a court it would take are both held.
    const clash = (await db
      .prepare(
        `SELECT min(lower(w.during)) AS at, v.time_zone, v.lat, v.lng FROM claims w
           JOIN spaces s ON s.court_id IN (${parts.map(() => "?").join(",")})
           JOIN claims p ON p.space_id = s.id AND p.court_id <> ? AND p.active AND p.occupied && w.occupied
           JOIN venues v ON v.id = w.venue_id
          WHERE w.court_id = ? AND w.space_id = ? AND w.active AND (upper(w.occupied) IS NULL OR upper(w.occupied) > now())
          GROUP BY v.time_zone, v.lat, v.lng`
      )
      .get(...parts, wholeId, wholeId, own)) as { at: Date | null; time_zone: string | null; lat: number | null; lng: number | null } | undefined;
    const date = clash?.at ? localDateOf(new Date(clash.at).toISOString(), venueZoneOf(clash)) : null;
    return {
      ok: false,
      error: `${whole.name} and a court it would take are both booked at the same time${date ? ` on ${date}` : ""}. Move one of them first.`,
    };
  }
  return { ok: true, parts: await linkedParts(wholeId) };
}

async function linkedParts(wholeId: number): Promise<number[]> {
  const rows = (await getDb().prepare("SELECT part_id FROM court_links WHERE whole_id = ? ORDER BY part_id").all(wholeId)) as {
    part_id: number;
  }[];
  return rows.map((r) => r.part_id);
}
