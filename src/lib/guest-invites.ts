import { getDb } from "./db";
import { accountPhone, cleanAccess } from "./access";
import { errorText, translator, type ErrorCode } from "./i18n";
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
  const phone = await accountPhone(userId);
  if (!phone) return [];
  return (await getDb()
    .prepare(
      `SELECT a.id, a.venue_id, v.name AS venue_name, a.label, v.guest_invites, v.guest_invite_days
         FROM venue_access_list a JOIN venues v ON v.id = a.venue_id
        WHERE a.phone_key = phone_key(?) AND a.kind IN ('resident', 'member')
          AND (a.expires_on IS NULL OR a.expires_on >= ?)
          AND v.access IN ('members', 'private') AND v.guest_invites > 0
          AND v.published_at IS NOT NULL AND v.suspended_at IS NULL
          ${venueId !== undefined ? "AND v.id = ?" : ""}
        ORDER BY v.name`
    )
    .all(phone, todayISO(), ...(venueId !== undefined ? [venueId] : []))) as HostRow[];
}

async function guestsOf(hostId: number): Promise<MyGuest[]> {
  const rows = (await getDb()
    .prepare(
      "SELECT id, phone, name, expires_on FROM venue_access_list WHERE invited_by = ? AND expires_on >= ? ORDER BY expires_on, id"
    )
    .all(hostId, todayISO())) as { id: number; phone: string; name: string | null; expires_on: string }[];
  return rows.map((r) => ({
    id: r.id,
    phone: r.phone,
    name: r.name,
    expiresOn: r.expires_on,
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

/**
 * Put a guest on the list for `days` days from today. A number already on the
 * list stays as it is, unless it is this resident's own guest (the visit is
 * extended) or a guest whose invitation has run out (it becomes this one's).
 */
export async function inviteGuest(
  userId: number,
  input: { venueId: number; phone: string; name?: string | null; days: number }
): Promise<{ ok: true; guest: MyGuest } | Refusal> {
  const [host] = await hostEntries(userId, input.venueId);
  if (!host) return refuse("GUEST_NOT_HOST");
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > host.guest_invite_days)
    return refuse("GUEST_DAYS", { n: host.guest_invite_days });
  const cleaned = cleanAccess({ phone: input.phone, name: input.name ?? null, kind: "guest", expiresOn: todayISO() });
  if (!cleaned.ok) return { ok: false, error: cleaned.error };
  const { phone, name } = cleaned.row;
  const today = todayISO();
  const expiresOn = addDays(today, input.days - 1);

  const db = getDb();
  return await db.transaction(async (): Promise<{ ok: true; guest: MyGuest } | Refusal> => {
    const self = (await db.prepare("SELECT phone_key(?) = phone_key(?) AS same").get(phone, (await accountPhone(userId)) ?? "")) as {
      same: boolean;
    };
    if (self.same) return refuse("GUEST_SELF");
    const existing = (await db
      .prepare("SELECT id, kind, expires_on, invited_by FROM venue_access_list WHERE venue_id = ? AND phone_key = phone_key(?)")
      .get(input.venueId, phone)) as { id: number; kind: string; expires_on: string | null; invited_by: number | null } | undefined;
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
      await db
        .prepare(
          "UPDATE venue_access_list SET name = COALESCE(?, name), label = ?, kind = 'guest', expires_on = ?, invited_by = ?, added_by = NULL WHERE id = ?"
        )
        .run(name, host.label, expiresOn, host.id, existing.id);
      id = existing.id;
    } else {
      const info = await db
        .prepare(
          "INSERT INTO venue_access_list (venue_id, phone, name, label, kind, expires_on, invited_by) VALUES (?, ?, ?, ?, 'guest', ?, ?)"
        )
        .run(input.venueId, phone, name, host.label, expiresOn, host.id);
      id = Number(info.lastInsertRowid);
    }
    return { ok: true, guest: { id, phone, name, expiresOn } };
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
