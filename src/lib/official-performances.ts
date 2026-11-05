import { getDb, withTransaction } from "./db";
import { logAction } from "./activity";
import { officialByToken } from "./match-reports";
import { baseUrl } from "./outbox";
import { tellVenueStaffEach } from "./owner-alerts";
import {
  previewPerformances,
  recordPerformances,
  tournamentById,
  tournamentDetail,
  type PerformanceInput,
  type PerformancePreview,
  type Result,
  type TournamentDetail,
} from "./tournaments";

/**
 * Officials entering a climbing (counted performance) event's results from their own page
 * (docs/features/tournaments.md#officials-and-counted-results; migration 0276).
 *
 * An official's link is for one event (`tournament_officials`, lib/match-reports.ts). For a performance event it lets them
 * do exactly one thing: enter the counts of a round that is still open, line by line (a boulder's attempts, zone and top; a
 * height), through the same `recordPerformances` the dashboard uses, so every check, the atomic save and the ranking are
 * the ones a manager's save gets. Nothing else: no settings, entries, payments, draw, final or ending the event, and no
 * other event.
 *
 * **Open and finalised.** A round is open while any competitor in it still has no line. When the last line is in it is
 * *finalised* (the event's ranking and, once every group is in, the final's field follow from it); a group is also
 * *advanced* once the final has results. An official re-enters a line of an open round freely (each overwrite is kept with
 * what it replaced). They cannot change a finalised or advanced round: they send a **correction request** (the reason and the
 * intended counts, checked as a save would be) that a manager reviews through the existing correction flow, a preview of
 * what it changes and an apply made only against that preview's token. Making the final from a tie (`makeFinal`) and ending
 * the event stay the organiser's.
 *
 * **After the event has finished** the link keeps working for `OFFICIAL_AFTER_FINISH_DAYS` days (lib/match-reports.ts) for two things only:
 * seeing the event's results and sending or withdrawing a correction request. Entering counts (`OFC_EVENT_FINISHED`), a match result, a
 * call, any other action and any other event stay refused, a cancelled event ends the link at once, and a manager applies a request to a
 * finished event as any correction (the dashboard's save, `recordPerformances`, which reopens nothing and rates nothing: counted events are
 * not rated).
 */

export const REQUEST_REASON_MAX = 300;
export const MAX_LINES = 100;

interface Refusal {
  ok: false;
  error: string;
  code: string;
}
const refuse = (code: string, error: string): Refusal => ({ ok: false, error, code });

export type RoundLock = "finalised" | "advanced" | null;

/** Whether an official may still enter this round: its status, and for a group whether the final has begun. */
async function lockOf(matchId: number): Promise<RoundLock> {
  const db = getDb();
  const m = (await db.prepare("SELECT tournament_id, stage, status, round FROM tournament_matches WHERE id = ?").get(matchId)) as { tournament_id: number; stage: string; status: string; round: number } | undefined;
  if (!m) return null;
  if (m.stage === "heat") {
    // A counted event played in Swiss rounds (ADR 0038): a round is advanced once anybody has climbed a later one (the groups were formed from it).
    const later = (await db
      .prepare(
        `SELECT 1 FROM tournament_performances p JOIN tournament_matches h ON h.id = p.match_id
          WHERE h.tournament_id = ? AND h.stage = 'heat' AND h.round > ? AND p.status <> 'pending' AND EXISTS (SELECT 1 FROM swiss_events e WHERE e.tournament_id = h.tournament_id) LIMIT 1`
      )
      .get(m.tournament_id, m.round)) as unknown;
    if (later) return "advanced";
    const final = (await db
      .prepare(
        `SELECT 1 FROM tournament_performances p JOIN tournament_matches f ON f.id = p.match_id
          WHERE f.tournament_id = ? AND f.stage = 'final' AND p.status <> 'pending' LIMIT 1`
      )
      .get(m.tournament_id)) as unknown;
    if (final) return "advanced";
  }
  return m.status === "done" ? "finalised" : null;
}

interface Who {
  official: { id: number; name: string };
  tournamentId: number;
  venueId: number;
  /** "finished": the event is over and the link is for its results and correction requests only (`OFFICIAL_AFTER_FINISH_DAYS`). */
  phase: "running" | "finished";
  until: string | null;
}

/** The official, if their link works and is for a performance event (also for the days after it has finished); else the refusal. */
async function performanceOfficial(token: string): Promise<{ ok: true; who: Who } | Refusal> {
  const who = await officialByToken(token, { afterFinish: true });
  if (!who) return refuse("OFC_LINK", "This link no longer works. Ask the venue for a new one.");
  const t = await tournamentById(who.tournamentId);
  if (!t || t.format !== "performance" || !t.rules.performance?.counted) return refuse("OFC_NOT_PERF", "This link is not for a climbing event's counts.");
  return { ok: true, who: { official: { id: who.official.id, name: who.official.name }, tournamentId: who.tournamentId, venueId: who.venueId, phase: who.phase, until: who.until } };
}

async function roundIn(who: Who, matchId: number): Promise<{ ok: true; stage: string } | Refusal> {
  const m = (await getDb().prepare("SELECT tournament_id, stage FROM tournament_matches WHERE id = ?").get(matchId)) as { tournament_id: number; stage: string } | undefined;
  if (!m || m.tournament_id !== who.tournamentId || (m.stage !== "heat" && m.stage !== "final")) return refuse("OFC_NOT_HERE", "That round is not in this event.");
  return { ok: true, stage: m.stage };
}

function readLines(given: unknown): PerformanceInput[] | Refusal {
  if (!Array.isArray(given) || given.length === 0 || given.length > MAX_LINES) return refuse("OFC_LINES", "Give the lines to save.");
  const out: PerformanceInput[] = [];
  for (const p of given as Record<string, unknown>[]) {
    if (!p || typeof p !== "object") return refuse("OFC_LINES", "Give the lines to save.");
    out.push({
      entryId: Number(p.entryId),
      status: typeof p.status === "string" ? (p.status as PerformanceInput["status"]) : undefined,
      note: typeof p.note === "string" ? p.note : undefined,
      counts: Array.isArray(p.counts) ? p.counts : undefined,
    });
  }
  return out;
}

const shownOf = (d: TournamentDetail, matchId: number, entryId: number): string | null => {
  const l = (d.performance?.lines[matchId] ?? []).find((x) => x.entryId === entryId);
  if (!l) return null;
  return l.status === "pending" ? null : (l.shown ?? l.status);
};
const countsOf = (d: TournamentDetail, matchId: number, entryId: number): string | null => {
  const l = (d.performance?.lines[matchId] ?? []).find((x) => x.entryId === entryId);
  return l && l.status !== "pending" && l.counts ? JSON.stringify(l.counts) : null;
};
const nameOf = (d: TournamentDetail, entryId: number) => d.entries.find((e) => e.id === entryId)?.name ?? `#${entryId}`;

/**
 * An official enters (or re-enters) lines of an open round. `preview`: what it would change, nothing changed. Refused for a
 * finalised or advanced round (`OFC_ROUND_FINAL`), a round or a competitor of another event, and anything the dashboard's own
 * save would refuse. Each line is kept with what it replaced, and the event's activity log names the official.
 */
export async function officialPerformances(
  token: string,
  matchId: number,
  given: unknown,
  opts: { preview?: boolean; confirm?: { token: string } } = {}
): Promise<Result<TournamentDetail> | { ok: true; value: PerformancePreview; preview: true }> {
  const found = await performanceOfficial(token);
  if (!found.ok) return found;
  const { who } = found;
  // Once the event has finished the link shows the results and takes a correction request: no count is entered or overwritten, a preview included.
  if (who.phase === "finished") return refuse("OFC_EVENT_FINISHED", "This event has finished: you can still see its results and ask for a correction.");
  const round = await roundIn(who, matchId);
  if (!round.ok) return round;
  const lines = readLines(given);
  if (!Array.isArray(lines)) return lines;
  if (opts.preview) {
    const p = await previewPerformances(matchId, lines);
    return p.ok ? { ok: true, value: p.value, preview: true } : p;
  }
  const db = getDb();
  const done = await withTransaction(async (): Promise<Result<TournamentDetail>> => {
    // The round's row is held while it is read and written, so it cannot be finalised between the look and the save.
    await db.prepare("SELECT id FROM tournament_matches WHERE id = ? FOR UPDATE").get(matchId);
    if ((await lockOf(matchId)) !== null)
      return refuse("OFC_ROUND_FINAL", "This round is finalised: ask the organiser for a correction.");
    const before = (await tournamentDetail(who.tournamentId, { forStaff: true }))!;
    const saved = await recordPerformances(matchId, lines, opts.confirm);
    if (!saved.ok) return saved;
    for (const l of lines)
      await db
        .prepare(
          `INSERT INTO tournament_official_marks (tournament_id, official_id, official_name, match_id, entry_id, was_shown, now_shown, was_counts, now_counts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(who.tournamentId, who.official.id, who.official.name, matchId, l.entryId, shownOf(before, matchId, l.entryId), shownOf(saved.value, matchId, l.entryId), countsOf(before, matchId, l.entryId), countsOf(saved.value, matchId, l.entryId));
    const said = lines.map((l) => {
      const was = shownOf(before, matchId, l.entryId);
      return `${nameOf(saved.value, l.entryId)}: ${shownOf(saved.value, matchId, l.entryId) ?? "-"}${was === null ? "" : ` (was ${was})`}`;
    });
    await logAction(
      { id: null, name: `Official: ${who.official.name}` },
      { venueId: who.venueId, action: "tournament.performances", detail: `${saved.value.name}: results for ${lines.length} competitor(s) — ${said.join("; ")}` }
    );
    return saved;
  });
  if (!done.ok) return done;
  // What an official sees back is the event as the public sees it.
  return { ok: true, value: (await tournamentDetail(who.tournamentId))! };
}

// ------------------------------------------------------------ correction requests

export interface CorrectionRequest {
  id: number;
  matchId: number;
  officialName: string;
  reason: string;
  /** The intended lines, as an official sent them. */
  lines: PerformanceInput[];
  status: "open" | "applied" | "declined" | "withdrawn";
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

interface RequestRow {
  id: number;
  tournament_id: number;
  match_id: number;
  official_id: number;
  official_name: string;
  reason: string;
  lines: string;
  status: CorrectionRequest["status"];
  created_at: string;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
}

const toRequest = (r: RequestRow): CorrectionRequest => ({
  id: r.id,
  matchId: r.match_id,
  officialName: r.official_name,
  reason: r.reason,
  lines: JSON.parse(r.lines) as PerformanceInput[],
  status: r.status,
  createdAt: r.created_at,
  decidedBy: r.decided_by_name,
  decidedAt: r.decided_at,
  decisionNote: r.decision_note,
});

/**
 * An official asks for a correction to a round that is finalised or advanced: why, and the counts it should have. The lines
 * are checked as a save of them would be now (a preview, nothing changed), so a request is never one that could not be made. It
 * changes nothing; the managers are told. One open request per round and official.
 */
export async function requestCorrection(token: string, matchId: number, reason: unknown, given: unknown): Promise<Result<CorrectionRequest>> {
  const found = await performanceOfficial(token);
  if (!found.ok) return found;
  const { who } = found;
  const round = await roundIn(who, matchId);
  if (!round.ok) return round;
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 3 || why.length > REQUEST_REASON_MAX) return refuse("OFC_REASON", "Say why, in 3 to 300 characters.");
  const lines = readLines(given);
  if (!Array.isArray(lines)) return lines;
  const db = getDb();
  const made = await withTransaction(async (): Promise<Result<number>> => {
    await db.prepare("SELECT id FROM tournament_matches WHERE id = ? FOR UPDATE").get(matchId);
    if ((await lockOf(matchId)) === null) return refuse("OFC_ROUND_OPEN", "This round is still open: enter the line again instead.");
    if (await db.prepare("SELECT 1 FROM tournament_correction_requests WHERE match_id = ? AND official_id = ? AND status = 'open'").get(matchId, who.official.id))
      return refuse("OFC_REQ_OPEN", "You already have a correction request waiting for this round. Withdraw it first.");
    const check = await previewPerformances(matchId, lines);
    if (!check.ok) return check;
    const row = (await db
      .prepare("INSERT INTO tournament_correction_requests (tournament_id, match_id, official_id, official_name, reason, lines) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
      .get(who.tournamentId, matchId, who.official.id, who.official.name, why, JSON.stringify(lines))) as { id: number };
    return { ok: true, value: row.id };
  });
  if (!made.ok) return made;
  const t = (await tournamentById(who.tournamentId))!;
  await logAction(
    { id: null, name: `Official: ${who.official.name}` },
    { venueId: who.venueId, action: "tournament.correction_requested", detail: `${t.name}: round ${matchId}, ${lines.length} line(s): ${why}` }
  );
  await tellVenueStaffEach(
    who.venueId,
    (s) => ({
      subject: s("ofs1.cr.alert.s", { t: t.name }),
      body: s("ofs1.cr.alert.b", { t: t.name, who: who.official.name, why, place: s("sh.tab.tournaments"), url: `${baseUrl()}/admin` }),
    }),
    { managersOnly: true }
  );
  return { ok: true, value: toRequest((await db.prepare("SELECT * FROM tournament_correction_requests WHERE id = ?").get(made.value)) as RequestRow) };
}

/** The official takes their own request back. */
export async function withdrawCorrection(token: string, requestId: number): Promise<Result<null>> {
  const found = await performanceOfficial(token);
  if (!found.ok) return found;
  const done = await getDb()
    .prepare("UPDATE tournament_correction_requests SET status = 'withdrawn', decided_at = datetime('now') WHERE id = ? AND official_id = ? AND status = 'open'")
    .run(requestId, found.who.official.id);
  if (done.changes !== 1) return refuse("OFC_REQ_GONE", "That request is no longer waiting.");
  return { ok: true, value: null };
}

/** What an official's page shows beyond the event: which rounds are open, their recent entries and their requests. */
export async function officialPerformanceView(token: string): Promise<{
  rounds: { matchId: number; lock: RoundLock }[];
  recent: { matchId: number; entry: string; was: string | null; now: string | null; at: string }[];
  requests: CorrectionRequest[];
} | null> {
  const found = await performanceOfficial(token);
  if (!found.ok) return null;
  const db = getDb();
  const matches = (await db.prepare("SELECT id FROM tournament_matches WHERE tournament_id = ? AND stage IN ('heat', 'final') ORDER BY id").all(found.who.tournamentId)) as { id: number }[];
  const rounds: { matchId: number; lock: RoundLock }[] = [];
  for (const m of matches) rounds.push({ matchId: m.id, lock: await lockOf(m.id) });
  const d = (await tournamentDetail(found.who.tournamentId))!;
  const marks = (await db
    .prepare("SELECT match_id, entry_id, was_shown, now_shown, entered_at FROM tournament_official_marks WHERE official_id = ? ORDER BY id DESC LIMIT 15")
    .all(found.who.official.id)) as { match_id: number; entry_id: number; was_shown: string | null; now_shown: string | null; entered_at: string }[];
  const requests = (await db.prepare("SELECT * FROM tournament_correction_requests WHERE official_id = ? ORDER BY id DESC LIMIT 20").all(found.who.official.id)) as RequestRow[];
  return {
    rounds,
    recent: marks.map((m) => ({ matchId: m.match_id, entry: nameOf(d, m.entry_id), was: m.was_shown, now: m.now_shown, at: m.entered_at })),
    requests: requests.map(toRequest),
  };
}

// ------------------------------------------------------------ the organiser's side

/** Requests for an event, the open ones first. */
export async function listCorrectionRequests(tournamentId: number): Promise<CorrectionRequest[]> {
  const rows = (await getDb()
    .prepare("SELECT * FROM tournament_correction_requests WHERE tournament_id = ? ORDER BY (status = 'open') DESC, id DESC LIMIT 100")
    .all(tournamentId)) as RequestRow[];
  return rows.map(toRequest);
}

async function openRequest(tournamentId: number, requestId: number): Promise<RequestRow | null> {
  const r = (await getDb().prepare("SELECT * FROM tournament_correction_requests WHERE id = ? AND tournament_id = ?").get(requestId, tournamentId)) as RequestRow | undefined;
  return r ?? null;
}

/** What applying a request would change (nothing is changed), with the token an apply is made against. */
export async function previewCorrectionRequest(tournamentId: number, requestId: number): Promise<Result<PerformancePreview>> {
  const r = await openRequest(tournamentId, requestId);
  if (!r) return { ok: false, error: "Not found." };
  if (r.status !== "open") return refuse("OFC_REQ_GONE", "That request is no longer waiting.");
  return previewPerformances(r.match_id, toRequest(r).lines);
}

/**
 * A manager applies a request: the lines saved through `recordPerformances` against the token of the preview they reviewed
 * (refused as changed if the event moved since), and the request marked applied, as one change.
 */
export async function applyCorrectionRequest(tournamentId: number, requestId: number, admin: { id: number; name: string }, token: unknown): Promise<Result<TournamentDetail>> {
  if (typeof token !== "string" || token === "") return refuse("OFC_NEEDS_PREVIEW", "Preview the correction first, and apply it as previewed.");
  const db = getDb();
  return withTransaction(async (): Promise<Result<TournamentDetail>> => {
    const r = (await db.prepare("SELECT * FROM tournament_correction_requests WHERE id = ? AND tournament_id = ? FOR UPDATE").get(requestId, tournamentId)) as RequestRow | undefined;
    if (!r) return { ok: false, error: "Not found." };
    if (r.status !== "open") return refuse("OFC_REQ_GONE", "That request is no longer waiting.");
    const request = toRequest(r);
    const saved = await recordPerformances(r.match_id, request.lines, { token });
    if (!saved.ok) return saved;
    await db
      .prepare("UPDATE tournament_correction_requests SET status = 'applied', decided_by_admin_id = ?, decided_by_name = ?, decided_at = datetime('now') WHERE id = ?")
      .run(admin.id, admin.name, r.id);
    const venueId = saved.value.venueId;
    await logAction(admin, {
      venueId,
      action: "tournament.correction_applied",
      detail: `${saved.value.name}: ${r.official_name}'s correction to round ${r.match_id} applied (${request.lines.length} line(s)): ${r.reason}`,
    });
    return saved;
  });
}

/** A manager declines a request with a reason (3 to 300 characters). */
export async function declineCorrectionRequest(tournamentId: number, requestId: number, admin: { id: number; name: string }, note: unknown): Promise<Result<null>> {
  const why = typeof note === "string" ? note.trim() : "";
  if (why.length < 3 || why.length > REQUEST_REASON_MAX) return refuse("OFC_REASON", "Say why, in 3 to 300 characters.");
  const r = await openRequest(tournamentId, requestId);
  if (!r) return { ok: false, error: "Not found." };
  const done = await getDb()
    .prepare("UPDATE tournament_correction_requests SET status = 'declined', decided_by_admin_id = ?, decided_by_name = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ? AND status = 'open'")
    .run(admin.id, admin.name, why, r.id);
  if (done.changes !== 1) return refuse("OFC_REQ_GONE", "That request is no longer waiting.");
  const t = await tournamentById(tournamentId);
  await logAction(admin, { venueId: t?.venueId ?? null, action: "tournament.correction_declined", detail: `${t?.name ?? ""}: ${r.official_name}'s correction to round ${r.match_id} declined: ${why}` });
  return { ok: true, value: null };
}

/** What an official's page is given beside the event (`officialPerformanceView`). */
export type OfficialPerformanceView = NonNullable<Awaited<ReturnType<typeof officialPerformanceView>>>;
