/**
 * Why a send failed, in the one way the outbox needs to know: will trying again help?
 *
 * Almost every failure is a provider or network failure (a mail account suspended, a WhatsApp token that has
 * expired, DNS, a timeout, a throttle): the message is fine and a later try may work, so the outbox keeps
 * trying with a capped backoff until the message is too old to matter (lib/outbox.ts `maxMessageAgeDays`).
 * A few failures are about the message itself and trying again can only fail the same way (the address is not
 * an address, the number is one WhatsApp says it cannot deliver to, the message was never written for this
 * channel): a transport throws one of these to have the message given up at once, with the reason.
 *
 * Anything not marked here is treated as transient. Wrongly giving up a message that would have gone is worse
 * than trying a bad one for a few days at a slow cadence.
 */
export class PermanentSendError extends Error {
  readonly permanent = true;
  // A plain constructor, not parameter properties: scripts load files like this one with Node's type stripping.
  constructor(message: string) {
    super(message);
    this.name = "PermanentSendError";
  }
}

/** Whether a thrown error says that sending again cannot help. */
export function isPermanentSendError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { permanent?: unknown }).permanent === true;
}
