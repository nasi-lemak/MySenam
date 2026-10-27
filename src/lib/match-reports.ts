import crypto from "crypto";
import { getDb } from "./db";
import { flipScore, scoreRefusal } from "./brackets";
import { sentences } from "./outbox";
import { tellVenueStaff } from "./owner-alerts";
import { recordResult, tellEntrant, tournamentById, tournamentDetail, type Result, type ResultInput, type TournamentDetail } from "./tournaments";
import { venueHours } from "./store";
import { isValidDateString, todayISO } from "./time";

/**
 * Results entered by the people on court, not only the venue's staff.
 *
 * **Players.** A tournament whose results are by the players (`results_by`)
 * lets either side of a match report it from the tournament's page; the other
 * side confirms it, and only then is it a result, through the same
 * `recordResult` staff use — the same score checks, the same progression and
 * corrections. A side that disagrees disputes it with a note, and the venue's
 * staff are told and enter the result themselves, which settles the report.
 * A result staff or an official enter at any time settles a report waiting
 * on the match.
 *
 * **Officials.** A referee or table official is given a link of their own,
 * for one tournament, made by staff and withdrawn by them. Whoever holds it
 * enters results as staff would, and each one is recorded with the
 * official's name (on the match and in the activity log). Only the SHA-256
 * of the link's secret is kept.
 */

export interface MatchReport {
  id: number;
  matchId: number;
  /** The side that reported it. */
  entryId: number;
  /** Null for a draw. */
  winner: number | null;
  score: string | null;
  walkover: boolean;
  status: "pending" | "confirmed" | "disputed" | "superseded";
  disputeNote: string | null;
  createdAt: string;
}

interface ReportRow {
  id: number;
  tournament_id: number;
  match_id: number;
  entry_id: number;
  winner: number | null;
  score: string | null;
  walkover: number;
  status: MatchReport["status"];
  dispute_note: string | null;
  created_at: string;
}

const toReport = (r: ReportRow): MatchReport => ({
  id: r.id,
  matchId: r.match_id,
  entryId: r.entry_id,
  winner: r.winner,
  score: r.score,
  walkover: r.walkover === 1,
  status: r.status,
  disputeNote: r.dispute_note,
  createdAt: r.created_at,
});

/** Reports still waiting (pending) or disputed, for a tournament: for its staff, and for the players in them. */
export async function openReports(tournamentId: number): Promise<MatchReport[]> {
  const rows = (await getDb()
    .prepare("SELECT * FROM tournament_reports WHERE tournament_id = ? AND status IN ('pending', 'disputed') ORDER BY id")
    .all(tournamentId)) as ReportRow[];
  return rows.map(toReport);
}

interface MatchSides {
  id: number;
  tournament_id: number;
  stage: string;
  status: string;
  entry_a: number | null;
  entry_b: number | null;
  user_a: number | null;
  user_b: number | null;
}

async function matchSides(matchId: number): Promise<MatchSides | undefined> {
  return (await getDb()
    .prepare(
      `SELECT m.id, m.tournament_id, m.stage, m.status, m.entry_a, m.entry_b,
              (SELECT e.user_id FROM tournament_entries e WHERE e.id = m.entry_a) AS user_a,
              (SELECT e.user_id FROM tournament_entries e WHERE e.id = m.entry_b) AS user_b
         FROM tournament_matches m WHERE m.id = ?`
    )
    .get(matchId)) as MatchSides | undefined;
}

/**
 * The side this account plays in the match, or acts for (a participant it
 * entered), or null. An account on both sides (a guardian whose two children
 * meet) reports for neither: staff enter that result.
 */
function sideOf(m: MatchSides, userId: number): number | null {
  if (m.user_a === userId && m.user_b === userId) return null;
  if (m.user_a === userId) return m.entry_a;
  if (m.user_b === userId) return m.entry_b;
  return null;
}

/** A player's report the other side says nothing about stands after this long: a tournament keeps moving. */
export const REPORT_STANDS_HOURS = 24;

/**
 * A player reports their match: who won, and the score (or a walkover), their
 * own points first — kept, as every score is, with the first-named side's
 * first. It waits for the other side. Reporting again replaces the side's own pending
 * report; a report the other side made is confirmed or disputed instead.
 */
export async function reportResult(userId: number, matchId: number, input: { winner: number | null; score?: string; walkover?: boolean }): Promise<Result<MatchReport>> {
  const db = getDb();
  const m = await matchSides(matchId);
  if (!m) return { ok: false, error: "Match not found." };
  const t = (await tournamentById(m.tournament_id))!;
  if (t.resultsBy !== "players") return { ok: false, error: "The venue enters this tournament's results." };
  if (t.status !== "drawn") return { ok: false, error: "Results are not being taken." };
  const mine = sideOf(m, userId);
  if (mine === null) return { ok: false, error: "That is not your match." };
  if (m.status !== "scheduled" || m.entry_a === null || m.entry_b === null) return { ok: false, error: "That match is not waiting for a result." };
  const draw = input.winner === null;
  if (draw && !(t.rules.scoring.kind === "tally" && t.rules.scoring.draws && m.stage === "group" && !input.walkover))
    return { ok: false, error: "This match needs a winner." };
  if (!draw && input.winner !== m.entry_a && input.winner !== m.entry_b) return { ok: false, error: "The winner has to be one of the two." };
  const typed = input.score?.trim() || null;
  const score = typed && mine === m.entry_b ? flipScore(typed) : typed;
  if (!input.walkover) {
    if (!score) return { ok: false, error: "Give the score, or report a walkover." };
    const refusal = scoreRefusal(score, draw ? null : input.winner === m.entry_a, t.rules.scoring, { drawAllowed: draw });
    if (refusal) return { ok: false, error: refusal };
  }
  const open = (await db.prepare("SELECT * FROM tournament_reports WHERE match_id = ? AND status IN ('pending', 'disputed')").get(matchId)) as ReportRow | undefined;
  if (open?.status === "disputed") return { ok: false, error: "This result is disputed: the venue will enter it." };
  if (open && open.entry_id !== mine) return { ok: false, error: "The other side has reported it: confirm it, or say it is wrong." };
  if (open) await db.prepare("UPDATE tournament_reports SET status = 'superseded', answered_at = datetime('now') WHERE id = ?").run(open.id);
  const row = (await db
    .prepare(
      `INSERT INTO tournament_reports (tournament_id, match_id, entry_id, user_id, winner, score, walkover)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .get(m.tournament_id, matchId, mine, userId, input.winner, input.walkover ? null : score, input.walkover ? 1 : 0)) as ReportRow;
  // The other side is asked, and told that silence lets it stand.
  const theirs = (await db.prepare("SELECT user_id FROM tournament_entries WHERE id = ?").get(mine === m.entry_a ? m.entry_b : m.entry_a)) as
    | { user_id: number | null }
    | undefined;
  if (theirs?.user_id)
    await tellEntrant(
      theirs.user_id,
      t,
      (tr) => tr("mail.report.s", { t: t.name }),
      (tr) =>
        sentences(
          tr,
          input.walkover || !score ? tr("mail.report.walkover", { t: t.name }) : tr("mail.report.score", { t: t.name, score }),
          tr("mail.report.ask", { hours: REPORT_STANDS_HOURS })
        )
    );
  return { ok: true, value: toReport(row) };
}

/**
 * Reports nobody answered in REPORT_STANDS_HOURS stand, recorded through the
 * same checks as any result. One that can no longer be recorded (the match
 * moved on meanwhile) goes to the venue's staff as disputed, never dropped.
 */
export async function standUnansweredReports(): Promise<number> {
  const db = getDb();
  const due = (await db
    .prepare(
      `SELECT r.* FROM tournament_reports r JOIN tournaments t ON t.id = r.tournament_id
        WHERE r.status = 'pending' AND t.status = 'drawn' AND r.created_at < datetime('now', '-${REPORT_STANDS_HOURS} hours') ORDER BY r.id`
    )
    .all()) as ReportRow[];
  let stood = 0;
  for (const open of due) {
    // Claimed first, so two servers stand it once.
    const claimed = await db
      .prepare("UPDATE tournament_reports SET status = 'confirmed', answered_at = datetime('now') WHERE id = ? AND status = 'pending'")
      .run(open.id);
    if (claimed.changes !== 1) continue;
    const done = await recordResult(open.match_id, { winner: open.winner, score: open.score ?? undefined, walkover: open.walkover === 1 });
    if (!done.ok) {
      await db
        .prepare("UPDATE tournament_reports SET status = 'disputed', dispute_note = ? WHERE id = ?")
        .run(`Unanswered, and could not be recorded: ${done.error}`.slice(0, 500), open.id);
      const t = await tournamentById(open.tournament_id);
      if (t) await tellVenueStaff(t.venueId, `A result needs entering: ${t.name}`, `A player's report in ${t.name} went unanswered, and could not be recorded (${done.error}). Enter the result from Tournaments → ${t.name}.`);
      continue;
    }
    await db.prepare("UPDATE tournament_matches SET result_by = 'players' WHERE id = ?").run(open.match_id);
    stood++;
  }
  return stood;
}

/**
 * The other side answers a report: confirmed, it is recorded as the result
 * (refused as staff's would be, and then left for staff); disputed, with a
 * note, the venue's staff are told and enter it themselves.
 */
export async function answerReport(
  userId: number,
  matchId: number,
  answer: { confirm: true } | { dispute: string }
): Promise<Result<TournamentDetail | MatchReport>> {
  const db = getDb();
  const m = await matchSides(matchId);
  if (!m) return { ok: false, error: "Match not found." };
  const mine = sideOf(m, userId);
  if (mine === null) return { ok: false, error: "That is not your match." };
  const open = (await db.prepare("SELECT * FROM tournament_reports WHERE match_id = ? AND status = 'pending'").get(matchId)) as ReportRow | undefined;
  if (!open) return { ok: false, error: "There is no result waiting for you on that match." };
  if (open.entry_id === mine) return { ok: false, error: "You reported it: the other side confirms it." };
  if ("dispute" in answer) {
    const note = answer.dispute.trim().slice(0, 500);
    if (note.length < 3) return { ok: false, error: "Say what is wrong with it." };
    const row = (await db
      .prepare("UPDATE tournament_reports SET status = 'disputed', dispute_note = ?, answered_at = datetime('now') WHERE id = ? AND status = 'pending' RETURNING *")
      .get(note, open.id)) as ReportRow | undefined;
    if (!row) return { ok: false, error: "That has been answered already." };
    const t = (await tournamentById(m.tournament_id))!;
    await tellVenueStaff(
      t.venueId,
      `A result is disputed: ${t.name}`,
      `The two sides of a match in ${t.name} disagree about its result ("${note}"). Enter the result yourselves from Tournaments → ${t.name}.`
    );
    return { ok: true, value: toReport(row) };
  }
  const input: ResultInput = { winner: open.winner, score: open.score ?? undefined, walkover: open.walkover === 1 };
  const done = await recordResult(matchId, input);
  if (!done.ok) return done;
  await db.prepare("UPDATE tournament_reports SET status = 'confirmed', answered_at = datetime('now') WHERE id = ?").run(open.id);
  await db.prepare("UPDATE tournament_matches SET result_by = 'players' WHERE id = ?").run(matchId);
  return { ok: true, value: (await tournamentDetail(m.tournament_id))! };
}

/** Mark who entered a result staff or an official recorded. */
export async function noteResultBy(matchId: number, by: string): Promise<void> {
  await getDb().prepare("UPDATE tournament_matches SET result_by = ? WHERE id = ?").run(by.slice(0, 80), matchId);
}

// ------------------------------------------------------------ officials

export interface Official {
  id: number;
  name: string;
  createdAt: string;
  revokedAt: string | null;
  /** The last day the link works, in the venue's time. */
  expiresOn: string | null;
}

const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/**
 * A link for an official to enter one tournament's results: 192 random bits,
 * of which only the SHA-256 is kept, so the link is shown once. It works
 * until the tournament's last day unless an earlier one is given, and stops
 * at once when withdrawn. An official has no account: the link is the whole
 * of their access, limited to entering results of this tournament's matches
 * still to be decided.
 */
export async function addOfficial(
  tournamentId: number,
  name: string,
  adminId: number | null,
  expiresOn?: string | null
): Promise<Result<{ official: Official; token: string }>> {
  const clean = name.trim();
  if (clean.length < 2 || clean.length > 60) return { ok: false, error: "Give the official's name." };
  const t = await tournamentById(tournamentId);
  if (!t || t.status === "cancelled" || t.status === "finished") return { ok: false, error: "That tournament is not running." };
  if (t.format === "performance") return { ok: false, error: "A performance event's marks are entered by staff." };
  const until = expiresOn || t.endsOn;
  if (!isValidDateString(until) || until > t.endsOn || until < todayISO((await venueHours(t.venueId)).zone))
    return { ok: false, error: `The link can work until ${t.endsOn}, the last day, at the latest.` };
  const token = crypto.randomBytes(24).toString("base64url");
  const row = (await getDb()
    .prepare(
      "INSERT INTO tournament_officials (tournament_id, name, token_hash, created_by, expires_on) VALUES (?, ?, ?, ?, ?) RETURNING id, name, created_at, revoked_at, expires_on"
    )
    .get(tournamentId, clean, hash(token), adminId, until)) as { id: number; name: string; created_at: string; revoked_at: string | null; expires_on: string | null };
  return { ok: true, value: { official: { id: row.id, name: row.name, createdAt: row.created_at, revokedAt: row.revoked_at, expiresOn: row.expires_on }, token } };
}

export async function listOfficials(tournamentId: number): Promise<Official[]> {
  const rows = (await getDb()
    .prepare("SELECT id, name, created_at, revoked_at, expires_on FROM tournament_officials WHERE tournament_id = ? ORDER BY id")
    .all(tournamentId)) as { id: number; name: string; created_at: string; revoked_at: string | null; expires_on: string | null }[];
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, revokedAt: r.revoked_at, expiresOn: r.expires_on }));
}

/** The link stops working at once. */
export async function revokeOfficial(tournamentId: number, officialId: number): Promise<boolean> {
  const done = await getDb()
    .prepare("UPDATE tournament_officials SET revoked_at = datetime('now') WHERE id = ? AND tournament_id = ? AND revoked_at IS NULL")
    .run(officialId, tournamentId);
  return done.changes > 0;
}

/** Whose link this is, while it works and the tournament runs. */
export async function officialByToken(token: string): Promise<{ official: Official; tournamentId: number; venueId: number } | null> {
  if (!token || token.length > 100) return null;
  const row = (await getDb()
    .prepare(
      `SELECT o.id, o.name, o.created_at, o.revoked_at, o.expires_on, o.tournament_id, t.venue_id FROM tournament_officials o JOIN tournaments t ON t.id = o.tournament_id
        WHERE o.token_hash = ? AND o.revoked_at IS NULL AND t.status IN ('open', 'closed', 'drawn')`
    )
    .get(hash(token))) as { id: number; name: string; created_at: string; revoked_at: null; expires_on: string | null; tournament_id: number; venue_id: number } | undefined;
  if (!row) return null;
  // Past its last day, in the venue's time: it no longer works.
  if (row.expires_on && todayISO((await venueHours(row.venue_id)).zone) > row.expires_on) return null;
  return { official: { id: row.id, name: row.name, createdAt: row.created_at, revokedAt: null, expiresOn: row.expires_on }, tournamentId: row.tournament_id, venueId: row.venue_id };
}

/** An official enters a result: as staff would, recorded with their name and in the activity log. */
export async function officialResult(token: string, matchId: number, input: ResultInput): Promise<Result<TournamentDetail>> {
  const who = await officialByToken(token);
  if (!who) return { ok: false, error: "This link no longer works." };
  const db = getDb();
  const m = (await db.prepare("SELECT tournament_id, status FROM tournament_matches WHERE id = ?").get(matchId)) as { tournament_id: number; status: string } | undefined;
  if (!m || m.tournament_id !== who.tournamentId) return { ok: false, error: "That match is not in this tournament." };
  // A result already in is corrected by the organiser, who sees what a correction changes.
  if (m.status !== "scheduled") return { ok: false, error: "That match has its result: ask the organiser to correct it." };
  // An official records results; taking a player out of the event stays with staff.
  const done = await recordResult(matchId, { ...input, outOfEvent: false });
  if (!done.ok) return done;
  await noteResultBy(matchId, `official: ${who.official.name}`);
  await db
    .prepare("INSERT INTO staff_actions (admin_id, admin_name, venue_id, action, detail) VALUES (NULL, ?, ?, 'tournament.result', ?)")
    .run(`Official: ${who.official.name}`, who.venueId, `${done.value.name}: match ${matchId}, ${input.walkover ? "walkover" : (input.score ?? "")}`.slice(0, 500));
  return { ok: true, value: (await tournamentDetail(who.tournamentId))! };
}
