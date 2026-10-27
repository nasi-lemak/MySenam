import { linkIn } from "./link-locale";
import crypto from "crypto";
import { getDb } from "./db";
import { accountPhone, cleanAccess, ENTRY_COUNTS_FOR } from "./access";
import { errorText, translator, type ErrorCode } from "./i18n";
import { accountLocale, baseUrl, drainOutbox, enqueue } from "./outbox";
import { keyedHash } from "./secrets";
import { addDays, todayISO } from "./time";
import type { Refusal } from "./types";

/**
 * Residents inviting their own guests.
 *
 * A members-only or private venue can let the residents and members on its
 * list put a guest's number on it themselves, for a few days, up to a number
 * at a time, rather than asking the management office for each one. The guest
 * carries the resident's unit, so their bookings come out of that household's
 * allowance under the venue's house rules, and they go when the resident does.
 *
 * Who counts as a resident here is the list's one rule (lib/access.ts
 * `ENTRY_COUNTS_FOR`): the account an entry is linked to, or one that has
 * proved its number. A guest's entry counts only for an account that has
 * proved the guest's number, or for the account that accepted the invitation
 * emailed to the address the resident gave.
 *
 * **No account enumeration** (the owner's decision of 27 October 2026). An
 * address given is never looked up: whether or not an account holds it, the
 * resident gets the same answer, the entry goes on the list the same way and
 * the address is sent the same email, through the outbox, with a single-use
 * link. Only the link's keyed hash is kept, with a keyed hash of the address;
 * it works until the guest's entry ends, for that one entry, and only for an
 * account signed in with that address (made then, if there is none). Inviting
 * again replaces it; the guest taken off, run out or taken over, or the
 * resident leaving, voids it. The resident sees *invitation sent* until the
 * guest accepts, then *linked*.
 */

export interface GuestPolicy {
  /** Guests each resident may have on the list at once; 0 is off. */
  perResident: number;
  /** The longest an invitation may run, in days. */
  days: number;
}

export const MAX_GUESTS_PER_RESIDENT = 10;
export const MAX_GUEST_DAYS = 14;

export interface MyGuest {
  id: number;
  phone: string;
  name: string | null;
  expiresOn: string;
  /** Linked to the account that accepted the invitation: it counts online for that account. */
  linked: boolean;
  /** An emailed invitation is out for it, not yet accepted (says nothing about whether an account holds the address). */
  invited: boolean;
}

export interface InviteVenue {
  id: number;
  name: string;
  policy: GuestPolicy;
  guests: MyGuest[];
}

const ENGLISH = translator("en");
function refuse(code: ErrorCode, vars?: Record<string, string | number>): Refusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, vars };
}

export async function guestPolicy(venueId: number): Promise<GuestPolicy> {
  const row = (await getDb()
    .prepare("SELECT guest_invites, guest_invite_days FROM venues WHERE id = ?")
    .get(venueId)) as { guest_invites: number; guest_invite_days: number } | undefined;
  return { perResident: row?.guest_invites ?? 0, days: row?.guest_invite_days ?? 3 };
}

export async function setGuestPolicy(
  venueId: number,
  input: { perResident: unknown; days: unknown }
): Promise<{ ok: true; policy: GuestPolicy } | { ok: false; error: string }> {
  const per = input.perResident;
  const days = input.days;
  if (!Number.isInteger(per) || (per as number) < 0 || (per as number) > MAX_GUESTS_PER_RESIDENT)
    return { ok: false, error: `Guests per resident is 0–${MAX_GUESTS_PER_RESIDENT}.` };
  if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > MAX_GUEST_DAYS)
    return { ok: false, error: `An invitation runs 1–${MAX_GUEST_DAYS} days.` };
  await getDb().prepare("UPDATE venues SET guest_invites = ?, guest_invite_days = ? WHERE id = ?").run(per, days, venueId);
  return { ok: true, policy: await guestPolicy(venueId) };
}

interface HostRow {
  id: number;
  venue_id: number;
  venue_name: string;
  label: string | null;
  guest_invites: number;
  guest_invite_days: number;
}

/** The list entries this account invites as: a resident or member, still on, where the venue allows it. */
async function hostEntries(userId: number, venueId?: number): Promise<HostRow[]> {
  return (await getDb()
    .prepare(
      `SELECT a.id, a.venue_id, v.name AS venue_name, a.label, v.guest_invites, v.guest_invite_days
         FROM venue_access_list a JOIN venues v ON v.id = a.venue_id
        WHERE ${ENTRY_COUNTS_FOR} AND a.kind IN ('resident', 'member')
          AND (a.expires_on IS NULL OR a.expires_on >= ?)
          AND v.access IN ('members', 'private') AND v.guest_invites > 0
          AND v.published_at IS NOT NULL AND v.suspended_at IS NULL
          ${venueId !== undefined ? "AND v.id = ?" : ""}
        ORDER BY v.name`
    )
    .all(userId, userId, todayISO(), ...(venueId !== undefined ? [venueId] : []))) as HostRow[];
}

/** SQL: an invitation for entry `a` still open, from its present host (one `?`, today). */
const OPEN_INVITATION = `EXISTS (SELECT 1 FROM guest_invitations gi WHERE gi.entry_id = a.id AND gi.host_entry_id = a.invited_by
  AND gi.used_at IS NULL AND gi.cancelled_at IS NULL AND gi.expires_on >= ?)`;

async function guestsOf(hostId: number): Promise<MyGuest[]> {
  const today = todayISO();
  const rows = (await getDb()
    .prepare(
      `SELECT a.id, a.phone, a.name, a.expires_on, a.user_id, ${OPEN_INVITATION} AS invited
         FROM venue_access_list a WHERE a.invited_by = ? AND a.expires_on >= ? ORDER BY a.expires_on, a.id`
    )
    .all(today, hostId, today)) as { id: number; phone: string; name: string | null; expires_on: string; user_id: number | null; invited: boolean }[];
  return rows.map((r) => ({
    id: r.id,
    phone: r.phone,
    name: r.name,
    expiresOn: r.expires_on,
    linked: r.user_id !== null,
    invited: r.invited === true,
  }));
}

/** The venues this account can invite guests to, with the guests it has there now. */
export async function myInviteVenues(userId: number): Promise<InviteVenue[]> {
  const hosts = await hostEntries(userId);
  const out: InviteVenue[] = [];
  for (const h of hosts)
    out.push({
      id: h.venue_id,
      name: h.venue_name,
      policy: { perResident: h.guest_invites, days: h.guest_invite_days },
      guests: await guestsOf(h.id),
    });
  return out;
}

/** A plausible email address: its shape only, never whether an account holds it. */
const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

const tokenHash = (token: string) => keyedHash("guest-invitation", token);
const emailHash = (email: string) => keyedHash("guest-invitation-email", email.trim().toLowerCase());

/**
 * Put a guest on the list for `days` days from today. A number already on the
 * list stays as it is, unless it is this resident's own guest (the visit is
 * extended) or a guest whose invitation has run out (it becomes this one's).
 * `email`: the address is sent an invitation to accept with the account that
 * signs in with it (made then, if none does). It is never looked up, and the
 * answer and the work done are the same whoever holds it, if anybody does.
 */
export async function inviteGuest(
  userId: number,
  input: { venueId: number; phone: string; name?: string | null; days: number; email?: string | null }
): Promise<{ ok: true; guest: MyGuest } | Refusal> {
  const [host] = await hostEntries(userId, input.venueId);
  if (!host) return refuse("GUEST_NOT_HOST");
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > host.guest_invite_days)
    return refuse("GUEST_DAYS", { n: host.guest_invite_days });
  const cleaned = cleanAccess({ phone: input.phone, name: input.name ?? null, kind: "guest", expiresOn: todayISO() });
  if (!cleaned.ok) return { ok: false, error: cleaned.error };
  const { phone, name } = cleaned.row;
  const email = input.email?.trim() || null;
  if (email !== null && (email.length > 200 || !EMAIL_SHAPE.test(email))) return refuse("GUEST_EMAIL_INVALID");
  // The resident's own address, which they know: compared with their own account only; no other is looked at.
  if (email !== null) {
    const me = (await getDb().prepare("SELECT email FROM users WHERE id = ?").get(userId)) as { email: string } | undefined;
    if (me && me.email.trim().toLowerCase() === email.toLowerCase()) return refuse("GUEST_ACCOUNT_SELF");
  }
  const today = todayISO();
  const expiresOn = addDays(today, input.days - 1);
  // Made before the transaction, which may run again: the same link either time.
  const token = email !== null ? crypto.randomBytes(24).toString("base64url") : null;

  const db = getDb();
  const result = await db.transaction(async (): Promise<{ ok: true; guest: MyGuest } | Refusal> => {
    const self = (await db.prepare("SELECT phone_key(?) = phone_key(?) AS same").get(phone, (await accountPhone(userId)) ?? "")) as {
      same: boolean;
    };
    if (self.same) return refuse("GUEST_SELF");
    const existing = (await db
      .prepare("SELECT id, kind, expires_on, invited_by, user_id FROM venue_access_list WHERE venue_id = ? AND phone_key = phone_key(?) FOR UPDATE")
      .get(input.venueId, phone)) as { id: number; kind: string; expires_on: string | null; invited_by: number | null; user_id: number | null } | undefined;
    const mine = existing?.invited_by === host.id;
    const lapsed = existing?.kind === "guest" && existing.expires_on !== null && existing.expires_on < today;
    if (existing && !mine && !lapsed) return refuse("GUEST_LISTED");

    if (!mine) {
      const { n } = (await db
        .prepare("SELECT COUNT(*)::int AS n FROM venue_access_list WHERE invited_by = ? AND expires_on >= ?")
        .get(host.id, today)) as { n: number };
      if (n >= host.guest_invites) return refuse("GUEST_LIMIT", { n: host.guest_invites });
    }

    let id: number;
    if (existing) {
      // Their own guest keeps the account that accepted until a new invitation is accepted; a lapsed guest taken over keeps
      // neither the account nor any invitation still out.
      await db
        .prepare(
          "UPDATE venue_access_list SET name = COALESCE(?, name), label = ?, kind = 'guest', expires_on = ?, invited_by = ?, added_by = NULL WHERE id = ?"
        )
        .run(name, host.label, expiresOn, host.id, existing.id);
      if (!mine) {
        await db.prepare("UPDATE venue_access_list SET user_id = NULL, linked_by = NULL, linked_at = NULL WHERE id = ?").run(existing.id);
        await db.prepare("UPDATE guest_invitations SET cancelled_at = now() WHERE entry_id = ? AND used_at IS NULL AND cancelled_at IS NULL").run(existing.id);
      }
      id = existing.id;
    } else {
      const info = await db
        .prepare(
          `INSERT INTO venue_access_list (venue_id, phone, name, label, kind, expires_on, invited_by)
           VALUES (?, ?, ?, ?, 'guest', ?, ?)`
        )
        .run(input.venueId, phone, name, host.label, expiresOn, host.id);
      id = Number(info.lastInsertRowid);
    }
    if (email !== null && token !== null) await sendInvitation({ userId, host, entryId: id, email, token, expiresOn });
    const linked = mine && existing?.user_id !== null && existing?.user_id !== undefined;
    const invited =
      email !== null ||
      (mine &&
        (await db
          .prepare("SELECT 1 AS n FROM guest_invitations WHERE entry_id = ? AND used_at IS NULL AND cancelled_at IS NULL AND expires_on >= ?")
          .get(id, today)) !== undefined);
    return { ok: true, guest: { id, phone, name, expiresOn, linked, invited } };
  })();
  // As a password reset's link: sent now if it can be, not waited on, and the same either way.
  if (result.ok && token !== null) void drainOutbox().catch(() => null);
  return result;
}

/**
 * Replace any open invitation for this guest with a new one, and queue its
 * email. Written in the resident's language: nothing about whoever holds the
 * address is read, so the email is the same whether or not anybody does.
 */
async function sendInvitation(input: { userId: number; host: HostRow; entryId: number; email: string; token: string; expiresOn: string }): Promise<void> {
  const db = getDb();
  await db.prepare("UPDATE guest_invitations SET cancelled_at = now() WHERE entry_id = ? AND used_at IS NULL AND cancelled_at IS NULL").run(input.entryId);
  await db
    .prepare(
      `INSERT INTO guest_invitations (venue_id, entry_id, host_entry_id, invited_by_user, token_hash, email_hash, expires_on)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(input.host.venue_id, input.entryId, input.host.id, input.userId, tokenHash(input.token), emailHash(input.email), input.expiresOn);
  const inviter = (await db.prepare("SELECT name FROM users WHERE id = ?").get(input.userId)) as { name: string } | undefined;
  // As a password reset's link: no venue's (its staff do not see it), its text not kept once sent, never readdressed.
  const locale = await accountLocale(input.userId);
  await enqueue({
    venueId: null,
    kind: "account_email",
    channel: "email",
    recipient: input.email,
    locale,
    subject: "gi6.mail.subject",
    body: "gi6.mail.body",
    vars: {
      by: (inviter?.name ?? "").trim().split(/\s+/)[0] || "-",
      venue: input.host.venue_name,
      until: input.expiresOn,
      // Opens in the email's language (lib/link-locale.ts).
      link: linkIn(`${baseUrl()}/guest-invitation?token=${input.token}`, locale),
    },
    // Not sent once it can no longer be accepted.
    expiresMinutes: (Date.parse(`${addDays(input.expiresOn, 1)}T00:00:00Z`) - Date.now()) / 60000 + 24 * 60,
  });
}

export type AcceptResult = { ok: true; venue: { id: number; name: string }; expiresOn: string } | Refusal;

/**
 * Accept an emailed invitation, signed in: the one guest entry it was made
 * for is linked to this account, and nothing else changes (no other entry,
 * venue, household or staff access). Every reason it cannot be used gets the
 * same answer: unknown, used, replaced, run out, the guest taken off or over,
 * the resident gone or no longer able to invite, or another address's — one
 * sent to another address is left for its own account to use.
 */
export async function acceptGuestInvitation(user: { id: number; email: string }, token: unknown): Promise<AcceptResult> {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return refuse("GUEST_INVITATION_INVALID");
  const today = todayISO();
  const db = getDb();
  return await db.transaction(async (): Promise<AcceptResult> => {
    const row = (await db
      .prepare(
        `SELECT i.id, i.entry_id, i.host_entry_id, i.invited_by_user, i.email_hash, i.venue_id, v.name AS venue_name, e.expires_on
           FROM guest_invitations i
           JOIN venue_access_list e ON e.id = i.entry_id AND e.venue_id = i.venue_id AND e.kind = 'guest' AND e.invited_by = i.host_entry_id
           JOIN venues v ON v.id = i.venue_id
          WHERE i.token_hash = ? AND i.used_at IS NULL AND i.cancelled_at IS NULL AND i.expires_on >= ? AND e.expires_on >= ?
          FOR UPDATE OF i`
      )
      .get(tokenHash(token), today, today)) as
      | { id: number; entry_id: number; host_entry_id: number; invited_by_user: number; email_hash: string; venue_id: number; venue_name: string; expires_on: string }
      | undefined;
    if (!row || row.email_hash !== emailHash(user.email) || row.invited_by_user === user.id) return refuse("GUEST_INVITATION_INVALID");
    // The resident must still be one who may invite guests here, under the same entry, as when they invited.
    if (!(await hostEntries(row.invited_by_user, row.venue_id)).some((h) => h.id === row.host_entry_id)) return refuse("GUEST_INVITATION_INVALID");
    const used = await db
      .prepare("UPDATE guest_invitations SET used_at = now(), used_by = ? WHERE id = ? AND used_at IS NULL AND cancelled_at IS NULL")
      .run(user.id, row.id);
    if (used.changes !== 1) return refuse("GUEST_INVITATION_INVALID");
    await db
      .prepare("UPDATE venue_access_list SET user_id = ?, linked_by = NULL, linked_at = datetime('now') WHERE id = ? AND venue_id = ?")
      .run(user.id, row.entry_id, row.venue_id);
    return { ok: true, venue: { id: row.venue_id, name: row.venue_name }, expiresOn: row.expires_on };
  })();
}

/** Take one's own guest off the list early. */
export async function cancelGuest(userId: number, guestId: number): Promise<boolean> {
  const hosts = await hostEntries(userId);
  if (hosts.length === 0) return false;
  const done = await getDb()
    .prepare(`DELETE FROM venue_access_list WHERE id = ? AND invited_by IN (${hosts.map(() => "?").join(",")})`)
    .run(guestId, ...hosts.map((h) => h.id));
  return done.changes === 1;
}
