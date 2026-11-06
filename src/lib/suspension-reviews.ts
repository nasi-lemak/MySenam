import { getDb, withTransaction } from "./db";
import { refuse, type Refusal } from "./messages";

/**
 * A person whose messaging is suspended asks for it to be looked at again (ADR 0059; docs/features/player-messages.md#a-suspension-of-messaging-can-be-reviewed).
 *
 * The same neutral route as a restriction in a youth group's conversation has (lib/youth-restrictions.ts `askForReview`, ADR 0052), for the adult player's
 * suspension, whether staff made it or the published rule did: one short text, optional; once only while a request is open; **nothing of any report is shown,
 * asked or confirmed**; decided by somebody who may lift it (the owner, the venue's manager for a venue's own or one resting on its reports alone), who lifts it
 * or answers that it stands, with a reason that is recorded (`lib/message-moderation.ts` `liftSuspension`, `keepSuspension`); the person is shown only that it was
 * received and, when decided, the outcome in neutral words. A person with no suspension gets the answer a stranger would: it is not there. **This promises no
 * legal right to a review or to notification: those are pending legal review (ADR 0052).**
 */

const clean = (raw: unknown, max: number): string => (typeof raw === "string" ? raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ").slice(0, max) : "");

export type ReviewAsked = { ok: true; state: "received" } | Refusal;

/** Ask for the suspension in force on this account to be looked at again. */
export async function askForSuspensionReview(userId: number, textRaw: unknown): Promise<ReviewAsked> {
  const text = clean(textRaw, 300);
  const made = await withTransaction(async (): Promise<{ id: number; suspensionVenueId: number | null; suspensionId: number } | Refusal> => {
    const db = getDb();
    // One request stands for the person, whichever of their suspensions it is put to: the widest first (everywhere), then a venue's.
    const s = (await db
      .prepare("SELECT id, venue_id FROM player_message_suspensions WHERE user_id = ? AND lifted_at IS NULL ORDER BY (venue_id IS NULL) DESC, id LIMIT 1 FOR UPDATE")
      .get(userId)) as { id: number; venue_id: number | null } | undefined;
    if (!s) return refuse("PM_NOT_FOUND");
    const open = await db.prepare("SELECT 1 FROM player_message_suspension_appeals a JOIN player_message_suspensions x ON x.id = a.suspension_id WHERE x.user_id = ? AND x.lifted_at IS NULL AND a.status = 'open'").get(userId);
    if (open) return refuse("PM_REVIEW_DUP");
    const row = (await db
      .prepare("INSERT INTO player_message_suspension_appeals (suspension_id, user_id, message) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING id")
      .get(s.id, userId, text || null)) as { id: number } | undefined;
    if (!row) return refuse("PM_REVIEW_DUP");
    return { id: row.id, suspensionVenueId: s.venue_id, suspensionId: s.id };
  });
  if ("ok" in made) return made;
  // Whoever may decide it is told one is waiting (that and where only: nothing of why, nothing of who).
  try {
    const venues = (
      (await getDb()
        .prepare(
          `SELECT DISTINCT r.venue_id FROM player_message_reports r JOIN player_message_suspensions s ON s.id = ?
            WHERE r.reported_id = s.user_id AND r.venue_id IS NOT NULL AND r.created_at >= datetime(s.created_at, '-30 days')`
        )
        .all(made.suspensionId)) as { venue_id: number }[]
    ).map((v) => v.venue_id);
    await (await import("./message-alerts")).tellReviewRequested(made.id, made.suspensionVenueId, venues, userId);
  } catch (err) {
    console.error("[mysenam] could not queue a moderation notice:", err instanceof Error ? err.message : "unknown error");
  }
  return { ok: true, state: "received" };
}

export interface MySuspensionReview {
  state: "none" | "received" | "decided";
  /** The outcome of the latest decided request, in neutral words; never why. */
  outcome: "lifted" | "continues" | null;
  /** Whether the person's messaging is suspended now (what the screen already says: "your messages are paused"). */
  suspended: boolean;
}

/** Where this person's latest request for a review stands: only what they asked and what was decided. The same for anybody who never asked. */
export async function mySuspensionReview(userId: number): Promise<MySuspensionReview> {
  const db = getDb();
  const suspended = Boolean(await db.prepare("SELECT 1 FROM player_message_suspensions WHERE user_id = ? AND lifted_at IS NULL LIMIT 1").get(userId));
  const r = (await db
    .prepare("SELECT status, outcome FROM player_message_suspension_appeals WHERE user_id = ? ORDER BY id DESC LIMIT 1")
    .get(userId)) as { status: "open" | "decided"; outcome: "lifted" | "continues" | null } | undefined;
  if (!r) return { state: "none", outcome: null, suspended };
  return r.status === "open" ? { state: "received", outcome: null, suspended } : { state: "decided", outcome: r.outcome, suspended };
}
