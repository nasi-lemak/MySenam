import { notifyLessonSeriesMoved } from "./coach-schedule";
import { getDb } from "./db";
import { previewMove, staffMove } from "./game-moves";
import { findBookingByCode, getCourt, venueHours } from "./store";
import { addDays, dayOfWeek } from "./time";
import { instantOf } from "./interval";
import type { Booking, Refusal } from "./types";
import type { PolicyBreach } from "./booking-rules";
import type { WindowOverrideRecord } from "./window-overrides";

/**
 * Staff moving the weeks of a weekly series still to be played to another
 * time, weekday or court in one step
 * (docs/features/booking.md#moving-a-weekly-series).
 *
 * Not a second engine: each week is the single staff move
 * (lib/game-moves.ts `previewMove` / `staffMove`, lib/store.ts
 * `rescheduleBooking`), so what is free, the court's rules and a manager's
 * override, linked courts and buffers, a lesson's coach, an open game's
 * players and the price are decided for each week exactly as for one booking
 * moved on its own: a paid week keeps what was paid, an unpaid one is priced
 * at its new time. Each week moves in its own transaction; a week that cannot
 * move (taken, closed, outside the court's rules) stays where it is and is
 * named with why, and the others still move.
 */

/** Where the weeks go: a start (minutes of the day), and where given a weekday (0 Sunday … 6 Saturday) and a court. */
export interface SeriesMoveTo {
  start: number;
  weekday?: number;
  courtId?: number;
  /** A manager going past the court's booking rules; recorded by the caller. */
  override?: boolean;
  /** A manager's override of an advisory launch or tide window, authorised by the route (lib/window-overrides.ts): each week outside its window is moved with it recorded. */
  windowOverride?: WindowOverrideRecord;
}

/** One week of the series and what moving it would do. */
export interface SeriesMoveWeek {
  code: string;
  from: { date: string; startMin: number; endMin: number; courtId: number; courtName: string };
  /** Where it would go; its court where it can move. */
  to: { date: string; startMin: number; endMin: number; courtId: number | null; courtName: string | null };
  movable: boolean;
  /** An unpaid week's price at its new time, less what it is now; 0 for a paid week, which keeps what was paid. */
  priceChange: number;
  /** A paid week: what the new time costs against the old at today's rates, not charged. */
  unchargedDifference: number;
  /** A paid week moved cheaper: the difference that goes back the way it was paid (lib/move-money.ts), unless staff keep it. */
  refund?: { amount: number; how: "online" | "counter" | "credit" };
  /** The court's rules a manager's override would go past. */
  overrides?: string[];
  /** `venue`: an open game with players on it, moved only by a manager with a reason the players are given. */
  outcome?: "move" | "venue";
  /** Why it cannot move. */
  refusal?: Pick<Refusal, "error" | "code" | "vars">;
}

const refused = (error: string): Refusal => ({ ok: false, error });

/** The new date of a week: the weekday asked for, in the same week (Monday to Sunday) as the week's own date. */
export function weekDate(date: string, weekday: number | undefined): string {
  if (weekday === undefined) return date;
  const monday = (d: number) => (d + 6) % 7;
  return addDays(date, monday(weekday) - monday(dayOfWeek(date)));
}

/** The weeks of a series not yet over, soonest first, and the venues they are at. */
async function weeksToPlay(seriesCode: string): Promise<Booking[]> {
  const rows = (await getDb()
    .prepare("SELECT code FROM bookings WHERE UPPER(series_code) = UPPER(?) AND status = 'confirmed' AND class_id IS NULL ORDER BY date, start_min")
    .all(seriesCode.trim())) as { code: string }[];
  const out: Booking[] = [];
  for (const r of rows) {
    const b = await findBookingByCode(r.code);
    if (!b) continue;
    const court = await getCourt(b.courtId);
    const { zone } = await venueHours(court?.venueId ?? 0, b.date);
    if (instantOf(b.date, b.endMin, zone).getTime() <= Date.now()) continue;
    out.push(b);
  }
  return out;
}

async function courtName(id: number): Promise<string> {
  return (await getCourt(id))?.name ?? "";
}

function target(b: Booking, to: SeriesMoveTo) {
  return {
    date: weekDate(b.date, to.weekday),
    start: to.start,
    ...(to.courtId !== undefined ? { courtId: to.courtId } : {}),
    ...(to.override ? { override: true } : {}),
    ...(to.windowOverride ? { windowOverride: to.windowOverride } : {}),
  };
}

/** What staff choose from: the series as it is now (its next week's weekday, start and court) and the courts of its venue for its activity. */
export async function seriesMoveChoices(
  seriesCode: string
): Promise<{ ok: true; weekday: number; start: number; courtId: number; weeks: number; courts: { id: number; name: string }[] } | Refusal> {
  const weeks = await weeksToPlay(seriesCode);
  if (weeks.length === 0) return refused("Series not found.");
  const first = weeks[0];
  const court = await getCourt(first.courtId);
  const courts = (await getDb()
    .prepare(
      `SELECT c.id, c.name FROM courts c
        WHERE c.venue_id = ? AND EXISTS (SELECT 1 FROM court_activities ca WHERE ca.court_id = c.id AND ca.sport = ?) ORDER BY c.id`
    )
    .all(court?.venueId ?? 0, first.sport)) as { id: number; name: string }[];
  return { ok: true, weekday: dayOfWeek(first.date), start: first.startMin, courtId: first.courtId, weeks: weeks.length, courts };
}

/** Each week still to be played and what moving it would do, changing nothing. */
export async function previewSeriesMove(seriesCode: string, to: SeriesMoveTo): Promise<{ ok: true; weeks: SeriesMoveWeek[] } | Refusal> {
  const weeks = await weeksToPlay(seriesCode);
  if (weeks.length === 0) return refused("Series not found.");
  const out: SeriesMoveWeek[] = [];
  for (const b of weeks) {
    const where = target(b, to);
    const from = { date: b.date, startMin: b.startMin, endMin: b.endMin, courtId: b.courtId, courtName: await courtName(b.courtId) };
    const length = b.endMin - b.startMin;
    const seen = await previewMove(b.code, where, "staff");
    if (!seen.ok) {
      out.push({
        code: b.code,
        from,
        to: { date: where.date, startMin: to.start, endMin: to.start + length, courtId: to.courtId ?? null, courtName: to.courtId !== undefined ? await courtName(to.courtId) : null },
        movable: false,
        priceChange: 0,
        unchargedDifference: 0,
        refusal: { error: seen.error, ...(seen.code ? { code: seen.code } : {}), ...(seen.vars ? { vars: seen.vars } : {}) },
      });
      continue;
    }
    const p = seen.preview;
    out.push({
      code: b.code,
      from,
      to: { date: p.to.date, startMin: p.to.startMin, endMin: p.to.endMin, courtId: p.to.courtId, courtName: p.to.courtName },
      movable: true,
      priceChange: p.priceChange,
      unchargedDifference: p.unchargedDifference,
      ...(p.money.settles === "refund" && p.money.refund ? { refund: { amount: p.money.refund.amount, how: p.money.refund.how } } : {}),
      ...(p.overrides ? { overrides: p.overrides } : {}),
      outcome: p.outcome === "venue" ? "venue" : "move",
    });
  }
  return { ok: true, weeks: out };
}

/** A week moved: the booking where it is now, where it was, and what the single move said. */
export interface SeriesWeekMoved {
  booking: Booking;
  from: { date: string; startMin: number; endMin: number; courtId: number };
  priceChange: number;
  unchargedDifference: number;
  /** A paid week moved cheaper: what went back, and how (owed back, or to credit). */
  refund?: { amount: number; how: "online" | "counter" | "credit" };
  overrides?: PolicyBreach[];
  outcome: "move" | "venue";
}

/**
 * Move the weeks staff chose (every week still to be played where `codes` is
 * not given), each by the single staff move, each in its own transaction. A
 * week that cannot move stays, returned with why; the others move.
 */
export async function moveSeries(
  admin: { id: number; name: string; role: string },
  seriesCode: string,
  to: SeriesMoveTo,
  opts: { codes?: string[]; reason?: string | null } = {}
): Promise<{ ok: true; moved: SeriesWeekMoved[]; left: { code: string; error: string; errorCode?: string; vars?: Record<string, string | number> }[] } | Refusal> {
  const weeks = await weeksToPlay(seriesCode);
  if (weeks.length === 0) return refused("Series not found.");
  const byCode = new Map(weeks.map((w) => [w.code.toUpperCase(), w]));
  const chosen = opts.codes ? [...new Set(opts.codes.map((c) => c.trim().toUpperCase()))] : [...byCode.keys()];
  if (chosen.length === 0) return refused("Choose the weeks to move.");
  for (const c of chosen) if (!byCode.has(c)) return refused("The series changed since you looked. Look at it again.");
  const moved: SeriesWeekMoved[] = [];
  const left: { code: string; error: string; errorCode?: string; vars?: Record<string, string | number> }[] = [];
  for (const c of chosen) {
    const b = byCode.get(c)!;
    // A lesson's coach is told once for the weeks moved, below, not once a week.
    const done = await staffMove(admin, b.code, { ...target(b, to), changedBy: { adminId: admin.id, name: admin.name }, quietCoach: true }, opts.reason ?? null);
    if (!done.ok) {
      left.push({ code: b.code, error: done.error, ...(done.code ? { errorCode: done.code } : {}), ...(done.vars ? { vars: done.vars } : {}) });
      continue;
    }
    if (done.outcome === "proposal") continue;
    const r = done.result;
    moved.push({
      booking: r.booking,
      from: { date: r.from.date, startMin: r.from.startMin, endMin: r.from.endMin, courtId: r.from.courtId },
      priceChange: r.priceChange,
      unchargedDifference: r.unchargedDifference,
      ...(r.money.settles === "refund" && r.money.refund ? { refund: { amount: r.money.refund.amount, how: r.money.refund.how } } : {}),
      ...(r.overrides ? { overrides: r.overrides } : {}),
      outcome: done.outcome,
    });
  }
  const lessons = moved.filter((m) => m.booking.coachId);
  if (lessons.length > 0)
    await notifyLessonSeriesMoved(
      seriesCode,
      lessons.map((m) => ({ bookingId: m.booking.id, was: { date: m.from.date, startMin: m.from.startMin, endMin: m.from.endMin } }))
    );
  return { ok: true, moved, left };
}
