import { isManager, isOwner, listAdmins, listAdminsFor, type Admin } from "./admin-auth";
import { logAction } from "./activity";
import { getDb, withTransaction } from "./db";
import { tellOwnersEach } from "./owner-alerts";
import { emailPlain } from "./outbox";
import { siteName } from "./site";
import { translator, type T } from "./i18n";
import { staffReaderLocale } from "./staff-locales";
import { checkSecondFactor, clearAttempts, hasTwoFactor } from "./two-factor";

/**
 * Two-factor sign-in reset, for a member of staff who has lost both their
 * authenticator and their recovery codes.
 *
 * Not a bypass: it is done by somebody else with authority over the account
 * (a platform owner, or a manager of the business it belongs to; another
 * owner for an owner), who must have two-factor on themselves and prove it
 * with a fresh code at the time, and who writes down how they knew it was
 * really that person (seen in person, called on a number already on file).
 * The reset signs the account out everywhere, voids any sign-in half done,
 * and is told to the account's own email and to every platform owner (each
 * in their own language, lib/staff-locales.ts `staffReaderLocale`), so a
 * reset somebody was talked into is seen at once by the person it locks out
 * and by the people who can undo it. The last owner, with nobody above them,
 * is reset from the server's console (`resetFromConsole`), which already
 * means control of the machine.
 */

export const MIN_REASON = 10;

export type ResetResult = { ok: true } | { ok: false; error: string; status: number };

const refused = (error: string, status = 403): ResetResult => ({ ok: false, error, status });

/** What the reset does, whoever asked for it: in one transaction, then the emails. */
async function reset(target: Admin, entry: { by: Admin | null; reason: string }): Promise<void> {
  await withTransaction(async () => {
    const db = getDb();
    await db
      .prepare("UPDATE admins SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, recovery_codes = NULL WHERE id = ?")
      .run(target.id);
    await db.prepare("DELETE FROM admin_sessions WHERE admin_id = ?").run(target.id);
    await db.prepare("DELETE FROM admin_login_tickets WHERE admin_id = ?").run(target.id);
    // Whatever the attempts at its code had added up to is cleared with it: this is how a locked-out account is let back in at once.
    await clearAttempts(target.id);
    // AI assistants signed in as the account are signed out with it (lib/mcp/oauth.ts).
    await db.prepare("UPDATE oauth_grants SET revoked_at = datetime('now'), revoked_reason = 'two-factor sign-in was reset' WHERE admin_id = ? AND revoked_at IS NULL").run(target.id);
    await db
      .prepare("INSERT INTO two_factor_resets (admin_id, reset_by, by_console, reason) VALUES (?, ?, ?, ?)")
      .run(target.id, entry.by?.id ?? null, entry.by === null, entry.reason.trim());
  });
  const who = (t: T) => (entry.by ? `${entry.by.name} (${entry.by.email})` : t("sl8.tfa.console"));
  if (entry.by)
    await logAction(entry.by, { venueId: target.venueId, businessId: target.businessId, action: "staff.twoFactorReset", detail: `${target.name} (${target.email}): ${entry.reason.trim()}` });
  const site = siteName();
  const own = translator(staffReaderLocale(target.locale));
  await emailPlain({
    to: target.email,
    subject: own("sl8.tfa.subject", { site }),
    text: own("sl8.tfa.body", { name: target.name, who: who(own), site }),
    kind: "auth_email",
    venueId: target.venueId,
    locale: own.locale,
  });
  await tellOwnersEach(({ customer: t }) => ({
    subject: t("sl8.tfa.ownerSubject", { site, name: target.name }),
    body: t("sl8.tfa.ownerBody", { name: target.name, email: target.email, who: who(t), reason: entry.reason.trim() }),
  }));
}

/**
 * Reset `targetId`'s two-factor sign-in, by `by`, who proves it is them with
 * `code` (their own current code or one of their recovery codes).
 */
export async function resetTwoFactorFor(by: Admin, targetId: number, input: { reason: unknown; code: unknown; address?: string }): Promise<ResetResult> {
  if (!isOwner(by) && !isManager(by)) return refused("Only a platform owner or a business manager can reset two-factor sign-in.");
  if (targetId === by.id) return refused("You cannot reset your own two-factor sign-in. Use a recovery code, or ask somebody above you.", 409);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < MIN_REASON)
    return refused("Say how you confirmed it is really them: seen in person, or called on a number already on file.", 400);
  const target = (await listAdminsFor(by)).find((a) => a.id === targetId);
  if (!target) return refused("That account is not one you manage.");
  // An owner is reset only by another owner.
  if (isOwner(target) && !isOwner(by)) return refused("Only another platform owner can reset an owner's two-factor sign-in.");
  // Somebody resetting others' protection has it on themselves, and shows it now.
  if (!(await hasTwoFactor(by.id))) return refused("Turn two-factor sign-in on for your own account before resetting anybody else's.");
  if (typeof input.code !== "string" || !(await checkSecondFactor(by.id, input.code, input.address ?? "")))
    return refused("Your own two-factor code is not right.", 401);
  if (!(await hasTwoFactor(target.id))) return refused("That account does not have two-factor sign-in on.", 409);
  await reset(target, { by, reason });
  return { ok: true };
}

/**
 * The console's reset, for the last owner (or any account) when nobody above
 * can do it: run on the server, by whoever controls it.
 */
export async function resetFromConsole(email: string, reason: string): Promise<ResetResult> {
  if (reason.trim().length < MIN_REASON) return refused("Give a reason of at least ten characters: how you confirmed who asked.", 400);
  const target = (await listAdmins()).find((a) => a.email.toLowerCase() === email.trim().toLowerCase());
  if (!target) return refused("No staff account has that email.", 404);
  if (!(await hasTwoFactor(target.id))) return refused("That account does not have two-factor sign-in on.", 409);
  await reset(target, { by: null, reason });
  return { ok: true };
}

/** The resets made on accounts this admin can see, newest first. */
export async function listResets(by: Admin): Promise<{ adminId: number; resetBy: number | null; byConsole: boolean; reason: string; createdAt: string }[]> {
  const ids = new Set((await listAdminsFor(by)).map((a) => a.id));
  const rows = (await getDb()
    .prepare("SELECT admin_id, reset_by, by_console, reason, created_at FROM two_factor_resets ORDER BY created_at DESC LIMIT 200")
    .all()) as { admin_id: number; reset_by: number | null; by_console: boolean; reason: string; created_at: string }[];
  return rows
    .filter((r) => ids.has(r.admin_id))
    .map((r) => ({ adminId: r.admin_id, resetBy: r.reset_by, byConsole: Boolean(r.by_console), reason: r.reason, createdAt: String(r.created_at) }));
}
