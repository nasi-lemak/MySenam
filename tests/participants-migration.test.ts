import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { runStep } from "../src/lib/db-steps";

/**
 * Migrations 0138–0140 (ADR 0023) on an install with people adults manage
 * (0135), bookings for them, their sign-offs and waivers, and inductions
 * filed by phone number: every managed person becomes a participant with
 * their adult's relationship made explicit as it was declared; every booking
 * for one names them in `booking_participants`, the booking itself (its
 * money, customer and summary) untouched; nothing is moved between people on
 * contact details: an induction under a family's number stays the number
 * holder's, flagged for staff where the name is not the account holder's.
 */

const DIR = path.join(__dirname, "..", "db", "migrations");
const FILES = fs.readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

async function run(db: PGlite, files: string[]): Promise<void> {
  for (const f of files) {
    const version = f.replace(/\.sql$/, "");
    await db.transaction(async (tx) => {
      await tx.exec(fs.readFileSync(path.join(DIR, f), "utf8"));
      await runStep(version, { query: async (sql, params) => ({ rows: (await tx.query(sql, params)).rows as Record<string, unknown>[] }) });
    });
  }
}

describe("migrations 0138–0140 on people managed from accounts, their bookings and phone-keyed inductions", () => {
  it("makes each relationship explicit, keeps every booking as it was, and moves nothing on contact details", async () => {
    const db = new PGlite({ extensions: { citext } });
    await run(db, FILES.filter((f) => f < "0138"));
    const id = async (sql: string, params: unknown[] = []) => (await db.query<{ id: number }>(`${sql} RETURNING id`, params)).rows[0].id;

    const venue = await id("INSERT INTO venues (name, area, address, phone, time_zone) VALUES ('Old Wall', 'PJ', 'x', '031', 'Asia/Kuala_Lumpur')");
    const court = await id("INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate) VALUES ($1, 'Hall', 'badminton', 20, 30)", [venue]);
    const user = (name: string, email: string, ph: string) => id("INSERT INTO users (name, email, phone, password_hash) VALUES ($1, $2, $3, 'x')", [name, email, ph]);
    const mum = await user("Siti Aminah", "siti@old.my", "0123000001");
    const solo = await user("Lim Wei", "lim@old.my", "0123000002");
    // Siti manages two children, one archived; the two share her number and email, as children do.
    const kid = (name: string, rel: string, archived: boolean) =>
      id(
        `INSERT INTO managed_people (user_id, display_name, birth_year, relationship, authority_declared_at, created_at, archived_at)
         VALUES ($1, $2, 2015, $3, '2026-10-26 09:00:00+08', '2026-10-26 09:00:00+08', $4)`,
        [mum, name, rel, archived ? "2026-10-27 10:00:00+08" : null]
      );
    const aisyah = await kid("Aisyah", "parent", false);
    const adam = await kid("Adam", "guardian", true);
    const booking = (name: string, ph: string, userId: number | null, start: number, participant: number | null, participantName: string | null) =>
      id(
        `INSERT INTO bookings (code, court_id, sport, date, start_min, end_min, starts_at, ends_at, name, phone, total_price, user_id, participant_id, participant_name)
         VALUES ($1, $2, 'badminton', '2030-03-05', $3, $4, '2030-03-05 10:00+08', '2030-03-05 11:00+08', $5, $6, 25.5, $7, $8, $9)`,
        [`OLD${start}`, court, start, start + 60, name, ph, userId, participant, participantName]
      );
    const forAisyah = await booking("Siti Aminah", "0123000001", mum, 600, aisyah, "Aisyah");
    const forAdam = await booking("Siti Aminah", "0123000001", mum, 660, adam, "Adam");
    const sitiOwn = await booking("Siti Aminah", "0123000001", mum, 720, null, null);
    const linWei = await booking("Lim Wei", "0123000002", solo, 780, null, null);
    // A booking whose person has since gone (0135's ON DELETE SET NULL): the name was kept.
    const gone = await booking("Siti Aminah", "0123000001", mum, 840, null, "Old name");
    const signOff = await id(
      "INSERT INTO sign_offs (venue_id, sport, phone, name, user_id, managed_person_id) VALUES ($1, 'badminton', '0123000001', 'Aisyah', $2, $3)",
      [venue, mum, aisyah]
    );
    // Inductions as they were filed: by venue and number.
    const filedAsChild = await id("INSERT INTO inductions (venue_id, phone, name) VALUES ($1, '60123000001', 'Aisyah')", [venue]);
    const otherVenue = await id("INSERT INTO venues (name, area, address, phone, time_zone) VALUES ('Second Wall', 'PJ', 'x', '032', 'Asia/Kuala_Lumpur')");
    const filedAsMum = await id("INSERT INTO inductions (venue_id, phone, name) VALUES ($1, '60123000001', 'siti aminah ')", [otherVenue]);
    const filedAsLim = await id("INSERT INTO inductions (venue_id, phone, name) VALUES ($1, '60123000002', 'Lim Wei')", [venue]);
    const bookingsBefore = (await db.query("SELECT row_to_json(b)::text AS row FROM bookings b ORDER BY id")).rows;

    await run(db, FILES.filter((f) => f >= "0138"));

    // Participants keep their ids and names; the adult's relationship is explicit, as declared then.
    expect((await db.query("SELECT id, display_name, birth_year, origin, linked_user_id, created_by_user_id FROM participants ORDER BY id")).rows).toEqual([
      { id: aisyah, display_name: "Aisyah", birth_year: 2015, origin: "account", linked_user_id: null, created_by_user_id: mum },
      { id: adam, display_name: "Adam", birth_year: 2015, origin: "account", linked_user_id: null, created_by_user_id: mum },
    ]);
    const guardians = (await db.query<Record<string, unknown>>(
      `SELECT participant_id, user_id, relationship, provenance, authority_declared_at = '2026-10-26 09:00:00+08' AS declared_then,
              archived_at IS NOT NULL AS archived, revoked_at FROM participant_guardians ORDER BY participant_id`
    )).rows;
    expect(guardians).toEqual([
      { participant_id: aisyah, user_id: mum, relationship: "parent", provenance: "online", declared_then: true, archived: false, revoked_at: null },
      { participant_id: adam, user_id: mum, relationship: "guardian", provenance: "online", declared_then: true, archived: true, revoked_at: null },
    ]);
    expect((await db.query("SELECT participant_id, action FROM participant_events ORDER BY participant_id")).rows).toEqual([
      { participant_id: aisyah, action: "guardian.declared" },
      { participant_id: adam, action: "guardian.declared" },
    ]);

    // Each booking for somebody names them; the adult's own and an unrelated customer's name nobody.
    expect((await db.query("SELECT booking_id, takes_part_as, participant_id, name, added_by_user_id FROM booking_participants ORDER BY booking_id")).rows).toEqual([
      { booking_id: forAisyah, takes_part_as: "participant", participant_id: aisyah, name: "Aisyah", added_by_user_id: mum },
      { booking_id: forAdam, takes_part_as: "participant", participant_id: adam, name: "Adam", added_by_user_id: mum },
      { booking_id: gone, takes_part_as: "participant", participant_id: null, name: "Old name", added_by_user_id: mum },
    ]);
    expect((await db.query("SELECT 1 FROM booking_participants WHERE booking_id IN ($1, $2)", [sitiOwn, linWei])).rows).toEqual([]);
    // The bookings themselves, money and all, exactly as they were: every column they had, unchanged (columns later
    // migrations add to bookings are new, and not this migration's to keep).
    const before = (bookingsBefore as { row: string }[]).map((r) => JSON.parse(r.row) as Record<string, unknown>);
    const after = ((await db.query("SELECT row_to_json(b)::text AS row FROM bookings b ORDER BY id")).rows as { row: string }[]).map(
      (r) => JSON.parse(r.row) as Record<string, unknown>
    );
    expect(after.map((row, i) => Object.fromEntries(Object.keys(before[i]).map((k) => [k, row[k]])))).toEqual(before);
    // The sign-off stays the child's.
    expect((await db.query("SELECT managed_person_id FROM sign_offs WHERE id = $1", [signOff])).rows).toEqual([{ managed_person_id: aisyah }]);

    // Inductions stay the number holder's, nothing moved; the one under the child's name on a family's number is flagged.
    expect((await db.query("SELECT id, participant_id, for_participant, review_reason FROM inductions ORDER BY id")).rows).toEqual([
      { id: filedAsChild, participant_id: null, for_participant: false, review_reason: "shared-number" },
      { id: filedAsMum, participant_id: null, for_participant: false, review_reason: null },
      { id: filedAsLim, participant_id: null, for_participant: false, review_reason: null },
    ]);

    // The summary on a booking now follows its participants: a second child added is in its names.
    const bilal = await id("INSERT INTO participants (display_name) VALUES ('Bilal')");
    await db.query("INSERT INTO booking_participants (booking_id, takes_part_as, participant_id, name) VALUES ($1, 'participant', $2, 'Bilal')", [forAisyah, bilal]);
    expect((await db.query("SELECT participant_id, participant_name FROM bookings WHERE id = $1", [forAisyah])).rows).toEqual([
      { participant_id: aisyah, participant_name: "Aisyah, Bilal" },
    ]);
    // A participant's own induction no longer collides with the number holder's at the same venue.
    await db.query("INSERT INTO inductions (venue_id, phone, name, participant_id, for_participant) VALUES ($1, '60123000001', 'Aisyah', $2, true)", [venue, aisyah]);
    await expect(db.query("INSERT INTO inductions (venue_id, phone, name) VALUES ($1, '60123000001', 'Again')", [venue])).rejects.toThrow();
    // An application for a participant never turns into the adult's: the participant cannot be deleted under it.
    const requirement = await id("INSERT INTO approval_requirements (venue_id, sport, declaration) VALUES ($1, 'badminton', 'I agree.')", [venue]);
    await db.query(
      "INSERT INTO approval_requests (requirement_id, venue_id, sport, user_id, name, phone, status, managed_person_id, declared_adult, guardian_name, guardian_declared_at, expires_at) VALUES ($1, $2, 'badminton', $3, 'Adam', '0123000001', 'pending', $4, 0, 'Siti Aminah', now(), now() + interval '14 days')",
      [requirement, venue, mum, adam]
    );
    await expect(db.query("DELETE FROM participants WHERE id = $1", [adam])).rejects.toThrow();
    await db.close();
  });
});
