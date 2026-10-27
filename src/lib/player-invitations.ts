import crypto from "crypto";
import { getDb } from "./db";
import { errorText, translator, type ErrorCode, type Phrase, type Vars } from "./i18n";
import { accountLocale, enqueue } from "./outbox";
import { keyedHash } from "./secrets";
import type { Refusal } from "./types";

/**
 * Players invited to an open game or a community group by email address.
 *
 * **No account enumeration** (the owner's decision of 27 October 2026;
 * docs/architecture/security.md#no-account-enumeration). The address typed is
 * never looked up: whether or not an account holds it, and whether or not
 * whoever does may be invited, the inviter gets the same answer and the same
 * work is done. The invitation counts against the inviter's daily limit, and
 * the address is sent an email, through the outbox, with a single-use link.
 * Only the link's keyed hash is kept, with a keyed hash of the address. The
 * host or organiser sees "invited (email)", never a name, until the account
 * that signs in with that address accepts it; the rules on who may be invited
 * (ADR 0016) are applied then, and an invitation they do not allow is refused
 * in the same words as one that does not exist. Inviting the same address to
 * the same game or group again replaces the link.
 *
 * Inviting somebody the inviter already knows here, picked from their lists
 * (lib/games.ts, invitePlayer), is unchanged: it names an account the
 * inviter has already seen.
 */

/** How long an emailed invitation to a group can be accepted. */
export const GROUP_INVITE_DAYS = 7;

/** A plausible email address: its shape only, never whether an account holds it. */
const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

const tokenHash = (token: string) => keyedHash("player-invitation", token);
const emailHash = (email: string) => keyedHash("player-invitation-email", email.trim().toLowerCase());

const ENGLISH = translator("en");
function refuse(code: ErrorCode, status?: number): Refusal & { status?: number } {
  return { ok: false, error: errorText(ENGLISH, code), code, ...(status ? { status } : {}) };
}

/** Every invitation that cannot be used, for whatever reason, is refused in these words. */
export const invitationInvalid = () => refuse("PLAYER_INVITATION_INVALID", 404);

/**
 * The address as typed, trimmed, if it has the shape of one; otherwise a
 * refusal. The inviter's own address is refused too: compared with their own
 * account only, which they know; no other account is looked at.
 */
export async function invitationAddress(inviterId: number, email: unknown): Promise<{ ok: true; email: string } | (Refusal & { status?: number })> {
  const address = typeof email === "string" ? email.trim() : "";
  if (address.length > 200 || !EMAIL_SHAPE.test(address)) return refuse("INVITE_EMAIL_INVALID", 400);
  const me = (await getDb().prepare("SELECT email FROM users WHERE id = ?").get(inviterId)) as { email: string } | undefined;
  if (me && me.email.trim().toLowerCase() === address.toLowerCase()) return refuse("INVITE_EMAIL_SELF", 400);
  return { ok: true, email: address };
}

/** A new link's secret: 24 random bytes. Made before a transaction that may run again, so it is the same either time. */
export const newInvitationToken = () => crypto.randomBytes(24).toString("base64url");

/** SQL: email invitations this person (one `?`) has sent in the last day, accepted or not: every one counts. */
export const EMAIL_INVITES_TODAY = `(SELECT COUNT(*) FROM player_invitations WHERE invited_by = ? AND created_at >= datetime('now', '-1 day'))`;

/** SQL: the row `alias` came from an accepted email invitation, already counted as one (`target` is game_id or group_id). */
export const FROM_EMAIL_INVITATION = (alias: string, target: "game_id" | "group_id") =>
  `EXISTS (SELECT 1 FROM player_invitations i WHERE i.${target} = ${alias}.${target} AND i.used_by = ${alias}.user_id AND i.invited_by = ${alias}.invited_by)`;

/** An invitation by email the host or organiser sees: that one is out, and until when; nothing about who. */
export interface EmailInvitation {
  id: number;
  expiresAt: string;
}

/** The email invitations out for a game or a group, not yet accepted or run out. */
export async function openEmailInvitations(target: { gameId: number } | { groupId: number }): Promise<EmailInvitation[]> {
  const [column, id] = "gameId" in target ? ["game_id", target.gameId] : ["group_id", target.groupId];
  const rows = (await getDb()
    .prepare(
      `SELECT id, expires_at FROM player_invitations
        WHERE ${column} = ? AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > datetime('now') ORDER BY id`
    )
    .all(id)) as { id: number; expires_at: string }[];
  return rows.map((r) => ({ id: r.id, expiresAt: r.expires_at }));
}

/** How many email invitations are out for a game, for its limit on invitations waiting for an answer. */
export async function openEmailInvitationCount(gameId: number): Promise<number> {
  const row = (await getDb()
    .prepare("SELECT COUNT(*)::int AS n FROM player_invitations WHERE game_id = ? AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > datetime('now')")
    .get(gameId)) as { n: number };
  return row.n;
}

/**
 * Record an invitation and queue its email, in the caller's transaction. Any
 * invitation still out to the same address for the same game or group is
 * replaced. Written in the inviter's language: nothing about whoever holds
 * the address is read, so the email is the same whether or not anybody does.
 * Like a password reset's, it belongs to no venue (staff never see it), its
 * text is not kept once sent, and it is not sent once it can no longer be
 * accepted.
 */
export async function issueInvitation(input: {
  target: { gameId: number } | { groupId: number };
  invitedBy: number;
  email: string;
  token: string;
  /** As stored: "YYYY-MM-DD HH:MM:SS", UTC. */
  expiresAt: string;
  subject: Phrase;
  body: Phrase;
  vars: Vars;
}): Promise<void> {
  const db = getDb();
  const [column, id] = "gameId" in input.target ? ["game_id", input.target.gameId] : ["group_id", input.target.groupId];
  await db
    .prepare(`UPDATE player_invitations SET cancelled_at = datetime('now') WHERE ${column} = ? AND email_hash = ? AND used_at IS NULL AND cancelled_at IS NULL`)
    .run(id, emailHash(input.email));
  await db
    .prepare(`INSERT INTO player_invitations (${column}, invited_by, token_hash, email_hash, expires_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, input.invitedBy, tokenHash(input.token), emailHash(input.email), input.expiresAt);
  await enqueue({
    venueId: null,
    kind: "account_email",
    channel: "email",
    recipient: input.email,
    locale: await accountLocale(input.invitedBy),
    subject: input.subject,
    body: input.body,
    vars: input.vars,
    expiresMinutes: Math.max(1, (Date.parse(`${input.expiresAt.replace(" ", "T")}Z`) - Date.now()) / 60000),
  });
}

/** An invitation as accepting it finds it. */
export interface InvitationRow {
  id: number;
  gameId: number | null;
  groupId: number | null;
  invitedBy: number;
}

/**
 * The invitation a link carries, if it can still be used by this account:
 * not used, replaced or run out, sent to the address this account signs in
 * with, and not this account's own. Null for every other reason alike.
 */
export async function usableInvitation(user: { id: number; email: string }, token: unknown): Promise<InvitationRow | null> {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const row = (await getDb()
    .prepare(
      `SELECT id, game_id, group_id, invited_by, email_hash FROM player_invitations
        WHERE token_hash = ? AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > datetime('now')`
    )
    .get(tokenHash(token))) as { id: number; game_id: number | null; group_id: number | null; invited_by: number; email_hash: string } | undefined;
  if (!row || row.email_hash !== emailHash(user.email) || row.invited_by === user.id) return null;
  return { id: row.id, gameId: row.game_id, groupId: row.group_id, invitedBy: row.invited_by };
}

/**
 * Spend an invitation, in the caller's transaction, after its game's or
 * group's row is locked. False if it was used, replaced or ran out meanwhile.
 */
export async function claimInvitation(id: number, userId: number): Promise<boolean> {
  const done = await getDb()
    .prepare(
      `UPDATE player_invitations SET used_at = datetime('now'), used_by = ?
        WHERE id = ? AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > datetime('now')`
    )
    .run(userId, id);
  return done.changes === 1;
}

/** Invitations long past their time: nothing is left to check against them. */
export async function forgetOldInvitations(): Promise<number> {
  const done = await getDb().prepare("DELETE FROM player_invitations WHERE expires_at < datetime('now', '-2 days')").run();
  return done.changes;
}

export type PlayerAcceptResult =
  | { ok: true; kind: "game"; gameId: number; status: string }
  | { ok: true; kind: "group"; groupId: number; name: string }
  | (Refusal & { status?: number });

/**
 * Accept an emailed invitation, signed in with the address it was sent to:
 * a game's is taking up a place in it (or asking, or the waiting list), as
 * an invitation by name is; a group's is joining it.
 */
export async function acceptPlayerInvitation(user: { id: number; email: string; phone: string }, token: unknown): Promise<PlayerAcceptResult> {
  const invitation = await usableInvitation(user, token);
  if (!invitation) return invitationInvalid();
  if (invitation.gameId !== null) return (await import("./games")).acceptGameInvitation(user, invitation);
  return (await import("./groups")).acceptGroupInvitation(user, invitation);
}
