import { isOwner, listAdmins } from "./admin-auth";
import { getDb } from "./db";
import { emailPlain } from "./outbox";
import { siteName } from "./site";

/** An alert no longer worth sending a week on (an outbox with no mail server set up for that long). */
const ALERT_EXPIRES_MINUTES = 7 * 24 * 60;

/**
 * Tell every platform owner something a venue did that they would want to
 * know about: a new name, or a sudden pile of new courts or classes. Nothing
 * is held back waiting for them; they hear about it, and can undo it.
 * Queued in the outbox, so a mail server that is down delays it rather than
 * losing it, and the owners can see under Messages how it went.
 */
export async function tellOwners(subject: string, body: string): Promise<void> {
  const owners = (await listAdmins()).filter(isOwner);
  for (const owner of owners)
    await emailPlain({
      to: owner.email,
      subject,
      text: `${body}\n\nNothing needs doing if that is right. If it is not, change it under Venues & staff.\n\n${siteName()}`,
      kind: "staff_alert",
      expiresMinutes: ALERT_EXPIRES_MINUTES,
    });
}

/** A venue's own managers and staff, by email: its business's managers, and anyone at that branch. */
export async function tellVenueStaff(venueId: number, subject: string, body: string): Promise<void> {
  const people = (await getDb()
    .prepare(
      `SELECT a.email, a.name FROM admins a
        WHERE a.venue_id = ? OR a.business_id = (SELECT business_id FROM venues WHERE id = ?)`
    )
    .all(venueId, venueId)) as { email: string; name: string }[];
  for (const p of people)
    await emailPlain({
      to: p.email,
      subject,
      text: `Hi ${p.name},\n\n${body}\n\n${siteName()}`,
      kind: "staff_alert",
      venueId,
      expiresMinutes: ALERT_EXPIRES_MINUTES,
    });
}
