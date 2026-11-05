import { getDb } from "./db";
import { courtDay, getCourt } from "./store";
import { courtFor } from "./court-activities";
import { launchOk, launchRefusal, reasonFor, type LaunchDay, type LaunchRefusal } from "./launch-day";
import { listRules, ruleById, ruleFor, type LaunchRule } from "./launch-windows";
import { addDays, dayOfWeek, isValidDateString, todayISO } from "./time";
import { instantOf, type Span } from "./interval";
import type { Sport } from "./types";
import { venueZoneOf } from "./zones";

/**
 * What a launch or tide window leaves outside it (ADR 0037): the bookings and
 * class sessions to come that are not wholly inside the window their day has
 * now. Worked out each time from the rules and the tide table as they stand, so
 * correcting a table, or changing a rule, puts what it strands on the list at
 * once and nothing is ever cancelled for it: staff move or cancel each through
 * the existing paths (the day list, with its customer messages), or keep it as
 * booked, which holds until the day's window changes again.
 */

export interface Stranded {
  kind: "booking" | "class";
  /** A booking's code, or a class's id. */
  ref: string;
  /** The booking's id, or the class's; what the list is acted on by. */
  id: number;
  date: string;
  startMin: number;
  endMin: number;
  courtId: number;
  court: string;
  /** The customer's name, or the class's. */
  name: string;
  /** A booking's phone, for the desk to call; null for a class. */
  phone: string | null;
  /** Why it is outside, as the refusal would say it. */
  why: LaunchRefusal["code"];
  /** The windows that day, as lines ("7:10 AM–10:40 AM"), none when the day has none. */
  windows: Span[];
  returnBuffer: number;
}

/** What names a day's window as it stands: a booking kept as booked is listed again when this changes. */
export function windowSignature(day: LaunchDay): string {
  return `${day.returnBuffer}|${day.windows.map((w) => `${w.start}-${w.end}`).join(",")}|${day.closed.map((c) => `${c.reason}:${c.start}-${c.end}`).join(",")}`;
}

interface Item {
  kind: "booking" | "class";
  id: number;
  ref: string;
  date: string;
  start_min: number;
  end_min: number;
  court_id: number;
  court: string;
  name: string;
  phone: string | null;
  sport: Sport;
}

/**
 * Bookings and class sessions at a venue, from today on, outside the window
 * their day has. `kept` are those staff chose to leave as booked and the
 * window has not changed since.
 */
export async function strandedByLaunch(venueId: number): Promise<{ stranded: Stranded[]; kept: Stranded[] }> {
  const rules = await listRules(venueId);
  if (rules.length === 0) return { stranded: [], kept: [] };
  const db = getDb();
  const venue = (await db.prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(venueId)) as { time_zone: string | null; lat: number | null; lng: number | null } | undefined;
  const zone = venueZoneOf(venue ?? {});
  const today = todayISO(zone);
  const courts = [...new Set(rules.map((r) => r.courtId))];
  const marks = courts.map(() => "?").join(",");
  const bookings = (await db
    .prepare(
      `SELECT 'booking' AS kind, b.id, b.code AS ref, b.date, b.start_min, b.end_min, b.court_id, c.name AS court, b.name, b.phone, b.sport
         FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND b.court_id IN (${marks}) AND b.date >= ? AND b.status = 'confirmed' AND b.class_id IS NULL`
    )
    .all(venueId, ...courts, today)) as Item[];
  const classes = (await db
    .prepare(
      `SELECT 'class' AS kind, k.id, CAST(k.id AS TEXT) AS ref, k.date, k.start_min, k.end_min, k.court_id, c.name AS court, k.name, NULL AS phone, c.sport
         FROM classes k JOIN courts c ON c.id = k.court_id
        WHERE c.venue_id = ? AND k.court_id IN (${marks}) AND k.date >= ? AND k.status = 'scheduled'`
    )
    .all(venueId, ...courts, today)) as Item[];
  const kept = new Map(
    ((await db.prepare("SELECT booking_id, signature FROM launch_kept WHERE booking_id IN (SELECT b.id FROM bookings b JOIN courts c ON c.id = b.court_id WHERE c.venue_id = ?)").all(venueId)) as { booking_id: number; signature: string }[]).map((r) => [r.booking_id, r.signature])
  );

  const days = new Map<string, LaunchDay | null>();
  const now = Date.now();
  const out: Stranded[] = [];
  const held: Stranded[] = [];
  for (const it of [...bookings, ...classes]) {
    // One that has finished is left alone, as a rain-out leaves it.
    if (instantOf(it.date, it.end_min, zone).getTime() <= now) continue;
    const key = `${it.court_id}\u0000${it.sport}\u0000${it.date}`;
    if (!days.has(key)) {
      const court = await getCourt(it.court_id);
      days.set(key, court ? (await courtDay(courtFor(court, it.sport), it.date)).launch : null);
    }
    const launch = days.get(key) ?? null;
    if (!launch || launchOk(launch, { start: it.start_min, end: it.end_min })) continue;
    const item: Stranded = {
      kind: it.kind,
      ref: String(it.ref),
      id: Number(it.id),
      date: it.date,
      startMin: it.start_min,
      endMin: it.end_min,
      courtId: it.court_id,
      court: it.court,
      name: it.name,
      phone: it.phone,
      why: launchRefusal(launch, { start: it.start_min, end: it.end_min }).code,
      windows: launch.windows,
      returnBuffer: launch.returnBuffer,
    };
    if (it.kind === "booking" && kept.get(Number(it.id)) === windowSignature(launch)) held.push(item);
    else out.push(item);
  }
  const order = (a: Stranded, b: Stranded) => a.date.localeCompare(b.date) || a.startMin - b.startMin || a.court.localeCompare(b.court) || a.ref.localeCompare(b.ref);
  return { stranded: out.sort(order), kept: held.sort(order) };
}

/** Leave a booking as booked, outside its day's window as it stands now. */
export async function keepStranded(venueId: number, code: unknown, adminId: number | null): Promise<{ ok: true; item: Stranded } | { ok: false; error: string }> {
  if (typeof code !== "string") return { ok: false, error: "Which booking?" };
  const { stranded } = await strandedByLaunch(venueId);
  const item = stranded.find((s) => s.kind === "booking" && s.ref === code);
  if (!item) return { ok: false, error: "That booking is not outside a launch window, or is not at this venue." };
  const court = await getCourt(item.courtId);
  const booking = (await getDb().prepare("SELECT sport FROM bookings WHERE id = ?").get(item.id)) as { sport: Sport } | undefined;
  const launch = court && booking ? (await courtDay(courtFor(court, booking.sport), item.date)).launch : null;
  if (!launch) return { ok: false, error: "That booking is not outside a launch window, or is not at this venue." };
  await getDb()
    .prepare(
      `INSERT INTO launch_kept (booking_id, signature, kept_by) VALUES (?, ?, ?)
       ON CONFLICT (booking_id) DO UPDATE SET signature = EXCLUDED.signature, kept_by = EXCLUDED.kept_by, kept_at = datetime('now')`
    )
    .run(item.id, windowSignature(launch), adminId);
  return { ok: true, item };
}

export interface PreviewDay {
  date: string;
  weekday: number;
  windows: Span[];
  returnBuffer: number;
  /** Why the day has no window: the first reason it is closed, or "closed" for a day the venue is shut. */
  why: "closed" | "outside_launch" | "low_water" | "no_tide_data" | "short_window" | "return_buffer" | null;
}

/**
 * A month of a rule's windows as bookings would meet them: each date's
 * windows within the court's opening hours, or why it has none. `month` is
 * `YYYY-MM`.
 */
export async function monthPreview(venueId: number, ruleId: number, month: string): Promise<{ ok: true; rule: LaunchRule; days: PreviewDay[] } | { ok: false; error: string }> {
  if (!/^\d{4}-\d{2}$/.test(month) || !isValidDateString(`${month}-01`)) return { ok: false, error: "Give the month as YYYY-MM." };
  const rule = await ruleById(venueId, ruleId);
  if (!rule) return { ok: false, error: "That rule is not at this venue." };
  const court = await getCourt(rule.courtId);
  if (!court) return { ok: false, error: "That resource is gone." };
  const as = courtFor(court, rule.sport ?? court.sport);
  const days: PreviewDay[] = [];
  for (let date = `${month}-01`; date.startsWith(month); date = addDays(date, 1)) {
    const day = await courtDay(as, date);
    const launch = day.launch;
    const why = day.closed ? ("closed" as const) : launch && launch.windows.length === 0 ? (reasonFor(launch, 0, 1440) ?? "outside_launch") : null;
    days.push({ date, weekday: dayOfWeek(date), windows: launch?.windows ?? (day.closed ? [] : [{ start: day.openMin, end: day.closeMin }]), returnBuffer: launch?.returnBuffer ?? 0, why });
  }
  return { ok: true, rule, days };
}

/** The window a venue page tells customers of, for each resource with a rule: today's and tomorrow's. */
export async function publishedWindows(venueId: number): Promise<{ courtId: number; court: string; date: string; when: "today" | "tomorrow"; windows: Span[]; returnBuffer: number; why: PreviewDay["why"] }[]> {
  const rules = await listRules(venueId);
  if (rules.length === 0) return [];
  const db = getDb();
  const venue = (await db.prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(venueId)) as { time_zone: string | null; lat: number | null; lng: number | null } | undefined;
  const today = todayISO(venueZoneOf(venue ?? {}));
  const out: Awaited<ReturnType<typeof publishedWindows>> = [];
  const seen = new Set<number>();
  for (const rule of rules) {
    if (seen.has(rule.courtId)) continue;
    seen.add(rule.courtId);
    const court = await getCourt(rule.courtId);
    if (!court || court.classesOnly) continue;
    // The resource's own activity first: its window is the one customers meet.
    const mainRule = ruleFor(rules.filter((r) => r.courtId === rule.courtId), court.sport) ?? rule;
    for (const date of [today, addDays(today, 1)]) {
      const day = await courtDay(courtFor(court, mainRule.sport ?? court.sport), date);
      if (day.closed || !day.launch) continue;
      out.push({
        courtId: court.id,
        court: court.name,
        date,
        when: date === today ? ("today" as const) : ("tomorrow" as const),
        windows: day.launch.windows,
        returnBuffer: day.launch.returnBuffer,
        why: day.launch.windows.length === 0 ? (reasonFor(day.launch, 0, 1440) ?? "outside_launch") : null,
      });
    }
  }
  return out;
}
