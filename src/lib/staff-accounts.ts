import crypto from "crypto";
import { getDb, withTransaction } from "./db";
import { hashPassword } from "./auth";
import { keyedHash } from "./secrets";
import { baseUrl, emailPlain, transportOverridden } from "./outbox";
import { emailConfig } from "./transports";
import { siteName } from "./site";
import { errorText, translator, type ErrorCode } from "./i18n";
import { linkIn } from "./link-locale";
import { chosenStaffLocale, staffReaderLocale } from "./staff-locales";
import { logAction } from "./activity";
import { MIN_PASSWORD } from "./password-reset";
import { deleteAdmin, getAdminById, isManager, isOwner, listAdminsFor, setStaffRole, type Admin } from "./admin-auth";
import type { StaffRole } from "./roles";

/**
 * Staff accounts: who may add, change and remove whom, and inviting people
 * to set their own password (audit R8 X1-14; docs/architecture/tenancy.md,
 * docs/architecture/authentication.md#staff-invitations).
 *
 * - The platform owner manages every account.
 * - A business manager manages their business's: its managers, and staff at
 *   its branches. Not the platform owner.
 * - A branch manager (a manager at one venue) manages that venue's front desk
 *   only: adds them, corrects their name and address, makes one a manager,
 *   and removes them. Not managers, not anybody at another branch.
 * - Front desk manages nobody (refused before any of this, `MANAGER_ONLY`).
 *
 * New staff are invited: their address is sent a link that works once, for
 * INVITE_DAYS, and only a keyed hash of it is stored, as a password reset's
 * is. The account is made only when the link is used, with the password the
 * invitee chose there, so nobody else knows it and nothing can sign in before
 * then. A manager can send an invitation again (a new link; the old one stops
 * working) or withdraw it.
 *
 * Inviting says nothing about whether the address already has an account
 * somewhere the inviter cannot see: an invitation is made and listed either
 * way, and only the invitee, who holds the address, is told when they open
 * the link that it already has an account. Within what the inviter can see,
 * a clash is said at once.
 *
 * Where the install has no email account (neither SES nor SMTP set up, see emailConfig), there
 * is nothing to send an invitation with, so the manager gives a password, as
 * before; where it has one, a typed password is refused.
 */

export const INVITE_DAYS = 7;

type Refusal = { ok: false; error: string; status: number; code?: ErrorCode };
const refuse = (error: string, status = 403): Refusal => ({ ok: false, error, status });

const EN = translator("en");
const coded = (code: ErrorCode, status: number): Refusal => ({ ok: false, error: errorText(EN, code), status, code });

/** A manager at one venue, who looks after its front desk. */
export function isBranchManager(admin: Pick<Admin, "venueId" | "businessId" | "role">): boolean {
  return admin.venueId !== null && admin.businessId === null && admin.role === "manager";
}

/** Whether this account looks after anybody's account at all. */
export function managesStaff(admin: Admin): boolean {
  return isOwner(admin) || isManager(admin) || isBranchManager(admin);
}

/** Where an account (or an invitation) is, and its role there. */
export interface StaffPlace {
  venueId: number | null;
  businessId: number | null;
  role: StaffRole;
}

/** Whether `by` may add, change or remove an account (or an invitation) of this place and role. */
export function mayManage(by: Admin, target: StaffPlace): boolean {
  if (isOwner(by)) return true;
  if (isManager(by)) {
    // Platform owners are the owner's own.
    if (target.venueId === null && target.businessId === null) return false;
    return target.businessId === by.businessId || (target.venueId !== null && (by.venueIds ?? []).includes(target.venueId));
  }
  if (isBranchManager(by)) return target.venueId === by.venueId && target.businessId === null && target.role === "desk";
  return false;
}

/** The refusal for a place `by` may not manage, in the words that fit who they are. */
function outOfReach(by: Admin, adding: boolean): Refusal {
  if (isBranchManager(by)) return refuse("At your own branch you add, change and remove front-desk staff; a business manager looks after managers.");
  return refuse(adding ? "You can only add staff to your own business." : "That account is not part of your business.");
}

/** Whether invitations can go out: an email account, or the development log (MYSENAM_SEND=log), or a test's transport. */
export function invitationsPossible(): boolean {
  return emailConfig() !== null || process.env.MYSENAM_SEND === "log" || transportOverridden();
}

/** Whether a manager may still type a new member of staff's password: only where the install has no email account. */
export function typedPasswordAllowed(): boolean {
  return emailConfig() === null;
}

/** What the staff screen needs to know to offer the right form. */
export function staffSignUpOptions(): { invitationsPossible: boolean; typedPassword: boolean } {
  return { invitationsPossible: invitationsPossible(), typedPassword: typedPasswordAllowed() };
}

export interface StaffInvitation {
  id: number;
  /** Set for a new address for an existing account. */
  adminId: number | null;
  name: string;
  email: string;
  venueId: number | null;
  businessId: number | null;
  role: StaffRole;
  locale: string | null;
  invitedBy: string | null;
  sentAt: string;
  expiresAt: string;
  /** Past its expiry: sending it again gives a fresh link. */
  expired: boolean;
}

interface InvitationRow {
  id: number;
  admin_id: number | null;
  name: string;
  email: string;
  venue_id: number | null;
  business_id: number | null;
  role: StaffRole;
  locale: string | null;
  invited_by_name?: string | null;
  sent_at: string;
  expires_at: string;
  expired?: boolean;
  accepted_at?: string | null;
  withdrawn_at?: string | null;
}

const toInvitation = (r: InvitationRow): StaffInvitation => ({
  id: r.id,
  adminId: r.admin_id,
  name: r.name,
  email: r.email,
  venueId: r.venue_id,
  businessId: r.business_id,
  role: r.venue_id !== null && r.role === "desk" ? "desk" : "manager",
  locale: r.locale,
  invitedBy: r.invited_by_name ?? null,
  sentAt: r.sent_at,
  expiresAt: r.expires_at,
  expired: !!r.expired,
});

const OPEN_INVITATIONS = `SELECT i.*, a.name AS invited_by_name, i.expires_at <= datetime('now') AS expired
  FROM staff_invitations i LEFT JOIN admins a ON a.id = i.invited_by
  WHERE i.accepted_at IS NULL AND i.withdrawn_at IS NULL`;

/** The invitations not yet accepted or withdrawn that `by` manages, oldest first. */
export async function listInvitationsFor(by: Admin): Promise<StaffInvitation[]> {
  const rows = (await getDb().prepare(`${OPEN_INVITATIONS} ORDER BY i.id`).all()) as InvitationRow[];
  return rows.map(toInvitation).filter((i) => seesPlace(by, i));
}

/** Whether `by` sees accounts at this place (a branch manager sees every invitation at their branch, and manages the desk's). */
function seesPlace(by: Admin, place: StaffPlace): boolean {
  if (isOwner(by)) return true;
  if (isManager(by)) return mayManage(by, place);
  return isBranchManager(by) && place.venueId === by.venueId;
}

const hashOf = (token: string) => keyedHash("staff-invitation", token);
const newToken = () => crypto.randomBytes(24).toString("base64url");

/** The words for where an invitation is: the branch, the whole business, or the platform. */
async function placeName(place: { venueId: number | null; businessId: number | null }): Promise<string> {
  const db = getDb();
  if (place.venueId !== null) {
    const v = (await db.prepare("SELECT name FROM venues WHERE id = ?").get(place.venueId)) as { name: string } | undefined;
    return v?.name ?? siteName();
  }
  if (place.businessId !== null) {
    const b = (await db.prepare("SELECT name FROM businesses WHERE id = ?").get(place.businessId)) as { name: string } | undefined;
    return b?.name ?? siteName();
  }
  return siteName();
}

/** Email the link, in the invitee's own staff language (else the install's first). */
async function sendInvitation(inv: InvitationRow, token: string, by: { name: string }): Promise<void> {
  const own = translator(staffReaderLocale(inv.locale));
  const link = linkIn(`${baseUrl()}/reset-password?kind=invite&token=${token}`, own.locale);
  const site = siteName();
  const where = await placeName({ venueId: inv.venue_id, businessId: inv.business_id });
  const role = inv.venue_id === null ? own("r9a.mail.roleManagerAll") : inv.role === "desk" ? own("r9a.mail.roleDesk") : own("r9a.mail.roleManager");
  await emailPlain({
    to: inv.email,
    subject: own(inv.admin_id === null ? "r9a.mail.inviteSubject" : "r9a.mail.addressSubject", { site }),
    text: own(inv.admin_id === null ? "r9a.mail.inviteBody" : "r9a.mail.addressBody", {
      name: inv.name.split(/\s+/)[0],
      who: by.name,
      where,
      role,
      site,
      link,
      days: INVITE_DAYS,
    }),
    kind: "account_email",
    venueId: inv.venue_id,
    expiresMinutes: INVITE_DAYS * 24 * 60,
    locale: own.locale,
  });
}

function validName(name: unknown): name is string {
  return typeof name === "string" && name.trim().length >= 2 && name.trim().length <= 120;
}
function validEmail(email: unknown): email is string {
  return typeof email === "string" && email.trim().length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** Within what `by` can see: an account, or an invitation still out, already at this address. */
async function visibleClash(by: Admin, email: string, exceptAdmin: number | null = null): Promise<Refusal | null> {
  const lower = email.trim().toLowerCase();
  if ((await listAdminsFor(by)).some((a) => a.email.toLowerCase() === lower && a.id !== exceptAdmin))
    return refuse("An admin with this email already exists.", 409);
  if ((await listInvitationsFor(by)).some((i) => i.email.toLowerCase() === lower))
    return refuse("There is already an invitation out to that address. Send it again or withdraw it.", 409);
  return null;
}

export type InviteResult = { ok: true; invitation: StaffInvitation } | Refusal;

/**
 * Invite somebody to a place and role `by` manages: the invitation is stored
 * and its email queued; the account is made when they accept.
 */
export async function inviteStaff(
  by: Admin,
  input: { name: string; email: string; venueId: number | null; businessId: number | null; role: StaffRole; locale: unknown }
): Promise<InviteResult> {
  if (!invitationsPossible())
    return refuse("This install cannot send email yet, so there is no invitation to send: give them a password of at least 8 characters instead.", 400);
  const place: StaffPlace = { venueId: input.venueId, businessId: input.venueId === null ? input.businessId : null, role: input.venueId !== null ? input.role : "manager" };
  if (!mayManage(by, place)) return outOfReach(by, true);
  const clash = await visibleClash(by, input.email);
  if (clash) return clash;
  const token = newToken();
  const row = (await getDb()
    .prepare(
      `INSERT INTO staff_invitations (name, email, venue_id, business_id, role, locale, invited_by, token_hash, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+${INVITE_DAYS} days')) RETURNING *`
    )
    .get(input.name.trim(), input.email.trim(), place.venueId, place.businessId, place.role, chosenStaffLocale(input.locale), by.id, hashOf(token))) as InvitationRow;
  await sendInvitation(row, token, by);
  await logAction(by, {
    venueId: place.venueId,
    action: "staff.invited",
    detail: `${row.name} (${row.email})${place.venueId !== null ? `, ${place.role === "desk" ? "front desk" : "manager"}` : place.businessId !== null ? ", business manager" : ", platform owner"}`,
  });
  return { ok: true, invitation: toInvitation({ ...row, invited_by_name: by.name, expired: false }) };
}

async function openInvitation(by: Admin, id: number): Promise<{ ok: true; row: InvitationRow } | Refusal> {
  const row = (await getDb()
    .prepare("SELECT *, expires_at <= datetime('now') AS expired FROM staff_invitations WHERE id = ?")
    .get(id)) as InvitationRow | undefined;
  if (!row || !mayManage(by, toInvitation(row))) return refuse("That invitation is not one you manage.");
  if (row.accepted_at || row.withdrawn_at) return refuse("That invitation has already been accepted or withdrawn.", 409);
  return { ok: true, row };
}

/**
 * Send an invitation again, with a new link (the old one stops working) and a
 * new INVITE_DAYS; its name and address can be corrected on the way.
 */
export async function resendInvitation(by: Admin, id: number, change: { name?: unknown; email?: unknown } = {}): Promise<InviteResult> {
  if (!invitationsPossible())
    return refuse("This install cannot send email yet, so there is no invitation to send: give them a password of at least 8 characters instead.", 400);
  const open = await openInvitation(by, id);
  if (!open.ok) return open;
  const name = change.name === undefined || change.name === null || change.name === "" ? open.row.name : change.name;
  const email = change.email === undefined || change.email === null || change.email === "" ? open.row.email : change.email;
  if (!validName(name)) return refuse("Name is required.", 400);
  if (!validEmail(email)) return refuse("A valid email is required.", 400);
  if (email.trim().toLowerCase() !== open.row.email.toLowerCase()) {
    const lower = email.trim().toLowerCase();
    if ((await listAdminsFor(by)).some((a) => a.email.toLowerCase() === lower && a.id !== open.row.admin_id))
      return refuse("An admin with this email already exists.", 409);
    if ((await listInvitationsFor(by)).some((i) => i.id !== id && i.email.toLowerCase() === lower))
      return refuse("There is already an invitation out to that address. Send it again or withdraw it.", 409);
  }
  const token = newToken();
  const row = (await getDb()
    .prepare(
      `UPDATE staff_invitations SET name = ?, email = ?, token_hash = ?, sent_at = datetime('now'), expires_at = datetime('now', '+${INVITE_DAYS} days')
        WHERE id = ? AND accepted_at IS NULL AND withdrawn_at IS NULL RETURNING *`
    )
    .get(name.trim(), email.trim(), hashOf(token), id)) as InvitationRow | undefined;
  if (!row) return refuse("That invitation has already been accepted or withdrawn.", 409);
  await sendInvitation(row, token, by);
  const corrected = row.email !== open.row.email || row.name !== open.row.name;
  await logAction(by, {
    venueId: row.venue_id,
    action: "staff.invitation_resent",
    detail: corrected ? `${open.row.name} (${open.row.email}) → ${row.name} (${row.email})` : `${row.name} (${row.email})`,
  });
  return { ok: true, invitation: toInvitation({ ...row, invited_by_name: null, expired: false }) };
}

/** Withdraw an invitation: its link stops working at once. */
export async function withdrawInvitation(by: Admin, id: number): Promise<{ ok: true } | Refusal> {
  const open = await openInvitation(by, id);
  if (!open.ok) return open;
  const done = await getDb()
    .prepare("UPDATE staff_invitations SET withdrawn_at = datetime('now') WHERE id = ? AND accepted_at IS NULL AND withdrawn_at IS NULL")
    .run(id);
  if (done.changes === 0) return refuse("That invitation has already been accepted or withdrawn.", 409);
  await logAction(by, { venueId: open.row.venue_id, action: "staff.invitation_withdrawn", detail: `${open.row.name} (${open.row.email})` });
  return { ok: true };
}

class Refused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.error);
  }
}

export type AcceptResult = { ok: true; adminId: number } | Refusal;

/**
 * Accept an invitation with the password the invitee chose: the account is
 * made (or, for a new address, moved to it, its other sessions ended), the
 * link is used up, and the caller signs them in.
 */
export async function acceptInvitation(token: string, password: string): Promise<AcceptResult> {
  if (password.length < MIN_PASSWORD || password.length > 200)
    return { ok: false, error: errorText(EN, "PASSWORD_WEAK", { n: MIN_PASSWORD }), status: 400, code: "PASSWORD_WEAK" };
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return coded("RESET_INVALID", 400);
  let accepted: { adminId: number; row: InvitationRow };
  try {
    accepted = await withTransaction(async () => {
      const db = getDb();
      const row = (await db
        .prepare(
          `UPDATE staff_invitations SET accepted_at = datetime('now')
            WHERE token_hash = ? AND accepted_at IS NULL AND withdrawn_at IS NULL AND expires_at > datetime('now')
            RETURNING *`
        )
        .get(hashOf(token))) as InvitationRow | undefined;
      if (!row) throw new Refused(coded("RESET_INVALID", 400));
      const taken = (await db.prepare("SELECT id FROM admins WHERE email = ?").get(row.email)) as { id: number } | undefined;
      if (taken && taken.id !== row.admin_id) throw new Refused(coded("R9A_ADDRESS_TAKEN", 409));
      if (row.admin_id === null) {
        const made = (await db
          .prepare("INSERT INTO admins (name, email, password_hash, venue_id, business_id, role, locale) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
          .get(row.name, row.email, hashPassword(password), row.venue_id, row.venue_id === null ? row.business_id : null, row.venue_id !== null ? row.role : "manager", chosenStaffLocale(row.locale))) as { id: number };
        return { adminId: made.id, row };
      }
      await db.prepare("UPDATE admins SET email = ?, password_hash = ? WHERE id = ?").run(row.email, hashPassword(password), row.admin_id);
      // A new address and password: whoever was signed in as the account before is not now.
      await db.prepare("DELETE FROM admin_sessions WHERE admin_id = ?").run(row.admin_id);
      await db.prepare("DELETE FROM admin_login_tickets WHERE admin_id = ?").run(row.admin_id);
      // AI assistants signed in as the account are signed out with it (lib/mcp/oauth.ts).
      await db.prepare("UPDATE oauth_grants SET revoked_at = datetime('now'), revoked_reason = 'the account moved to a new address' WHERE admin_id = ? AND revoked_at IS NULL").run(row.admin_id);
      await db
        .prepare("UPDATE staff_invitations SET withdrawn_at = datetime('now') WHERE admin_id = ? AND id <> ? AND accepted_at IS NULL AND withdrawn_at IS NULL")
        .run(row.admin_id, row.id);
      return { adminId: row.admin_id, row };
    });
  } catch (err) {
    if (err instanceof Refused) return err.refusal;
    throw err;
  }
  const admin = await getAdminById(accepted.adminId);
  if (admin)
    await logAction(admin, {
      venueId: admin.venueId,
      action: accepted.row.admin_id === null ? "staff.joined" : "staff.address_changed",
      detail: `${admin.name} (${admin.email})`,
    });
  return { ok: true, adminId: accepted.adminId };
}

type Done = { ok: true } | Refusal;

/** The account `id`, if `by` manages it (as it is now). */
async function managedAccount(by: Admin, id: number): Promise<{ ok: true; target: Admin } | Refusal> {
  const target = (await listAdminsFor(by)).find((a) => a.id === id);
  if (!target) return outOfReach(by, false);
  if (!mayManage(by, target)) return outOfReach(by, false);
  return { ok: true, target };
}

/**
 * Make a member of branch staff a manager or front desk. A branch manager
 * runs front desk only: making somebody a manager is a business manager's or
 * the owner's, so a branch manager cannot make a fellow manager in two steps.
 */
export async function changeRole(by: Admin, id: number, role: StaffRole): Promise<Done> {
  if (id === by.id) return refuse("You cannot change your own role.", 409);
  const found = await managedAccount(by, id);
  if (!found.ok) return found;
  const { target } = found;
  if (target.venueId === null) return refuse("Only branch staff have a role; business managers always manage.", 409);
  if (target.role === role) return { ok: true };
  if (role === "manager" && isBranchManager(by))
    return refuse("At your own branch you add, change and remove front-desk staff; a business manager makes somebody a manager.", 403);
  await setStaffRole(id, role);
  await logAction(by, { venueId: target.venueId, action: "staff.role", detail: `${target.name}: ${target.role} → ${role}` });
  return { ok: true };
}

export type CorrectResult = { ok: true; invited: boolean } | Refusal;

/**
 * Correct a member of staff's name, or their address. A new address is
 * invited: the account moves to it only when the link sent there is used,
 * with a password chosen there, and the old address is told. Where the
 * install cannot send email, the address changes at once.
 */
export async function correctStaff(by: Admin, id: number, change: { name?: unknown; email?: unknown }): Promise<CorrectResult> {
  const found = await managedAccount(by, id);
  if (!found.ok) return found;
  const { target } = found;
  const db = getDb();
  if (change.name !== undefined && change.name !== null && change.name !== target.name) {
    if (!validName(change.name)) return refuse("Name is required.", 400);
    await db.prepare("UPDATE admins SET name = ? WHERE id = ?").run(change.name.trim(), id);
    await logAction(by, { venueId: target.venueId, action: "staff.corrected", detail: `${target.name} → ${change.name.trim()} (${target.email})` });
  }
  if (change.email === undefined || change.email === null || change.email === "") return { ok: true, invited: false };
  if (!validEmail(change.email)) return refuse("A valid email is required.", 400);
  const email = change.email.trim();
  if (email.toLowerCase() === target.email.toLowerCase()) return { ok: true, invited: false };
  const clash = await visibleClash(by, email, id);
  if (clash) return clash;
  const name = validName(change.name) ? change.name.trim() : target.name;
  if (!invitationsPossible()) {
    // Nothing to send an invitation with: the address is corrected as it stands.
    if ((await db.prepare("SELECT id FROM admins WHERE email = ? AND id <> ?").get(email, id)) !== undefined)
      return refuse("An admin with this email already exists.", 409);
    await db.prepare("UPDATE admins SET email = ? WHERE id = ?").run(email, id);
    await logAction(by, { venueId: target.venueId, action: "staff.address_changed", detail: `${name}: ${target.email} → ${email}` });
    return { ok: true, invited: false };
  }
  // Any earlier change of address still out for this account gives way to this one.
  await db
    .prepare("UPDATE staff_invitations SET withdrawn_at = datetime('now') WHERE admin_id = ? AND accepted_at IS NULL AND withdrawn_at IS NULL")
    .run(id);
  const token = newToken();
  const row = (await db
    .prepare(
      `INSERT INTO staff_invitations (admin_id, name, email, venue_id, business_id, role, locale, invited_by, token_hash, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+${INVITE_DAYS} days')) RETURNING *`
    )
    .get(id, name, email, target.venueId, target.venueId === null ? target.businessId : null, target.role, target.locale, by.id, hashOf(token))) as InvitationRow;
  await sendInvitation(row, token, by);
  // The address it was at is told, so a change nobody asked for is seen.
  const own = translator(staffReaderLocale(target.locale));
  await emailPlain({
    to: target.email,
    subject: own("r9a.mail.movingSubject", { site: siteName() }),
    text: own("r9a.mail.movingBody", { name: target.name.split(/\s+/)[0], who: by.name, email, site: siteName() }),
    kind: "account_email",
    venueId: target.venueId,
    locale: own.locale,
  });
  await logAction(by, { venueId: target.venueId, action: "staff.address_invited", detail: `${name}: ${target.email} → ${email}` });
  return { ok: true, invited: true };
}

/**
 * Remove an account `by` manages. It is signed out everywhere at once (its
 * sessions go with it), and any invitations it sent that are still out are
 * withdrawn. The last platform owner, and a business's last manager, stay.
 */
export async function removeStaff(by: Admin, id: number): Promise<Done> {
  if (id === by.id) return refuse("You cannot remove your own account.", 409);
  const found = await managedAccount(by, id);
  if (!found.ok) return found;
  const { target } = found;
  try {
    await withTransaction(async () => {
      await getDb()
        .prepare("UPDATE staff_invitations SET withdrawn_at = datetime('now') WHERE invited_by = ? AND accepted_at IS NULL AND withdrawn_at IS NULL")
        .run(id);
      // Its sessions and sign-in tickets go with the account (ON DELETE CASCADE): signed out at once.
      const result = await deleteAdmin(id);
      if (!result.ok) throw new Refused(refuse(result.error ?? "Admin not found.", 409));
    });
  } catch (err) {
    if (err instanceof Refused) return err.refusal;
    throw err;
  }
  await logAction(by, { venueId: target.venueId, action: "staff.removed", detail: `${target.name} (${target.email})` });
  return { ok: true };
}
