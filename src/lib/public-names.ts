import { getDb } from "./db";
import { venueZoneOf } from "./zones";
import { todayISO } from "./time";
import { GUARDIAN_AGE, ageOn, type TournamentDetail } from "./tournaments";

/**
 * How a person or a pair appears on a public surface: the one rule behind every public tournament page and payload, the live
 * page, box leagues, ladders, counted events and the notices that name an entrant to another family
 * (docs/architecture/privacy.md#minors-names-on-public-pages).
 *
 * A **declared minor** is shown by first name and the initial of the next word ("Aina L."), each of a pair by the same rule, so a
 * partner's full name never stands beside a child's short one (a pair is often family); where there is no second word, the first
 * name alone. Declared, never verified: a guardian's agreement recorded at entry, a participant a guardian manages
 * (ADR 0022/0023), or a date of birth under 18 on the event's first day (today, for a list of people with no event). A team is
 * shown by its team name, its members never. An adult is shown as entered. The one exception is a guardian's authorisation of the
 * child's full name (lib/public-name-consents.ts), which this file only reads, live, on every call: nothing is cached.
 *
 * Staff and guardian views do not come through here: the organiser's tabs, the official's page, check-in, a guardian's own pages
 * and emails to a guardian about their own child keep the full names they need. A public function takes the public audience (this
 * file); a staff function never calls it.
 */

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

/** What is declared about an entry, entrant, league or ladder player: the entrant's word, never verified. */
export interface Declared {
  /** A guardian's agreement was recorded when they entered. */
  guardian?: boolean;
  /** A participant a guardian manages is the entrant. */
  participantId?: number | null;
  birthDate?: string | null;
  partnerBirthDate?: string | null;
}

const young = (born: string | null | undefined, on: string): boolean => !!born && ageOn(born, on) < GUARDIAN_AGE;

/** Whether somebody (or either of a pair) is, as declared, a minor on this day. */
export function isDeclaredMinor(d: Declared, on: string): boolean {
  return d.guardian === true || (d.participantId !== null && d.participantId !== undefined) || young(d.birthDate, on) || young(d.partnerBirthDate, on);
}

export interface PublicContext {
  /** The day ages are measured on: an event's first day, or today. */
  on: string;
  /** Everybody short, as an organiser may choose for the live page and the public page. */
  everybodyShort?: boolean;
  /** Participants whose guardian has authorised their full name here, now (`authorisedParticipants`). */
  authorised?: ReadonlySet<number>;
}

/**
 * The name as the public sees it. `team`: shown as it is. The exception applies only to the participant a guardian answers for,
 * and never where the partner of a pair is a declared minor too (no guardian of theirs has said yes), nor where the organiser
 * set everybody to short names.
 */
export function publicName(e: Declared & { name: string; team?: boolean }, ctx: PublicContext): string {
  if (e.team) return e.name;
  if (ctx.everybodyShort) return shortName(e.name);
  if (!isDeclaredMinor(e, ctx.on)) return e.name;
  if (e.participantId != null && ctx.authorised?.has(e.participantId) && !young(e.partnerBirthDate, ctx.on)) return e.name;
  return shortName(e.name);
}

export type EventKind = "tournament" | "league" | "ladder";

/**
 * Which of these participants have a live authorisation for this event, read now: not withdrawn, not past its date, the event (or
 * the league's or ladder's season it was given for) not over, and the account that gave it still managing the participant. An
 * event's authorisation covers that event only; a venue's every competitive entry at the venue.
 */
export async function authorisedParticipants(ev: { kind: EventKind; id: number; venueId: number }, participantIds: (number | null | undefined)[]): Promise<Set<number>> {
  const ids = [...new Set(participantIds.filter((p): p is number => typeof p === "number"))];
  if (ids.length === 0) return new Set();
  const db = getDb();
  const venue = (await db.prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(ev.venueId)) as { time_zone: string | null; lat: number | null; lng: number | null } | undefined;
  const live =
    ev.kind === "tournament"
      ? { sql: "EXISTS (SELECT 1 FROM tournaments x WHERE x.id = c.event_id AND x.ends_on >= ?)", args: [todayISO(venue ? venueZoneOf(venue) : undefined)] }
      : ev.kind === "league"
        ? { sql: "EXISTS (SELECT 1 FROM league_seasons s WHERE s.id = c.season_id AND s.status <> 'finished')", args: [] }
        : { sql: "EXISTS (SELECT 1 FROM ladder_seasons s WHERE s.id = c.season_id AND s.ended_on IS NULL)", args: [] };
  const rows = (await db
    .prepare(
      `SELECT DISTINCT c.participant_id FROM public_name_consents c
        WHERE c.participant_id IN (${ids.map(() => "?").join(",")}) AND c.venue_id = ? AND c.revoked_at IS NULL AND c.expires_at > now()
          AND EXISTS (SELECT 1 FROM participant_guardians g WHERE g.participant_id = c.participant_id AND g.user_id = c.granted_by_user_id
                       AND g.revoked_at IS NULL AND g.suspended_at IS NULL AND g.archived_at IS NULL)
          AND (c.scope = 'venue' OR (c.scope = 'event' AND c.event_kind = ? AND c.event_id = ? AND ${live.sql}))`
    )
    .all(...ids, ev.venueId, ev.kind, ev.id, ...live.args)) as { participant_id: number }[];
  return new Set(rows.map((r) => r.participant_id));
}

/**
 * A tournament's detail for the public audience: every entry named by the rule, in every format (knockout, groups, Swiss,
 * double elimination, performance and counted events alike). `everybody` overrides the tournament's own choice: a notice to
 * another family shortens a declared minor only (the live page's own setting is for the live page and the public page).
 */
export async function namedForThePublic(d: TournamentDetail, opts: { everybody?: boolean } = {}): Promise<TournamentDetail> {
  const rows = (await getDb()
    .prepare("SELECT id, guardian_name, participant_id, birth_date, partner_birth_date FROM tournament_entries WHERE tournament_id = ?")
    .all(d.id)) as { id: number; guardian_name: string | null; participant_id: number | null; birth_date: string | null; partner_birth_date: string | null }[];
  const declared = new Map(rows.map((r) => [r.id, r]));
  const authorised = await authorisedParticipants({ kind: "tournament", id: d.id, venueId: d.venueId }, rows.map((r) => r.participant_id));
  const ctx: PublicContext = { on: d.startsOn, everybodyShort: opts.everybody ?? d.liveNames === "short", authorised };
  return {
    ...d,
    entries: d.entries.map((e) => {
      const r = declared.get(e.id);
      const name = publicName(
        { name: e.name, team: d.entryKind === "team", guardian: !!r?.guardian_name, participantId: r?.participant_id ?? null, birthDate: r?.birth_date ?? null, partnerBirthDate: r?.partner_birth_date ?? null },
        ctx
      );
      return name === e.name ? e : { ...e, name };
    }),
  };
}
