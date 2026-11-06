import { isOwner, listAdmins } from "./admin-auth";
import { getDb } from "./db";
import { emailPlain } from "./outbox";
import { siteName } from "./site";
import { staffTranslator, type StaffT } from "./staff-i18n";
import { staffReaderLocale } from "./staff-locales";

/**
 * What an alert may be told to leave out: people (by staff login email) who are not to be told, and a kind of its own for what is not for the
 * outbox screens a reported member of staff can read (`safeguarding_notice`, lib/outbox.ts: not listed there, and with no venue).
 */
export interface AlertOptions {
  exceptEmails?: string[];
  kind?: "staff_alert" | "safeguarding_notice";
  /** The same alert twice (a job run on two servers, a repeat) is queued once per reader: the key is made unique for each by their email. */
  dedupeKey?: string;
}

/** An alert no longer worth sending a week on (an outbox with no mail server set up for that long). */
const ALERT_EXPIRES_MINUTES = 7 * 24 * 60;

/** An alert as one reader reads it: written by `write` with the lookup in their own staff language. */
export type WriteAlert = (t: StaffT) => { subject: string; body: string };

/** Sentences joined as the reader's language writes them: a space between, none in Chinese. */
export function staffSentences(t: StaffT, ...parts: (string | false | null | undefined)[]): string {
  return parts.filter((p): p is string => Boolean(p)).join(t.locale === "zh" ? "" : " ");
}

/**
 * Tell every platform owner something they would want to know about: a
 * venue's new name, a sudden pile of new courts or classes, a dispute, a
 * failure. Nothing is held back waiting for them; they hear about it, and can
 * undo it. Each owner reads it in their own staff language
 * (lib/staff-locales.ts `staffReaderLocale`): `write` says the subject and
 * body with the lookup it is handed, once per owner. Queued in the outbox, so
 * a mail server that is down delays it rather than losing it, and the owners
 * can see under Messages how it went.
 */
export async function tellOwnersEach(write: WriteAlert, opts: AlertOptions = {}): Promise<void> {
  const except = new Set((opts.exceptEmails ?? []).map((e) => e.toLowerCase()));
  const owners = (await listAdmins()).filter(isOwner).filter((o) => !except.has(o.email.toLowerCase()));
  for (const owner of owners) {
    const t = staffTranslator(staffReaderLocale(owner.locale));
    const { subject, body } = write(t);
    await emailPlain({
      to: owner.email,
      subject,
      text: `${body}\n\n${t.customer("sl8.mail.ownerFooter", { site: siteName() })}`,
      kind: opts.kind ?? "staff_alert",
      expiresMinutes: ALERT_EXPIRES_MINUTES,
      locale: t.locale,
      ...(opts.dedupeKey ? { dedupeKey: `${opts.dedupeKey}:${owner.email.toLowerCase()}` } : {}),
    });
  }
}

/**
 * A venue's own managers and staff, by email: its business's managers, and
 * anyone at that branch, each in their own staff language, as
 * `tellOwnersEach`. `managersOnly` leaves out the branch's front desk (a
 * decision that is a manager's: lib/team-forfeits.ts).
 */
export async function tellVenueStaffEach(venueId: number, write: WriteAlert, opts: AlertOptions & { managersOnly?: boolean } = {}): Promise<void> {
  const except = new Set((opts.exceptEmails ?? []).map((e) => e.toLowerCase()));
  const people = (await getDb()
    .prepare(
      `SELECT a.email, a.name, a.locale FROM admins a
        WHERE (a.venue_id = ? OR a.business_id = (SELECT business_id FROM venues WHERE id = ?))${opts.managersOnly ? " AND NOT (a.venue_id IS NOT NULL AND a.role = 'desk')" : ""}`
    )
    .all(venueId, venueId)) as { email: string; name: string; locale: string | null }[];
  for (const p of people.filter((x) => !except.has(x.email.toLowerCase()))) {
    const t = staffTranslator(staffReaderLocale(p.locale));
    const { subject, body } = write(t);
    await emailPlain({
      to: p.email,
      subject,
      text: t("r9d.venueMail", { name: p.name, body, site: siteName() }),
      kind: opts.kind ?? "staff_alert",
      venueId: opts.kind === "safeguarding_notice" ? null : venueId,
      expiresMinutes: ALERT_EXPIRES_MINUTES,
      locale: t.locale,
      ...(opts.dedupeKey ? { dedupeKey: `${opts.dedupeKey}:${p.email.toLowerCase()}` } : {}),
    });
  }
}
