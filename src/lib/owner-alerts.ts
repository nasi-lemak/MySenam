import { isOwner, listAdmins } from "./admin-auth";
import { getDb } from "./db";
import { siteName } from "./site";
import { sendPlainEmail } from "./transports";

/**
 * Tell every platform owner something a venue did that they would want to
 * know about: a new name, or a sudden pile of new courts or classes. Nothing
 * is held back waiting for them; they hear about it, and can undo it.
 */
export async function tellOwners(subject: string, body: string): Promise<void> {
  const owners = (await listAdmins()).filter(isOwner);
  for (const owner of owners)
    await sendPlainEmail(
      owner.email,
      subject,
      `${body}\n\nNothing needs doing if that is right. If it is not, change it under Venues & staff.\n\n${siteName()}`
    );
}

/** A venue's own managers and staff, by email: its business's managers, and anyone at that branch. */
export async function tellVenueStaff(venueId: number, subject: string, body: string): Promise<void> {
  const people = (await getDb()
    .prepare(
      `SELECT a.email, a.name FROM admins a
        WHERE a.venue_id = ? OR a.business_id = (SELECT business_id FROM venues WHERE id = ?)`
    )
    .all(venueId, venueId)) as { email: string; name: string }[];
  for (const p of people) await sendPlainEmail(p.email, subject, `Hi ${p.name},\n\n${body}\n\n${siteName()}`);
}
