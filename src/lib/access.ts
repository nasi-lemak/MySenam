import { getDb } from "./db";
import { errorText, translator, type ErrorCode } from "./i18n";
import { phoneChecksOn } from "./phone-check";
import { activeMembership } from "./store";
import { todayISO } from "./time";
import type { Refusal } from "./types";
import { longEnough } from "./phone";

/**
 * Who a venue is for.
 *
 * - **Public**: anybody finds it in search and books, as every venue did.
 * - **Members only**: bookings need an active membership here, or a place on
 *   the venue's list. It can still be found (unless the venue turns that off),
 *   so somebody looking can see it exists and how to join.
 * - **Private**: in no public list, search or map. Only people on its list,
 *   and its staff, can open its page or book: a condominium's courts, pool or
 *   gym, where residents, staff and approved guests are the only users.
 *
 * The list is phone numbers — what a management office or club secretary has
 * on file — matched against the signed-in account's number. Where this
 * install checks numbers (lib/phone-check.ts), only a checked number counts:
 * a number is not identity until somebody has shown they hold it. Guests
 * carry an end date and drop off on their own.
 *
 * Listing (who can *find* a venue) is in lib/listing.ts; this is who can
 * *enter* and *book*.
 */

export type VenueAccess = "public" | "members" | "private";
export const ACCESS_MODES: VenueAccess[] = ["public", "members", "private"];
export type AccessKind = "resident" | "member" | "guest";
export const ACCESS_KINDS: AccessKind[] = ["resident", "member", "guest"];

export interface AccessSettings {
  access: VenueAccess;
  /** Members only: still shown in search. Always false for a private venue. */
  listed: boolean;
  /** What somebody not on the list is told: how to join, who to ask. */
  note: string | null;
}

export interface AccessEntry {
  id: number;
  phone: string;
  name: string | null;
  label: string | null;
  kind: AccessKind;
  expiresOn: string | null;
  createdAt: string;
  /** Whether an account with this (checked) number exists yet. */
  hasAccount: boolean;
  /** A guest a resident invited: who, by name or unit. */
  invitedBy?: string;
}

const ENGLISH = translator("en");
function refuse(code: ErrorCode): Refusal {
  return { ok: false, error: errorText(ENGLISH, code), code };
}

export async function accessSettings(venueId: number): Promise<AccessSettings> {
  const row = (await getDb()
    .prepare("SELECT access, access_listed, access_note FROM venues WHERE id = ?")
    .get(venueId)) as { access: VenueAccess; access_listed: number; access_note: string | null } | undefined;
  if (!row) return { access: "public", listed: true, note: null };
  return { access: row.access, listed: row.access === "public" || (row.access === "members" && row.access_listed === 1), note: row.access_note };
}

export async function setAccessSettings(
  venueId: number,
  input: { access: VenueAccess; listed?: boolean; note?: string | null }
): Promise<{ ok: true; settings: AccessSettings } | { ok: false; error: string }> {
  if (!ACCESS_MODES.includes(input.access)) return { ok: false, error: "Choose public, members only or private." };
  const note = input.note?.trim().slice(0, 500) || null;
  await getDb()
    .prepare("UPDATE venues SET access = ?, access_listed = ?, access_note = ? WHERE id = ?")
    .run(input.access, input.listed === false ? 0 : 1, note, venueId);
  return { ok: true, settings: await accessSettings(venueId) };
}

/** The account's number as it counts for a list: checked, where numbers are checked. */
export async function accountPhone(userId: number): Promise<string | null> {
  const row = (await getDb().prepare("SELECT phone, verified_phone FROM users WHERE id = ?").get(userId)) as
    | { phone: string; verified_phone: string | null }
    | undefined;
  if (!row) return null;
  const phone = phoneChecksOn() ? row.verified_phone : row.phone;
  return phone && phone.trim() !== "" ? phone : null;
}

/** Is this account on the venue's list, today? */
export async function onAccessList(venueId: number, userId: number): Promise<boolean> {
  const phone = await accountPhone(userId);
  if (!phone) return false;
  return (
    (await getDb()
      .prepare(
        "SELECT 1 AS n FROM venue_access_list WHERE venue_id = ? AND phone_key = phone_key(?) AND (expires_on IS NULL OR expires_on >= ?)"
      )
      .get(venueId, phone, todayISO())) !== undefined
  );
}

/** May this account book here? Members: a membership or the list. Private: the list. */
export async function eligible(venueId: number, userId: number, mode?: VenueAccess): Promise<boolean> {
  const access = mode ?? (await accessSettings(venueId)).access;
  if (access === "public") return true;
  if (await onAccessList(venueId, userId)) return true;
  if (access === "members") {
    const phone = await accountPhone(userId);
    return phone !== null && (await activeMembership(venueId, phone)) !== null;
  }
  return false;
}

/**
 * Why this customer may not book, enrol, queue or join here, or null if they
 * may. Not asked of staff booking at the counter.
 */
export async function accessRefusal(venueId: number, userId: number | null): Promise<Refusal | null> {
  const { access } = await accessSettings(venueId);
  if (access === "public") return null;
  if (userId === null) return refuse(access === "members" ? "MEMBERS_SIGN_IN" : "PRIVATE_SIGN_IN");
  if (await eligible(venueId, userId, access)) return null;
  return refuse(access === "members" ? "MEMBERS_ONLY" : "PRIVATE_VENUE");
}

/** Private venues this account is on the list of, for its account page. */
export async function myPrivateVenues(userId: number): Promise<{ id: number; name: string; area: string }[]> {
  const phone = await accountPhone(userId);
  if (!phone) return [];
  return (await getDb()
    .prepare(
      `SELECT DISTINCT v.id, v.name, v.area FROM venue_access_list a JOIN venues v ON v.id = a.venue_id
        WHERE a.phone_key = phone_key(?) AND (a.expires_on IS NULL OR a.expires_on >= ?)
          AND v.access IN ('private', 'members') AND v.published_at IS NOT NULL AND v.suspended_at IS NULL
        ORDER BY v.name`
    )
    .all(phone, todayISO())) as { id: number; name: string; area: string }[];
}

// ------------------------------------------------------------ the list

const SELECT_ENTRY = `
  SELECT a.id, a.phone, a.name, a.label, a.kind, a.expires_on, a.created_at,
         EXISTS (SELECT 1 FROM users u WHERE phone_key(COALESCE(u.verified_phone, u.phone)) = a.phone_key) AS has_account,
         COALESCE(i.name, i.phone) AS inviter
    FROM venue_access_list a LEFT JOIN venue_access_list i ON i.id = a.invited_by`;

type EntryRow = {
  id: number;
  phone: string;
  name: string | null;
  label: string | null;
  kind: AccessKind;
  expires_on: string | null;
  created_at: string;
  has_account: boolean | number;
  inviter: string | null;
};
const toEntry = (r: EntryRow): AccessEntry => ({
  id: r.id,
  phone: r.phone,
  name: r.name,
  label: r.label,
  kind: r.kind,
  expiresOn: r.expires_on,
  createdAt: r.created_at,
  hasAccount: r.has_account === true || r.has_account === 1,
  ...(r.inviter ? { invitedBy: r.inviter } : {}),
});

export async function accessList(venueId: number): Promise<AccessEntry[]> {
  return (
    (await getDb()
      .prepare(`${SELECT_ENTRY} WHERE a.venue_id = ? ORDER BY a.kind, a.label NULLS LAST, a.name NULLS LAST, a.id`)
      .all(venueId)) as EntryRow[]
  ).map(toEntry);
}

export const MAX_ACCESS_ENTRIES = 5000;

export interface AccessInput {
  phone: string;
  name?: string | null;
  label?: string | null;
  kind?: AccessKind;
  expiresOn?: string | null;
}

export function cleanAccess(input: AccessInput): { ok: true; row: Required<AccessInput> } | { ok: false; error: string } {
  const phone = input.phone.trim();
  const digits = phone.replace(/[^0-9]/g, "");
  if (!longEnough(phone) || digits.length > 15) return { ok: false, error: `${phone || "(blank)"} is not a phone number.` };
  const kind = input.kind ?? "resident";
  if (!ACCESS_KINDS.includes(kind)) return { ok: false, error: "A resident, a member or a guest." };
  const expiresOn = input.expiresOn?.trim() || null;
  if (expiresOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(expiresOn)) return { ok: false, error: "The end date is a date, YYYY-MM-DD." };
  if (kind === "guest" && expiresOn === null) return { ok: false, error: "A guest needs an end date." };
  return {
    ok: true,
    row: {
      phone,
      name: input.name?.trim().slice(0, 100) || null,
      label: input.label?.trim().slice(0, 50) || null,
      kind,
      expiresOn,
    },
  };
}

/** Add people to the list, or update them if their number is already on it. */
export async function addAccess(
  venueId: number,
  people: AccessInput[],
  adminId: number | null
): Promise<{ ok: true; added: number; updated: number } | { ok: false; error: string }> {
  const rows: Required<AccessInput>[] = [];
  for (const [i, p] of people.entries()) {
    const c = cleanAccess(p);
    if (!c.ok) return { ok: false, error: people.length > 1 ? `Line ${i + 1}: ${c.error}` : c.error };
    rows.push(c.row);
  }
  const db = getDb();
  const { n } = (await db.prepare("SELECT COUNT(*)::int AS n FROM venue_access_list WHERE venue_id = ?").get(venueId)) as { n: number };
  if (n + rows.length > MAX_ACCESS_ENTRIES) return { ok: false, error: `A list holds up to ${MAX_ACCESS_ENTRIES} people.` };
  let added = 0;
  let updated = 0;
  await db.transaction(async () => {
    for (const r of rows) {
      const result = (await db
        .prepare(
          `INSERT INTO venue_access_list (venue_id, phone, name, label, kind, expires_on, added_by) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (venue_id, phone_key) DO UPDATE SET name = COALESCE(excluded.name, venue_access_list.name),
             label = COALESCE(excluded.label, venue_access_list.label), kind = excluded.kind, expires_on = excluded.expires_on,
             invited_by = NULL
           RETURNING (xmax = 0) AS inserted`
        )
        .get(venueId, r.phone, r.name, r.label, r.kind, r.expiresOn, adminId)) as { inserted: boolean };
      if (result.inserted) added++;
      else updated++;
    }
  })();
  return { ok: true, added, updated };
}

/**
 * Lines pasted from a spreadsheet: `phone, name, unit` — the name and the
 * unit optional, commas or tabs between. A header line is skipped.
 */
export function parseAccessLines(text: string, kind: AccessKind, expiresOn: string | null): AccessInput[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split(/[,\t;]/).map((s) => s.trim()))
    .filter((cells) => cells[0] && /[0-9]/.test(cells[0]))
    .map(([phone, name, label]) => ({ phone, name: name || null, label: label || null, kind, expiresOn }));
}

export async function removeAccess(venueId: number, id: number): Promise<boolean> {
  return (await getDb().prepare("DELETE FROM venue_access_list WHERE venue_id = ? AND id = ?").run(venueId, id)).changes === 1;
}
