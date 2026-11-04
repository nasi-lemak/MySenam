import { getDb, withTransaction } from "./db";
import { logAction } from "./activity";
import { isLocale, translator, type Locale } from "./i18n";
import { instantOf } from "./interval";
import { guardianshipOf, participantEvent, refused, type ParticipantRefusal } from "./participants";
import type { EventKind } from "./public-names";
import { siteName } from "./site";
import { todayISO } from "./time";
import { venueZoneOf } from "./zones";

/**
 * A guardian's authorisation to show a child's full name on public pages (docs/architecture/privacy.md#minors-names-on-public-pages;
 * migration 0274). By default a declared minor is shown by first name and the initial of the next everywhere the public can see
 * (lib/public-names.ts); this is the one exception, and it is the guardian's alone:
 *
 * - only an account that manages the participant now (ADR 0022: a live, unpaused, unarchived guardianship) can give it. Never the
 *   participant's own login, never staff or a manager, never a venue ticking a box for them, never implied by entering;
 * - per child and per scope: this one event (a tournament, or a league's or ladder's current season), or every competitive entry
 *   the child has at one venue, for 12 months;
 * - recorded as declared: who, when, which scope, and the wording the guardian saw, in the language they saw it in;
 * - withdrawn at once by any guardian who manages the child; the public pages read it live on every request, so a withdrawal is
 *   in force on the next one;
 * - it ends by itself with the event or the season, after its twelve months, or when the guardian stops managing the child;
 * - logged in the child's history and the venue's staff log, in the guardian's data export, and erased with the guardian.
 *
 * The law on publishing a child's name is not settled by this code: the wording awaits the owner's lawyer's review.
 */

/** How long a venue-wide authorisation lasts. */
export const BROAD_MONTHS = 12;

export type ConsentRefusal = ParticipantRefusal;

const refuse = (code: string, error: string, status = 409): ConsentRefusal => refused(code, error, status);

/** What the guardian is asked, in a language: also what is stored as the wording they saw. */
export function wordingFor(locale: Locale, input: { child: string; scope: "event" | "venue"; event?: string; venue: string }): string {
  const tr = translator(locale, siteName());
  return input.scope === "event"
    ? tr("pn1.wording.event", { child: input.child, event: input.event ?? "", venue: input.venue })
    : tr("pn1.wording.venue", { child: input.child, venue: input.venue, months: BROAD_MONTHS });
}

interface EventInfo {
  venueId: number;
  venueName: string;
  name: string;
  seasonId: number | null;
  /** The latest the authorisation can apply. */
  expiresAt: string;
}

/** The event (and its season, for a league or a ladder) the child holds a place in, and when its authorisation must end. */
async function eventFor(participantId: number, kind: EventKind, id: number): Promise<EventInfo | ConsentRefusal> {
  const db = getDb();
  const zoneOf = (v: { time_zone: string | null; lat: number | null; lng: number | null }) => venueZoneOf(v);
  const cap = (await db.prepare(`SELECT (now() + interval '${BROAD_MONTHS} months') AS at`).get()) as { at: unknown };
  const capIso = new Date(cap.at as string | Date).toISOString();
  if (kind === "tournament") {
    const t = (await db
      .prepare(
        `SELECT t.venue_id, t.name, t.ends_on, t.status, v.name AS venue_name, v.time_zone, v.lat, v.lng,
                EXISTS (SELECT 1 FROM tournament_entries e WHERE e.tournament_id = t.id AND e.participant_id = ? AND e.status <> 'withdrawn') AS entered
           FROM tournaments t JOIN venues v ON v.id = t.venue_id WHERE t.id = ?`
      )
      .get(participantId, id)) as { venue_id: number; name: string; ends_on: string; status: string; venue_name: string; time_zone: string | null; lat: number | null; lng: number | null; entered: boolean } | undefined;
    if (!t || !t.entered) return refuse("PN1_NO_ENTRY", "They have no entry in that event.", 404);
    const zone = zoneOf(t);
    if (t.status === "cancelled" || t.ends_on < todayISO(zone)) return refuse("PN1_OVER", "That event is over.");
    return { venueId: t.venue_id, venueName: t.venue_name, name: t.name, seasonId: null, expiresAt: instantOf(t.ends_on, 24 * 60, zone).toISOString() };
  }
  if (kind === "league") {
    const l = (await db
      .prepare(
        `SELECT l.venue_id, l.name, l.status, v.name AS venue_name,
                EXISTS (SELECT 1 FROM league_players p WHERE p.league_id = l.id AND p.participant_id = ? AND p.status = 'active') AS entered,
                (SELECT s.id FROM league_seasons s WHERE s.league_id = l.id AND s.status <> 'finished' ORDER BY s.number DESC LIMIT 1) AS season_id
           FROM leagues l JOIN venues v ON v.id = l.venue_id WHERE l.id = ?`
      )
      .get(participantId, id)) as { venue_id: number; name: string; status: string; venue_name: string; entered: boolean; season_id: number | null } | undefined;
    if (!l || !l.entered) return refuse("PN1_NO_ENTRY", "They have no place in that league.", 404);
    if (l.season_id === null) return refuse("PN1_NO_SEASON", "No season is planned or running yet: allow it once there is one.");
    return { venueId: l.venue_id, venueName: l.venue_name, name: l.name, seasonId: l.season_id, expiresAt: capIso };
  }
  const l = (await db
    .prepare(
      `SELECT l.venue_id, l.name, v.name AS venue_name,
              EXISTS (SELECT 1 FROM ladder_players p WHERE p.ladder_id = l.id AND p.participant_id = ? AND p.status = 'active') AS entered,
              (SELECT s.id FROM ladder_seasons s WHERE s.ladder_id = l.id AND s.ended_on IS NULL ORDER BY s.number DESC LIMIT 1) AS season_id
         FROM ladders l JOIN venues v ON v.id = l.venue_id WHERE l.id = ?`
    )
    .get(participantId, id)) as { venue_id: number; name: string; venue_name: string; entered: boolean; season_id: number | null } | undefined;
  if (!l || !l.entered) return refuse("PN1_NO_ENTRY", "They have no place on that ladder.", 404);
  if (l.season_id === null) return refuse("PN1_NO_SEASON", "No season is running yet: allow it once there is one.");
  return { venueId: l.venue_id, venueName: l.venue_name, name: l.name, seasonId: l.season_id, expiresAt: capIso };
}

export interface Consent {
  id: number;
  participantId: number;
  scope: "event" | "venue";
  venueId: number;
  venueName: string;
  eventKind: EventKind | null;
  eventId: number | null;
  eventName: string | null;
  grantedAt: string;
  expiresAt: string;
  /** Given by the account asking, or by another guardian of the child. */
  byYou: boolean;
  wording: string;
  wordingLocale: string;
}

interface ConsentRow {
  id: number;
  participant_id: number;
  scope: "event" | "venue";
  venue_id: number;
  venue_name: string;
  time_zone: string | null;
  lat: number | null;
  lng: number | null;
  event_kind: EventKind | null;
  event_id: number | null;
  season_id: number | null;
  event_name: string | null;
  event_ends_on: string | null;
  season_over: boolean | null;
  granted_by_user_id: number | null;
  wording: string;
  wording_locale: string;
  granted_at: unknown;
  expires_at: unknown;
  revoked_at: unknown;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

const CONSENT_SELECT = `
  SELECT c.id, c.participant_id, c.scope, c.venue_id, v.name AS venue_name, v.time_zone, v.lat, v.lng, c.event_kind, c.event_id, c.season_id,
         c.granted_by_user_id, c.wording, c.wording_locale, c.granted_at, c.expires_at, c.revoked_at,
         CASE c.event_kind WHEN 'tournament' THEN (SELECT t.name FROM tournaments t WHERE t.id = c.event_id)
                           WHEN 'league' THEN (SELECT l.name FROM leagues l WHERE l.id = c.event_id)
                           WHEN 'ladder' THEN (SELECT l.name FROM ladders l WHERE l.id = c.event_id) END AS event_name,
         (SELECT t.ends_on FROM tournaments t WHERE c.event_kind = 'tournament' AND t.id = c.event_id) AS event_ends_on,
         CASE c.event_kind WHEN 'league' THEN COALESCE((SELECT s.status = 'finished' FROM league_seasons s WHERE s.id = c.season_id), true)
                           WHEN 'ladder' THEN COALESCE((SELECT s.ended_on IS NOT NULL FROM ladder_seasons s WHERE s.id = c.season_id), true) END AS season_over
    FROM public_name_consents c JOIN venues v ON v.id = c.venue_id`;

/** Whether an unwithdrawn authorisation still applies today (the same conditions the public pages read: lib/public-names.ts `authorisedParticipants`). */
function inForce(r: ConsentRow, now: number): boolean {
  if (r.revoked_at) return false;
  if (new Date(iso(r.expires_at)).getTime() <= now) return false;
  if (r.scope === "venue") return true;
  if (r.event_kind === "tournament") return r.event_ends_on !== null && r.event_ends_on >= todayISO(venueZoneOf(r));
  return r.season_over === false;
}

/** Every guardian of the participant but the one at the stage given: who may still be asked (a live guardianship, as the public pages require). */
async function liveGuardians(participantId: number): Promise<Set<number>> {
  const rows = (await getDb()
    .prepare("SELECT user_id FROM participant_guardians WHERE participant_id = ? AND user_id IS NOT NULL AND revoked_at IS NULL AND suspended_at IS NULL AND archived_at IS NULL")
    .all(participantId)) as { user_id: number }[];
  return new Set(rows.map((r) => r.user_id));
}

/** The authorisations in force for a child now (given by any guardian who still manages them). */
async function inForceFor(participantId: number, userId: number): Promise<Consent[]> {
  const rows = (await getDb().prepare(`${CONSENT_SELECT} WHERE c.participant_id = ? AND c.revoked_at IS NULL ORDER BY c.id`).all(participantId)) as ConsentRow[];
  const guardians = await liveGuardians(participantId);
  const now = Date.now();
  return rows
    .filter((r) => r.granted_by_user_id !== null && guardians.has(r.granted_by_user_id) && inForce(r, now))
    .map((r) => ({
      id: r.id,
      participantId: r.participant_id,
      scope: r.scope,
      venueId: r.venue_id,
      venueName: r.venue_name,
      eventKind: r.event_kind,
      eventId: r.event_id,
      eventName: r.event_name,
      grantedAt: iso(r.granted_at),
      expiresAt: iso(r.expires_at),
      byYou: r.granted_by_user_id === userId,
      wording: r.wording,
      wordingLocale: r.wording_locale,
    }));
}

export interface PublicNameChoice {
  kind: EventKind;
  id: number;
  name: string;
  venueId: number;
  venueName: string;
  /** Where it ends: an event's last day, or "season". */
  until: string | null;
}

export interface PublicNames {
  participant: { id: number; displayName: string };
  /** The places the child holds now, each of which an authorisation could be given for. */
  choices: PublicNameChoice[];
  /** Venues where they hold a place now: each can be allowed for all the child's entries there, for BROAD_MONTHS. */
  venues: { id: number; name: string }[];
  /** What is in force now, each withdrawable. */
  consents: Consent[];
  months: number;
}

/** The child's competitive places now, and the authorisations in force: for the guardian's page only. */
export async function publicNamesFor(userId: number, participantId: unknown): Promise<PublicNames | ConsentRefusal> {
  const g = await guardianshipOf(userId, participantId, { live: true });
  if (!g) return refuse("PN1_NOT_GUARDIAN", "You do not manage them.", 403);
  const p = g.participant;
  const db = getDb();
  const today = todayISO();
  const tournaments = (await db
    .prepare(
      `SELECT t.id, t.name, t.venue_id, v.name AS venue_name, t.ends_on FROM tournaments t JOIN venues v ON v.id = t.venue_id
        WHERE t.status <> 'cancelled' AND t.ends_on >= ? AND EXISTS (SELECT 1 FROM tournament_entries e WHERE e.tournament_id = t.id AND e.participant_id = ? AND e.status <> 'withdrawn')
        ORDER BY t.starts_on, t.id`
    )
    .all(addDaysLoose(today, -1), p.id)) as { id: number; name: string; venue_id: number; venue_name: string; ends_on: string }[];
  const leagues = (await db
    .prepare(
      `SELECT l.id, l.name, l.venue_id, v.name AS venue_name FROM leagues l JOIN venues v ON v.id = l.venue_id
        WHERE l.status = 'running' AND EXISTS (SELECT 1 FROM league_players x WHERE x.league_id = l.id AND x.participant_id = ? AND x.status = 'active')
          AND EXISTS (SELECT 1 FROM league_seasons s WHERE s.league_id = l.id AND s.status <> 'finished') ORDER BY l.id`
    )
    .all(p.id)) as { id: number; name: string; venue_id: number; venue_name: string }[];
  const ladders = (await db
    .prepare(
      `SELECT l.id, l.name, l.venue_id, v.name AS venue_name FROM ladders l JOIN venues v ON v.id = l.venue_id
        WHERE l.status = 'open' AND EXISTS (SELECT 1 FROM ladder_players x WHERE x.ladder_id = l.id AND x.participant_id = ? AND x.status = 'active')
          AND EXISTS (SELECT 1 FROM ladder_seasons s WHERE s.ladder_id = l.id AND s.ended_on IS NULL) ORDER BY l.id`
    )
    .all(p.id)) as { id: number; name: string; venue_id: number; venue_name: string }[];
  const choices: PublicNameChoice[] = [
    ...tournaments.filter((t) => t.ends_on >= todayISO()).map((t) => ({ kind: "tournament" as const, id: t.id, name: t.name, venueId: t.venue_id, venueName: t.venue_name, until: t.ends_on })),
    ...leagues.map((l) => ({ kind: "league" as const, id: l.id, name: l.name, venueId: l.venue_id, venueName: l.venue_name, until: null })),
    ...ladders.map((l) => ({ kind: "ladder" as const, id: l.id, name: l.name, venueId: l.venue_id, venueName: l.venue_name, until: null })),
  ];
  const venues = [...new Map(choices.map((c) => [c.venueId, { id: c.venueId, name: c.venueName }])).values()];
  return { participant: { id: p.id, displayName: p.displayName }, choices, venues, consents: await inForceFor(p.id, userId), months: BROAD_MONTHS };
}

// An ISO date shifted by whole days, without the time-zone sensitive helper: the lower bound of a list, not a rule.
function addDaysLoose(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type AuthoriseInput =
  | { participantId: unknown; scope: "event"; kind: unknown; eventId: unknown; locale?: unknown; confirm: unknown }
  | { participantId: unknown; scope: "venue"; venueId: unknown; locale?: unknown; confirm: unknown };

/**
 * The guardian authorises the child's full name on public pages. `confirm: true` is required: nothing implies it. The guardianship is
 * checked in the transaction, with the participant's row locked, so a relationship ended a moment ago gives nothing.
 */
export async function authorise(user: { id: number; name: string }, input: Record<string, unknown>): Promise<{ ok: true; value: Consent; already: boolean } | ConsentRefusal> {
  if (input.confirm !== true) return refuse("PN1_CONFIRM", "Say that you understand what becomes public: tick the box.", 400);
  const scope = input.scope;
  if (scope !== "event" && scope !== "venue") return refuse("PN1_SCOPE", "Choose one event, or every entry at one venue.", 400);
  const locale: Locale = typeof input.locale === "string" && isLocale(input.locale) ? input.locale : "en";
  return withTransaction(async () => {
    const db = getDb();
    const g = await guardianshipOf(user.id, input.participantId, { live: true });
    if (!g) return refuse("PN1_NOT_GUARDIAN", "You do not manage them.", 403);
    const p = g.participant;
    await db.prepare("SELECT id FROM participants WHERE id = ? FOR UPDATE").get(p.id);
    let venueId: number;
    let venueName: string;
    let eventKind: EventKind | null = null;
    let eventId: number | null = null;
    let eventName: string | undefined;
    let seasonId: number | null = null;
    let expires: string | null = null;
    if (scope === "event") {
      const kind = input.kind;
      const id = Number(input.eventId);
      if ((kind !== "tournament" && kind !== "league" && kind !== "ladder") || !Number.isInteger(id) || id <= 0) return refuse("PN1_SCOPE", "Choose one event, or every entry at one venue.", 400);
      const ev = await eventFor(p.id, kind, id);
      if ("ok" in ev) return ev;
      ({ venueId, venueName } = ev);
      eventKind = kind;
      eventId = id;
      eventName = ev.name;
      seasonId = ev.seasonId;
      expires = ev.expiresAt;
    } else {
      const id = Number(input.venueId);
      if (!Number.isInteger(id) || id <= 0) return refuse("PN1_SCOPE", "Choose one event, or every entry at one venue.", 400);
      const here = (await db
        .prepare(
          `SELECT v.name FROM venues v WHERE v.id = ? AND (
              EXISTS (SELECT 1 FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id WHERE t.venue_id = v.id AND e.participant_id = ? AND e.status <> 'withdrawn')
           OR EXISTS (SELECT 1 FROM league_players x JOIN leagues l ON l.id = x.league_id WHERE l.venue_id = v.id AND x.participant_id = ? AND x.status = 'active')
           OR EXISTS (SELECT 1 FROM ladder_players x JOIN ladders l ON l.id = x.ladder_id WHERE l.venue_id = v.id AND x.participant_id = ? AND x.status = 'active'))`
        )
        .get(id, p.id, p.id, p.id)) as { name: string } | undefined;
      if (!here) return refuse("PN1_NO_ENTRY", "They hold no place at that venue.", 404);
      venueId = id;
      venueName = here.name;
    }
    // Already allowed, for this: nothing new is recorded.
    const live = (await inForceFor(p.id, user.id)).find((c) => (scope === "venue" ? c.scope === "venue" && c.venueId === venueId : c.scope === "event" && c.eventKind === eventKind && c.eventId === eventId));
    if (live) return { ok: true as const, value: live, already: true };
    const wording = wordingFor(locale, { child: p.displayName, scope, event: eventName, venue: venueName });
    const row = (await db
      .prepare(
        `INSERT INTO public_name_consents (participant_id, granted_by_user_id, venue_id, scope, event_kind, event_id, season_id, wording, wording_locale, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${expires ? "?" : `now() + interval '${BROAD_MONTHS} months'`}) RETURNING id`
      )
      .get(...[p.id, user.id, venueId, scope, eventKind, eventId, seasonId, wording, locale, ...(expires ? [expires] : [])])) as { id: number };
    const detail = scope === "event" ? `${eventKind} ${eventName}: full name on public pages, authorised by their guardian` : `every entry at ${venueName}: full name on public pages, authorised by their guardian for ${BROAD_MONTHS} months`;
    await participantEvent(p.id, "public_name.authorised", { userId: user.id, name: user.name }, { venueId, detail });
    await logAction({ id: null, name: `Guardian: ${user.name}` }, { venueId, action: "participant.public_name_authorised", detail: `${p.displayName}: ${detail}` });
    const made = (await inForceFor(p.id, user.id)).find((c) => c.id === row.id)!;
    return { ok: true as const, value: made, already: false };
  });
}

/** Withdrawn at once, by any guardian who manages the child. The record stays (withdrawn, when), the public pages stop using it on the next request. */
export async function withdrawConsent(user: { id: number; name: string }, consentId: unknown): Promise<{ ok: true } | ConsentRefusal> {
  const id = Number(consentId);
  if (!Number.isInteger(id) || id <= 0) return refuse("PN1_NOT_FOUND", "That authorisation was not found.", 404);
  return withTransaction(async () => {
    const db = getDb();
    const c = (await db.prepare("SELECT id, participant_id, venue_id, scope, event_kind, event_id, revoked_at FROM public_name_consents WHERE id = ? FOR UPDATE").get(id)) as
      | { id: number; participant_id: number; venue_id: number; scope: string; event_kind: string | null; event_id: number | null; revoked_at: unknown }
      | undefined;
    if (!c) return refuse("PN1_NOT_FOUND", "That authorisation was not found.", 404);
    const g = await guardianshipOf(user.id, c.participant_id, { live: true });
    if (!g) return refuse("PN1_NOT_GUARDIAN", "You do not manage them.", 403);
    if (c.revoked_at) return { ok: true as const };
    await db.prepare("UPDATE public_name_consents SET revoked_at = now() WHERE id = ? AND revoked_at IS NULL").run(id);
    const venue = (await db.prepare("SELECT name FROM venues WHERE id = ?").get(c.venue_id)) as { name: string };
    const detail = c.scope === "event" ? `${c.event_kind} ${c.event_id}: full name withdrawn from public pages` : `every entry at ${venue.name}: full name withdrawn from public pages`;
    await participantEvent(c.participant_id, "public_name.withdrawn", { userId: user.id, name: user.name }, { venueId: c.venue_id, detail });
    await logAction({ id: null, name: `Guardian: ${user.name}` }, { venueId: c.venue_id, action: "participant.public_name_withdrawn", detail: `${g.participant.displayName}: ${detail}` });
    return { ok: true as const };
  });
}

/** What an account's data export holds: each authorisation it gave, with the wording it saw, and whether it still applies. */
export async function consentsExport(userId: number): Promise<unknown[]> {
  const rows = (await getDb()
    .prepare(`${CONSENT_SELECT} WHERE c.granted_by_user_id = ? ORDER BY c.id`)
    .all(userId)) as ConsentRow[];
  const names = new Map(
    ((await getDb()
      .prepare("SELECT id, display_name FROM participants WHERE id IN (SELECT participant_id FROM public_name_consents WHERE granted_by_user_id = ?)")
      .all(userId)) as { id: number; display_name: string }[]).map((p) => [p.id, p.display_name])
  );
  const now = Date.now();
  return rows.map((r) => ({
    child: names.get(r.participant_id) ?? null,
    scope: r.scope,
    venue: r.venue_name,
    event: r.event_kind ? { kind: r.event_kind, name: r.event_name } : null,
    wording: r.wording,
    wordingLanguage: r.wording_locale,
    grantedAt: iso(r.granted_at),
    expiresAt: iso(r.expires_at),
    withdrawnAt: r.revoked_at ? iso(r.revoked_at) : null,
    inForceNow: inForce(r, now),
  }));
}

/** Erasing a guardian's account takes every authorisation they gave (the public pages show the child short again at once). */
export async function eraseConsentsOf(userId: number): Promise<void> {
  await getDb().prepare("DELETE FROM public_name_consents WHERE granted_by_user_id = ?").run(userId);
}
