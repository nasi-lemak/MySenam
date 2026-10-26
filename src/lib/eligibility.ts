import type { KindNeeds } from "./court-activities";
import { getDb } from "./db";
import { ACTS_FOR } from "./participants";
import { signOffWho } from "./sign-offs";
import type { Sport } from "./types";

/**
 * Who may book an activity that needs the venue's approval, as search and the
 * venue's grid show it (docs/features/discovery.md#who-is-taking-part).
 *
 * Informational only. Booking, the door code and every other path ask
 * `signOffHolds` (lib/sign-offs.ts) again at the time; a badge that said
 * "approved" before a sign-off ran out or was taken back never lets anybody
 * book. The rule for whose sign-off counts is the same SQL as booking's
 * (`signOffWho`), and so is the scope: the branch that gave it, or every
 * branch of its business where given for all of them, for this activity (or
 * anything there), of the kind the resource asks for. Nothing from one venue
 * counts at another, and an approval for one activity never counts for
 * another.
 *
 * Only for a signed-in account, and only for who it says is taking part:
 * itself, and participants it acts for now (a guardian whose relationship is
 * not revoked, or their own login). Nobody chosen, nothing is worked out:
 * the account holder's own eligibility is not assumed to be the one that
 * matters. Statuses come from what is already recorded (sign-offs and this
 * account's applications), never stored, and say no more than that: no
 * application details, declarations or documents.
 */

export const ELIGIBILITY_STATUSES = ["eligible", "required", "pending", "info", "inPerson", "expired"] as const;
/**
 * `eligible`: a sign-off (or certification) holds on the day; `pending`,
 * `info`, `inPerson`: an application this account made is waiting for review,
 * for an answer, or for the in-person step; `expired`: one ran out before the
 * day; `required`: none (including one taken back).
 */
export type EligibilityStatus = (typeof ELIGIBILITY_STATUSES)[number];

/** Who a signed-in account says is taking part: itself, participants (by id), or several. */
export interface Taking {
  userId: number;
  self: boolean;
  participants: number[];
}

/** At most this many at once: the account and everybody it may manage. */
export const MAX_TAKING = 13;

/**
 * `taking=self,12,15` from a query string: `self` for the account holder,
 * participant ids for the others. Null when nobody is named, or it does not
 * read. Whether the account acts for each is the database's to say.
 */
export function readTaking(value: string | null | undefined, userId: number): Taking | null {
  if (!value) return null;
  let self = false;
  const participants = new Set<number>();
  for (const part of value.split(",").slice(0, MAX_TAKING)) {
    const token = part.trim();
    if (token === "self") self = true;
    else if (/^\d{1,9}$/.test(token) && Number(token) > 0) participants.add(Number(token));
    else return null;
  }
  if (!self && participants.size === 0) return null;
  return { userId, self, participants: [...participants] };
}

/** One person's status: `participant` null is the account holder themself. */
export interface EligibilityLine {
  participant: number | null;
  status: EligibilityStatus;
}

/** Statuses at a set of venues, for what a resource asks for there. */
export interface EligibilityAt {
  /** Each person chosen (and acted for), in the order chosen, for this need at this venue. */
  lines(venueId: number, needs: KindNeeds): EligibilityLine[] | undefined;
}

const LIVE: Record<string, EligibilityStatus> = { pending: "pending", info_requested: "info", in_person_due: "inPerson" };

interface Row {
  part: "who" | "sign" | "app";
  pid: number;
  venue_id: number | null;
  kind: string | null;
  state: string | null;
  until: string | null;
}

/**
 * Everybody chosen, at every venue asked about, in one query: the
 * participants the account acts for, their sign-offs in scope there for the
 * activity, and this account's applications still open there. Search calls it
 * once for the venues on the page that ask for anything.
 */
export async function eligibilityAt(input: { taking: Taking; sport: Sport; date: string; venueIds: number[] }): Promise<EligibilityAt> {
  const { taking } = input;
  const venues = [...new Set(input.venueIds)];
  const none: EligibilityAt = { lines: () => undefined };
  if (venues.length === 0 || (!taking.self && taking.participants.length === 0)) return none;
  const vMarks = venues.map(() => "?").join(",");
  const pMarks = taking.participants.map(() => "?").join(",");
  const user = taking.userId;
  // Which sign-offs could be theirs, said so an index finds them (a superset of `signOffWho`, which decides).
  const parts: string[] = [];
  const args: unknown[] = [];
  const inScope = `(s.venue_id = v.id OR (s.business_id IS NOT NULL AND s.business_id = v.business_id))`;
  if (taking.participants.length > 0) {
    const who = signOffWho("customer", { column: "ep.id" }, { phone: "", userId: user });
    parts.push(
      `SELECT 'who' AS part, ep.id AS pid, NULL::integer AS venue_id, NULL::text AS kind, NULL::text AS state, NULL::text AS until
         FROM participants ep WHERE ep.id IN (${pMarks}) AND ${ACTS_FOR("ep")}`,
      `SELECT 'sign' AS part, ep.id AS pid, v.id AS venue_id, s.kind AS kind, NULL::text AS state, s.expires_on AS until
         FROM participants ep
         JOIN sign_offs s ON s.revoked_at IS NULL AND (s.managed_person_id = ep.id OR s.user_id = ep.linked_user_id)
         JOIN venues v ON v.id IN (${vMarks}) AND ${inScope}
        WHERE ep.id IN (${pMarks}) AND (s.sport = ? OR s.sport IS NULL) AND ${who.sql}`
    );
    args.push(...taking.participants, user, user, ...venues, ...taking.participants, input.sport, ...who.args);
  }
  if (taking.self) {
    const who = signOffWho("customer", null, { phone: "", userId: user });
    parts.push(
      `SELECT 'sign' AS part, 0 AS pid, v.id AS venue_id, s.kind AS kind, NULL::text AS state, s.expires_on AS until
         FROM sign_offs s
         JOIN venues v ON v.id IN (${vMarks}) AND ${inScope}
        WHERE s.revoked_at IS NULL
          AND (s.user_id = ? OR phone_key(s.phone) = (SELECT phone_key(u.phone) FROM users u WHERE u.id = ? AND u.phone_verified_at IS NOT NULL)
               OR s.managed_person_id = ANY (ARRAY(SELECT po.id FROM participants po WHERE po.linked_user_id = ?)))
          AND (s.sport = ? OR s.sport IS NULL) AND ${who.sql}`
    );
    args.push(...venues, user, user, user, input.sport, ...who.args);
  }
  // This account's own applications still open (another guardian's are theirs to see).
  const forWhom = [
    ...(taking.self ? ["r.managed_person_id IS NULL"] : []),
    ...(taking.participants.length > 0 ? [`r.managed_person_id IN (${pMarks})`] : []),
  ].join(" OR ");
  parts.push(
    `SELECT 'app' AS part, COALESCE(r.managed_person_id, 0) AS pid, r.venue_id AS venue_id, q.kind AS kind, r.status AS state, NULL::text AS until
       FROM approval_requests r JOIN approval_requirements q ON q.id = r.requirement_id
      WHERE r.user_id = ? AND r.venue_id IN (${vMarks}) AND r.sport = ?
        AND r.status IN ('pending', 'info_requested', 'in_person_due') AND (${forWhom})`
  );
  args.push(user, ...venues, input.sport, ...taking.participants);

  const rows = (await getDb().prepare(parts.join("\nUNION ALL\n")).all(...args)) as Row[];

  const actedFor = new Set(rows.filter((r) => r.part === "who").map((r) => r.pid));
  const order: (number | null)[] = [...(taking.self ? [null] : []), ...taking.participants.filter((p) => actedFor.has(p))];
  const key = (pid: number | null) => pid ?? 0;
  const signs = rows.filter((r) => r.part === "sign");
  const apps = rows.filter((r) => r.part === "app");
  const cache = new Map<string, EligibilityLine[]>();

  return {
    lines(venueId, needs) {
      if (!needs || !venues.includes(venueId)) return undefined;
      const memo = `${venueId}:${needs}`;
      const known = cache.get(memo);
      if (known) return known;
      // A certification asks for a certification; a sign-off is met by either.
      const fits = (kind: string | null) => needs === "signOff" || kind === "certification";
      const lines = order.map((who): EligibilityLine => {
        const mine = signs.filter((r) => r.pid === key(who) && r.venue_id === venueId && fits(r.kind));
        if (mine.some((r) => r.until === null || r.until >= input.date)) return { participant: who, status: "eligible" };
        const open = apps.find((r) => r.pid === key(who) && r.venue_id === venueId && fits(r.kind));
        if (open?.state && LIVE[open.state]) return { participant: who, status: LIVE[open.state] };
        return { participant: who, status: mine.length > 0 ? "expired" : "required" };
      });
      cache.set(memo, lines);
      return lines;
    },
  };
}
