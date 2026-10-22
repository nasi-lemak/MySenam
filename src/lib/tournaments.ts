import { getDb } from "./db";
import { hoursOn, parseWeekHours } from "./week-hours";
import { receiptFee } from "./documents";
import {
  bracketSize,
  firstRound,
  groupCount,
  intoGroups,
  knockoutFromGroups,
  parseScore,
  roundRobin,
  scheduleMatches,
  shuffle,
  standings,
  type Slot,
  type Standing,
  type ToSchedule,
} from "./brackets";
import { accessRefusal } from "./access";
import { listRule, OPEN_TO_CUSTOMERS } from "./listing";
import { baseUrl } from "./outbox";
import { siteName } from "./site";
import { offerSlotPlace, venueHours } from "./store";
import { venueZoneOf } from "./zones";
import { sendPlainEmail } from "./transports";
import { addDays, formatHour, isPastSlot, isValidDateString, todayISO } from "./time";
import { SPORTS, type Sport } from "./types";
import type { Level } from "./games";
import { categoryRefusal, isCategory, isPartnerGender, type Category } from "./who";
import { money } from "./region";

/**
 * Tournaments run by venues.
 *
 * A venue sets one up — sport, singles or doubles, level, entry fee, how many
 * may enter, the days and hours, and which courts — and those hours are held
 * at once, as blocks, so nobody books over them. Players enter with their
 * account (and name a partner for doubles), and pay the fee online to the
 * venue or at its counter; past the limit they wait, and move up when
 * somebody withdraws.
 *
 * Staff make the draw: a straight knockout, or round-robin groups whose best
 * go through to one. Seeds are kept apart and get the byes; everybody else
 * is drawn by lot. Every match is given a court and an hour within those
 * held, with nobody playing twice at once and no round before the one it
 * follows — or the draw says how many matches did not fit — and the held
 * hours no match will use go back on sale, then more as results come in
 * (releaseUnneeded). Staff enter each
 * result; winners move on by themselves, groups fill the knockout when their
 * last match is in, and the public page shows it all as it happens.
 */

export type Format = "knockout" | "groups";
export type TournamentStatus = "open" | "closed" | "drawn" | "finished" | "cancelled";
export type EntryStatus = "entered" | "waitlisted" | "withdrawn";

export interface Tournament {
  id: number;
  venueId: number;
  venueName: string;
  area: string;
  name: string;
  sport: Sport;
  format: Format;
  teamSize: 1 | 2;
  /** Open, women's, men's, or mixed doubles (lib/who.ts). */
  category: Category;
  level: Level | null;
  entryFee: number;
  maxEntries: number;
  groupSize: number;
  advance: number;
  startsOn: string;
  endsOn: string;
  startHour: number;
  endHour: number;
  description: string | null;
  status: TournamentStatus;
  courtIds: number[];
  entered: number;
  waitlisted: number;
  payOnline: boolean;
}

export interface Entry {
  id: number;
  name: string;
  status: EntryStatus;
  seed: number | null;
  paid: boolean;
  /** Only for staff, and for the player themselves. */
  userId?: number | null;
}

export interface Match {
  id: number;
  stage: "group" | "knockout";
  groupNo: number | null;
  round: number;
  position: number;
  a: number | null;
  b: number | null;
  courtId: number | null;
  courtName: string | null;
  date: string | null;
  hour: number | null;
  score: string | null;
  winner: number | null;
  status: "scheduled" | "done" | "walkover" | "bye";
}

export interface TournamentDetail extends Tournament {
  entries: Entry[];
  matches: Match[];
  /** Each group's table, once the draw is made. */
  groups: { groupNo: number; table: Standing[] }[];
}

const T_SELECT = `
  SELECT t.*, v.name AS venue_name, v.area,
         (SELECT COUNT(*)::int FROM tournament_entries e WHERE e.tournament_id = t.id AND e.status = 'entered') AS entered,
         (SELECT COUNT(*)::int FROM tournament_entries e WHERE e.tournament_id = t.id AND e.status = 'waitlisted') AS waitlisted,
         ARRAY(SELECT court_id FROM tournament_courts tc WHERE tc.tournament_id = t.id ORDER BY court_id) AS court_ids,
         EXISTS (SELECT 1 FROM venue_payment_accounts a WHERE a.venue_id = v.id AND a.enabled = 1) AS pay_online
    FROM tournaments t JOIN venues v ON v.id = t.venue_id`;

interface TRow {
  id: number;
  venue_id: number;
  venue_name: string;
  area: string;
  name: string;
  sport: Sport;
  format: Format;
  team_size: number;
  category: Category;
  level: Level | null;
  entry_fee: number | string;
  max_entries: number;
  group_size: number;
  advance: number;
  starts_on: string;
  ends_on: string;
  start_hour: number;
  end_hour: number;
  description: string | null;
  status: TournamentStatus;
  court_ids: number[];
  entered: number;
  waitlisted: number;
  pay_online: boolean;
}

function toTournament(r: TRow): Tournament {
  return {
    id: r.id,
    venueId: r.venue_id,
    venueName: r.venue_name,
    area: r.area,
    name: r.name,
    sport: r.sport,
    format: r.format,
    teamSize: r.team_size === 2 ? 2 : 1,
    category: r.category ?? "open",
    level: r.level,
    entryFee: Number(r.entry_fee),
    maxEntries: r.max_entries,
    groupSize: r.group_size,
    advance: r.advance,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    startHour: r.start_hour,
    endHour: r.end_hour,
    description: r.description,
    status: r.status,
    courtIds: (r.court_ids ?? []).map(Number),
    entered: r.entered,
    waitlisted: r.waitlisted,
    payOnline: Boolean(r.pay_online),
  };
}

export async function tournamentById(id: number): Promise<Tournament | null> {
  const row = (await getDb().prepare(`${T_SELECT} WHERE t.id = ?`).get(id)) as TRow | undefined;
  return row ? toTournament(row) : null;
}

/** A venue's own tournaments, newest first, for its staff. */
export async function listTournaments(venueIds: number[]): Promise<Tournament[]> {
  if (venueIds.length === 0) return [];
  return (
    (await getDb()
      .prepare(`${T_SELECT} WHERE t.venue_id IN (${venueIds.map(() => "?").join(",")}) ORDER BY t.starts_on DESC, t.id DESC`)
      .all(...venueIds)) as TRow[]
  ).map(toTournament);
}

/** Tournaments the public can see: coming up, or just played, at venues customers can reach. */
export async function publicTournaments(filter: { sport?: Sport; venueIds?: number[] } = {}): Promise<Tournament[]> {
  const clauses = [listRule(filter.venueIds), "t.status <> 'cancelled'", "t.ends_on >= ?"];
  const params: (string | number)[] = [addDays(todayISO(), -7)];
  if (filter.sport) {
    clauses.push("t.sport = ?");
    params.push(filter.sport);
  }
  if (filter.venueIds) {
    if (filter.venueIds.length === 0) return [];
    clauses.push(`t.venue_id IN (${filter.venueIds.map(() => "?").join(",")})`);
    params.push(...filter.venueIds);
  }
  return (
    (await getDb()
      .prepare(`${T_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY t.starts_on, t.id LIMIT 100`)
      .all(...params)) as TRow[]
  ).map(toTournament);
}

export async function tournamentDetail(id: number, opts: { forStaff?: boolean } = {}): Promise<TournamentDetail | null> {
  const t = await tournamentById(id);
  if (!t) return null;
  const db = getDb();
  const entries = (
    (await db
      .prepare(
        `SELECT id, name, status, seed, paid_at, user_id FROM tournament_entries
          WHERE tournament_id = ? ORDER BY status = 'entered' DESC, seed NULLS LAST, id`
      )
      .all(id)) as { id: number; name: string; status: EntryStatus; seed: number | null; paid_at: string | null; user_id: number | null }[]
  ).map((e) => ({
    id: e.id,
    name: e.name,
    status: e.status,
    seed: e.seed,
    paid: e.paid_at !== null,
    ...(opts.forStaff ? { userId: e.user_id } : {}),
  }));
  const matches = await matchesOf(id);
  const groups = [...new Set(matches.filter((m) => m.stage === "group").map((m) => m.groupNo!))].sort((a, b) => a - b).map((g) => {
    const inGroup = matches.filter((m) => m.stage === "group" && m.groupNo === g);
    const ids = [...new Set(inGroup.flatMap((m) => [m.a!, m.b!]))];
    return {
      groupNo: g,
      table: standings(
        ids,
        inGroup.map((m) => ({ a: m.a!, b: m.b!, winner: m.winner, score: m.score }))
      ),
    };
  });
  return { ...t, entries, matches, groups };
}

async function matchesOf(tournamentId: number): Promise<Match[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT m.*, c.name AS court_name FROM tournament_matches m LEFT JOIN courts c ON c.id = m.court_id
        WHERE m.tournament_id = ? ORDER BY m.stage = 'knockout', m.round, m.group_no, m.position`
    )
    .all(tournamentId)) as {
    id: number;
    stage: "group" | "knockout";
    group_no: number | null;
    round: number;
    position: number;
    entry_a: number | null;
    entry_b: number | null;
    court_id: number | null;
    court_name: string | null;
    date: string | null;
    hour: number | null;
    score: string | null;
    winner: number | null;
    status: Match["status"];
  }[];
  return rows.map((r) => ({
    id: r.id,
    stage: r.stage,
    groupNo: r.group_no,
    round: r.round,
    position: r.position,
    a: r.entry_a,
    b: r.entry_b,
    courtId: r.court_id,
    courtName: r.court_name,
    date: r.date,
    hour: r.hour,
    score: r.score,
    winner: r.winner,
    status: r.status,
  }));
}

// ------------------------------------------------------------ setting one up

export type Result<T = Tournament> = { ok: true; value: T } | { ok: false; error: string; clashes?: number; code?: string };

export interface TournamentInput {
  venueId: number;
  name: string;
  sport: Sport;
  format: Format;
  teamSize: 1 | 2;
  category?: Category;
  level: Level | null;
  entryFee: number;
  maxEntries: number;
  groupSize?: number;
  advance?: number;
  startsOn: string;
  endsOn: string;
  startHour: number;
  endHour: number;
  courtIds: number[];
  description?: string;
}

/** The time zone of the venue running a tournament. */
async function tournamentZone(tournamentId: number): Promise<string> {
  const row = (await getDb().prepare("SELECT venue_id FROM tournaments WHERE id = ?").get(tournamentId)) as { venue_id: number } | undefined;
  return (await venueHours(row?.venue_id ?? 0)).zone;
}

/** Every day, hour and court a tournament would hold. */
function heldSlots(t: { startsOn: string; endsOn: string; startHour: number; endHour: number; courtIds: number[] }): Slot[] {
  const slots: Slot[] = [];
  for (let d = t.startsOn; d <= t.endsOn; d = addDays(d, 1))
    for (let h = t.startHour; h < t.endHour; h++) for (const c of t.courtIds) slots.push({ courtId: c, date: d, hour: h });
  return slots;
}

export async function createTournament(input: TournamentInput, adminId: number): Promise<Result> {
  const db = getDb();
  const name = input.name.trim();
  if (name.length < 3 || name.length > 100) return { ok: false, error: "Give it a name." };
  if (!SPORTS.includes(input.sport)) return { ok: false, error: "Unknown sport." };
  if (input.format !== "knockout" && input.format !== "groups") return { ok: false, error: "Knockout, or groups then knockout." };
  const category = input.category ?? "open";
  if (!isCategory(category)) return { ok: false, error: "Open, women's, men's or mixed." };
  if (category === "mixed" && input.teamSize !== 2) return { ok: false, error: "Mixed is doubles: one woman and one man." };
  if (!isValidDateString(input.startsOn) || !isValidDateString(input.endsOn) || input.endsOn < input.startsOn)
    return { ok: false, error: "Give the first and last day." };
  if (addDays(input.startsOn, 13) < input.endsOn) return { ok: false, error: "Two weeks at most." };
  if (!Number.isInteger(input.maxEntries) || input.maxEntries < 2 || input.maxEntries > 128)
    return { ok: false, error: "Between 2 and 128 entries." };
  if (!Number.isFinite(input.entryFee) || input.entryFee < 0 || input.entryFee > 10000) return { ok: false, error: "Check the entry fee." };
  const venue = (await db
    .prepare("SELECT open_hour, close_hour, week_hours, slot_minutes, time_zone, lat, lng FROM venues WHERE id = ?")
    .get(input.venueId)) as
    | { open_hour: number; close_hour: number; week_hours: string | null; slot_minutes: number; time_zone: string | null; lat: number | null; lng: number | null }
    | undefined;
  if (!venue) return { ok: false, error: "Venue not found." };
  // Today where the venue is.
  if (input.startsOn <= todayISO(venueZoneOf(venue))) return { ok: false, error: "It has to start after today, so players can enter." };
  if (input.endHour <= input.startHour) return { ok: false, error: "The hours must be within the venue's opening hours." };
  // Every day of it, by that day's own hours.
  const usual = { openHour: venue.open_hour, closeHour: venue.close_hour, weekHours: parseWeekHours(venue.week_hours) };
  for (let d = input.startsOn; d <= input.endsOn; d = addDays(d, 1)) {
    const on = hoursOn(usual, d);
    if (on.closed) return { ok: false, error: `The venue is closed on ${d}.` };
    if (input.startHour < on.openHour || input.endHour > on.closeHour)
      return { ok: false, error: `The hours must be within the venue's opening hours, which on ${d} are ${formatHour(on.openHour)}–${formatHour(on.closeHour)}.` };
  }
  const courtIds = [...new Set(input.courtIds)];
  if (courtIds.length === 0) return { ok: false, error: "Hold at least one court." };
  const courts = (await db
    .prepare(`SELECT id FROM courts WHERE venue_id = ? AND sport = ? AND id IN (${courtIds.map(() => "?").join(",")})`)
    .all(input.venueId, input.sport, ...courtIds)) as { id: number }[];
  if (courts.length !== courtIds.length) return { ok: false, error: "Hold only this venue's courts for that sport." };

  // A court out of service on any of those days cannot be held for them.
  const out = (await db
    .prepare(
      `SELECT c.name FROM court_outages o JOIN courts c ON c.id = o.court_id
        WHERE o.court_id IN (${courtIds.map(() => "?").join(",")})
          AND o.starts_on <= ? AND (o.ends_on IS NULL OR o.ends_on >= ?) LIMIT 1`
    )
    .get(...courtIds, input.endsOn, input.startsOn)) as { name: string } | undefined;
  if (out) return { ok: false, error: `${out.name} is out of service then. Choose other courts or days.` };

  // Whatever is booked in those hours stays booked: say so, rather than hold over it.
  const slots = heldSlots({ ...input, courtIds });
  const { clashes } = (await db
    .prepare(
      `SELECT COUNT(DISTINCT s.booking_id)::int AS clashes FROM booking_slots s
        WHERE s.court_id IN (${courtIds.map(() => "?").join(",")}) AND s.date >= ? AND s.date <= ?
          AND s.hour >= ? AND s.hour < ?`
    )
    .get(...courtIds, input.startsOn, input.endsOn, input.startHour, input.endHour)) as { clashes: number };
  if (clashes > 0)
    return {
      ok: false,
      error: `${clashes === 1 ? "A booking is" : `${clashes} bookings are`} already in those hours. Move ${clashes === 1 ? "it" : "them"}, or choose other hours or courts.`,
      clashes,
    };

  let id = 0;
  await db.transaction(async () => {
    const info = await db
      .prepare(
        `INSERT INTO tournaments (venue_id, name, sport, format, team_size, category, level, entry_fee, max_entries, group_size, advance,
                                  starts_on, ends_on, start_hour, end_hour, description, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.venueId,
        name,
        input.sport,
        input.format,
        input.teamSize === 2 ? 2 : 1,
        category,
        input.level,
        Math.round(input.entryFee * 100) / 100,
        input.maxEntries,
        Math.min(Math.max(input.groupSize ?? 4, 3), 6),
        input.advance === 1 ? 1 : 2,
        input.startsOn,
        input.endsOn,
        input.startHour,
        input.endHour,
        input.description?.trim().slice(0, 2000) || null,
        adminId
      );
    id = info.lastInsertRowid as number;
    for (const c of courtIds) await db.prepare("INSERT INTO tournament_courts (tournament_id, court_id) VALUES (?, ?)").run(id, c);
    // The hours, held. An hour staff had already blocked stays theirs, and is
    // simply not one the draw can use. Where the venue sells half hours, both
    // halves are held; matches are still drawn by the hour.
    const step = venue.slot_minutes / 60;
    const hold = db.prepare(
      `INSERT INTO slot_blocks (court_id, date, hour, reason, tournament_id, span) VALUES (?, ?, ?, ?, ?, ${step})
       ON CONFLICT (court_id, date, hour) DO NOTHING`
    );
    for (const s of slots)
      for (const half of step < 1 ? [s.hour, s.hour + step] : [s.hour])
        await hold.run(s.courtId, s.date, half, `Tournament: ${name}`, id);
  })();
  return { ok: true, value: (await tournamentById(id))! };
}

/** No more entries; the draw comes next. */
export async function closeEntries(id: number): Promise<Result> {
  const done = await getDb().prepare("UPDATE tournaments SET status = 'closed' WHERE id = ? AND status = 'open'").run(id);
  if (done.changes === 0) return { ok: false, error: "Entries are not open." };
  return { ok: true, value: (await tournamentById(id))! };
}

/** Called off: the courts go back, entrants hear, and fees paid online are owed back. */
export async function cancelTournament(id: number): Promise<Result> {
  const db = getDb();
  const t = await tournamentById(id);
  if (!t || t.status === "cancelled" || t.status === "finished") return { ok: false, error: "That cannot be called off now." };
  const freed = (await db
    .prepare("SELECT DISTINCT court_id, date FROM slot_blocks WHERE tournament_id = ? AND date >= ?")
    .all(id, todayISO())) as { court_id: number; date: string }[];
  await db.transaction(async () => {
    await db.prepare("UPDATE tournaments SET status = 'cancelled' WHERE id = ?").run(id);
    await db.prepare("DELETE FROM slot_blocks WHERE tournament_id = ?").run(id);
    await db
      .prepare(
        `UPDATE online_payments SET refund_due = amount
          WHERE purpose = 'entry' AND status = 'paid'
            AND tournament_entry_id IN (SELECT id FROM tournament_entries WHERE tournament_id = ? AND status <> 'withdrawn')`
      )
      .run(id);
  })();
  // Whoever is waiting for one of those courts is offered it.
  for (const day of freed) await offerSlotPlace(day.court_id, day.date);
  for (const userId of await entrants(id)) await tellEntrant(userId, t, `${t.name} is called off`, `${t.name} at ${t.venueName} has been called off. Any entry fee you paid online will be refunded by the venue.`);
  return { ok: true, value: (await tournamentById(id))! };
}

// ------------------------------------------------------------ entries

export async function enter(
  user: { id: number; name: string },
  tournamentId: number,
  input: { partnerName?: string; partnerGender?: string } = {}
): Promise<Result<Entry>> {
  const db = getDb();
  const t = await tournamentById(tournamentId);
  if (!t || t.status !== "open") return { ok: false, error: "Entries are not open." };
  // A women's event takes women; mixed doubles, a woman and a man.
  const partnerGender = isPartnerGender(input.partnerGender) ? input.partnerGender : null;
  const notFor = await categoryRefusal(user.id, t.category, t.teamSize === 2 ? { partnerGender } : null);
  if (notFor) return { ok: false, error: notFor.error, code: notFor.code };
  const open = (await db
    .prepare(`SELECT (${OPEN_TO_CUSTOMERS}) AS open FROM venues v WHERE v.id = ?`)
    .get(t.venueId)) as { open: boolean };
  if (!open.open) return { ok: false, error: "That venue is not taking entries at the moment." };
  const notHere = await accessRefusal(t.venueId, user.id);
  if (notHere) return { ok: false, error: notHere.error, code: notHere.code };
  const partner = input.partnerName?.trim() ?? "";
  if (t.teamSize === 2 && (partner.length < 2 || partner.length > 60)) return { ok: false, error: "Name your partner." };
  if (await db.prepare("SELECT 1 FROM tournament_entries WHERE tournament_id = ? AND user_id = ? AND status <> 'withdrawn'").get(tournamentId, user.id))
    return { ok: false, error: "You have entered already." };
  const status: EntryStatus = t.entered >= t.maxEntries ? "waitlisted" : "entered";
  const name = t.teamSize === 2 ? `${user.name.trim()} / ${partner}` : user.name.trim();
  const info = await db
    .prepare("INSERT INTO tournament_entries (tournament_id, user_id, name, partner_name, partner_gender, status) VALUES (?, ?, ?, ?, ?, ?)")
    .run(tournamentId, user.id, name.slice(0, 130), partner || null, t.teamSize === 2 ? partnerGender : null, status);
  await tellEntrant(
    user.id,
    t,
    status === "entered" ? `You're entered: ${t.name}` : `You're on the waiting list: ${t.name}`,
    status === "entered"
      ? `You're entered in ${t.name} at ${t.venueName}, ${t.startsOn}.` +
          (t.entryFee > 0 ? ` The entry fee is ${money(t.entryFee.toFixed(2))}${t.payOnline ? "; pay it from the tournament's page" : ", paid at the venue"}.` : "") +
          " You'll hear your first match once the draw is made."
      : `${t.name} is full, so you're on its waiting list. If somebody withdraws, you're in, and we'll tell you.`
  );
  return { ok: true, value: (await entryById(info.lastInsertRowid as number))! };
}

async function entryById(id: number): Promise<Entry | null> {
  const r = (await getDb().prepare("SELECT id, name, status, seed, paid_at, user_id FROM tournament_entries WHERE id = ?").get(id)) as
    | { id: number; name: string; status: EntryStatus; seed: number | null; paid_at: string | null; user_id: number | null }
    | undefined;
  return r ? { id: r.id, name: r.name, status: r.status, seed: r.seed, paid: r.paid_at !== null, userId: r.user_id } : null;
}

/** The player's own entry in a tournament, if they have one. */
export async function myEntry(userId: number, tournamentId: number): Promise<Entry | null> {
  const r = (await getDb()
    .prepare("SELECT id FROM tournament_entries WHERE tournament_id = ? AND user_id = ? AND status <> 'withdrawn' ORDER BY id DESC LIMIT 1")
    .get(tournamentId, userId)) as { id: number } | undefined;
  return r ? await entryById(r.id) : null;
}

/**
 * Out. Before the draw, the place goes to whoever has waited longest; after
 * it, each match still to play is a walkover to the other side. A fee paid
 * online is owed back if they withdrew before the draw.
 */
export async function withdraw(entryId: number): Promise<Result<Entry>> {
  const db = getDb();
  const row = (await db
    .prepare("SELECT e.id, e.status, e.tournament_id FROM tournament_entries e WHERE e.id = ?")
    .get(entryId)) as { id: number; status: EntryStatus; tournament_id: number } | undefined;
  if (!row || row.status === "withdrawn") return { ok: false, error: "That entry is not in." };
  const t = (await tournamentById(row.tournament_id))!;
  if (t.status === "finished" || t.status === "cancelled") return { ok: false, error: "That tournament is over." };

  await db.prepare("UPDATE tournament_entries SET status = 'withdrawn' WHERE id = ?").run(entryId);
  if (t.status === "drawn") {
    const pending = (await db
      .prepare(
        `SELECT id, entry_a, entry_b FROM tournament_matches
          WHERE tournament_id = ? AND status = 'scheduled' AND (entry_a = ? OR entry_b = ?)`
      )
      .all(t.id, entryId, entryId)) as { id: number; entry_a: number | null; entry_b: number | null }[];
    for (const m of pending) {
      const other = m.entry_a === entryId ? m.entry_b : m.entry_a;
      if (other !== null) await settleMatch(m.id, other, null, "walkover");
    }
    return { ok: true, value: (await entryById(entryId))! };
  }

  await db
    .prepare("UPDATE online_payments SET refund_due = amount WHERE purpose = 'entry' AND status = 'paid' AND tournament_entry_id = ?")
    .run(entryId);
  if (row.status === "entered") {
    const next = (await db
      .prepare("SELECT id, user_id FROM tournament_entries WHERE tournament_id = ? AND status = 'waitlisted' ORDER BY id LIMIT 1")
      .get(t.id)) as { id: number; user_id: number | null } | undefined;
    if (next) {
      await db.prepare("UPDATE tournament_entries SET status = 'entered' WHERE id = ?").run(next.id);
      if (next.user_id) await tellEntrant(next.user_id, t, `You're in: ${t.name}`, `A place came free in ${t.name} at ${t.venueName}, and it's yours.`);
    }
  }
  return { ok: true, value: (await entryById(entryId))! };
}

export async function setEntry(entryId: number, change: { paid?: boolean; seed?: number | null }): Promise<Result<Entry>> {
  const db = getDb();
  if (change.paid !== undefined) {
    const was = (await db.prepare("SELECT paid_at FROM tournament_entries WHERE id = ?").get(entryId)) as { paid_at: string | null } | undefined;
    await db.prepare(`UPDATE tournament_entries SET paid_at = ${change.paid ? "COALESCE(paid_at, datetime('now'))" : "NULL"} WHERE id = ?`).run(entryId);
    // Paid at the counter just now, or the mark taken back: receipted, or credited.
    if (was && (was.paid_at === null) === change.paid) await receiptFee("entry", entryId, change.paid);
  }
  if (change.seed !== undefined) {
    if (change.seed !== null && (!Number.isInteger(change.seed) || change.seed < 1 || change.seed > 64))
      return { ok: false, error: "A seed is 1 or more." };
    await db.prepare("UPDATE tournament_entries SET seed = ? WHERE id = ?").run(change.seed, entryId);
  }
  const entry = await entryById(entryId);
  return entry ? { ok: true, value: entry } : { ok: false, error: "Not found." };
}

// ------------------------------------------------------------ the draw

interface NewMatch {
  key: string;
  stage: "group" | "knockout";
  groupNo: number | null;
  round: number;
  position: number;
  a: number | null;
  b: number | null;
  nextKey: string | null;
  nextSlot: "a" | "b" | null;
  after: string[];
  bye: boolean;
}

/** The skeleton of a knockout of `size` lines, round by round. */
function knockout(size: number, firstPairs: [number | null, number | null][], feedersOfRoundOne: string[]): NewMatch[] {
  const rounds = Math.log2(size);
  const out: NewMatch[] = [];
  for (let r = 1; r <= rounds; r++) {
    const count = size / 2 ** r;
    for (let p = 1; p <= count; p++) {
      const pair = r === 1 ? firstPairs[p - 1] : [null, null];
      out.push({
        key: `k${r}-${p}`,
        stage: "knockout",
        groupNo: null,
        round: r,
        position: p,
        a: pair[0],
        b: pair[1],
        nextKey: r < rounds ? `k${r + 1}-${Math.ceil(p / 2)}` : null,
        nextSlot: r < rounds ? (p % 2 === 1 ? "a" : "b") : null,
        after: r === 1 ? feedersOfRoundOne : [`k${r - 1}-${p * 2 - 1}`, `k${r - 1}-${p * 2}`],
        bye: false,
      });
    }
  }
  return out;
}

/**
 * Make the draw: seeds first in seed order, everybody else by lot; the
 * matches; and a court and an hour for each. All or nothing.
 */
export async function makeDraw(tournamentId: number, random: () => number = Math.random): Promise<Result<TournamentDetail>> {
  const db = getDb();
  const t = await tournamentById(tournamentId);
  if (!t || (t.status !== "open" && t.status !== "closed")) return { ok: false, error: "The draw is made already, or it is over." };
  const entries = (await db
    .prepare("SELECT id, seed FROM tournament_entries WHERE tournament_id = ? AND status = 'entered' ORDER BY seed NULLS LAST, id")
    .all(tournamentId)) as { id: number; seed: number | null }[];
  const minimum = t.format === "groups" ? 3 : 2;
  if (entries.length < minimum) return { ok: false, error: `At least ${minimum} entries are needed.` };
  const ranked = [...entries.filter((e) => e.seed !== null), ...shuffle(entries.filter((e) => e.seed === null), random)].map((e) => e.id);

  const matches: NewMatch[] = [];
  if (t.format === "knockout") {
    matches.push(...knockout(bracketSize(ranked.length), firstRound(ranked), []));
  } else {
    const groups = intoGroups(ranked, groupCount(ranked.length, t.groupSize));
    let longest = 0;
    groups.forEach((members, gi) => {
      const rounds = roundRobin(members.length);
      longest = Math.max(longest, rounds.length);
      rounds.forEach((pairs, ri) =>
        pairs.forEach(([x, y], pi) =>
          matches.push({
            key: `g${gi + 1}-${ri + 1}-${pi + 1}`,
            stage: "group",
            groupNo: gi + 1,
            round: ri + 1,
            position: pi + 1,
            a: members[x],
            b: members[y],
            nextKey: null,
            nextSlot: null,
            after: [],
            bye: false,
          })
        )
      );
    });
    // Round by round across the groups, so every group is played at once.
    matches.sort((x, y) => x.round - y.round || x.groupNo! - y.groupNo! || x.position - y.position);
    const qualifiers = groups.length * t.advance;
    if (qualifiers >= 2) {
      const groupKeys = matches.map((m) => m.key);
      const size = bracketSize(qualifiers);
      const lines = Array.from({ length: qualifiers }, () => null);
      // Who fills it is known only when the groups finish; byes, if any, are
      // marked then, so they still fall to the best group finishers.
      matches.push(...knockout(size, firstRound(lines).map(() => [null, null] as [null, null]), groupKeys));
    }
  }

  // Byes go straight through, before scheduling.
  for (const m of matches.filter((x) => x.stage === "knockout" && x.round === 1 && t.format === "knockout")) {
    if ((m.a === null) !== (m.b === null)) {
      m.bye = true;
      const next = matches.find((x) => x.key === m.nextKey);
      if (next) next[m.nextSlot!] = m.a ?? m.b;
    }
  }
  const byes = new Set(matches.filter((m) => m.bye).map((m) => m.key));
  const toPlay: ToSchedule[] = matches
    .filter((m) => !m.bye)
    .map((m) => ({
      key: m.key,
      sides: [m.a !== null ? `e${m.a}` : `w:${m.key}:a`, m.b !== null ? `e${m.b}` : `w:${m.key}:b`],
      after: m.after.filter((k) => !byes.has(k)),
    }));
  const zone = await tournamentZone(tournamentId);
  const slots = (
    (await db
      // Not an hour on a court taken out of service since.
      .prepare(
        `SELECT s.court_id, s.date, s.hour FROM slot_blocks s
          WHERE s.tournament_id = ? AND s.hour = FLOOR(s.hour)
            AND NOT EXISTS (
              SELECT 1 FROM court_outages o
               WHERE o.court_id = s.court_id AND o.starts_on <= s.date AND (o.ends_on IS NULL OR o.ends_on >= s.date))
          ORDER BY s.date, s.hour, s.court_id`
      )
      .all(tournamentId)) as { court_id: number; date: string; hour: number }[]
  )
    .filter((s) => !isPastSlot(s.date, s.hour, zone))
    .map((s) => ({ courtId: s.court_id, date: s.date, hour: s.hour }));
  const scheduled = scheduleMatches(toPlay, slots);
  if (!scheduled.ok)
    return {
      ok: false,
      error: `Not enough court time: ${scheduled.unplaced} of ${toPlay.length} matches do not fit in the hours held. Add courts, hours or days, or take fewer entries.`,
    };

  await db.transaction(async () => {
    const ids = new Map<string, number>();
    // Last round first, so each match can point at the one its winner goes to.
    for (const m of [...matches].sort((x, y) => (y.stage === "knockout" ? y.round : 0) - (x.stage === "knockout" ? x.round : 0))) {
      const at = scheduled.placed.get(m.key);
      const info = await db
        .prepare(
          `INSERT INTO tournament_matches (tournament_id, stage, group_no, round, position, entry_a, entry_b,
                                           next_match_id, next_slot, court_id, date, hour, winner, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          tournamentId,
          m.stage,
          m.groupNo,
          m.round,
          m.position,
          m.a,
          m.b,
          m.nextKey ? ids.get(m.nextKey) ?? null : null,
          m.nextSlot,
          at?.courtId ?? null,
          at?.date ?? null,
          at?.hour ?? null,
          m.bye ? (m.a ?? m.b) : null,
          m.bye ? "bye" : "scheduled"
        );
      ids.set(m.key, info.lastInsertRowid as number);
    }
    await db.prepare("UPDATE tournaments SET status = 'drawn' WHERE id = ?").run(tournamentId);
  })();

  await releaseUnneeded(tournamentId);
  const detail = (await tournamentDetail(tournamentId))!;
  await tellFirstMatches(detail);
  return { ok: true, value: detail };
}

// ------------------------------------------------------------ results

/**
 * A result: who won, and the score if there is one. The winner goes on to
 * their next match; the last group match fills the knockout; the final
 * finishes it. A result can be put right until the match it fed is played.
 */
export async function recordResult(matchId: number, input: { winner: number; score?: string; walkover?: boolean }): Promise<Result<TournamentDetail>> {
  const db = getDb();
  const m = (await db.prepare("SELECT * FROM tournament_matches WHERE id = ?").get(matchId)) as
    | { id: number; tournament_id: number; entry_a: number | null; entry_b: number | null; next_match_id: number | null; status: string }
    | undefined;
  if (!m) return { ok: false, error: "Match not found." };
  const t = (await tournamentById(m.tournament_id))!;
  if (t.status !== "drawn" && t.status !== "finished") return { ok: false, error: "The draw is not made." };
  if (m.status === "bye") return { ok: false, error: "That is a bye." };
  if (m.entry_a === null || m.entry_b === null) return { ok: false, error: "Both sides are not known yet." };
  if (input.winner !== m.entry_a && input.winner !== m.entry_b) return { ok: false, error: "The winner has to be one of the two." };
  const score = input.score?.trim() || null;
  if (score) {
    const parsed = parseScore(score);
    if (!parsed) return { ok: false, error: 'Write the score as sets, like "21-15, 18-21, 21-10".' };
    const winnerSets = input.winner === m.entry_a ? parsed.setsA : parsed.setsB;
    const loserSets = input.winner === m.entry_a ? parsed.setsB : parsed.setsA;
    if (winnerSets <= loserSets) return { ok: false, error: "That score says the other side won." };
  } else if (!input.walkover) return { ok: false, error: "Give the score, or mark it a walkover." };
  if (m.next_match_id !== null) {
    const next = (await db.prepare("SELECT status FROM tournament_matches WHERE id = ?").get(m.next_match_id)) as { status: string };
    if (next.status === "done" || next.status === "walkover") return { ok: false, error: "The next match is played already." };
  }
  await settleMatch(matchId, input.winner, score, input.walkover ? "walkover" : "done");
  return { ok: true, value: (await tournamentDetail(t.id, { forStaff: true }))! };
}

async function settleMatch(matchId: number, winner: number, score: string | null, status: "done" | "walkover"): Promise<void> {
  const db = getDb();
  const m = (await db.prepare("SELECT * FROM tournament_matches WHERE id = ?").get(matchId)) as {
    id: number;
    tournament_id: number;
    stage: string;
    next_match_id: number | null;
    next_slot: "a" | "b" | null;
  };
  await db
    .prepare("UPDATE tournament_matches SET winner = ?, score = ?, status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(winner, score, status, matchId);
  if (m.next_match_id !== null)
    await db.prepare(`UPDATE tournament_matches SET entry_${m.next_slot} = ? WHERE id = ?`).run(winner, m.next_match_id);
  if (m.stage === "group") await fillKnockoutIfGroupsDone(m.tournament_id);
  await finishIfDone(m.tournament_id);
  // A walkover, a bye or the final may leave a court with nothing more to play.
  await releaseUnneeded(m.tournament_id);
}

/** The groups are in: their best go into the knockout, best finishers on the best lines. */
async function fillKnockoutIfGroupsDone(tournamentId: number): Promise<void> {
  const db = getDb();
  const t = (await tournamentById(tournamentId))!;
  const left = (await db
    .prepare("SELECT COUNT(*)::int AS n FROM tournament_matches WHERE tournament_id = ? AND stage = 'group' AND winner IS NULL")
    .get(tournamentId)) as { n: number };
  if (left.n > 0) return;
  const detail = (await tournamentDetail(tournamentId))!;
  const firstRoundMatches = detail.matches.filter((m) => m.stage === "knockout" && m.round === 1).sort((a, b) => a.position - b.position);
  if (firstRoundMatches.length === 0 || firstRoundMatches.some((m) => m.a !== null || m.b !== null)) return;
  // Group winners on the top lines; each runner-up in the other half from
  // its own group's winner, so they meet again only in the final.
  const winners = detail.groups.map((g) => g.table[0]?.entryId).filter((x): x is number => x !== undefined);
  const runnersUp = t.advance === 2 ? detail.groups.map((g) => g.table[1]?.entryId).filter((x): x is number => x !== undefined) : [];
  const pairs = firstRound(knockoutFromGroups(winners, runnersUp));
  for (let i = 0; i < firstRoundMatches.length; i++) {
    const [a, b] = pairs[i];
    const match = firstRoundMatches[i];
    await db.prepare("UPDATE tournament_matches SET entry_a = ?, entry_b = ? WHERE id = ?").run(a, b, match.id);
    if ((a === null) !== (b === null)) {
      await db.prepare("UPDATE tournament_matches SET status = 'bye', winner = ?, court_id = NULL, date = NULL, hour = NULL WHERE id = ?").run(a ?? b, match.id);
      const next = (await db.prepare("SELECT next_match_id, next_slot FROM tournament_matches WHERE id = ?").get(match.id)) as {
        next_match_id: number | null;
        next_slot: "a" | "b" | null;
      };
      if (next.next_match_id !== null)
        await db.prepare(`UPDATE tournament_matches SET entry_${next.next_slot} = ? WHERE id = ?`).run(a ?? b, next.next_match_id);
    }
  }
}

/** Every match decided: finished. */
async function finishIfDone(tournamentId: number): Promise<void> {
  const db = getDb();
  const left = (await db
    .prepare("SELECT COUNT(*)::int AS n FROM tournament_matches WHERE tournament_id = ? AND winner IS NULL")
    .get(tournamentId)) as { n: number };
  if (left.n > 0) return;
  await db.prepare("UPDATE tournaments SET status = 'finished' WHERE id = ? AND status = 'drawn'").run(tournamentId);
}

/**
 * Give back the held hours no match needs. Once the draw is made, every
 * match has its court and hour and none ever moves, so on each court each
 * day only the hours from its first match still to play to its last are
 * needed — those between stay held, so a match that runs over does not run
 * into somebody's booking. A court with nothing left to play that day is
 * given back whole; when the last match is in, everything left is. Hours
 * already gone stay, as the record of what was held. Whoever is waiting for
 * a court that day is offered what came free. Returns how many hours.
 */
export async function releaseUnneeded(tournamentId: number): Promise<number> {
  const db = getDb();
  const t = await tournamentById(tournamentId);
  // Before the draw nobody knows which hours will be needed.
  if (!t || (t.status !== "drawn" && t.status !== "finished")) return 0;
  const held = (await db
    .prepare("SELECT id, court_id, date, hour FROM slot_blocks WHERE tournament_id = ?")
    .all(tournamentId)) as { id: number; court_id: number; date: string; hour: number }[];
  const spans = new Map(
    (
      (await db
        .prepare(
          `SELECT court_id, date, MIN(hour) AS first, MAX(hour) AS last FROM tournament_matches
            WHERE tournament_id = ? AND status = 'scheduled' AND court_id IS NOT NULL
            GROUP BY court_id, date`
        )
        .all(tournamentId)) as { court_id: number; date: string; first: number; last: number }[]
    ).map((r) => [`${r.court_id}:${r.date}`, r])
  );
  const zone = await tournamentZone(tournamentId);
  const free = held.filter((b) => {
    if (isPastSlot(b.date, b.hour, zone)) return false;
    const span = spans.get(`${b.court_id}:${b.date}`);
    // By the hour: a match at 18:00 still needs the 18:30 half of a half-hour venue.
    const hour = Math.floor(b.hour);
    return !span || hour < span.first || hour > span.last;
  });
  if (free.length === 0) return 0;
  await db.prepare(`DELETE FROM slot_blocks WHERE id IN (${free.map(() => "?").join(",")})`).run(...free.map((b) => b.id));
  const days = new Map(free.map((b) => [`${b.court_id}:${b.date}`, b]));
  for (const b of days.values()) await offerSlotPlace(b.court_id, b.date);
  return free.length;
}

// ------------------------------------------------------------ telling people

async function entrants(tournamentId: number): Promise<number[]> {
  return (
    (await getDb()
      .prepare("SELECT user_id FROM tournament_entries WHERE tournament_id = ? AND status <> 'withdrawn' AND user_id IS NOT NULL")
      .all(tournamentId)) as { user_id: number }[]
  ).map((r) => r.user_id);
}

async function tellEntrant(userId: number, t: Tournament, subject: string, body: string): Promise<void> {
  const user = (await getDb().prepare("SELECT name, email FROM users WHERE id = ?").get(userId)) as { name: string; email: string } | undefined;
  if (!user) return;
  await sendPlainEmail(
    user.email,
    subject,
    `Hi ${user.name.split(/\s+/)[0]},\n\n${body}\n\n${baseUrl()}/tournaments/${t.id}\n\n${siteName()}`
  );
}

async function tellFirstMatches(d: TournamentDetail): Promise<void> {
  const db = getDb();
  const names = new Map(d.entries.map((e) => [e.id, e.name]));
  const rows = (await db
    .prepare("SELECT id, user_id FROM tournament_entries WHERE tournament_id = ? AND status = 'entered' AND user_id IS NOT NULL")
    .all(d.id)) as { id: number; user_id: number }[];
  for (const r of rows) {
    const first = d.matches.find((m) => m.status === "scheduled" && (m.a === r.id || m.b === r.id));
    const bye = d.matches.some((m) => m.status === "bye" && m.winner === r.id);
    const text = first
      ? `Your first match in ${d.name}: ${first.date} ${formatHour(first.hour!)}, ${first.courtName}, against ${names.get(first.a === r.id ? first.b! : first.a!) ?? "to be decided"}.`
      : bye
        ? `You have a bye in the first round of ${d.name}. Your next match is on the draw.`
        : `The draw for ${d.name} is made.`;
    await tellEntrant(r.user_id, d, `The draw is made: ${d.name}`, text);
  }
}
