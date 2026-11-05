import { logAction } from "./activity";
import { getDb, withTransaction } from "./db";
import { tellVenueStaffEach } from "./owner-alerts";
import { baseUrl, sentences } from "./outbox";
import { teamRefusal, type TeamRefusal, type TeamResult } from "./teams";
import { challengeFor, decide, ladderById, ladderRefusal, tellPlayer, type ChallengeRow, type LadderResult } from "./ladders";
import {
  decideFixture,
  fixtureRow,
  leagueTeam,
  sideOfCaptain,
  teamLeagueById,
  teamLeagueDetail,
  tellCaptainOf,
  type FixtureRow,
} from "./team-leagues";

/**
 * Forfeit requests in a league of teams (docs/features/tournaments.md#team-leagues; migration 0276).
 *
 * A forfeit changes the table, the points and who goes where, so **giving one is a manager's act**
 * (`MANAGER_ONLY`, lib/roles.ts). A team's captain, or a member of staff (the desk, who may not give one), may
 * **request** a forfeit of a fixture: which of its two teams is asked to forfeit, a reason from a short list, and up to
 * 300 characters of free text. A request records that and nothing else. It writes no result, moves nothing in the table,
 * advances nobody, and leaves the fixture's court time and the next fixture as they were. It tells the league's
 * managers (in their own language) and the other captain, and shows on the manager's fixture as *Forfeit requested by …*.
 *
 * One request is open per fixture and requester; its requester may withdraw it; it expires after 14 days; and it closes
 * by itself as soon as the fixture is decided any other way (played and confirmed, struck, or given as a forfeit by a
 * manager or a withdrawal): `closeSettledForfeitRequests`, run inside every change that settles a league's fixtures.
 *
 * A manager **confirms** it, which is the existing forfeit path (`decideFixture` with `forfeitBy`: the other side
 * awarded every game by the sport's template, the table recomputed through `standings`, the ratings read again, the
 * fixture's court time let go and offered to the waiting list), or **declines** it with a reason, both captains told. The
 * request keeps who asked, who decided, when, why, and the table before and after.
 */

export const FORFEIT_REASONS = ["no_show", "short_handed", "told_us", "other"] as const;
export type ForfeitReason = (typeof FORFEIT_REASONS)[number];
export const FORFEIT_REQUEST_DAYS = 14;
export const NOTE_MAX = 300;

export type RequestStatus = "open" | "confirmed" | "declined" | "withdrawn" | "expired" | "closed";

interface RequestRow {
  id: number;
  league_id: number;
  fixture_id: number;
  forfeit_team: number;
  requester_key: string;
  requester_kind: "captain" | "staff";
  requested_by_user_id: number | null;
  requested_by_team: number | null;
  requested_by_admin_id: number | null;
  requested_by_name: string;
  reason: ForfeitReason;
  note: string | null;
  status: RequestStatus;
  created_at: string;
  expires_at: string;
  decided_by_admin_id: number | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  closed_reason: string | null;
  standings_before: string | null;
  standings_after: string | null;
  lapsed?: boolean;
}

export interface ForfeitRequestView {
  id: number;
  fixtureId: number;
  forfeitTeam: { id: number; name: string };
  /** A captain's team name, or the member of staff's name. */
  by: string;
  byKind: "captain" | "staff";
  reason: ForfeitReason;
  note: string | null;
  status: RequestStatus;
  createdAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** Why it closed without a decision of its own. */
  closedReason: string | null;
  /** The viewer asked it, so may withdraw it. */
  mine: boolean;
  /** Staff only: the table as it stood when a manager confirmed, and after. */
  standingsBefore?: StandingLine[] | null;
  standingsAfter?: StandingLine[] | null;
}

export interface StandingLine {
  teamId: number;
  name: string;
  position: number;
  played: number;
  points: number;
  pointDiff: number;
}

export type Requester = { userId: number } | { admin: { id: number; name: string } };
export type ForfeitDecision = { confirm: true } | { decline: true; reason: unknown };

const SELECT = "SELECT r.*, (r.status = 'open' AND r.expires_at <= datetime('now')) AS lapsed FROM team_forfeit_requests r";
const keyOf = (by: Requester) => ("userId" in by ? `u:${by.userId}` : `a:${by.admin.id}`);

/** Compact table: who stood where, to keep with a decision and to say in the log. */
async function tableNow(leagueId: number): Promise<StandingLine[]> {
  const detail = await teamLeagueDetail(leagueId, { forStaff: true });
  return (detail?.standings ?? []).map((s) => ({ teamId: s.leagueTeamId, name: s.name, position: s.position, played: s.played, points: s.points, pointDiff: s.pointDiff }));
}

const effective = (r: RequestRow): RequestStatus => (r.status === "open" && r.lapsed === true ? "expired" : r.status);

function parseTable(raw: string | null): StandingLine[] | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StandingLine[];
  } catch {
    return null;
  }
}

async function view(rows: RequestRow[], viewerKey: string | null, forStaff: boolean): Promise<ForfeitRequestView[]> {
  const names = new Map<number, string>();
  for (const id of new Set(rows.map((r) => r.forfeit_team))) names.set(id, (await leagueTeam(id))?.name ?? "");
  return rows.map((r) => ({
    id: r.id,
    fixtureId: r.fixture_id,
    forfeitTeam: { id: r.forfeit_team, name: names.get(r.forfeit_team) ?? "" },
    by: r.requested_by_name,
    byKind: r.requester_kind,
    reason: r.reason,
    note: r.note,
    status: effective(r),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    decidedBy: r.decided_by_name,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    closedReason: r.closed_reason,
    mine: viewerKey !== null && r.requester_key === viewerKey,
    ...(forStaff ? { standingsBefore: parseTable(r.standings_before), standingsAfter: parseTable(r.standings_after) } : {}),
  }));
}

/**
 * A league's requests by fixture, for the detail view: staff see every request, a captain those on the fixtures of their
 * own teams, anybody else none. Newest first.
 */
export async function forfeitRequestsOfLeague(leagueId: number, viewer: { forStaff: boolean; viewerId: number | null; fixtureIds: Set<number> }): Promise<Map<number, ForfeitRequestView[]>> {
  const out = new Map<number, ForfeitRequestView[]>();
  if (!viewer.forStaff && viewer.fixtureIds.size === 0) return out;
  const rows = (await getDb().prepare(`${SELECT} WHERE r.league_id = ? ORDER BY r.id DESC`).all(leagueId)) as RequestRow[];
  const allowed = viewer.forStaff ? rows : rows.filter((r) => viewer.fixtureIds.has(r.fixture_id));
  const views = await view(allowed, viewer.viewerId === null ? null : `u:${viewer.viewerId}`, viewer.forStaff);
  for (const v of views) out.set(v.fixtureId, [...(out.get(v.fixtureId) ?? []), v]);
  return out;
}

/** The reason as the one note a person gave, cut to what fits. */
function readNote(reason: ForfeitReason, note: unknown): { ok: true; note: string | null } | { ok: false; refusal: TeamRefusal } {
  const text = typeof note === "string" ? note.trim() : "";
  if (text.length > NOTE_MAX || (reason === "other" && text.length < 3)) return { ok: false, refusal: teamRefusal("TL_FR_NOTE", { max: NOTE_MAX }, 400) };
  return { ok: true, note: text || null };
}

/**
 * A captain of one of the fixture's two teams, or a member of staff, asks the venue to call a forfeit. On the league's
 * lock and the fixture's, so a fixture decided meanwhile refuses it and a request is never added to a fixture already
 * decided. It changes nothing but the request.
 */
export async function requestForfeit(by: Requester, fixtureId: number, input: { forfeitTeam: unknown; reason: unknown; note?: unknown }): Promise<TeamResult<ForfeitRequestView>> {
  const reason = FORFEIT_REASONS.find((r) => r === input.reason);
  if (!reason) return teamRefusal("TL_FR_REASON", {}, 400);
  const note = readNote(reason, input.note);
  if (!note.ok) return note.refusal;
  const alertFor: { f?: FixtureRow; requested?: RequestRow } = {};
  const made = await withTransaction(async (): Promise<TeamResult<number>> => {
    const db = getDb();
    const first = await fixtureRow(fixtureId);
    if (!first) return teamRefusal("TL_NOT_FOUND", {}, 404);
    await db.prepare("SELECT id FROM team_leagues WHERE id = ? FOR UPDATE").get(first.league_id);
    const f = (await fixtureRow(fixtureId, true))!;
    const league = (await teamLeagueById(f.league_id))!;
    let asker: string;
    let askerTeam: number | null = null;
    if ("userId" in by) {
      const me = await sideOfCaptain(f, by.userId);
      if (!me) return teamRefusal("TL_NOT_CAPTAIN", {}, 403);
      askerTeam = me.leagueTeamId;
      asker = (await leagueTeam(me.leagueTeamId))!.name;
    } else asker = by.admin.name;
    if (league.status !== "scheduled") return teamRefusal("TL_SEASON_OVER");
    if (f.status !== "scheduled") return teamRefusal("TL_FIXTURE_DECIDED");
    const team = Number(input.forfeitTeam);
    if (team !== f.home_team && team !== f.away_team) return teamRefusal("TL_FORFEIT_TEAM", {}, 400);
    const key = keyOf(by);
    // One of their own that ran out is no longer in the way.
    await db.prepare("UPDATE team_forfeit_requests SET status = 'expired' WHERE fixture_id = ? AND requester_key = ? AND status = 'open' AND expires_at <= datetime('now')").run(f.id, key);
    if (await db.prepare("SELECT 1 FROM team_forfeit_requests WHERE fixture_id = ? AND requester_key = ? AND status = 'open'").get(f.id, key)) return teamRefusal("TL_FR_OPEN");
    const row = (await db
      .prepare(
        `INSERT INTO team_forfeit_requests (league_id, fixture_id, forfeit_team, requester_key, requester_kind, requested_by_user_id, requested_by_team, requested_by_admin_id, requested_by_name, reason, note, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+${FORFEIT_REQUEST_DAYS} days')) RETURNING *`
      )
      .get(f.league_id, f.id, team, key, "userId" in by ? "captain" : "staff", "userId" in by ? by.userId : null, askerTeam, "admin" in by ? by.admin.id : null, asker, reason, note.note)) as RequestRow;
    alertFor.f = f;
    alertFor.requested = row;
    await logAction("admin" in by ? by.admin : { id: null, name: `Captain of ${asker}` }, {
      venueId: league.venueId,
      action: "team_league.forfeit_requested",
      detail: `${league.name}: ${(await leagueTeam(f.home_team))?.name ?? ""} v ${(await leagueTeam(f.away_team))?.name ?? ""} on ${f.date}: ${(await leagueTeam(team))?.name ?? ""} asked to forfeit (${reason}) by ${asker}`,
    });
    return { ok: true, value: row.id };
  });
  if (!made.ok) return made;
  await tellAsked(alertFor.f!, alertFor.requested!);
  return { ok: true, value: (await oneView(made.value, "userId" in by ? `u:${by.userId}` : `a:${by.admin.id}`, "admin" in by))! };
}

async function oneView(id: number, viewerKey: string | null, forStaff: boolean): Promise<ForfeitRequestView | null> {
  const row = (await getDb().prepare(`${SELECT} WHERE r.id = ?`).get(id)) as RequestRow | undefined;
  return row ? (await view([row], viewerKey, forStaff))[0] : null;
}

/** The league's managers (each in their language) and the other captain hear that a forfeit was asked for. */
async function tellAsked(f: FixtureRow, r: RequestRow): Promise<void> {
  const league = (await teamLeagueById(f.league_id))!;
  const [home, away, asked] = await Promise.all([leagueTeam(f.home_team), leagueTeam(f.away_team), leagueTeam(r.forfeit_team)]);
  await tellVenueStaffEach(
    league.venueId,
    (t) => ({
      subject: t("ofs1.fr.alert.s", { league: league.name }),
      body: t("ofs1.fr.alert.b", {
        league: league.name,
        a: home?.name ?? "",
        b: away?.name ?? "",
        date: f.date,
        team: asked?.name ?? "",
        by: r.requested_by_name,
        reason: t(`ofs1.fr.reason.${r.reason}`),
        note: r.note ? ` "${r.note}"` : "",
        place: t("sh.tab.leagues"),
        url: `${baseUrl()}/admin`,
      }),
    }),
    { managersOnly: true }
  );
  // A captain asked it: the other captain is told. Staff asked it: the venue's own matter until a manager decides.
  if (r.requester_kind === "captain" && r.requested_by_team !== null) {
    const other = r.requested_by_team === f.home_team ? f.away_team : f.home_team;
    await tellCaptainOf(
      other,
      (tr) => tr("ofc1.fr.mail.asked.s", { league: league.name }),
      (tr) =>
        sentences(
          tr,
          tr("ofc1.fr.mail.asked.b", { league: league.name, a: home?.name ?? "", b: away?.name ?? "", date: f.date, by: r.requested_by_name, team: asked?.name ?? "", reason: tr(`ofc1.fr.reason.${r.reason}`) }),
          r.note && tr("ofc1.fr.mail.note", { note: r.note }),
          tr("ofc1.fr.mail.asked.ask")
        )
    );
  }
}

/** The requester takes it back. Nothing else changes; the other captain is told if a captain asked. */
export async function withdrawForfeitRequest(by: Requester, requestId: number): Promise<TeamResult<null>> {
  const told: { f?: FixtureRow; r?: RequestRow } = {};
  const done = await withTransaction(async (): Promise<TeamResult<null>> => {
    const db = getDb();
    const first = (await db.prepare("SELECT league_id FROM team_forfeit_requests WHERE id = ?").get(requestId)) as { league_id: number } | undefined;
    if (!first) return teamRefusal("TL_NOT_FOUND", {}, 404);
    await db.prepare("SELECT id FROM team_leagues WHERE id = ? FOR UPDATE").get(first.league_id);
    const r = (await db.prepare(`${SELECT} WHERE r.id = ? FOR UPDATE OF r`).get(requestId)) as RequestRow | undefined;
    if (!r || r.requester_key !== keyOf(by)) return teamRefusal("TL_NOT_FOUND", {}, 404);
    if (r.status !== "open" || r.lapsed === true) return teamRefusal("TL_FR_GONE");
    await db.prepare("UPDATE team_forfeit_requests SET status = 'withdrawn', decided_at = datetime('now') WHERE id = ? AND status = 'open'").run(r.id);
    const league = (await teamLeagueById(r.league_id))!;
    const f = (await fixtureRow(r.fixture_id))!;
    told.f = f;
    told.r = r;
    await logAction("admin" in by ? by.admin : { id: null, name: `Captain of ${r.requested_by_name}` }, {
      venueId: league.venueId,
      action: "team_league.forfeit_request_withdrawn",
      detail: `${league.name}: ${(await leagueTeam(f.home_team))?.name ?? ""} v ${(await leagueTeam(f.away_team))?.name ?? ""} on ${f.date}: request withdrawn by ${r.requested_by_name}`,
    });
    return { ok: true, value: null };
  });
  if (!done.ok) return done;
  const f = told.f!;
  const r = told.r!;
  if (r.requester_kind === "captain" && r.requested_by_team !== null) {
    const league = (await teamLeagueById(f.league_id))!;
    await tellCaptainOf(
      r.requested_by_team === f.home_team ? f.away_team : f.home_team,
      (tr) => tr("ofc1.fr.mail.withdrawn.s", { league: league.name }),
      (tr) => tr("ofc1.fr.mail.withdrawn.b", { league: league.name, by: r.requested_by_name })
    );
  }
  return { ok: true, value: null };
}

class Rolled extends Error {
  constructor(readonly refusal: TeamRefusal) {
    super(refusal.error);
  }
}

/**
 * A manager decides a request. **Confirm** is the existing forfeit (`decideFixture` with `forfeitBy`), made in the same
 * transaction as the request being marked confirmed, so the two stand or fall together; the table before and after is
 * kept with the request. **Decline** needs a reason (3 to 300 characters), and both captains are told it.
 * `expected.version` is the fixture as the manager saw it.
 */
export async function decideForfeitRequest(requestId: number, admin: { id: number; name: string }, decision: ForfeitDecision, expected: { version?: number } = {}): Promise<TeamResult<ForfeitRequestView>> {
  const why = "decline" in decision ? (typeof decision.reason === "string" ? decision.reason.trim() : "") : "";
  if ("decline" in decision && (why.length < 3 || why.length > NOTE_MAX)) return teamRefusal("TL_FR_WHY", { max: NOTE_MAX }, 400);
  const after: { r?: RequestRow; f?: FixtureRow } = {};
  const done = await withTransaction(async (): Promise<TeamResult<null>> => {
    const db = getDb();
    const first = (await db.prepare("SELECT league_id FROM team_forfeit_requests WHERE id = ?").get(requestId)) as { league_id: number } | undefined;
    if (!first) return teamRefusal("TL_NOT_FOUND", {}, 404);
    await db.prepare("SELECT id FROM team_leagues WHERE id = ? FOR UPDATE").get(first.league_id);
    const r = (await db.prepare(`${SELECT} WHERE r.id = ? FOR UPDATE OF r`).get(requestId)) as RequestRow;
    if (r.status !== "open" || r.lapsed === true) return teamRefusal("TL_FR_GONE");
    const league = (await teamLeagueById(r.league_id))!;
    const f = (await fixtureRow(r.fixture_id, true))!;
    if (expected.version !== undefined && expected.version !== f.version) return teamRefusal("TL_CHANGED");
    const names = `${(await leagueTeam(f.home_team))?.name ?? ""} v ${(await leagueTeam(f.away_team))?.name ?? ""} on ${f.date}`;
    if ("decline" in decision) {
      await db
        .prepare("UPDATE team_forfeit_requests SET status = 'declined', decided_by_admin_id = ?, decided_by_name = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ? AND status = 'open'")
        .run(admin.id, admin.name, why, r.id);
      await logAction(admin, { venueId: league.venueId, action: "team_league.forfeit_declined", detail: `${league.name}: ${names}: request by ${r.requested_by_name} declined: ${why}` });
      after.r = r;
      after.f = f;
      return { ok: true, value: null };
    }
    const before = await tableNow(r.league_id);
    // Marked first, so the settling of the fixture below does not close it as "decided otherwise".
    await db
      .prepare("UPDATE team_forfeit_requests SET status = 'confirmed', decided_by_admin_id = ?, decided_by_name = ?, decided_at = datetime('now') WHERE id = ? AND status = 'open'")
      .run(admin.id, admin.name, r.id);
    // The existing forfeit path, whole: the template's forfeit scoring, the table, ratings, the court time let go.
    const forfeited = await decideFixture(f.id, admin.id, { forfeitBy: r.forfeit_team });
    if (!forfeited.ok) throw new Rolled(forfeited);
    const now = await tableNow(r.league_id);
    await db.prepare("UPDATE team_forfeit_requests SET standings_before = ?, standings_after = ? WHERE id = ?").run(JSON.stringify(before), JSON.stringify(now), r.id);
    const mark = (lines: StandingLine[]) => lines.filter((l) => l.teamId === f.home_team || l.teamId === f.away_team).map((l) => `${l.name} ${l.position}. ${l.points}pts`).join(", ");
    await logAction(admin, {
      venueId: league.venueId,
      action: "team_league.forfeit_confirmed",
      detail: `${league.name}: ${names}: ${(await leagueTeam(r.forfeit_team))?.name ?? ""} forfeit, asked by ${r.requested_by_name} (${r.reason}). Table before: ${mark(before)}; after: ${mark(now)}`,
    });
    after.r = r;
    after.f = f;
    return { ok: true, value: null };
  }).catch((err) => {
    if (err instanceof Rolled) return err.refusal;
    throw err;
  });
  if (!done.ok) return done;
  const r = after.r!;
  const f = after.f!;
  // A confirmation is told to both captains by the forfeit itself (`decideFixture`); a decline is told here, with the reason.
  if ("decline" in decision) {
    const league = (await teamLeagueById(r.league_id))!;
    const [home, away] = [(await leagueTeam(f.home_team))?.name ?? "", (await leagueTeam(f.away_team))?.name ?? ""];
    for (const lt of [f.home_team, f.away_team])
      await tellCaptainOf(
        lt,
        (tr) => tr("ofc1.fr.mail.declined.s", { league: league.name }),
        (tr) => tr("ofc1.fr.mail.declined.b", { league: league.name, a: home, b: away, date: f.date, by: r.requested_by_name, why })
      );
  }
  return { ok: true, value: (await oneView(requestId, null, true))! };
}

/**
 * Requests on fixtures now decided any other way are closed (inside the transaction that decided them: it is called by
 * `settleLeague`). One that was the manager's own confirmation was marked confirmed before, and is not touched.
 */
export async function closeSettledForfeitRequests(leagueId: number): Promise<void> {
  await getDb()
    .prepare(
      `UPDATE team_forfeit_requests SET status = 'closed', closed_reason = 'decided', decided_at = datetime('now')
        WHERE league_id = ? AND status = 'open' AND fixture_id IN (SELECT id FROM team_fixtures WHERE league_id = ? AND status IN ('confirmed', 'forfeit', 'void'))`
    )
    .run(leagueId, leagueId);
}

/** The scheduler's: requests past their 14 days expire, and the captain who asked is told. Returns how many. */
export async function expireForfeitRequests(): Promise<number> {
  const db = getDb();
  const due = (await db.prepare("SELECT id FROM team_forfeit_requests WHERE status = 'open' AND ladder_challenge_id IS NULL AND expires_at <= datetime('now') ORDER BY id").all()) as { id: number }[];
  let n = 0;
  for (const d of due) {
    const r = await withTransaction(async () => {
      const row = (await db.prepare("SELECT * FROM team_forfeit_requests WHERE id = ? FOR UPDATE").get(d.id)) as RequestRow | undefined;
      if (!row || row.status !== "open") return null;
      await db.prepare("UPDATE team_forfeit_requests SET status = 'expired', decided_at = datetime('now') WHERE id = ? AND status = 'open'").run(row.id);
      return row;
    });
    if (!r) continue;
    n++;
    if (r.requester_kind === "captain" && r.requested_by_team !== null) {
      const f = await fixtureRow(r.fixture_id);
      const league = (await teamLeagueById(r.league_id))!;
      if (f)
        await tellCaptainOf(
          r.requested_by_team,
          (tr) => tr("ofc1.fr.mail.expired.s", { league: league.name }),
          (tr) => tr("ofc1.fr.mail.expired.b", { league: league.name, days: FORFEIT_REQUEST_DAYS, date: f.date })
        );
    }
  }
  return n;
}

// ------------------------------------------------------------ a ladder of teams

/**
 * The same request for a challenge on a **ladder of teams** (ADR 0040; migration 0283): a forfeit there changes the ranks, so giving one is a
 * manager's act, as it is in a league. A team's captain, or a member of staff, may ask; the request records who asked, which of the
 * challenge's two teams is asked to forfeit, a reason from the same short list and up to 300 characters of free text, and changes nothing else.
 * A manager confirms it (the ladder's own `decide` with a walkover: the other team wins by default and takes the place, the ledger and the ratings
 * follow, any court held is let go) or declines it with a reason. It expires after 14 days and closes by itself once the challenge ends any other way.
 * The same table, the same reasons, the same constants; only the subject is a ladder challenge and the places in it.
 */
interface LadderRequestRow {
  id: number;
  ladder_challenge_id: number;
  forfeit_player: number;
  requester_key: string;
  requester_kind: "captain" | "staff";
  requested_by_player: number | null;
  requested_by_name: string;
  reason: ForfeitReason;
  note: string | null;
  status: RequestStatus;
  created_at: string;
  expires_at: string;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  closed_reason: string | null;
  lapsed?: boolean;
}

export interface LadderForfeitRequestView {
  id: number;
  challengeId: number;
  /** The team asked to forfeit, by the name it is on the ladder under. */
  forfeitTeam: { id: number; name: string };
  by: string;
  byKind: "captain" | "staff";
  reason: ForfeitReason;
  note: string | null;
  status: RequestStatus;
  createdAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  closedReason: string | null;
  mine: boolean;
}

const LSELECT = "SELECT r.*, (r.status = 'open' AND r.expires_at <= datetime('now')) AS lapsed FROM team_forfeit_requests r";

async function ladderView(rows: LadderRequestRow[], viewerKey: string | null): Promise<LadderForfeitRequestView[]> {
  const names = new Map<number, string>();
  for (const id of new Set(rows.map((r) => r.forfeit_player))) names.set(id, ((await getDb().prepare("SELECT name FROM ladder_players WHERE id = ?").get(id)) as { name: string } | undefined)?.name ?? "");
  return rows.map((r) => ({
    id: r.id,
    challengeId: r.ladder_challenge_id,
    forfeitTeam: { id: r.forfeit_player, name: names.get(r.forfeit_player) ?? "" },
    by: r.requested_by_name,
    byKind: r.requester_kind,
    reason: r.reason,
    note: r.note,
    status: r.status === "open" && r.lapsed === true ? "expired" : r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    decidedBy: r.decided_by_name,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    closedReason: r.closed_reason,
    mine: viewerKey !== null && r.requester_key === viewerKey,
  }));
}

/** Requests by challenge: staff see every one, a captain those on their own challenges (the ones asked for them to see), nobody else any. */
export async function ladderForfeitRequests(challengeIds: number[], viewer: { forStaff: boolean; viewerId: number | null }): Promise<Map<number, LadderForfeitRequestView[]>> {
  const out = new Map<number, LadderForfeitRequestView[]>();
  if (challengeIds.length === 0 || (!viewer.forStaff && viewer.viewerId === null)) return out;
  const rows = (await getDb()
    .prepare(`${LSELECT} WHERE r.ladder_challenge_id IN (${challengeIds.map(() => "?").join(",")}) ORDER BY r.id DESC`)
    .all(...challengeIds)) as LadderRequestRow[];
  for (const v of await ladderView(rows, viewer.viewerId === null ? null : `u:${viewer.viewerId}`)) out.set(v.challengeId, [...(out.get(v.challengeId) ?? []), v]);
  return out;
}

async function oneLadderView(id: number, viewerKey: string | null): Promise<LadderForfeitRequestView | null> {
  const row = (await getDb().prepare(`${LSELECT} WHERE r.id = ?`).get(id)) as LadderRequestRow | undefined;
  return row ? (await ladderView([row], viewerKey))[0] : null;
}

/** A captain of one of the challenge's two teams, or a member of staff, asks the venue to call a forfeit. It changes nothing but the request. */
export async function requestLadderForfeit(by: Requester, challengeId: number, input: { forfeitPlayer: unknown; reason: unknown; note?: unknown }): Promise<LadderResult<LadderForfeitRequestView>> {
  const reason = FORFEIT_REASONS.find((r) => r === input.reason);
  if (!reason) return ladderRefusal("TL_FR_REASON", {}, 400);
  const note = readNote(reason, input.note);
  if (!note.ok) return { ...note.refusal, status: note.refusal.status ?? 400 };
  const asked: { ch?: ChallengeRow; row?: LadderRequestRow; ladderId?: number } = {};
  const made = await withTransaction(async (): Promise<LadderResult<number>> => {
    const db = getDb();
    const first = (await db.prepare("SELECT ladder_id FROM ladder_challenges WHERE id = ?").get(challengeId)) as { ladder_id: number } | undefined;
    if (!first) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
    await db.prepare("SELECT id FROM ladders WHERE id = ? FOR UPDATE").get(first.ladder_id);
    const ch = (await db.prepare("SELECT * FROM ladder_challenges WHERE id = ? FOR UPDATE").get(challengeId)) as ChallengeRow;
    const ladder = (await ladderById(ch.ladder_id))!;
    if (ladder.kind !== "teams") return ladderRefusal("LAD2_NOT_TEAMS", {}, 400);
    let asker: string;
    let askerPlace: number | null = null;
    if ("userId" in by) {
      const found = await challengeFor(by.userId, challengeId);
      if (!found) return ladderRefusal("LD_NO_CHALLENGE", {}, 404);
      askerPlace = found.myId;
      asker = ((await db.prepare("SELECT name FROM ladder_players WHERE id = ?").get(found.myId)) as { name: string }).name;
    } else asker = by.admin.name;
    if (ch.status !== "accepted") return ladderRefusal("LAD2_NOT_ACCEPTED");
    const team = Number(input.forfeitPlayer);
    if (team !== ch.challenger && team !== ch.challenged) return ladderRefusal("LAD2_FR_TEAM", {}, 400);
    const key = keyOf(by);
    await db.prepare("UPDATE team_forfeit_requests SET status = 'expired' WHERE ladder_challenge_id = ? AND requester_key = ? AND status = 'open' AND expires_at <= datetime('now')").run(ch.id, key);
    if (await db.prepare("SELECT 1 FROM team_forfeit_requests WHERE ladder_challenge_id = ? AND requester_key = ? AND status = 'open'").get(ch.id, key)) return ladderRefusal("LAD2_FR_OPEN");
    const row = (await db
      .prepare(
        `INSERT INTO team_forfeit_requests (ladder_challenge_id, forfeit_player, requester_key, requester_kind, requested_by_user_id, requested_by_player, requested_by_admin_id, requested_by_name, reason, note, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+${FORFEIT_REQUEST_DAYS} days')) RETURNING *`
      )
      .get(ch.id, team, key, "userId" in by ? "captain" : "staff", "userId" in by ? by.userId : null, askerPlace, "admin" in by ? by.admin.id : null, asker, reason, note.note)) as LadderRequestRow;
    const names = new Map(((await db.prepare("SELECT id, name FROM ladder_players WHERE id IN (?, ?)").all(ch.challenger, ch.challenged)) as { id: number; name: string }[]).map((r) => [r.id, r.name]));
    await logAction("admin" in by ? by.admin : { id: null, name: `Captain of ${asker}` }, {
      venueId: ladder.venueId,
      action: "ladder.forfeit_requested",
      detail: `${ladder.name}: ${names.get(ch.challenger) ?? ""} v ${names.get(ch.challenged) ?? ""}: ${names.get(team) ?? ""} asked to forfeit (${reason}) by ${asker}`,
    });
    asked.ch = ch;
    asked.row = row;
    asked.ladderId = ladder.id;
    return { ok: true, value: row.id };
  });
  if (!made.ok) return made;
  const ladder = (await ladderById(asked.ladderId!))!;
  const ch = asked.ch!;
  const row = asked.row!;
  const names = new Map(((await getDb().prepare("SELECT id, name FROM ladder_players WHERE id IN (?, ?)").all(ch.challenger, ch.challenged)) as { id: number; name: string }[]).map((r) => [r.id, r.name]));
  await tellVenueStaffEach(
    ladder.venueId,
    (t) => ({
      subject: t("lad2.fr.alert.s", { ladder: ladder.name }),
      body: t("lad2.fr.alert.b", {
        ladder: ladder.name,
        a: names.get(ch.challenger) ?? "",
        b: names.get(ch.challenged) ?? "",
        team: names.get(row.forfeit_player) ?? "",
        by: row.requested_by_name,
        reason: t(`ofs1.fr.reason.${row.reason}`),
        note: row.note ? ` "${row.note}"` : "",
        place: t("sh.tab.leagues"),
        url: `${baseUrl()}/admin`,
      }),
    }),
    { managersOnly: true }
  );
  // A captain asked: the other captain is told. Staff asked: the venue's own matter until a manager decides.
  if (row.requester_kind === "captain" && row.requested_by_player !== null) {
    const other = row.requested_by_player === ch.challenger ? ch.challenged : ch.challenger;
    await tellPlayer(
      other,
      ladder,
      (tr) => tr("lad2.fr.mail.asked.s", { l: ladder.name }),
      (tr) =>
        sentences(
          tr,
          tr("lad2.fr.mail.asked.b", { l: ladder.name, a: names.get(ch.challenger) ?? "", b: names.get(ch.challenged) ?? "", by: row.requested_by_name, team: names.get(row.forfeit_player) ?? "", reason: tr(`ofc1.fr.reason.${row.reason}`) }),
          row.note && tr("ofc1.fr.mail.note", { note: row.note }),
          tr("ofc1.fr.mail.asked.ask")
        )
    );
  }
  return { ok: true, value: (await oneLadderView(made.value, "userId" in by ? `u:${by.userId}` : `a:${by.admin.id}`))! };
}

/** The requester takes it back. Nothing else changes. */
export async function withdrawLadderForfeitRequest(by: Requester, requestId: number): Promise<LadderResult<null>> {
  return withTransaction(async (): Promise<LadderResult<null>> => {
    const db = getDb();
    const first = (await db.prepare("SELECT r.ladder_challenge_id, c.ladder_id FROM team_forfeit_requests r JOIN ladder_challenges c ON c.id = r.ladder_challenge_id WHERE r.id = ?").get(requestId)) as { ladder_id: number } | undefined;
    if (!first) return ladderRefusal("TL_NOT_FOUND", {}, 404);
    await db.prepare("SELECT id FROM ladders WHERE id = ? FOR UPDATE").get(first.ladder_id);
    const r = (await db.prepare(`${LSELECT} WHERE r.id = ? FOR UPDATE OF r`).get(requestId)) as LadderRequestRow | undefined;
    if (!r || r.requester_key !== keyOf(by)) return ladderRefusal("TL_NOT_FOUND", {}, 404);
    if (r.status !== "open" || r.lapsed === true) return ladderRefusal("TL_FR_GONE");
    await db.prepare("UPDATE team_forfeit_requests SET status = 'withdrawn', decided_at = datetime('now') WHERE id = ? AND status = 'open'").run(r.id);
    const ladder = (await ladderById(first.ladder_id))!;
    await logAction("admin" in by ? by.admin : { id: null, name: `Captain of ${r.requested_by_name}` }, {
      venueId: ladder.venueId,
      action: "ladder.forfeit_request_withdrawn",
      detail: `${ladder.name}: request withdrawn by ${r.requested_by_name}`,
    });
    return { ok: true, value: null };
  });
}

class LadderRolled extends Error {
  constructor(readonly refusal: Exclude<LadderResult<unknown>, { ok: true }>) {
    super(refusal.error);
  }
}

/**
 * A manager decides a request. **Confirm** is the ladder's own `decide` with a walkover to the other team, made in the same transaction as the
 * request being marked confirmed, so the two stand or fall together. **Decline** needs a reason (3 to 300 characters), and both captains are told.
 */
export async function decideLadderForfeitRequest(requestId: number, admin: { id: number; name: string }, decision: ForfeitDecision): Promise<LadderResult<LadderForfeitRequestView>> {
  const why = "decline" in decision ? (typeof decision.reason === "string" ? decision.reason.trim() : "") : "";
  if ("decline" in decision && (why.length < 3 || why.length > NOTE_MAX)) return ladderRefusal("TL_FR_WHY", { max: NOTE_MAX }, 400);
  const after: { r?: LadderRequestRow; ch?: ChallengeRow; ladderId?: number } = {};
  const done = await withTransaction(async (): Promise<LadderResult<null>> => {
    const db = getDb();
    const first = (await db.prepare("SELECT r.ladder_challenge_id, c.ladder_id FROM team_forfeit_requests r JOIN ladder_challenges c ON c.id = r.ladder_challenge_id WHERE r.id = ?").get(requestId)) as { ladder_challenge_id: number; ladder_id: number } | undefined;
    if (!first) return ladderRefusal("TL_NOT_FOUND", {}, 404);
    await db.prepare("SELECT id FROM ladders WHERE id = ? FOR UPDATE").get(first.ladder_id);
    const r = (await db.prepare(`${LSELECT} WHERE r.id = ? FOR UPDATE OF r`).get(requestId)) as LadderRequestRow;
    if (r.status !== "open" || r.lapsed === true) return ladderRefusal("TL_FR_GONE");
    const ladder = (await ladderById(first.ladder_id))!;
    const ch = (await db.prepare("SELECT * FROM ladder_challenges WHERE id = ? FOR UPDATE").get(first.ladder_challenge_id)) as ChallengeRow;
    const names = new Map(((await db.prepare("SELECT id, name FROM ladder_players WHERE id IN (?, ?)").all(ch.challenger, ch.challenged)) as { id: number; name: string }[]).map((x) => [x.id, x.name]));
    const text = `${names.get(ch.challenger) ?? ""} v ${names.get(ch.challenged) ?? ""}`;
    after.r = r;
    after.ch = ch;
    after.ladderId = ladder.id;
    if ("decline" in decision) {
      await db.prepare("UPDATE team_forfeit_requests SET status = 'declined', decided_by_admin_id = ?, decided_by_name = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ? AND status = 'open'").run(admin.id, admin.name, why, r.id);
      await logAction(admin, { venueId: ladder.venueId, action: "ladder.forfeit_declined", detail: `${ladder.name}: ${text}: request by ${r.requested_by_name} declined: ${why}` });
      return { ok: true, value: null };
    }
    // Marked first, so settling the challenge below does not close it as "decided otherwise".
    await db.prepare("UPDATE team_forfeit_requests SET status = 'confirmed', decided_by_admin_id = ?, decided_by_name = ?, decided_at = datetime('now') WHERE id = ? AND status = 'open'").run(admin.id, admin.name, r.id);
    const winner = r.forfeit_player === ch.challenger ? ch.challenged : ch.challenger;
    const decided = await decide(ch.id, { adminId: admin.id, name: admin.name }, { winner, walkover: true }, `Forfeit asked for by ${r.requested_by_name} (${r.reason}), confirmed`);
    if (!decided.ok) throw new LadderRolled(decided);
    await logAction(admin, { venueId: ladder.venueId, action: "ladder.forfeit_confirmed", detail: `${ladder.name}: ${text}: ${names.get(r.forfeit_player) ?? ""} forfeit, asked by ${r.requested_by_name} (${r.reason})` });
    return { ok: true, value: null };
  }).catch((err) => {
    if (err instanceof LadderRolled) return err.refusal;
    throw err;
  });
  if (!done.ok) return done;
  if ("decline" in decision) {
    const r = after.r!;
    const ch = after.ch!;
    const ladder = (await ladderById(after.ladderId!))!;
    const names = new Map(((await getDb().prepare("SELECT id, name FROM ladder_players WHERE id IN (?, ?)").all(ch.challenger, ch.challenged)) as { id: number; name: string }[]).map((x) => [x.id, x.name]));
    for (const id of [ch.challenger, ch.challenged])
      await tellPlayer(
        id,
        ladder,
        (tr) => tr("lad2.fr.mail.declined.s", { l: ladder.name }),
        (tr) => tr("lad2.fr.mail.declined.b", { l: ladder.name, a: names.get(ch.challenger) ?? "", b: names.get(ch.challenged) ?? "", by: r.requested_by_name, why })
      );
  }
  return { ok: true, value: (await oneLadderView(requestId, null))! };
}

/**
 * The scheduler's: requests on challenges that ended any other way are closed, and those past their 14 days expire, the captain who asked told.
 * Running it again changes nothing it has done.
 */
export async function housekeepLadderForfeits(): Promise<number> {
  const db = getDb();
  await db
    .prepare(
      `UPDATE team_forfeit_requests SET status = 'closed', closed_reason = 'decided', decided_at = datetime('now')
        WHERE ladder_challenge_id IS NOT NULL AND status = 'open'
          AND ladder_challenge_id IN (SELECT id FROM ladder_challenges WHERE status NOT IN ('accepted'))`
    )
    .run();
  const due = (await db.prepare("SELECT id FROM team_forfeit_requests WHERE status = 'open' AND ladder_challenge_id IS NOT NULL AND expires_at <= datetime('now') ORDER BY id").all()) as { id: number }[];
  let n = 0;
  for (const d of due) {
    const r = await withTransaction(async () => {
      const row = (await db.prepare("SELECT * FROM team_forfeit_requests WHERE id = ? FOR UPDATE").get(d.id)) as LadderRequestRow | undefined;
      if (!row || row.status !== "open") return null;
      await db.prepare("UPDATE team_forfeit_requests SET status = 'expired', decided_at = datetime('now') WHERE id = ? AND status = 'open'").run(row.id);
      return row;
    });
    if (!r) continue;
    n++;
    if (r.requester_kind === "captain" && r.requested_by_player !== null) {
      const ch = (await db.prepare("SELECT ladder_id FROM ladder_challenges WHERE id = ?").get(r.ladder_challenge_id)) as { ladder_id: number } | undefined;
      const ladder = ch ? await ladderById(ch.ladder_id) : null;
      if (ladder)
        await tellPlayer(
          r.requested_by_player,
          ladder,
          (tr) => tr("lad2.fr.mail.expired.s", { l: ladder.name }),
          (tr) => tr("lad2.fr.mail.expired.b", { l: ladder.name, days: FORFEIT_REQUEST_DAYS })
        );
    }
  }
  return n;
}
