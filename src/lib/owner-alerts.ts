import { isOwner, listAdmins } from "./admin-auth";
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
