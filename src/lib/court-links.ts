import { getDb, isUniqueViolation } from "./db";
import { todayISO } from "./time";

/**
 * Linked courts: one floor sold more than one way.
 *
 * A multi-purpose hall can be one futsal pitch or four badminton courts. The
 * venue says which courts the pitch takes (its parts); then booking the pitch
 * takes all four, and booking any one of the four takes the pitch. The four
 * do not take each other, and two wholes over the same court (futsal and
 * netball over the same badminton courts) take each other through it.
 *
 * The database does the holding (db/migrations/0072): each booked hour is
 * mirrored onto the linked courts as a `shadow` slot, so the same unique key
 * that stops two bookings of one court stops a booking across a link, however
 * two requests race. Blocks and outages carry across links the same way.
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

  const today = todayISO();
  try {
    await db.transaction(async () => {
      const before = (await linkedParts(wholeId)).filter((p) => !parts.includes(p));
      for (const part of before) {
        // Shadows of this link go with it: the whole's bookings on the part, the part's on the whole.
        await db
          .prepare(
            `DELETE FROM booking_slots s USING bookings b
              WHERE s.booking_id = b.id AND s.shadow = 1
                AND ((b.court_id = ? AND s.court_id = ?) OR (b.court_id = ? AND s.court_id = ?))`
          )
          .run(wholeId, part, part, wholeId);
        await db.prepare("DELETE FROM court_links WHERE whole_id = ? AND part_id = ?").run(wholeId, part);
      }
      const already = await linkedParts(wholeId);
      for (const part of parts.filter((p) => !already.includes(p))) {
        await db.prepare("INSERT INTO court_links (whole_id, part_id) VALUES (?, ?)").run(wholeId, part);
        // What is already sold from today takes the other side too, as a new booking would.
        await db
          .prepare(
            `INSERT INTO booking_slots (booking_id, court_id, date, hour, seat, span, shadow)
             SELECT booking_id, ?::int, date, hour, 0, span, 1 FROM booking_slots WHERE court_id = ? AND shadow = 0 AND date >= ?
             UNION ALL
             SELECT booking_id, ?::int, date, hour, -?::int, span, 1 FROM booking_slots WHERE court_id = ? AND shadow = 0 AND date >= ?`
          )
          .run(part, wholeId, today, wholeId, part, part, today);
      }
      // Big courts sharing a part take each other through it (migration 0087):
      // what this court's links now say, for what is sold from today.
      await db
        .prepare(
          `DELETE FROM booking_slots s USING bookings b
            WHERE s.booking_id = b.id AND s.shadow = 1 AND s.date >= ? AND s.seat = -b.court_id
              AND (b.court_id = ? OR s.court_id = ?)
              AND NOT EXISTS (SELECT 1 FROM court_links l WHERE l.whole_id = s.court_id AND l.part_id = b.court_id)`
        )
        .run(today, wholeId, wholeId);
      await db
        .prepare(
          `INSERT INTO booking_slots (booking_id, court_id, date, hour, seat, span, shadow)
           SELECT DISTINCT s.booking_id, o.whole_id, s.date, s.hour, -s.court_id, s.span, 1
             FROM booking_slots s
             JOIN court_links a ON a.whole_id = s.court_id
             JOIN court_links o ON o.part_id = a.part_id AND o.whole_id <> a.whole_id
            WHERE s.shadow = 0 AND s.date >= ? AND (s.court_id = ? OR o.whole_id = ?)`
        )
        .run(today, wholeId, wholeId);
    })();
  } catch (err) {
    if (!isUniqueViolation(err, "booking_slots")) throw err;
    const clash = (await db
      .prepare(
        `SELECT MIN(w.date) AS date FROM booking_slots w JOIN booking_slots p ON p.date = w.date AND p.hour = w.hour AND p.booking_id <> w.booking_id
          WHERE w.court_id = ? AND w.shadow = 0 AND w.date >= ? AND p.court_id IN (${parts.map(() => "?").join(",")})`
      )
      .get(wholeId, today, ...parts)) as { date: string | null } | undefined;
    return {
      ok: false,
      error: `${whole.name} and a court it would take are both booked at the same time${clash?.date ? ` on ${clash.date}` : ""}. Move one of them first.`,
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
