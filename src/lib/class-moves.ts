import { randomBytes } from "node:crypto";
import { logCancelledBookings } from "./activity";
import { policyBuffers, claimBuffers } from "./booking-rules";
import { CoachHeld, coachTeachingRefusal, holdCoach } from "./class-coaches";
import { claim, inTheWayOf, isConflict, occupantsOn, fits, unclaim } from "./claims";
import { coachLocale } from "./coach-schedule";
import { venueCancel } from "./counter-refunds";
import { getDb, isBusy, withTransaction } from "./db";
import { errorText, translator, type ErrorCode } from "./i18n";
import { formatMinute, hoursOf, instantOf, isMinute } from "./interval";
import {
  classMovePreviewTexts,
  classMoveRecipients,
  notifyBookingCancelled,
  sendClassMoveNotices,
  type ClassMoveLink,
  type ClassMoveRecipient,
  type MovedClass,
} from "./notify";
import { enqueue } from "./outbox";
import { refundCancelled, type CancelRefund } from "./payments";
import { clockRange } from "./region";
import {
  courtDay,
  getBookingById,
  getClass,
  getClassRoster,
  getCourt,
  getVenueClosure,
  offerSlotPlace,
  venueHours,
} from "./store";
import { addDays, isValidDateString } from "./time";
import { recordSupervisors, supervisionRefusal } from "./rosters";
import type { ClassSession, Court, Refusal } from "./types";
import { coachById } from "./coaching";
import { membersOnlyRefusal } from "./entitlements";
import { bookingPlaces } from "./participants";

/**
 * Moving a class: staff put one session, one and the rest of its weekly series, or the whole term (every session not yet
 * begun) at another date, time or court, in one step (docs/features/programmes.md#moving-a-class).
 *
 * Not a second engine, and not cancel-and-enrol again. A class's enrolments are bookings with a `class_id` that hold no
 * claim of their own (the class holds the court), so a move is the class's own claim let go and made again at the new
 * time, in the transaction that updates the class and each enrolment's date, time and court, the way a booking is moved
 * (lib/store.ts `reclaimBooking`): all or none, and the database is what refuses a time that is taken (the exclusion
 * constraints and the capacity trigger on `claims`, and the one on `coach_claims` for the instructor where it is one of the
 * venue's coaches). The new time is claimed, or the old one stays: nothing is ever released without the new time held.
 *
 * A session shifts by what the chosen one does (days and minutes), so a series with an exception (one week already at
 * another time, one cancelled) keeps its exceptions relative to the others; a court given is every moved session's.
 * A session that has begun, one whose attendance was taken, and one cancelled cannot be moved.
 *
 * Everyone enrolled is kept, told once (lib/notify.ts `sendClassMoveNotices`) with the link to cancel for everything back,
 * which nothing here does for them: the cancellation is the venue's own (lib/counter-refunds.ts `venueCancel`, the path of a
 * class the venue calls off), by the customer's tap, within the window (`class_move_rules`, default 7 days, never past the
 * session's original time).
 */

const ENGLISH = translator("en");
function refuse(code: ErrorCode, vars?: Record<string, string | number>): Refusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, ...(vars ? { vars } : {}) };
}

export const MOVE_SCOPES = ["one", "following", "term"] as const;
export type MoveScope = (typeof MOVE_SCOPES)[number];
export const isMoveScope = (v: unknown): v is MoveScope => typeof v === "string" && (MOVE_SCOPES as readonly string[]).includes(v);

/** Where the chosen session goes: a date, a start (minutes of the day) and, where it changes, a court. */
export interface ClassMoveTo {
  date: string;
  start: number;
  courtId?: number;
}

type Conflict = Pick<Refusal, "error" | "code" | "vars">;
const conflictOf = (r: Refusal): Conflict => ({ error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.vars ? { vars: r.vars } : {}) });

/** The days a customer has, after a move, to cancel for everything back (install data; 7 where the row is missing). */
export async function classMoveWindowDays(): Promise<number> {
  const row = (await getDb().prepare("SELECT refund_window_days FROM class_move_rules WHERE id = 1").get()) as { refund_window_days: number } | undefined;
  return row?.refund_window_days ?? 7;
}

/** Until when a moved place may be cancelled for everything back: the window after `now`, or the session's original start if that is sooner. */
export function refundUntil(before: Pick<ClassSession, "date" | "startMin">, zone: string, days: number, now = new Date()): Date {
  const window = new Date(now.getTime() + days * 86_400_000);
  const original = instantOf(before.date, before.startMin, zone);
  return original.getTime() < window.getTime() ? original : window;
}

/**
 * The roster check (a staffed session's officer, instructor or lifeguard on the new time, ADR 0036), called for each
 * session before it moves and again when it is claimed: a refusal where the new time has nobody qualified rostered for it.
 */
export async function classRosterRefusal(session: ClassSession, to: { date: string; startMin: number; endMin: number; courtId: number }): Promise<Refusal | null> {
  const court = (await getDb().prepare("SELECT venue_id, sport FROM courts WHERE id = ?").get(to.courtId)) as { venue_id: number; sport: string } | undefined;
  if (!court) return null;
  return supervisionRefusal({
    venueId: court.venue_id,
    courtId: to.courtId,
    sport: session.sport ?? court.sport,
    date: to.date,
    span: { start: to.startMin, end: to.endMin },
    zone: (await venueHours(court.venue_id)).zone,
  });
}

/** What the move would do to one session. */
export interface SessionMove {
  classId: number;
  name: string;
  seriesCode: string | null;
  from: { date: string; startMin: number; endMin: number; courtId: number; courtName: string };
  to: { date: string; startMin: number; endMin: number; courtId: number; courtName: string };
  enrolled: number;
  waiting: number;
  /** Enrolled: each person's place, how it was paid, and whether it holds a pass entry or a membership's benefit (what a cancellation within the window gives back). */
  people: { bookingId: number; code: string; name: string; participantName: string | null; paymentStatus: string; pass: boolean; membership: boolean }[];
  /** Why this session cannot be moved, where it cannot. */
  conflict?: Conflict;
}

export interface MovePreview {
  ok: true;
  scope: MoveScope;
  sessions: SessionMove[];
  /** Sessions of the series left where they are, and why. */
  skipped: { classId: number; date: string; reason: "started" | "cancelled" | "unchanged" }[];
  /** Any session with a conflict: the move would be refused, all of it. */
  blocked: boolean;
  windowDays: number;
  /** What each person will be told, in their own language and on which channels; the links stand as "a private link". */
  notices: { name: string; kind: "enrolled" | "waiting"; locale: string; channels: string[]; text: string }[];
}

export interface Planned {
  chosen: ClassSession;
  scope: MoveScope;
  items: { session: ClassSession; to: SessionMove["to"]; conflict: Conflict | null; court: Court }[];
  skipped: MovePreview["skipped"];
  zone: string;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** The sessions a move concerns, each at where it would go, and what is wrong with it; or why nothing can be moved. */
async function plan(classId: number, to: ClassMoveTo, scopeIn: unknown): Promise<Planned | Refusal> {
  const scope = scopeIn === undefined ? "one" : scopeIn;
  if (!isMoveScope(scope)) return refuse("CLSA_MOVE_SCOPE");
  const chosen = await getClass(classId);
  if (!chosen) return refuse("CLASS_NOT_FOUND");
  if (chosen.status === "cancelled") return refuse("CLASS_CANCELLED");
  const { zone } = await venueHours(chosen.venueId);
  const started = (c: Pick<ClassSession, "date" | "startMin">) => instantOf(c.date, c.startMin, zone).getTime() <= Date.now();
  if (started(chosen)) return refuse("CLASS_STARTED");
  if (!to || typeof to.date !== "string" || !isValidDateString(to.date) || !isMinute(to.start)) return refuse("SLOT_PAST");
  const shiftDays = daysBetween(chosen.date, to.date);
  const shiftMin = to.start - chosen.startMin;

  let toCourt: Court | null = null;
  if (to.courtId !== undefined && to.courtId !== chosen.courtId) {
    toCourt = await getCourt(to.courtId);
    // Another venue's court is not said to exist (nothing of it is named).
    if (!toCourt || toCourt.venueId !== chosen.venueId) return refuse("COURT_NOT_FOUND");
  }

  // The sessions: this one, or with the series from it on, or every one of the term not yet begun.
  const series: ClassSession[] = [];
  if (scope !== "one" && chosen.seriesCode) {
    const rows = (await getDb().prepare("SELECT id FROM classes WHERE series_code = ? ORDER BY date, start_min, id").all(chosen.seriesCode)) as { id: number }[];
    for (const r of rows) {
      const c = await getClass(r.id);
      if (c) series.push(c);
    }
  } else series.push(chosen);
  const skipped: MovePreview["skipped"] = [];
  const movable: ClassSession[] = [];
  for (const c of series) {
    // `following` is this session and the later ones: the earlier ones are not part of it, and not mentioned.
    if (c.id !== chosen.id && scope === "following" && (c.date < chosen.date || (c.date === chosen.date && c.startMin < chosen.startMin))) continue;
    if (c.status === "cancelled") skipped.push({ classId: c.id, date: c.date, reason: "cancelled" });
    else if (c.id !== chosen.id && started(c)) skipped.push({ classId: c.id, date: c.date, reason: "started" });
    else movable.push(c);
  }
  const ids = movable.map((c) => c.id);

  const items: Planned["items"] = [];
  for (const session of movable) {
    const court = toCourt ?? (await getCourt(session.courtId))!;
    const dest = {
      date: addDays(session.date, shiftDays),
      startMin: session.startMin + shiftMin,
      endMin: session.endMin + shiftMin,
      courtId: court.id,
      courtName: court.name,
    };
    if (dest.date === session.date && dest.startMin === session.startMin && court.id === session.courtId) {
      // Where it already is: left alone (a series whose other sessions move).
      skipped.push({ classId: session.id, date: session.date, reason: "unchanged" });
      continue;
    }
    items.push({ session, to: dest, conflict: await sessionConflict(session, dest, court, ids, zone), court });
  }
  if (items.length === 0) return refuse("CLSA_MOVE_SAME");
  return { chosen, scope, items, skipped, zone };
}

/** Everything that stops one session being at `dest`, read for showing and refusing early; the claims decide when it is written. */
async function sessionConflict(
  session: ClassSession,
  dest: SessionMove["to"],
  court: Court,
  movedIds: number[],
  zone: string
): Promise<Conflict | null> {
  const db = getDb();
  const date = { date: dest.date };
  // Attendance taken: a session somebody has been checked in to is under way, whatever its start says. Verified attendance
  // only (ADR 0058): the desk's, a register mark's, or a customer's own check-in that staff confirmed, never a remote tap.
  const attended = await db
    .prepare("SELECT 1 AS x FROM check_ins ci JOIN bookings b ON b.id = ci.booking_id WHERE b.class_id = ? AND b.status = 'confirmed' AND (ci.source = 'desk' OR ci.confirmed_at IS NOT NULL) LIMIT 1")
    .get(session.id);
  if (attended) return conflictOf(refuse("CLSA_MOVE_ATTENDANCE", { date: session.date }));

  if (court.venueId !== session.venueId || court.capacity <= 1 || court.capacity < session.capacity) return conflictOf(refuse("CLSA_MOVE_COURT", { n: session.capacity }));
  const offers = await db
    .prepare("SELECT 1 AS x FROM courts c WHERE c.id = ? AND (c.sport = ? OR EXISTS (SELECT 1 FROM court_activities ca WHERE ca.court_id = c.id AND ca.sport = ?))")
    .get(court.id, session.sport, session.sport);
  if (!offers) return conflictOf(refuse("CLSA_MOVE_COURT", { n: session.capacity }));

  if (!isMinute(dest.startMin) || !isMinute(dest.endMin) || dest.endMin <= dest.startMin) return conflictOf(refuse("CLSA_MOVE_HOURS", date));
  if (instantOf(dest.date, dest.startMin, zone).getTime() <= Date.now()) return conflictOf(refuse("SLOT_PAST"));
  const day = await courtDay(court, dest.date);
  if (await getVenueClosure(court.venueId, dest.date)) return conflictOf(refuse("VENUE_CLOSED"));
  if (dest.startMin < day.openMin || dest.endMin > day.closeMin) return conflictOf(refuse("CLSA_MOVE_HOURS", date));

  // The court's time: what holds it then, but for the classes being moved (their own old claims are let go).
  const held = (await occupantsOn([court], dest.date, day.zone)).get(court.id) ?? [];
  const span = { start: dest.startMin, end: dest.endMin };
  const buffers = policyBuffers(day.policy);
  const mine = (o: { kind: string; classId: number | null }) => o.kind === "class" && o.classId !== null && movedIds.includes(o.classId);
  if (!fits(held, court.capacity, span, buffers, mine, court.capacity)) {
    const inWay = inTheWayOf(held, court.capacity, span, buffers, mine);
    return conflictOf(refuse(inWay.some((o) => o.kind === "class") ? "CLSA_MOVE_CLASS" : "CLSA_MOVE_BOOKED", { court: court.name, date: dest.date }));
  }

  // The instructor, where it is one of the venue's coaches: working then, and in nothing else.
  if (session.coachId) {
    const why = await coachTeachingRefusal(session.coachId, session.venueId, session.sport, [{ date: dest.date, startMin: dest.startMin, endMin: dest.endMin }], zone, movedIds);
    if (why) return conflictOf(why);
  }

  // A members' session: everybody holding a place is still a member on the new date (lib/entitlements.ts).
  const roster = (await getClassRoster(session.id)).filter((b) => b.status === "confirmed");
  for (const b of roster) {
    const places = await bookingPlaces(b.id);
    const owner = ((await db.prepare("SELECT user_id FROM bookings WHERE id = ?").get(b.id)) as { user_id: number | null } | undefined)?.user_id ?? null;
    const why = await membersOnlyRefusal({
      venueId: court.venueId,
      court,
      classId: session.id,
      participants: places.flatMap((p) => (!p.customer && p.participantId !== null ? [{ id: p.participantId, name: p.name ?? "" }] : [])),
      customer: places.some((p) => p.customer) ? { phone: b.phone, userId: owner, by: "staff" } : null,
      dates: [dest.date],
    });
    if (why) return conflictOf(why);
  }

  const rostered = await classRosterRefusal(session, { date: dest.date, startMin: dest.startMin, endMin: dest.endMin, courtId: court.id });
  if (rostered) return conflictOf(rostered);
  return null;
}

const asSession = (item: Planned["items"][number]): ClassSession => ({
  ...item.session,
  date: item.to.date,
  startMin: item.to.startMin,
  endMin: item.to.endMin,
  startHour: hoursOf(item.to.startMin),
  endHour: hoursOf(item.to.endMin),
  courtId: item.to.courtId,
  courtName: item.to.courtName,
});

/** What moving would do, changing nothing: each session where it goes, who is in it, what is wrong with it, and what each person will be told. */
export async function previewClassMove(classId: number, to: ClassMoveTo, scope?: unknown): Promise<MovePreview | Refusal> {
  const planned = await plan(classId, to, scope);
  if (!("items" in planned)) return planned;
  const db = getDb();
  const sessions: SessionMove[] = [];
  for (const item of planned.items) {
    const s = item.session;
    const rows = (await db
      .prepare(
        `SELECT b.id, b.code, b.name, b.participant_name, b.payment_status,
                EXISTS (SELECT 1 FROM pass_entries e WHERE e.booking_id = b.id AND e.delta < 0) AS pass,
                EXISTS (SELECT 1 FROM place_benefits pb WHERE pb.booking_id = b.id) AS membership
           FROM bookings b WHERE b.class_id = ? AND b.status = 'confirmed' ORDER BY b.id`
      )
      .all(s.id)) as { id: number; code: string; name: string; participant_name: string | null; payment_status: string; pass: boolean; membership: boolean }[];
    const waiting = (await db.prepare("SELECT COUNT(*)::int AS n FROM waitlist WHERE class_id = ? AND status IN ('waiting', 'offered')").get(s.id)) as { n: number };
    sessions.push({
      classId: s.id,
      name: s.name,
      seriesCode: s.seriesCode,
      from: { date: s.date, startMin: s.startMin, endMin: s.endMin, courtId: s.courtId, courtName: s.courtName },
      to: item.to,
      enrolled: rows.length,
      waiting: Number(waiting.n),
      people: rows.map((r) => ({
        bookingId: r.id, code: r.code, name: r.name, participantName: r.participant_name, paymentStatus: r.payment_status, pass: r.pass === true, membership: r.membership === true,
      })),
      ...(item.conflict ? { conflict: item.conflict } : {}),
    });
  }
  const days = await classMoveWindowDays();
  const moved: MovedClass[] = planned.items.map((i) => ({ before: i.session, after: asSession(i) }));
  const recipients = await classMoveRecipients(moved);
  const notices = await classMovePreviewTexts(recipients, (r) => {
    const untils = r.sessions.map((s) => refundUntil(s.before, planned.zone, days).getTime());
    return untils.length > 0 ? new Date(Math.min(...untils)) : null;
  });
  return {
    ok: true,
    scope: planned.scope,
    sessions,
    skipped: planned.skipped,
    blocked: sessions.some((s) => s.conflict),
    windowDays: days,
    notices,
  };
}

class Refused extends Error {
  constructor(readonly refusal: Refusal) {
    super("CLASS_MOVE_REFUSED");
  }
}

/**
 * Where a move made on somebody's say-so (lib/class-move-requests.ts: a manager approving a front-desk request) ties its own record to the
 * same transaction. Nothing here is used by a move made directly.
 */
export interface MoveHooks {
  /** Under the classes' row locks, before anything is read again or changed: a refusal undoes everything and is what the move answers. */
  locked?: (planned: Planned) => Promise<Refusal | null>;
  /** In the same transaction, once the sessions are moved and the move recorded: the request is marked approved in the same commit. */
  applied?: (moveId: number, moved: MovedClass[]) => Promise<void>;
}

export type ClassMoveResult =
  | {
      ok: true;
      moveId: number;
      scope: MoveScope;
      moved: MovedClass[];
      skipped: MovePreview["skipped"];
      /** Messages written to those enrolled and waiting (a person once, however many sessions of theirs moved). */
      told: number;
    }
  | (Refusal & { conflicts?: (Conflict & { classId: number; date: string })[] });

/**
 * Move the sessions (see the top of this file): all of them, or none, with a refusal naming what is in the way of each that
 * cannot. Everything is read again under the classes' row locks (the ones every enrolment takes), so an enrolment and a move at
 * the same moment, or two staff moving one class, never leave a session half moved: the second sees what the first did and is
 * refused as changed.
 */
export async function moveClasses(
  admin: { id: number | null; name: string },
  classId: number,
  to: ClassMoveTo,
  scope?: unknown,
  hooks?: MoveHooks
): Promise<ClassMoveResult> {
  const planned = await plan(classId, to, scope);
  if (!("items" in planned)) return planned;
  const blocked = planned.items.filter((i) => i.conflict);
  if (blocked.length > 0) {
    const first = blocked[0].conflict!;
    return {
      ok: false,
      error: first.error,
      ...(first.code ? { code: first.code } : {}),
      ...(first.vars ? { vars: first.vars } : {}),
      conflicts: blocked.map((i) => ({ ...i.conflict!, classId: i.session.id, date: i.session.date })),
    };
  }
  const { zone } = planned;
  const ids = planned.items.map((i) => i.session.id).sort((a, b) => a - b);
  const days = await classMoveWindowDays();
  const db = getDb();
  let outcome: { moveId: number; moved: MovedClass[]; recipients: ClassMoveRecipient[]; links: Map<string, ClassMoveLink> };
  try {
    outcome = await withTransaction(async () => {
      // The lock every enrolment takes while it counts places (lib/store.ts `enrolPeopleOnce`), in id order.
      for (const id of ids) await db.prepare("SELECT id FROM classes WHERE id = ? FOR UPDATE").get(id);
      const lockedOut = hooks?.locked ? await hooks.locked(planned) : null;
      if (lockedOut) throw new Refused(lockedOut);
      // Nothing changed since it was read: not moved, cancelled, begun or attended meanwhile.
      for (const item of planned.items) {
        const now = await getClass(item.session.id);
        const s = item.session;
        if (
          !now || now.status !== "scheduled" || now.date !== s.date || now.startMin !== s.startMin || now.endMin !== s.endMin || now.courtId !== s.courtId ||
          (now.coachId ?? null) !== (s.coachId ?? null)
        )
          throw new Refused(refuse("CLSA_MOVE_CHANGED"));
        if (instantOf(now.date, now.startMin, zone).getTime() <= Date.now()) throw new Refused(refuse("CLASS_STARTED"));
        const attended = await db.prepare("SELECT 1 AS x FROM check_ins ci JOIN bookings b ON b.id = ci.booking_id WHERE b.class_id = ? AND b.status = 'confirmed' AND (ci.source = 'desk' OR ci.confirmed_at IS NOT NULL) LIMIT 1").get(s.id);
        if (attended) throw new Refused(refuse("CLSA_MOVE_ATTENDANCE", { date: s.date }));
        const rostered = await classRosterRefusal(s, item.to);
        if (rostered) throw new Refused(rostered);
      }
      // The old times let go, all of them first (a weekly series moved by a week lands on its own old times), then each new time held,
      // courts before coaches (the order every claim locks in). A time taken, and the whole transaction is undone: the old times stay.
      for (const id of ids) {
        await unclaim({ kind: "class", classId: id });
        await db.prepare("DELETE FROM coach_claims WHERE class_id = ?").run(id);
      }
      const ordered = [...planned.items].sort((a, b) => a.to.date.localeCompare(b.to.date) || a.to.startMin - b.to.startMin);
      for (const item of ordered) {
        // The hours and closures at the new time, asked again here, in this transaction, from the court as it is now (ADR 0069, B14): the
        // check made when the move was planned is older than this transaction, so a day closed or hours narrowed since either is seen
        // here, or sees this move when it reads what is held (serializable: never neither).
        const day = await courtDay((await getCourt(item.court.id)) ?? item.court, item.to.date);
        if (await getVenueClosure(item.court.venueId, item.to.date)) throw new Refused(refuse("VENUE_CLOSED"));
        if (item.to.startMin < day.openMin || item.to.endMin > day.closeMin) throw new Refused(refuse("CLSA_MOVE_HOURS", { date: item.to.date }));
        const span = { start: item.to.startMin, end: item.to.endMin };
        try {
          await withTransaction(() =>
            claim({
              court: item.court,
              source: { kind: "class", classId: item.session.id },
              date: item.to.date,
              span,
              zone: day.zone,
              places: item.court.capacity,
              ...claimBuffers(day.policy),
            })
          );
        } catch (err) {
          if (!isConflict(err)) throw err;
          const held = (await occupantsOn([item.court], item.to.date, day.zone)).get(item.court.id) ?? [];
          const inWay = inTheWayOf(held, item.court.capacity, span, policyBuffers(day.policy));
          throw new Refused(refuse(inWay.some((o) => o.kind === "class") ? "CLSA_MOVE_CLASS" : "CLSA_MOVE_BOOKED", { court: item.court.name, date: item.to.date }));
        }
      }
      // Who supervises each session at its new time is recorded afresh (lib/rosters.ts), as a booking's move does.
      for (const item of ordered)
        await recordSupervisors({ session: { kind: "class", id: item.session.id }, venueId: item.court.venueId, courtId: item.to.courtId, sport: item.court.sport, date: item.to.date, span: { start: item.to.startMin, end: item.to.endMin }, zone });
      for (const item of ordered)
        if (item.session.coachId)
          await holdCoach(item.session.id, item.session.coachId, { date: item.to.date, startMin: item.to.startMin, endMin: item.to.endMin }, zone);

      // The class, and each place held in it, at the new date, time and court (an enrolment moves as a booking does: court, date, minutes, moments).
      for (const item of planned.items) {
        await db.prepare("UPDATE classes SET court_id = ?, date = ?, start_min = ?, end_min = ? WHERE id = ?").run(item.to.courtId, item.to.date, item.to.startMin, item.to.endMin, item.session.id);
        await db
          .prepare("UPDATE bookings SET court_id = ?, date = ?, start_min = ?, end_min = ?, starts_at = ?, ends_at = ? WHERE class_id = ? AND status = 'confirmed'")
          .run(
            item.to.courtId, item.to.date, item.to.startMin, item.to.endMin,
            instantOf(item.to.date, item.to.startMin, zone).toISOString(), instantOf(item.to.date, item.to.endMin, zone).toISOString(),
            item.session.id
          );
      }
      const moved: MovedClass[] = [];
      for (const item of planned.items) moved.push({ before: item.session, after: (await getClass(item.session.id))! });

      const move = (await db
        .prepare("INSERT INTO class_moves (venue_id, scope, moved_by_admin_id, moved_by_name, sessions) VALUES (?, ?, ?, ?, ?) RETURNING id")
        .get(planned.chosen.venueId, planned.scope, admin.id, admin.name, moved.length)) as { id: number };
      for (const m of moved)
        await db
          .prepare(
            `INSERT INTO class_move_sessions (move_id, class_id, from_court_id, from_date, from_start_min, from_end_min, to_court_id, to_date, to_start_min, to_end_min)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(move.id, m.after.id, m.before.courtId, m.before.date, m.before.startMin, m.before.endMin, m.after.courtId, m.after.date, m.after.startMin, m.after.endMin);

      if (hooks?.applied) await hooks.applied(move.id, moved);

      // Each person holding a place: one link, for all their places in this move, to cancel for everything back until the window ends.
      const recipients = await classMoveRecipients(moved);
      const links = new Map<string, ClassMoveLink>();
      for (const r of recipients) {
        if (r.kind !== "enrolled") continue;
        const token = randomBytes(24).toString("base64url");
        let earliest: Date | null = null;
        for (const b of r.bookings) {
          const before = moved.find((m) => m.after.id === b.classId)!.before;
          const until = refundUntil(before, zone, days);
          if (!earliest || until < earliest) earliest = until;
          await db
            .prepare("INSERT INTO class_move_offers (move_id, booking_id, token, valid_until) VALUES (?, ?, ?, ?) ON CONFLICT (move_id, booking_id) DO NOTHING")
            .run(move.id, b.id, token, until.toISOString());
        }
        if (earliest) links.set(r.key, { token, until: earliest });
      }
      return { moveId: move.id, moved, recipients, links };
    });
  } catch (err) {
    if (err instanceof Refused) return err.refusal;
    if (err instanceof CoachHeld) return err.refusal;
    // Ran out of tries against others (lib/db.ts): nothing was kept, safe to ask again.
    if (isBusy(err)) return refuse("BUSY");
    throw err;
  }

  // The time each session left may be wanted by somebody waiting for it.
  for (const m of outcome.moved) await offerSlotPlace(m.before.courtId, m.before.date);
  const told = await sendClassMoveNotices(outcome.moveId, outcome.recipients, outcome.links);
  await notifyCoachesOfMove(outcome.moveId, outcome.moved);
  return { ok: true, moveId: outcome.moveId, scope: planned.scope, moved: outcome.moved, skipped: planned.skipped, told };
}

/**
 * A coach teaching moved sessions is told once, by email in their own language, where the venue has their address
 * (`coach_lesson` messages, as a lesson moved is told): the first session from where it was to where it is, and how many moved.
 */
async function notifyCoachesOfMove(moveId: number, moved: MovedClass[]): Promise<number> {
  let queued = 0;
  for (const coachId of new Set(moved.flatMap((m) => (m.after.coachId ? [m.after.coachId] : [])))) {
    const mine = moved.filter((m) => m.after.coachId === coachId).sort((a, b) => a.after.date.localeCompare(b.after.date) || a.after.startMin - b.after.startMin);
    const coach = await coachById(coachId);
    const row = (await getDb().prepare("SELECT email, locale FROM coaches WHERE id = ?").get(coachId)) as { email: string | null; locale: string | null } | undefined;
    if (!coach || !row?.email) continue;
    const locale = coachLocale(row.locale);
    const { before, after } = mine[0];
    const venue = (await getDb().prepare("SELECT name FROM venues WHERE id = ?").get(after.venueId)) as { name: string } | undefined;
    await enqueue({
      venueId: after.venueId,
      bookingId: null,
      kind: "coach_lesson",
      channel: "email",
      recipient: row.email,
      locale,
      subject: "clsa.msg.coachMovedSubject",
      body: "clsa.msg.coachMoved",
      dedupeKey: `classmove-coach:${moveId}:${coachId}`,
      vars: {
        name: coach.name.split(/\s+/)[0],
        class: after.name,
        n: String(mine.length),
        venue: venue?.name ?? "",
        was: `${before.date}, ${clockRange(before.startMin, before.endMin, locale)}, ${before.courtName}`,
        date: after.date,
        time: clockRange(after.startMin, after.endMin, locale),
        court: after.courtName,
      },
    });
    queued++;
  }
  return queued;
}

/** The move in words, for the staff activity log: what it was and what it is, for the first session and how many moved. */
export function classMoveDetail(result: Extract<ClassMoveResult, { ok: true }>): string {
  const first = result.moved[0];
  if (!first) return "";
  const at = (c: ClassSession) => `${c.date} ${formatMinute(c.startMin)}–${formatMinute(c.endMin)} ${c.courtName}`;
  const many = result.moved.length > 1 ? `, ${result.moved.length} sessions (${result.scope === "term" ? "the whole term" : "from this one"})` : "";
  return `${first.after.name}${many}: ${at(first.before)} → ${at(first.after)}; ${result.told} told`;
}

// ---------------------------------------------------------------- the customer's link

/** One place moved, as its customer sees it at the link. */
export interface MovedPlace {
  bookingId: number;
  className: string;
  venueName: string;
  /** The venue's time zone, for the time the window ends. */
  zone: string;
  /** Where it is now, and (as the move left it) where it was. */
  now: { date: string; startMin: number; endMin: number; courtName: string };
  was: { date: string; startMin: number; endMin: number; courtName: string };
  validUntil: string;
  state: "open" | "cancelled" | "closed";
}

interface OfferRow {
  id: number;
  move_id: number;
  booking_id: number;
  valid_until: Date | string;
  cancelled_at: Date | string | null;
}

/** The places a link covers, with whether each can still be cancelled for everything back; null for a token nobody holds. */
export async function movedPlaces(token: string): Promise<MovedPlace[] | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const rows = (await getDb()
    .prepare(
      `SELECT o.id, o.move_id, o.booking_id, o.valid_until, o.cancelled_at, b.status, b.class_id, cl.name AS class_name, v.name AS venue_name, v.id AS venue_id,
              cs.from_date, cs.from_start_min, cs.from_end_min, cs.to_date, cs.to_start_min, cs.to_end_min,
              fc.name AS from_court, tc.name AS to_court
         FROM class_move_offers o
         JOIN bookings b ON b.id = o.booking_id
         JOIN classes cl ON cl.id = b.class_id
         JOIN courts c ON c.id = cl.court_id JOIN venues v ON v.id = c.venue_id
         JOIN class_move_sessions cs ON cs.move_id = o.move_id AND cs.class_id = b.class_id
         JOIN courts fc ON fc.id = cs.from_court_id JOIN courts tc ON tc.id = cs.to_court_id
        WHERE o.token = ? ORDER BY cs.to_date, cs.to_start_min, o.id`
    )
    .all(token)) as (OfferRow & {
    status: string; class_name: string; venue_name: string; venue_id: number;
    from_date: string; from_start_min: number; from_end_min: number; to_date: string; to_start_min: number; to_end_min: number; from_court: string; to_court: string;
  })[];
  if (rows.length === 0) return null;
  const now = Date.now();
  const zones = new Map<number, string>();
  for (const r of rows) if (!zones.has(r.venue_id)) zones.set(r.venue_id, (await venueHours(r.venue_id)).zone);
  return rows.map((r) => ({
    bookingId: r.booking_id,
    className: r.class_name,
    venueName: r.venue_name,
    zone: zones.get(r.venue_id)!,
    now: { date: r.to_date, startMin: r.to_start_min, endMin: r.to_end_min, courtName: r.to_court },
    was: { date: r.from_date, startMin: r.from_start_min, endMin: r.from_end_min, courtName: r.from_court },
    validUntil: new Date(r.valid_until).toISOString(),
    state: r.cancelled_at !== null || r.status === "cancelled" ? "cancelled" : new Date(r.valid_until).getTime() > now ? "open" : "closed",
  }));
}

export type CancelMovedResult = { ok: true; refunds: CancelRefund[] } | Refusal;

/**
 * The customer's tap: this place cancelled with everything back (its money, credit or pass entry), within the window the move
 * gave them. It is the venue's own cancellation of an enrolment, the one a class called off makes (`venueCancel`, then what is
 * owed back online through the venue's policy), and happens once: a second tap finds it cancelled. After the window the link
 * refuses, and the usual cancellation terms apply from the booking.
 */
export async function cancelMovedPlace(token: string, bookingId: number): Promise<CancelMovedResult> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token) || !Number.isInteger(bookingId)) return refuse("CLSA_LINK");
  const db = getDb();
  const offer = (await db
    .prepare("SELECT id, move_id, booking_id, valid_until, cancelled_at FROM class_move_offers WHERE token = ? AND booking_id = ?")
    .get(token, bookingId)) as OfferRow | undefined;
  if (!offer) return refuse("CLSA_LINK");
  const booking = await getBookingById(bookingId);
  if (!booking) return refuse("CLSA_LINK");
  if (offer.cancelled_at !== null || booking.status === "cancelled") return refuse("ALREADY_CANCELLED");
  if (new Date(offer.valid_until).getTime() <= Date.now()) return refuse("CLSA_WINDOW");
  const done = await venueCancel(booking.code, "class");
  if (!done.ok) return done;
  await db.prepare("UPDATE class_move_offers SET cancelled_at = now() WHERE id = ? AND cancelled_at IS NULL").run(offer.id);
  // What was paid online goes back through the gateway as for any booking the venue cancels; the customer is told how (and the venue, if it asked to hear).
  const refunds = [...(await refundCancelled([booking.id], { byVenue: true })), ...(await (await import("./counter-refunds")).counterRefundLines([booking.id]))];
  const locale = ((await db.prepare("SELECT locale FROM bookings WHERE id = ?").get(booking.id)) as { locale: string | null } | undefined)?.locale;
  await notifyBookingCancelled({ ...booking, status: "cancelled" }, locale === "ms" || locale === "zh" || locale === "ta" ? locale : "en", { refunds });
  const venueId = (await getCourt(booking.courtId))?.venueId ?? null;
  await logCancelledBookings({ id: null, name: "Customer, at the class-move link" }, venueId ?? 0, [booking], "cancelled by the customer after the venue moved the class; everything back");
  return { ok: true, refunds };
}
