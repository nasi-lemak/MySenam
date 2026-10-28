import { getDb, withTransaction } from "./db";
import { formatMinute, isMinute } from "./interval";
import { isAmount, money } from "./region";
import { addDays, isValidDateString, todayISO } from "./time";
import { venueZoneOf } from "./zones";
import type { Court, CourtActivity, CourtHoursChange, CourtRateChange } from "./types";
import {
  WEEKDAYS,
  changeOn,
  hoursFor,
  hoursOn,
  parseHoursChanges,
  parseWeekHours,
  validateUsualHours,
  validateWeekHours,
  type DatedHours,
  type HoursChange,
  type WeekHours,
} from "./week-hours";
import { policiesFor, policyHoursOn, updatePolicy, type BookingPolicy } from "./booking-policy";

/**
 * Opening hours and court rates changed from a date (audit R8 X1-13, ADR 0027).
 *
 * What is stored now (the venue's hours, the court's rates and activities'
 * rates, its booking rules) is what is in force today. A change from a later
 * date is a row of its own (`venue_hours_changes`, `court_changes`), a whole
 * set of hours or rates, and the venue and court rows carry the list
 * (`venues.hours_changes`, `courts.dated_changes`, kept by the database), so
 * every lookup that already reads hours or rates for a date resolves it there
 * (`hoursOn`, `policiesFor(…, date)`, `priceBooking`): the date booked decides,
 * and nothing about a booking already made changes. No scheduler is needed:
 * once its date comes a change applies by that rule alone, and it is made the
 * current settings (`applyDue…`) the next time staff look at or change them.
 */

/** A booking the change would leave outside the hours, for staff to move or cancel. */
export interface StrandedBooking {
  code: string;
  date: string;
  startMin: number;
  endMin: number;
  court: string;
}

export type DatedRefusal = { ok: false; error: string; stranded?: StrandedBooking[] };

const LATER_ONLY = "Choose a date after today: a change from today is saved with the settings as usual.";
export const NOT_WAITING = "That change is not waiting to apply.";

/** One line for the activity log and the editor: 08:00–23:00, Fri 16:00–02:00, Sun closed. */
export function describeHours(h: { openMin: number; closeMin: number; weekHours?: WeekHours | null }): string {
  const days = (h.weekHours ?? [])
    .map((d, i) => (d === null ? null : d === "closed" ? `${WEEKDAYS[i].slice(0, 3)} closed` : `${WEEKDAYS[i].slice(0, 3)} ${formatMinute(d.open)}–${formatMinute(d.close)}`))
    .filter((x): x is string => x !== null);
  return [`${formatMinute(h.openMin)}–${formatMinute(h.closeMin)}`, ...days].join(", ");
}

function describeRates(r: { offPeakRate: number; peakRate: number; memberOffPeakRate: number | null; memberPeakRate: number | null; activities?: CourtActivity[] }): string {
  const member = r.memberOffPeakRate !== null || r.memberPeakRate !== null ? `; members ${r.memberOffPeakRate === null ? "—" : money(r.memberOffPeakRate)}/${r.memberPeakRate === null ? "—" : money(r.memberPeakRate)}` : "";
  const own = (r.activities ?? []).filter((a) => a.offPeakRate !== null).map((a) => `; ${a.sport} ${money(a.offPeakRate!)}/${money(a.peakRate!)}`);
  return `${money(r.offPeakRate)}/${money(r.peakRate)}${member}${own.join("")}`;
}

// ------------------------------------------------------------ venue hours

type VenueHoursRow = { id: number; open_min: number; close_min: number; week_hours: string | null; hours_changes: string | null; time_zone: string | null; lat: number | null; lng: number | null };

async function venueRow(venueId: number): Promise<VenueHoursRow | undefined> {
  return (await getDb()
    .prepare("SELECT id, open_min, close_min, week_hours, hours_changes, time_zone, lat, lng FROM venues WHERE id = ?")
    .get(venueId)) as VenueHoursRow | undefined;
}

function storedOf(row: VenueHoursRow): DatedHours & { weekHours: WeekHours | null; hoursChanges: HoursChange[] } {
  return { openMin: row.open_min, closeMin: row.close_min, weekHours: parseWeekHours(row.week_hours), hoursChanges: parseHoursChanges(row.hours_changes) };
}

/**
 * Make a venue's changes whose date has come its current hours: the latest
 * such one becomes `open_min`/`close_min`/`week_hours`, and those rows go.
 * Reads never need this (they resolve by date); it keeps the editor and the
 * current settings true. Returns how many were made current.
 */
export async function applyDueHours(venueId: number): Promise<number> {
  return withTransaction(async () => {
    const row = await venueRow(venueId);
    if (!row) return 0;
    const today = todayISO(venueZoneOf(row));
    const due = parseHoursChanges(row.hours_changes).filter((c) => c.from <= today);
    if (due.length === 0) return 0;
    const now = due[due.length - 1];
    const db = getDb();
    await db
      .prepare("UPDATE venues SET open_min = ?, close_min = ?, week_hours = ? WHERE id = ?")
      .run(now.openMin, now.closeMin, now.weekHours ? JSON.stringify(now.weekHours) : null, venueId);
    await db.prepare("DELETE FROM venue_hours_changes WHERE venue_id = ? AND from_date <= ?").run(venueId, today);
    return due.length;
  });
}

/** The changes to a venue's hours not yet in force, soonest first (those whose date has come made current first). */
export async function listHoursChanges(venueId: number): Promise<HoursChange[]> {
  await applyDueHours(venueId);
  const row = await venueRow(venueId);
  return row ? parseHoursChanges(row.hours_changes) : [];
}

/**
 * Bookings to come at a venue that are inside the hours as they stand
 * (`before`) on their date and would fall outside them as `after` sets them:
 * every one, soonest first, so staff can move or cancel them.
 */
export async function strandedByHours(venueId: number, before: DatedHours, after: DatedHours, today: string): Promise<StrandedBooking[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT b.code, b.date, b.start_min, b.end_min, c.name AS court FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND b.date >= ? AND b.status = 'confirmed' AND b.class_id IS NULL
        ORDER BY b.date, b.start_min, c.name, b.code`
    )
    .all(venueId, today)) as { code: string; date: string; start_min: number; end_min: number; court: string }[];
  return rows
    .filter((r) => {
      const was = hoursOn(before, r.date);
      const now = hoursOn(after, r.date);
      if (was.closed === now.closed && was.openMin === now.openMin && was.closeMin === now.closeMin) return false;
      return now.closed || r.start_min < now.openMin || r.end_min > now.closeMin;
    })
    .map((r) => ({ code: r.code, date: r.date, startMin: r.start_min, endMin: r.end_min, court: r.court }));
}

/** "N bookings already made fall outside those hours", with every one of them. */
export function strandedRefusal(stranded: StrandedBooking[]): DatedRefusal {
  return {
    ok: false,
    error: `${stranded.length} booking${stranded.length === 1 ? "" : "s"} already made fall${stranded.length === 1 ? "s" : ""} outside those hours. Move or cancel ${stranded.length === 1 ? "it" : "them"} first.`,
    stranded,
  };
}

/** Where one version of the hours meets the next, the evening before may not run into the next day's opening. */
export function boundaryClash(hours: DatedHours): string | null {
  for (const c of hours.hoursChanges ?? []) {
    const eve = addDays(c.from, -1);
    const today = hoursOn(hours, eve);
    const tomorrow = hoursOn(hours, c.from);
    if (today.closed || tomorrow.closed) continue;
    if (today.closeMin - 1440 > tomorrow.openMin) return `The evening before ${c.from} runs past that day's opening. Close earlier, or open later from ${c.from}.`;
  }
  return null;
}

function readFrom(from: unknown, today: string): string | DatedRefusal {
  if (typeof from !== "string" || !isValidDateString(from)) return { ok: false, error: "A valid date is required." };
  if (from <= today) return { ok: false, error: LATER_ONLY };
  return from;
}

/**
 * Set a venue's hours from a later date, or change one set already (`id`):
 * the usual hours and the week, as a whole. Refused while bookings already
 * made on the dates it changes fall outside it, listing every one.
 */
export async function setHoursChange(
  venueId: number,
  input: { id?: number; from: unknown; openMin: unknown; closeMin: unknown; weekHours?: unknown }
): Promise<{ ok: true; change: HoursChange; was: string; now: string } | DatedRefusal> {
  await applyDueHours(venueId);
  return withTransaction(async () => {
    const row = await venueRow(venueId);
    if (!row) return { ok: false, error: "Venue not found." };
    const today = todayISO(venueZoneOf(row));
    const from = readFrom(input.from, today);
    if (typeof from !== "string") return from;
    if (!isMinute(input.openMin) || !isMinute(input.closeMin)) return { ok: false, error: "Opening hours are whole minutes." };
    const usual = validateUsualHours(input.openMin, input.closeMin);
    if (!usual.ok) return usual;
    const hours = { openMin: input.openMin as number, closeMin: input.closeMin as number };
    const week = validateWeekHours(input.weekHours ?? null, hours);
    if (!week.ok) return week;

    const before = storedOf(row);
    const editing = input.id !== undefined ? before.hoursChanges.find((c) => c.id === input.id) : undefined;
    if (input.id !== undefined && !editing) return { ok: false, error: NOT_WAITING };
    if (before.hoursChanges.some((c) => c.from === from && c.id !== input.id))
      return { ok: false, error: `There is already a change from ${from}. Change that one instead.` };
    const change: HoursChange = { id: input.id ?? 0, from, ...hours, weekHours: week.week };
    const after = { ...before, hoursChanges: [...before.hoursChanges.filter((c) => c.id !== input.id), change].sort((a, b) => a.from.localeCompare(b.from)) };
    const clash = boundaryClash(after);
    if (clash) return { ok: false, error: clash };
    const stranded = await strandedByHours(venueId, before, after, today);
    if (stranded.length > 0) return strandedRefusal(stranded);

    const db = getDb();
    const json = week.week ? JSON.stringify(week.week) : null;
    let id = input.id;
    if (editing)
      await db
        .prepare("UPDATE venue_hours_changes SET from_date = ?, open_min = ?, close_min = ?, week_hours = ? WHERE id = ? AND venue_id = ?")
        .run(from, hours.openMin, hours.closeMin, json, editing.id, venueId);
    else
      id = (
        (await db
          .prepare("INSERT INTO venue_hours_changes (venue_id, from_date, open_min, close_min, week_hours) VALUES (?, ?, ?, ?, ?) RETURNING id")
          .get(venueId, from, hours.openMin, hours.closeMin, json)) as { id: number }
      ).id;
    return {
      ok: true,
      change: { ...change, id: id! },
      was: describeHours(editing ? { ...editing } : hoursFor(before, from)),
      now: describeHours(change),
    };
  });
}

/** Withdraw a change not yet in force; refused while bookings made under it would fall outside the hours left. */
export async function withdrawHoursChange(venueId: number, id: number): Promise<{ ok: true; change: HoursChange; then: string } | DatedRefusal> {
  await applyDueHours(venueId);
  return withTransaction(async () => {
    const row = await venueRow(venueId);
    if (!row) return { ok: false, error: "Venue not found." };
    const before = storedOf(row);
    const change = before.hoursChanges.find((c) => c.id === id);
    if (!change) return { ok: false, error: NOT_WAITING };
    const after = { ...before, hoursChanges: before.hoursChanges.filter((c) => c.id !== id) };
    const clash = boundaryClash(after);
    if (clash) return { ok: false, error: clash };
    const stranded = await strandedByHours(venueId, before, after, todayISO(venueZoneOf(row)));
    if (stranded.length > 0) return strandedRefusal(stranded);
    await getDb().prepare("DELETE FROM venue_hours_changes WHERE id = ? AND venue_id = ?").run(id, venueId);
    return { ok: true, change, then: describeHours(hoursFor(after, change.from)) };
  });
}

// ------------------------------------------------------------ courts

type CourtRow = { id: number; venue_id: number; name: string; sport: string; dated_changes: string | null };

async function courtRows(where: { courtId: number } | { venueId: number }): Promise<CourtRow[]> {
  const db = getDb();
  return "courtId" in where
    ? ((await db.prepare("SELECT id, venue_id, name, sport, dated_changes FROM courts WHERE id = ?").all(where.courtId)) as CourtRow[])
    : ((await db.prepare("SELECT id, venue_id, name, sport, dated_changes FROM courts WHERE venue_id = ? ORDER BY id").all(where.venueId)) as CourtRow[]);
}

type StoredCourtChange =
  | ({ kind: "rates" } & CourtRateChange)
  | ({ kind: "hours" } & CourtHoursChange);

function courtChangesOf(raw: string | null): StoredCourtChange[] {
  let list: Record<string, unknown>[] = [];
  try {
    list = raw ? JSON.parse(raw) : [];
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) return [];
  const rate = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return list
    .filter((c) => typeof c.from === "string")
    .map((c): StoredCourtChange =>
      c.kind === "hours"
        ? { kind: "hours", id: Number(c.id), from: c.from as string, weekHours: parseWeekHours(c.weekHours ?? null) }
        : {
            kind: "rates",
            id: Number(c.id),
            from: c.from as string,
            offPeakRate: Number(c.offPeakRate),
            peakRate: Number(c.peakRate),
            memberOffPeakRate: rate(c.memberOffPeakRate),
            memberPeakRate: rate(c.memberPeakRate),
            activities: (Array.isArray(c.activities) ? (c.activities as Record<string, unknown>[]) : []).map((a) => ({
              sport: String(a.sport),
              offPeakRate: rate(a.offPeakRate),
              peakRate: rate(a.peakRate),
            })),
          }
    )
    .sort((a, b) => a.from.localeCompare(b.from));
}

async function venueToday(venueId: number): Promise<string> {
  const row = await venueRow(venueId);
  return todayISO(venueZoneOf(row ?? {}));
}

/**
 * Make courts' changes whose date has come their current settings: the latest
 * rates become the court's rates and its activities', the latest own hours its
 * booking rules' (court level). Reads never need this; it keeps the editors
 * and the current settings true.
 */
export async function applyDueCourtChanges(where: { courtId: number } | { venueId: number }): Promise<number> {
  let applied = 0;
  for (const court of await courtRows(where)) {
    const today = await venueToday(court.venue_id);
    const due = courtChangesOf(court.dated_changes).filter((c) => c.from <= today);
    if (due.length === 0) continue;
    await withTransaction(async () => {
      const db = getDb();
      const rates = due.filter((c): c is { kind: "rates" } & CourtRateChange => c.kind === "rates").pop();
      if (rates) {
        await db
          .prepare("UPDATE courts SET off_peak_rate = ?, peak_rate = ?, member_off_peak_rate = ?, member_peak_rate = ? WHERE id = ?")
          .run(rates.offPeakRate, rates.peakRate, rates.memberOffPeakRate, rates.memberPeakRate, court.id);
        for (const a of rates.activities)
          if (a.sport !== court.sport)
            await db
              .prepare("UPDATE court_activities SET off_peak_rate = ?, peak_rate = ? WHERE court_id = ? AND sport = ?")
              .run(a.offPeakRate, a.peakRate, court.id, a.sport);
      }
      const hours = due.filter((c): c is { kind: "hours" } & CourtHoursChange => c.kind === "hours").pop();
      if (hours) {
        const done = await updatePolicy({ court: court.id }, { weekHours: hours.weekHours });
        if (!done.ok) throw new Error(done.error);
      }
      await db.prepare("DELETE FROM court_changes WHERE court_id = ? AND from_date <= ?").run(court.id, today);
    });
    applied += due.length;
  }
  return applied;
}

export interface CourtChangeListing {
  courtId: number;
  court: string;
  rates: CourtRateChange[];
  hours: CourtHoursChange[];
}

/** Every change to a venue's courts not yet in force, court by court (those whose date has come made current first). */
export async function listCourtChanges(venueId: number): Promise<CourtChangeListing[]> {
  await applyDueCourtChanges({ venueId });
  return (await courtRows({ venueId }))
    .map((c) => {
      const all = courtChangesOf(c.dated_changes);
      return {
        courtId: c.id,
        court: c.name,
        rates: all.filter((x): x is { kind: "rates" } & CourtRateChange => x.kind === "rates").map(({ kind: _kind, ...x }) => x),
        hours: all.filter((x): x is { kind: "hours" } & CourtHoursChange => x.kind === "hours").map(({ kind: _kind, ...x }) => x),
      };
    })
    .filter((c) => c.rates.length > 0 || c.hours.length > 0);
}

/** As a court's rates are checked (lib/resources.ts). */
const MAX_RATE = 1000;

/** A rate as given: a number from 0 to MAX_RATE, or (where it may be left out) blank; else the refusal. */
function readRate(v: unknown, optional: boolean): number | null | string {
  if (optional && (v === null || v === undefined || v === "")) return null;
  if (!isAmount(v, 0, MAX_RATE)) return `Rates are 0 to ${MAX_RATE}.`;
  return v as number;
}

/**
 * Set a court's rates from a later date, or change rates set already (`id`):
 * off-peak, peak, the member rates and its other activities' own rates, as a
 * whole. Bookings already made keep the price they were sold at.
 */
export async function setCourtRates(
  court: Court,
  input: { id?: number; from: unknown; offPeakRate: unknown; peakRate: unknown; memberOffPeakRate?: unknown; memberPeakRate?: unknown; activities?: unknown }
): Promise<{ ok: true; change: CourtRateChange; was: string; now: string } | DatedRefusal> {
  await applyDueCourtChanges({ courtId: court.id });
  const today = await venueToday(court.venueId);
  const from = readFrom(input.from, today);
  if (typeof from !== "string") return from;
  const off = readRate(input.offPeakRate, false);
  const peak = readRate(input.peakRate, false);
  const memberOff = readRate(input.memberOffPeakRate, true);
  const memberPeak = readRate(input.memberPeakRate, true);
  for (const r of [off, peak, memberOff, memberPeak]) if (typeof r === "string") return { ok: false, error: r };
  if (memberOff !== null && (memberOff as number) > (off as number)) return { ok: false, error: "The off-peak member rate is higher than the public one." };
  if (memberPeak !== null && (memberPeak as number) > (peak as number)) return { ok: false, error: "The peak member rate is higher than the public one." };

  // Its other activities' own rates then: each one it offers, both rates or neither (the court's).
  const offered = court.activities.filter((a) => a.sport !== court.sport).map((a) => a.sport);
  const given = input.activities === undefined || input.activities === null ? [] : input.activities;
  if (!Array.isArray(given)) return { ok: false, error: "activities is a list." };
  const activities: CourtActivity[] = [];
  for (const a of given as { sport?: unknown; offPeakRate?: unknown; peakRate?: unknown }[]) {
    if (typeof a?.sport !== "string" || !offered.includes(a.sport)) return { ok: false, error: "Unknown sport." };
    const o = readRate(a.offPeakRate, true);
    const p = readRate(a.peakRate, true);
    if (typeof o === "string") return { ok: false, error: o };
    if (typeof p === "string") return { ok: false, error: p };
    if ((o === null) !== (p === null)) return { ok: false, error: "Give both rates for an activity, or neither." };
    if (activities.some((x) => x.sport === a.sport)) return { ok: false, error: "Each activity once." };
    activities.push({ sport: a.sport, offPeakRate: o, peakRate: p });
  }

  return withTransaction(async () => {
    const rows = await courtRows({ courtId: court.id });
    if (rows.length === 0) return { ok: false, error: "Court not found." };
    const all = courtChangesOf(rows[0].dated_changes).filter((c): c is { kind: "rates" } & CourtRateChange => c.kind === "rates");
    const editing = input.id !== undefined ? all.find((c) => c.id === input.id) : undefined;
    if (input.id !== undefined && !editing) return { ok: false, error: NOT_WAITING };
    if (all.some((c) => c.from === from && c.id !== input.id)) return { ok: false, error: `There is already a change from ${from}. Change that one instead.` };
    const change: CourtRateChange = {
      id: input.id ?? 0,
      from,
      offPeakRate: off as number,
      peakRate: peak as number,
      memberOffPeakRate: memberOff as number | null,
      memberPeakRate: memberPeak as number | null,
      activities,
    };
    // What would have applied that day: the rates set from an earlier date, else today's.
    const earlier = changeOn(all.filter((c) => c.id !== input.id), from);
    const was: CourtRateChange | Court = editing ?? earlier ?? court;
    const db = getDb();
    let id = input.id;
    const values = [from, change.offPeakRate, change.peakRate, change.memberOffPeakRate, change.memberPeakRate, JSON.stringify(activities)];
    if (editing)
      await db
        .prepare(
          `UPDATE court_changes SET from_date = ?, off_peak_rate = ?, peak_rate = ?, member_off_peak_rate = ?, member_peak_rate = ?, activity_rates = ?
            WHERE id = ? AND court_id = ? AND kind = 'rates'`
        )
        .run(...values, editing.id, court.id);
    else
      id = (
        (await db
          .prepare(
            `INSERT INTO court_changes (court_id, kind, from_date, off_peak_rate, peak_rate, member_off_peak_rate, member_peak_rate, activity_rates)
             VALUES (?, 'rates', ?, ?, ?, ?, ?, ?) RETURNING id`
          )
          .get(court.id, ...values)) as { id: number }
      ).id;
    return {
      ok: true as const,
      change: { ...change, id: id! },
      was: describeRates({ ...was, activities: was.activities.filter((a) => a.sport !== court.sport) }),
      now: describeRates(change),
    };
  });
}

/** A court's own hours on each date asked about, with its own hours set from dates as `changes` say. */
async function courtHoursOnDates(
  court: Court,
  changes: CourtHoursChange[],
  venue: DatedHours,
  dates: string[]
): Promise<Map<string, { openMin: number; closeMin: number; closed: boolean }>> {
  const policies = new Map<string, BookingPolicy>();
  const out = new Map<string, { openMin: number; closeMin: number; closed: boolean }>();
  for (const d of dates) {
    // Own hours are the same between one change's date and the next: one policy for each.
    const key = String(changeOn(changes, d)?.id ?? "none");
    if (!policies.has(key)) policies.set(key, (await policiesFor([{ id: court.id, venueId: court.venueId, sport: court.sport, hoursChanges: changes }], d)).get(court.id)!);
    out.set(d, policyHoursOn(policies.get(key)!, venue, d));
  }
  return out;
}

/** Bookings to come on a court inside its hours as `before` sets them and outside them as `after` does. */
async function strandedOnCourt(court: Court, before: CourtHoursChange[], after: CourtHoursChange[], today: string): Promise<StrandedBooking[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT b.code, b.date, b.start_min, b.end_min FROM bookings b
        WHERE b.court_id = ? AND b.date >= ? AND b.status = 'confirmed' AND b.class_id IS NULL
        ORDER BY b.date, b.start_min, b.code`
    )
    .all(court.id, today)) as { code: string; date: string; start_min: number; end_min: number }[];
  if (rows.length === 0) return [];
  const vrow = await venueRow(court.venueId);
  const venue: DatedHours = vrow ? storedOf(vrow) : { openMin: 0, closeMin: 1440 };
  const dates = [...new Set(rows.map((r) => r.date))];
  const was = await courtHoursOnDates(court, before, venue, dates);
  const now = await courtHoursOnDates(court, after, venue, dates);
  return rows
    .filter((r) => {
      const a = was.get(r.date)!;
      const b = now.get(r.date)!;
      if (a.closed === b.closed && a.openMin === b.openMin && a.closeMin === b.closeMin) return false;
      return b.closed || r.start_min < b.openMin || r.end_min > b.closeMin;
    })
    .map((r) => ({ code: r.code, date: r.date, startMin: r.start_min, endMin: r.end_min, court: court.name }));
}

/**
 * Set a court's own hours from a later date (null: the venue's from then), or
 * change those set already (`id`). Refused while bookings already made on the
 * dates it changes fall outside them, listing every one.
 */
export async function setCourtHoursChange(
  court: Court,
  input: { id?: number; from: unknown; weekHours: unknown }
): Promise<{ ok: true; change: CourtHoursChange; now: string } | DatedRefusal> {
  await applyDueCourtChanges({ courtId: court.id });
  const today = await venueToday(court.venueId);
  const from = readFrom(input.from, today);
  if (typeof from !== "string") return from;
  const vrow = await venueRow(court.venueId);
  if (!vrow) return { ok: false, error: "Venue not found." };
  // Checked as a week of hours is checked, against the venue's usual hours from then.
  const usual = hoursFor(storedOf(vrow), from);
  const week = validateWeekHours(input.weekHours ?? null, usual);
  if (!week.ok) return week;
  return withTransaction(async () => {
    const rows = await courtRows({ courtId: court.id });
    if (rows.length === 0) return { ok: false, error: "Court not found." };
    const before = courtChangesOf(rows[0].dated_changes)
      .filter((c): c is { kind: "hours" } & CourtHoursChange => c.kind === "hours")
      .map(({ kind: _kind, ...c }) => c);
    const editing = input.id !== undefined ? before.find((c) => c.id === input.id) : undefined;
    if (input.id !== undefined && !editing) return { ok: false, error: NOT_WAITING };
    if (before.some((c) => c.from === from && c.id !== input.id)) return { ok: false, error: `There is already a change from ${from}. Change that one instead.` };
    const change: CourtHoursChange = { id: input.id ?? -1, from, weekHours: week.week };
    const after = [...before.filter((c) => c.id !== input.id), change].sort((a, b) => a.from.localeCompare(b.from));
    const stranded = await strandedOnCourt(court, before, after, today);
    if (stranded.length > 0) return strandedRefusal(stranded);
    const db = getDb();
    const json = week.week ? JSON.stringify(week.week) : null;
    let id = input.id;
    if (editing) await db.prepare("UPDATE court_changes SET from_date = ?, week_hours = ? WHERE id = ? AND court_id = ? AND kind = 'hours'").run(from, json, editing.id, court.id);
    else
      id = ((await db.prepare("INSERT INTO court_changes (court_id, kind, from_date, week_hours) VALUES (?, 'hours', ?, ?) RETURNING id").get(court.id, from, json)) as { id: number }).id;
    return { ok: true as const, change: { ...change, id: id! }, now: week.week ? describeHours({ ...usual, weekHours: week.week }) : "the venue's hours" };
  });
}

/** Withdraw a court's change not yet in force; own hours only while no booking made under them would be left outside. */
export async function withdrawCourtChange(court: Court, id: number): Promise<{ ok: true; kind: "rates" | "hours"; from: string } | DatedRefusal> {
  await applyDueCourtChanges({ courtId: court.id });
  const today = await venueToday(court.venueId);
  return withTransaction(async () => {
    const rows = await courtRows({ courtId: court.id });
    const all = rows.length ? courtChangesOf(rows[0].dated_changes) : [];
    const change = all.find((c) => c.id === id);
    if (!change) return { ok: false, error: NOT_WAITING };
    if (change.kind === "hours") {
      const before = all.filter((c): c is { kind: "hours" } & CourtHoursChange => c.kind === "hours").map(({ kind: _kind, ...c }) => c);
      const stranded = await strandedOnCourt(court, before, before.filter((c) => c.id !== id), today);
      if (stranded.length > 0) return strandedRefusal(stranded);
    }
    await getDb().prepare("DELETE FROM court_changes WHERE id = ? AND court_id = ?").run(id, court.id);
    return { ok: true as const, kind: change.kind, from: change.from };
  });
}
