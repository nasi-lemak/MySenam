import { isConflict } from "./claims";
import { getDb, withTransaction } from "./db";
import { formatMinute, minuteOfDay } from "./interval";
import { accountLocale, baseUrl, enqueue, sentences, type Written } from "./outbox";
import { translator, type Locale, type Phrase } from "./i18n";
import { matchLabel, roundsByBracket, type BracketKind } from "./brackets";
import { siteName } from "./site";
import { linkIn } from "./link-locale";
import { whatsappFor } from "./whatsapp-credit";
import { addDays, todayISO } from "./time";
import { noteResultBy } from "./match-reports";
import {
  GUARDIAN_AGE,
  ageOn,
  matchName,
  matchNamePhrase,
  placeMatch,
  previewTakeOut,
  recordResult,
  releaseUnneeded,
  takeOut,
  tellEntry,
  tournamentById,
  tournamentDetail,
  tournamentZone,
  type Entry,
  type Match,
  type Result,
  type Tournament,
  type TournamentDetail,
} from "./tournaments";
import type { StaffText } from "./staff-text";

/**
 * Tournament day: the next match announced, a court called when it is free.
 *
 * Nothing here is a second scheduler, a second claim or a second way to
 * score. A fixture keeps the court and time the draw gave it (or a manager
 * moved it to), which the tournament already holds through its blocks, so the
 * database refuses any booking over it (lib/claims.ts). *Calling* a fixture
 * says its players are wanted at its court now: where its held slot already
 * covers this minute that is all it does; otherwise (a court freed early, a
 * match brought forward) the fixture is put on the court from the next minute
 * with the checks and the hold of any move (`placeMatch`, which `moveMatch`
 * uses too), so a booking is never moved and the same court is never given
 * to two matches. A result goes in only through `recordResult`, a forfeit
 * included, so the rules for walkovers, withdrawals and corrections
 * (ADR 0012) are the ones that apply.
 *
 * Who is told, and when, is what the rows of `tournament_notices` record:
 * each side of a fixture hears once that it is next on its court, and once
 * per call that it is called, by email always and on WhatsApp where the venue
 * has chosen it and the account has a number it proved; never to somebody who
 * left, in the language of their account, to the account that holds the entry
 * (a guardian's, for a participant) and nobody where there is no account.
 */

/** A fixture is announced as next once it starts within this many minutes (or is already late). */
export const ANNOUNCE_AHEAD_MIN = 60;

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

/** Thrown inside a transaction to undo it and say why. */
class DayRefused extends Error {
  readonly code: string | undefined;
  readonly vars: Record<string, string | number> | undefined;
  constructor(message: string, code?: string, vars?: Record<string, string | number>) {
    super(message);
    this.code = code;
    this.vars = vars;
  }
}

function refusal(err: unknown): { ok: false; error: string; code?: string; vars?: Record<string, string | number> } | null {
  // A booking or a block that took the minutes between reading and holding them: the database refused the overlap. It was raised inside
  // this change's own transaction, which cannot go on after it, so it is the change that is refused, undone whole (B70).
  if (isConflict(err)) return { ok: false, error: "A booking or a block took that time just now: choose another court or time.", code: "TD_COURT_TAKEN" };
  return err instanceof DayRefused ? { ok: false, error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.vars ? { vars: err.vars } : {}) } : null;
}

// ------------------------------------------------------------ what the day looks like

interface CallState {
  calledAt: string | null;
  dueAt: string | null;
  calledBy: string | null;
  startedAt: string | null;
  callCount: number;
  decidedAt: string | null;
}

interface Context {
  t: Tournament;
  d: TournamentDetail;
  zone: string;
  now: Date;
  today: string;
  nowMin: number;
  state: Map<number, CallState>;
  entries: Map<number, TournamentDetail["entries"][number]>;
  /** Entries' partners' declared dates of birth: a pair with a minor in it is shown short. */
  partnerBirth: Map<number, string | null>;
  /** How many rounds each bracket has, to name a round from the end of its own bracket. */
  rounds: Map<BracketKind, number>;
}

async function context(tournamentId: number, now: Date = new Date()): Promise<Context | null> {
  const t = await tournamentById(tournamentId);
  if (!t) return null;
  const d = (await tournamentDetail(tournamentId, { forStaff: true }))!;
  const zone = await tournamentZone(tournamentId);
  const today = todayISO(zone);
  const db = getDb();
  const rows = (await db
    .prepare("SELECT id, called_at, call_due_at, called_by, started_at, call_count, decided_at FROM tournament_matches WHERE tournament_id = ?")
    .all(tournamentId)) as { id: number; called_at: unknown; call_due_at: unknown; called_by: string | null; started_at: unknown; call_count: number; decided_at: unknown }[];
  const state = new Map(
    rows.map((r) => [r.id, { calledAt: iso(r.called_at), dueAt: iso(r.call_due_at), calledBy: r.called_by, startedAt: iso(r.started_at), callCount: r.call_count, decidedAt: iso(r.decided_at) }])
  );
  const partners = (await db.prepare("SELECT id, partner_birth_date FROM tournament_entries WHERE tournament_id = ?").all(tournamentId)) as { id: number; partner_birth_date: string | null }[];
  return {
    t,
    d,
    zone,
    now,
    today,
    nowMin: minuteOfDay(now, today, zone),
    state,
    entries: new Map(d.entries.map((e) => [e.id, e])),
    partnerBirth: new Map(partners.map((p) => [p.id, p.partner_birth_date])),
    // Each bracket's rounds (a knockout's, a double elimination's); -1 for a Swiss event, whose group-stage matches are its rounds (matchLabel).
    rounds: d.format === "swiss" ? new Map<BracketKind, number>([["main", -1]]) : roundsByBracket(d.matches.filter((m) => m.stage === "knockout")),
  };
}

/** Their first name and the initial of the next word: "Aina L.", for each of a pair. */
export function shortName(name: string): string {
  return name
    .split(" / ")
    .map((part) => {
      const words = part.trim().split(/\s+/).filter(Boolean);
      return words.length < 2 ? (words[0] ?? "") : `${words[0]} ${[...words[1]][0].toUpperCase()}.`;
    })
    .join(" / ");
}

/**
 * Whether the entry is, as declared, a minor: a guardian's agreement, a
 * participant a guardian manages, or a date of birth under 18 on the first
 * day (the entrant's word, never verified). A team is shown by its name.
 */
function declaredMinor(c: Context, e: Entry): boolean {
  if (c.t.entryKind === "team") return false;
  if (e.guardian || e.participantId) return true;
  const young = (born: string | null | undefined) => !!born && ageOn(born, c.t.startsOn) < GUARDIAN_AGE;
  return young(e.declaredBirthDate) || young(c.partnerBirth.get(e.id));
}

/** A name as another family or the public sees it: short for a declared minor, and for everybody where the tournament says so. */
function shownName(c: Context, entryId: number | null, everybodyShort = c.t.liveNames === "short"): string | null {
  if (entryId === null) return null;
  const e = c.entries.get(entryId);
  if (!e) return null;
  if (c.t.entryKind === "team") return e.name;
  return everybodyShort || declaredMinor(c, e) ? shortName(e.name) : e.name;
}

export type Blocker = { code: "notHere" | "resting" | "busy" | "left"; entryId: number; name: string; until?: string };

/** Why a fixture cannot be called yet; empty: ready. */
function blockersFor(c: Context, m: Match): Blocker[] {
  const out: Blocker[] = [];
  for (const id of [m.a, m.b]) {
    if (id === null) continue;
    const e = c.entries.get(id);
    if (!e) continue;
    if (e.status !== "entered" || e.out) {
      out.push({ code: "left", entryId: id, name: e.name });
      continue;
    }
    if (!e.checkedIn) out.push({ code: "notHere", entryId: id, name: e.name });
    if (c.d.matches.some((x) => x.id !== m.id && x.status === "scheduled" && (x.a === id || x.b === id) && c.state.get(x.id)?.calledAt))
      out.push({ code: "busy", entryId: id, name: e.name });
    if (c.t.minRestMinutes > 0) {
      const last = c.d.matches
        .filter((x) => (x.status === "done" || x.status === "retired") && (x.a === id || x.b === id))
        .map((x) => c.state.get(x.id)?.decidedAt)
        .filter((x): x is string => !!x)
        .sort()
        .at(-1);
      if (last) {
        const until = new Date(new Date(last).getTime() + c.t.minRestMinutes * 60_000);
        if (until.getTime() > c.now.getTime()) out.push({ code: "resting", entryId: id, name: e.name, until: until.toISOString() });
      }
    }
  }
  return out;
}

const isPair = (m: Match): boolean => (m.stage === "group" || m.stage === "knockout") && m.status === "scheduled" && m.a !== null && m.b !== null;

/** The sentence a blocker is refused with (English; the staff patterns in lib/staff-i18n/refusals-2.ts say it in Malay and Chinese). */
function blockerSentence(c: Context, b: Blocker): { text: string; code: string; vars: Record<string, string | number> } {
  switch (b.code) {
    case "notHere":
      return { text: `${b.name} has not been checked in yet: check them in first.`, code: "TD_NOT_HERE", vars: { name: b.name } };
    case "resting": {
      const until = formatMinute(minuteOfDay(new Date(b.until!), c.today, c.zone));
      return { text: `${b.name} is resting until ${until}.`, code: "TD_RESTING", vars: { name: b.name, until } };
    }
    case "busy":
      return { text: `${b.name} is on court in another match.`, code: "TD_BUSY", vars: { name: b.name } };
    default:
      return { text: `${b.name} has left the tournament.`, code: "TD_LEFT", vars: { name: b.name } };
  }
}

export interface DayFixture {
  id: number;
  /** "Semi-final 2", in English, and as a phrase for the staff language. */
  label: string;
  labelPhrase: StaffText;
  a: { id: number | null; name: string | null };
  b: { id: number | null; name: string | null };
  courtId: number | null;
  courtName: string | null;
  date: string | null;
  minute: number | null;
  minutes: number;
  state: "waiting" | "called" | "playing";
  /** Waiting only: ready to be called, or what stops it. */
  ready: boolean;
  blockers: Blocker[];
  calledAt: string | null;
  calledBy: string | null;
  /** Called, not started: when the wait ends, whether it has, and the minutes left (0 once over). */
  dueAt: string | null;
  overdue: boolean;
  minutesLeft: number;
}

export interface DayBoard {
  tournamentId: number;
  name: string;
  status: Tournament["status"];
  /** Today where the venue is, and its time of day now in minutes. */
  today: string;
  nowMin: number;
  now: string;
  settings: { minRestMinutes: number; callWaitMinutes: number; announceNext: boolean; liveNames: "full" | "short" };
  courts: { id: number; name: string; now: DayFixture | null; next: DayFixture | null; free: boolean; proposal: number | null }[];
  /** Fixtures between two known sides not yet called, in the order to call them. */
  waiting: DayFixture[];
  /** The last results, newest first. */
  recent: { id: number; label: string; labelPhrase: StaffText; a: string | null; b: string | null; winner: string | null; score: string | null; status: Match["status"] }[];
}

function fixtureOf(c: Context, m: Match): DayFixture {
  const s = c.state.get(m.id)!;
  const blockers = s.calledAt ? [] : blockersFor(c, m);
  const dueMs = s.dueAt ? new Date(s.dueAt).getTime() : null;
  return {
    id: m.id,
    label: matchName(c.d, m),
    labelPhrase: matchNamePhrase(c.d, m),
    a: { id: m.a, name: m.a === null ? null : (c.entries.get(m.a)?.name ?? null) },
    b: { id: m.b, name: m.b === null ? null : (c.entries.get(m.b)?.name ?? null) },
    courtId: m.courtId,
    courtName: m.courtName,
    date: m.date,
    minute: m.minute,
    minutes: m.minutes,
    state: s.startedAt ? "playing" : s.calledAt ? "called" : "waiting",
    ready: !s.calledAt && blockers.length === 0,
    blockers,
    calledAt: s.calledAt,
    calledBy: s.calledBy,
    dueAt: s.startedAt ? null : s.dueAt,
    overdue: !s.startedAt && dueMs !== null && dueMs <= c.now.getTime(),
    minutesLeft: !s.startedAt && dueMs !== null ? Math.max(0, Math.ceil((dueMs - c.now.getTime()) / 60_000)) : 0,
  };
}

const bySchedule = (a: Match, b: Match) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || (a.minute ?? 0) - (b.minute ?? 0) || a.id - b.id;

/** Ready fixtures for a court, in the order to propose them: those already on it first, then the rest by their time. */
function proposals(c: Context, courtId: number, except?: number): Match[] {
  const ready = c.d.matches.filter((m) => m.id !== except && isPair(m) && !c.state.get(m.id)?.calledAt && blockersFor(c, m).length === 0).sort(bySchedule);
  return [...ready.filter((m) => m.courtId === courtId), ...ready.filter((m) => m.courtId !== courtId)];
}

async function courtNames(c: Context): Promise<{ id: number; name: string }[]> {
  if (c.t.courtIds.length === 0) return [];
  return (await getDb()
    .prepare(`SELECT id, name FROM courts WHERE id IN (${c.t.courtIds.map(() => "?").join(",")}) ORDER BY id`)
    .all(...c.t.courtIds)) as { id: number; name: string }[];
}

/** The organiser's *Now and next* board: what is on each court, what is next, who is waiting. */
export async function dayBoard(tournamentId: number, now: Date = new Date()): Promise<DayBoard | null> {
  const c = await context(tournamentId, now);
  if (!c) return null;
  return boardOf(c);
}

async function boardOf(c: Context): Promise<DayBoard> {
  const live = c.d.matches.filter(isPair);
  const courts = (await courtNames(c)).map((court) => {
    const here = live.filter((m) => m.courtId === court.id);
    const onNow = here.find((m) => c.state.get(m.id)?.calledAt);
    const queue = here.filter((m) => !c.state.get(m.id)?.calledAt).sort(bySchedule);
    const free = !onNow;
    const propose = free ? proposals(c, court.id)[0] : undefined;
    return {
      id: court.id,
      name: court.name,
      now: onNow ? fixtureOf(c, onNow) : null,
      next: queue[0] ? fixtureOf(c, queue[0]) : null,
      free,
      proposal: propose?.id ?? null,
    };
  });
  const waiting = live
    .filter((m) => !c.state.get(m.id)?.calledAt)
    .sort(bySchedule)
    .map((m) => fixtureOf(c, m));
  const recent = c.d.matches
    .filter((m) => (m.stage === "group" || m.stage === "knockout") && (m.status === "done" || m.status === "retired" || m.status === "walkover"))
    .sort((x, y) => (c.state.get(y.id)?.decidedAt ?? "").localeCompare(c.state.get(x.id)?.decidedAt ?? "") || y.id - x.id)
    .slice(0, 8)
    .map((m) => ({
      id: m.id,
      label: matchName(c.d, m),
      labelPhrase: matchNamePhrase(c.d, m),
      a: m.a === null ? null : (c.entries.get(m.a)?.name ?? null),
      b: m.b === null ? null : (c.entries.get(m.b)?.name ?? null),
      winner: m.winner === null ? null : (c.entries.get(m.winner)?.name ?? null),
      score: m.score,
      status: m.status,
    }));
  return {
    tournamentId: c.t.id,
    name: c.t.name,
    status: c.t.status,
    today: c.today,
    nowMin: c.nowMin,
    now: c.now.toISOString(),
    settings: { minRestMinutes: c.t.minRestMinutes, callWaitMinutes: c.t.callWaitMinutes, announceNext: c.t.announceNext, liveNames: c.t.liveNames },
    courts,
    waiting,
    recent,
  };
}

// ------------------------------------------------------------ the day's settings

export interface DaySettings {
  minRestMinutes?: unknown;
  callWaitMinutes?: unknown;
  announceNext?: unknown;
  liveNames?: unknown;
}

/** A manager's settings for the day: rest between a player's matches, the wait for a called fixture, whether entrants are told, how names show on the live page. Any time before it is over. */
export async function setDaySettings(tournamentId: number, input: DaySettings): Promise<Result<DayBoard>> {
  const t = await tournamentById(tournamentId);
  if (!t) return { ok: false, error: "Tournament not found." };
  if (t.status === "finished" || t.status === "cancelled") return { ok: false, error: "That tournament is over." };
  const int = (v: unknown, min: number, max: number): number | null | undefined =>
    v === undefined ? undefined : typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
  const rest = int(input.minRestMinutes, 0, 240);
  const wait = int(input.callWaitMinutes, 1, 60);
  if (rest === null) return { ok: false, error: "Rest is 0 to 240 minutes." };
  if (wait === null) return { ok: false, error: "A called match waits 1 to 60 minutes." };
  if (input.announceNext !== undefined && typeof input.announceNext !== "boolean") return { ok: false, error: "Say whether entrants are told." };
  if (input.liveNames !== undefined && input.liveNames !== "full" && input.liveNames !== "short") return { ok: false, error: "Names on the live page are full or short." };
  await getDb()
    .prepare(
      `UPDATE tournaments SET min_rest_minutes = COALESCE(?, min_rest_minutes), call_wait_minutes = COALESCE(?, call_wait_minutes),
              announce_next = COALESCE(?, announce_next), live_names = COALESCE(?, live_names) WHERE id = ?`
    )
    .run(rest ?? null, wait ?? null, (input.announceNext as boolean | undefined) ?? null, (input.liveNames as string | undefined) ?? null, tournamentId);
  return { ok: true, value: (await dayBoard(tournamentId))! };
}

// ------------------------------------------------------------ telling people

/** "Group 2", "Final", "Semi-final", "Losers' round 2", "Grand final" in a language, as the public page says them. */
function labelIn(tr: ReturnType<typeof translator>, m: Pick<Match, "stage" | "groupNo" | "round" | "placement" | "bracket">, rounds: Map<BracketKind, number>): string {
  const label = matchLabel(m, rounds.get(m.bracket) ?? m.round);
  return tr(label.key as Phrase, label.n === undefined ? undefined : { n: label.n });
}

/**
 * One notice to one side of a fixture: an email, and a WhatsApp message where
 * the venue has WhatsApp for it and the account has a number it proved. Not
 * to somebody who left, nor where no account holds the entry. Written in the
 * account's language; for a participant, opening with whose it is.
 */
async function tellSide(c: Context, m: Match, entryId: number, kind: "next" | "called", seq: number): Promise<boolean> {
  const e = c.entries.get(entryId);
  if (!e || e.status !== "entered" || e.out) return false;
  const db = getDb();
  const holder = (await db
    .prepare(
      `SELECT e.user_id, e.participant_id, p.display_name, u.verified_phone FROM tournament_entries e
         LEFT JOIN participants p ON p.id = e.participant_id LEFT JOIN users u ON u.id = e.user_id WHERE e.id = ?`
    )
    .get(entryId)) as { user_id: number | null; participant_id: number | null; display_name: string | null; verified_phone: string | null } | undefined;
  if (!holder?.user_id) return false;
  const forName = holder.participant_id !== null ? holder.display_name : null;
  const opponentId = m.a === entryId ? m.b : m.a;
  const opponent = shownName(c, opponentId, false);
  const line: Written = (tr) =>
    sentences(
      tr,
      forName && tr("lg5.mail.entryFor", { name: forName }),
      tr(kind === "next" ? "dy1.line.next" : "dy1.line.called", {
        match: labelIn(tr, m, c.rounds),
        opponent: opponent ?? tr("mail.tour.draw.tbd"),
        court: m.courtName ?? "",
        time: m.minute === null ? "" : formatMinute(m.minute, tr.locale),
        minutes: c.t.callWaitMinutes,
      })
    );
  const link = `${baseUrl()}/tournaments/${c.t.id}/live`;
  const locale: Locale = await accountLocale(holder.user_id);
  const tr = translator(locale, siteName());
  const user = (await db.prepare("SELECT name, email FROM users WHERE id = ?").get(holder.user_id)) as { name: string; email: string } | undefined;
  if (!user) return false;
  const key = `tnday:${kind}:${m.id}:${entryId}:${seq}`;
  const subject = tr(kind === "next" ? "dy1.mail.next.s" : "dy1.mail.called.s", { t: c.t.name });
  const text = `${tr("mail.hi", { name: user.name.split(/\s+/)[0] })}\n\n${line(tr)}\n\n${linkIn(link, locale)}\n\n${siteName()}`;
  await enqueue({
    venueId: c.t.venueId,
    kind: "tournament_day",
    channel: "email",
    recipient: user.email,
    locale,
    subject: "msg.programmeSubject",
    body: "msg.programmeBody",
    vars: { subject, text },
    dedupeKey: key,
  });
  const phone = holder.verified_phone?.trim();
  if (phone && (await whatsappFor(c.t.venueId, "tournament_day")))
    await enqueue({
      venueId: c.t.venueId,
      kind: "tournament_day",
      channel: "whatsapp",
      recipient: phone,
      locale,
      body: "dy1.msg.day",
      vars: { tournament: c.t.name, line: line(tr), link: linkIn(link, locale) },
      dedupeKey: `${key}:whatsapp`,
    });
  return true;
}

/** Tell a side once: the notice is claimed first, so two servers or a retry never tell it twice; given back if telling failed. */
async function tellOnce(c: Context, m: Match, entryId: number, kind: "next" | "called", seq: number): Promise<boolean> {
  const db = getDb();
  const claimed = (await db
    .prepare("INSERT INTO tournament_notices (tournament_id, match_id, entry_id, kind, seq) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id")
    .get(c.t.id, m.id, entryId, kind, seq)) as { id: number } | undefined;
  if (!claimed) return false;
  try {
    if (await tellSide(c, m, entryId, kind, seq)) return true;
    // Nobody to tell (somebody who left, an entry at the counter): nothing is kept, so nothing is claimed.
    await db.prepare("DELETE FROM tournament_notices WHERE id = ?").run(claimed.id);
    return false;
  } catch (err) {
    await db.prepare("DELETE FROM tournament_notices WHERE id = ?").run(claimed.id);
    throw err;
  }
}

/**
 * Tell the sides of each court's next fixture that it is next: today's, between
 * two known sides, starting within `ANNOUNCE_AHEAD_MIN` minutes or late already, not
 * yet called. Once per fixture and side, however often this runs (after each
 * result, and by the scheduler every minute). Returns how many were told.
 */
export async function announceNext(tournamentId: number, now: Date = new Date()): Promise<number> {
  const c = await context(tournamentId, now);
  if (!c || c.t.status !== "drawn" || !c.t.announceNext || c.t.format === "performance") return 0;
  let told = 0;
  const nextOnCourt = new Map<number, Match>();
  for (const m of c.d.matches.filter(isPair).sort(bySchedule))
    if (m.courtId !== null && m.date === c.today && m.minute !== null && !c.state.get(m.id)?.calledAt && !nextOnCourt.has(m.courtId)) nextOnCourt.set(m.courtId, m);
  for (const m of nextOnCourt.values()) {
    if (m.minute! > c.nowMin + ANNOUNCE_AHEAD_MIN) continue;
    for (const side of [m.a!, m.b!]) if (await tellOnce(c, m, side, "next", 0)) told++;
  }
  return told;
}

/** For the scheduler: announce for every tournament that may be on today. */
export async function announceAll(now: Date = new Date()): Promise<number> {
  const ids = (await getDb()
    // A day either side: the venue's own zone decides which is today (announceNext).
    .prepare("SELECT id FROM tournaments WHERE status = 'drawn' AND announce_next AND starts_on <= ? AND ends_on >= ?")
    .all(addDays(todayISO(), 1), addDays(todayISO(), -1))) as { id: number }[];
  let told = 0;
  for (const { id } of ids) told += await announceNext(id, now);
  return told;
}

// ------------------------------------------------------------ calling

export interface Actor {
  id: number | null;
  name: string;
  /** A manager may bring a fixture forward or send it to another court; an official calls it where it is held. */
  role: "manager" | "official";
}

type Board<T = unknown> = Result<{ board: DayBoard } & T>;

async function lockTournament(tournamentId: number): Promise<void> {
  await getDb().prepare("SELECT id FROM tournaments WHERE id = ? FOR UPDATE").get(tournamentId);
}

/** The match, the day's context, and the refusals that every action on a fixture shares. */
async function fixtureContext(matchId: number, now: Date): Promise<{ c: Context; m: Match }> {
  const row = (await getDb().prepare("SELECT tournament_id FROM tournament_matches WHERE id = ?").get(matchId)) as { tournament_id: number } | undefined;
  if (!row) throw new DayRefused("Match not found.");
  await lockTournament(row.tournament_id);
  const c = await context(row.tournament_id, now);
  if (!c) throw new DayRefused("Tournament not found.");
  if (c.t.status !== "drawn") throw new DayRefused("The day board is for a tournament once it is drawn, until it is over.", "TD_NOT_DRAWN");
  if (c.t.format === "performance") throw new DayRefused("Heats are not called one by one: this is for matches between two sides.", "TD_HEATS");
  const m = c.d.matches.find((x) => x.id === matchId)!;
  if (m.status !== "scheduled") throw new DayRefused("That match is decided, so it cannot be called.", "TD_DECIDED");
  if (m.a === null || m.b === null) throw new DayRefused("Both sides of that match are not known yet.", "TD_NO_SIDES");
  return { c, m };
}

async function markCalled(c: Context, m: Match, by: Actor): Promise<number> {
  const seq = (c.state.get(m.id)?.callCount ?? 0) + 1;
  const due = new Date(c.now.getTime() + c.t.callWaitMinutes * 60_000);
  await getDb()
    .prepare("UPDATE tournament_matches SET called_at = ?::timestamptz, call_due_at = ?::timestamptz, called_by = ?, started_at = NULL, call_count = ?, updated_at = datetime('now') WHERE id = ?")
    .run(c.now.toISOString(), due.toISOString(), by.role === "official" ? `official: ${by.name}` : by.name, seq, m.id);
  return seq;
}

/**
 * Call a fixture: its players are wanted at its court now. Both sides have to
 * be checked in, not on court in another match, and rested; the court must
 * have nothing else called on it. Where the fixture's held slot covers this
 * minute, that is all; otherwise a manager brings it to `courtId` (or its
 * own court) from the next minute, held like any move and refused where a
 * booking, a block or another match is in the way. Both sides are told.
 */
export async function callFixture(matchId: number, by: Actor, opts: { courtId?: number } = {}, now: Date = new Date()): Promise<Board<{ moved: string | null }>> {
  const out: { moved: string | null; sequence: number; tournamentId: number } = { moved: null, sequence: 0, tournamentId: 0 };
  try {
    await withTransaction(async () => {
      const { c, m } = await fixtureContext(matchId, now);
      const s = c.state.get(m.id)!;
      if (s.calledAt) throw new DayRefused("That match is already called.", "TD_CALLED");
      const blocked = blockersFor(c, m)[0];
      if (blocked) {
        const said = blockerSentence(c, blocked);
        throw new DayRefused(said.text, said.code, said.vars);
      }
      const court = opts.courtId ?? m.courtId;
      if (court === null) throw new DayRefused("That match has no court: choose one.", "TD_NO_COURT");
      const busy = c.d.matches.find((x) => x.id !== m.id && x.status === "scheduled" && x.courtId === court && c.state.get(x.id)?.calledAt);
      if (busy) {
        const name = c.d.matches.find((x) => x.id === busy.id)?.courtName ?? "That court";
        throw new DayRefused(`Another match is called on ${name}: it has to finish or be released first.`, "TD_COURT_BUSY", { court: name });
      }
      const covers = court === m.courtId && m.date === c.today && m.minute !== null && m.minute <= c.nowMin && c.nowMin < m.minute + m.minutes;
      if (!covers) {
        if (by.role !== "manager") throw new DayRefused("A match can be called where it is held, once its time has come. Only a manager can bring it forward or send it to another court.", "TD_MANAGER_MOVE");
        const slot = { courtId: court, date: c.today, startMin: c.nowMin + 1 };
        const refused = await placeMatch(c.t, c.d, m, slot, m.minutes, new Set());
        if (refused) throw new DayRefused(refused);
        const where = (await getDb().prepare("SELECT name FROM courts WHERE id = ?").get(court)) as { name: string };
        out.moved = `${matchName(c.d, m)} brought to ${where.name} at ${formatMinute(slot.startMin)}${m.date !== null && m.minute !== null ? ` (was ${m.date} ${formatMinute(m.minute)}, ${m.courtName ?? ""})` : ""}.`;
      }
      out.sequence = await markCalled(c, m, by);
      out.tournamentId = c.t.id;
    });
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
  if (out.moved) await releaseUnneeded(out.tournamentId);
  await announceCalled(out.tournamentId, matchId, out.sequence, now);
  return { ok: true, value: { board: (await dayBoard(out.tournamentId, now))!, moved: out.moved } };
}

/** The called notice, from the fixture as it now stands (a fixture brought forward says its new court). */
async function announceCalled(tournamentId: number, matchId: number, seq: number, now: Date): Promise<void> {
  const fresh = await context(tournamentId, now);
  const m = fresh?.d.matches.find((x) => x.id === matchId);
  if (!fresh || !m || !fresh.t.announceNext) return;
  for (const side of [m.a, m.b]) if (side !== null) await tellOnce(fresh, m, side, "called", seq);
}

/** Mark a called fixture as started: its players are on court, so the wait ends. */
export async function startFixture(matchId: number, _by: Actor, now: Date = new Date()): Promise<Board> {
  try {
    const tournamentId = await withTransaction(async () => {
      const { c, m } = await fixtureContext(matchId, now);
      const s = c.state.get(m.id)!;
      if (!s.calledAt) throw new DayRefused("That match is not called.", "TD_NOT_CALLED");
      if (s.startedAt) throw new DayRefused("That match has started.", "TD_STARTED");
      await getDb().prepare("UPDATE tournament_matches SET started_at = ?::timestamptz, updated_at = datetime('now') WHERE id = ?").run(now.toISOString(), m.id);
      return c.t.id;
    });
    return { ok: true, value: { board: (await dayBoard(tournamentId, now))! } };
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
}

/** Take a call back: the fixture goes back to waiting, held where it was. */
export async function releaseCall(matchId: number, _by: Actor, now: Date = new Date()): Promise<Board> {
  try {
    const tournamentId = await withTransaction(async () => {
      const { c, m } = await fixtureContext(matchId, now);
      if (!c.state.get(m.id)?.calledAt) throw new DayRefused("That match is not called.", "TD_NOT_CALLED");
      await getDb()
        .prepare("UPDATE tournament_matches SET called_at = NULL, call_due_at = NULL, started_at = NULL, called_by = NULL, updated_at = datetime('now') WHERE id = ?")
        .run(m.id);
      return c.t.id;
    });
    return { ok: true, value: { board: (await dayBoard(tournamentId, now))! } };
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
}

export type NoShowDecision =
  | { action: "wait" }
  /** `absent`: the side that did not come, which forfeits; `outOfEvent`: and is taken out as withdrawn, under the tournament's rules for somebody who leaves. */
  | { action: "forfeit"; absent: number; outOfEvent?: boolean; note?: string }
  | { action: "swap" };

/**
 * What the organiser decides for a called fixture nobody came to: wait
 * another interval; forfeit (a walkover to the side that came, recorded by
 * `recordResult` as any walkover is, and only once the wait is over); or swap
 * in the next ready fixture, which takes the court now while this one takes
 * its place (or follows it) and goes back to waiting, its sides told.
 */
export async function decideNoShow(matchId: number, decision: NoShowDecision, by: Actor, now: Date = new Date()): Promise<Board<{ detail?: string }>> {
  if (by.role !== "manager") return { ok: false, error: "Only a manager decides what happens when nobody comes.", code: "TD_MANAGER_ONLY" };
  if (decision.action === "forfeit") return forfeit(matchId, decision, now);
  const out: { calledY: { id: number; seq: number } | null; displaced: number | null; tournamentId: number; detail?: string } = { calledY: null, displaced: null, tournamentId: 0 };
  try {
    await withTransaction(async () => {
      const { c, m } = await fixtureContext(matchId, now);
      out.tournamentId = c.t.id;
      const s = c.state.get(m.id)!;
      if (!s.calledAt) throw new DayRefused("That match is not called.", "TD_NOT_CALLED");
      if (s.startedAt) throw new DayRefused("That match has started.", "TD_STARTED");
      if (decision.action === "wait") {
        const due = new Date(now.getTime() + c.t.callWaitMinutes * 60_000);
        await getDb().prepare("UPDATE tournament_matches SET call_due_at = ?::timestamptz, updated_at = datetime('now') WHERE id = ?").run(due.toISOString(), m.id);
        return;
      }
      // Swap: the next ready fixture takes this court from the next minute; this one takes its old place, or follows it.
      if (m.courtId === null) throw new DayRefused("That match has no court.");
      const candidates = proposals(c, m.courtId, m.id).filter((y) => blockersFor(c, y).length === 0);
      if (candidates.length === 0) throw new DayRefused("No other match is ready to be called: both sides checked in, rested, and not on court.", "TD_NONE_READY");
      let why: DayRefused | null = null;
      for (const y of candidates) {
        try {
          await withTransaction(async () => {
            // Y takes this fixture's slot (held already, begun or not); this one takes Y's, or follows Y on the court.
            const hereNow = m.date !== null && m.minute !== null ? { courtId: m.courtId!, date: m.date, startMin: m.minute } : { courtId: m.courtId!, date: c.today, startMin: c.nowMin + 1 };
            const refusedY = await placeMatch(c.t, c.d, y, hereNow, y.minutes, new Set([m.id]), true);
            if (refusedY) throw new DayRefused(refusedY);
            const options = [
              ...(y.courtId !== null && y.date !== null && y.minute !== null ? [{ courtId: y.courtId, date: y.date, startMin: y.minute }] : []),
              { courtId: m.courtId!, date: hereNow.date, startMin: hereNow.startMin + y.minutes },
            ];
            let refusedX: string | null = null;
            for (const slot of options) {
              refusedX = await placeMatch(c.t, c.d, m, slot, m.minutes, new Set([y.id]), true);
              if (!refusedX) break;
            }
            if (refusedX) throw new DayRefused(refusedX);
            await getDb()
              .prepare("UPDATE tournament_matches SET called_at = NULL, call_due_at = NULL, started_at = NULL, called_by = NULL, updated_at = datetime('now') WHERE id = ?")
              .run(m.id);
            out.calledY = { id: y.id, seq: await markCalled(c, y, by) };
          });
          out.detail = `${matchName(c.d, y)} takes the court; ${matchName(c.d, m)} waits.`;
          out.displaced = m.id;
          return;
        } catch (err) {
          if (!(err instanceof DayRefused)) throw err;
          why ??= err;
        }
      }
      throw why ? new DayRefused(why.message, why.code, why.vars) : new DayRefused("No other match could take the court.", "TD_NO_SWAP");
    });
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
  if (out.calledY && out.displaced !== null) {
    await releaseUnneeded(out.tournamentId);
    const c = (await context(out.tournamentId, now))!;
    const y = c.d.matches.find((x) => x.id === out.calledY!.id)!;
    await announceCalled(out.tournamentId, y.id, out.calledY.seq, now);
    // Its sides are told what happened to the match they were called to, as for any move.
    const x = c.d.matches.find((q) => q.id === out.displaced)!;
    for (const entryId of [x.a, x.b])
      if (entryId !== null)
        await tellEntry(
          entryId,
          c.t,
          (tr) => tr("mail.tour.moved.s", { t: c.t.name }),
          (tr) => tr("mail.tour.moved.b", { match: matchName(c.d, x), t: c.t.name, date: x.date!, time: formatMinute(x.minute!, tr.locale), court: x.courtName ?? "" })
        );
  }
  return { ok: true, value: { board: (await dayBoard(out.tournamentId, now))!, ...(out.detail ? { detail: out.detail } : {}) } };
}

async function forfeit(matchId: number, decision: Extract<NoShowDecision, { action: "forfeit" }>, now: Date): Promise<Board<{ detail?: string }>> {
  let got: { c: Context; m: Match };
  try {
    got = await withTransaction(async () => {
      const { c, m } = await fixtureContext(matchId, now);
      const s = c.state.get(m.id)!;
      if (!s.calledAt) throw new DayRefused("That match is not called.", "TD_NOT_CALLED");
      if (s.startedAt) throw new DayRefused("That match has started.", "TD_STARTED");
      if (decision.absent !== m.a && decision.absent !== m.b) throw new DayRefused("Say which of the two sides did not come.", "TD_WHO_ABSENT");
      const left = s.dueAt ? Math.ceil((new Date(s.dueAt).getTime() - now.getTime()) / 60_000) : 0;
      if (left > 0) throw new DayRefused(`The wait is not over yet: ${left} minute${left === 1 ? "" : "s"} left.`, "TD_WAIT", { n: left });
      return { c, m };
    });
  } catch (err) {
    const r = refusal(err);
    if (r) return r;
    throw err;
  }
  const { c, m } = got;
  const winner = decision.absent === m.a ? m.b! : m.a!;
  const absentName = c.entries.get(decision.absent)?.name ?? "";
  // The result is the ordinary one: a walkover, through the same checks, progression and corrections.
  const done = await recordResult(matchId, { winner, walkover: true });
  if (!done.ok) return done;
  await noteResultBy(matchId, "staff");
  let detail = `${absentName} did not come: walkover to ${c.entries.get(winner)?.name ?? ""}.`;
  if (decision.outOfEvent) {
    // And out of the event, as anybody who leaves is: the tournament's rules decide what their results and matches become.
    const preview = await previewTakeOut(decision.absent, "withdrawn");
    if (preview.ok) {
      const out = await takeOut(decision.absent, "withdrawn", decision.note?.trim() || "Did not come when called.", { token: preview.value.token });
      if (out.ok) detail += ` ${absentName} is out of the event.`;
      else detail += ` ${absentName} could not be taken out: ${out.error}`;
    }
  }
  return { ok: true, value: { board: (await dayBoard(c.t.id, now))!, detail } };
}

// ------------------------------------------------------------ officials

/** What an official may do on the day: call a fixture where it is held, mark it started, take the call back. */
export async function officialDay(
  token: string,
  action: "call" | "start" | "release",
  matchId: number,
  now: Date = new Date()
): Promise<Board<{ moved?: string | null; officialName: string; venueId: number; tournamentName: string }>> {
  const { officialByToken } = await import("./match-reports");
  const who = await officialByToken(token);
  if (!who) return { ok: false, error: "This link no longer works. Ask the venue for a new one." };
  const row = (await getDb().prepare("SELECT 1 FROM tournament_matches WHERE id = ? AND tournament_id = ?").get(matchId, who.tournamentId)) as unknown;
  if (!row) return { ok: false, error: "That match is not in this tournament." };
  // A climbing event's official enters counts only (lib/official-performances.ts): no calling, starting or releasing.
  if ((await tournamentById(who.tournamentId))?.format === "performance") return { ok: false, error: "This link is for a climbing event's counts only.", code: "OFC_PERF_ONLY" };
  const actor: Actor = { id: null, name: who.official.name, role: "official" };
  const done = action === "call" ? await callFixture(matchId, actor, {}, now) : action === "start" ? await startFixture(matchId, actor, now) : await releaseCall(matchId, actor, now);
  if (!done.ok) return done;
  const t = (await tournamentById(who.tournamentId))!;
  return { ok: true, value: { ...done.value, officialName: who.official.name, venueId: who.venueId, tournamentName: t.name } };
}

// ------------------------------------------------------------ the public live page

export interface LiveFixture {
  id: number;
  /** What it is, for the page to say in its own language. */
  stage: Match["stage"];
  /** Which bracket; none reads as the ordinary knockout. */
  bracket?: BracketKind;
  groupNo: number | null;
  round: number;
  placement: 3 | null;
  /** How many rounds its own bracket has. */
  rounds: number;
  /** Names as the public sees them (short for a declared minor); null: still to be decided. */
  a: string | null;
  b: string | null;
  state: "scheduled" | "called" | "playing";
  date: string | null;
  minute: number | null;
}

export interface LiveBoard {
  id: number;
  name: string;
  venueName: string;
  sport: Tournament["sport"];
  status: Tournament["status"];
  today: string;
  courts: { id: number; name: string; now: LiveFixture | null; next: LiveFixture | null }[];
  recent: { id: number; stage: Match["stage"]; bracket?: BracketKind; groupNo: number | null; round: number; placement: 3 | null; rounds: number; a: string | null; b: string | null; winner: string | null; score: string | null; walkover: boolean }[];
}

/**
 * What the public live page shows, and nothing else: what is on each court
 * and next, and the last results, by the names the public may see. No check-in,
 * no call times or staff names, no guardians, no contact details, no entry or
 * account ids.
 */
export async function liveBoard(tournamentId: number, now: Date = new Date()): Promise<LiveBoard | null> {
  const c = await context(tournamentId, now);
  if (!c || c.t.status === "cancelled") return null;
  const fixture = (m: Match): LiveFixture => ({
    id: m.id,
    stage: m.stage,
    bracket: m.bracket,
    groupNo: m.groupNo,
    round: m.round,
    placement: m.placement,
    rounds: c.rounds.get(m.bracket) ?? m.round,
    a: shownName(c, m.a),
    b: shownName(c, m.b),
    state: c.state.get(m.id)?.startedAt ? "playing" : c.state.get(m.id)?.calledAt ? "called" : "scheduled",
    date: m.date,
    minute: m.minute,
  });
  const live = c.t.format === "performance" ? [] : c.d.matches.filter((m) => (m.stage === "group" || m.stage === "knockout") && m.status === "scheduled");
  const courts = (await courtNames(c)).map((court) => {
    const here = live.filter((m) => m.courtId === court.id);
    const onNow = here.find((m) => c.state.get(m.id)?.calledAt);
    const next = here.filter((m) => !c.state.get(m.id)?.calledAt && m.date !== null && m.a !== null && m.b !== null).sort(bySchedule)[0];
    return { id: court.id, name: court.name, now: onNow ? fixture(onNow) : null, next: next ? fixture(next) : null };
  });
  const recent = c.d.matches
    .filter((m) => (m.stage === "group" || m.stage === "knockout") && (m.status === "done" || m.status === "retired" || m.status === "walkover"))
    .sort((x, y) => (c.state.get(y.id)?.decidedAt ?? "").localeCompare(c.state.get(x.id)?.decidedAt ?? "") || y.id - x.id)
    .slice(0, 8)
    .map((m) => ({
      id: m.id,
      stage: m.stage,
      bracket: m.bracket,
      groupNo: m.groupNo,
      round: m.round,
      placement: m.placement,
      rounds: c.rounds.get(m.bracket) ?? m.round,
      a: shownName(c, m.a),
      b: shownName(c, m.b),
      winner: shownName(c, m.winner),
      score: m.score,
      walkover: m.status === "walkover",
    }));
  return { id: c.t.id, name: c.t.name, venueName: c.t.venueName, sport: c.t.sport, status: c.t.status, today: c.today, courts, recent };
}
