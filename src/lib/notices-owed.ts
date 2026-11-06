import { AsyncLocalStorage } from "async_hooks";
import { getDb } from "./db";

/**
 * A message a customer is owed, written down with the fact it is about.
 *
 * A booking is committed in one transaction and its confirmation is written afterwards, by the route that made it; a venue's or a
 * customer's cancellation the same, with a gateway call in between. A server that stops in the gap leaves a customer with a court
 * and no message, or a cancelled court and no word, and nothing ever looked for them (audit 9, G11 and C17).
 *
 * The least invasive fix that closes the gap: the transaction that makes the fact also writes one `notices_owed` row, and a sweep
 * (lib/notify.ts `tellOwedNotices`, run with every outbox tick) writes the message for any row whose message does not exist. The
 * request keeps writing its own message at once, with all it knows (what the staff chose, what the gateway said); the sweep is only
 * the net, and a message that exists is never written twice (the dedupe keys of lib/notify.ts).
 *
 * Which facts owe a message is the caller's to say, because not every way of making them tells the customer (the venue's own
 * system, a test booking, a lesson moved by the venue say it another way): a route that tells the customer runs its work under
 * `owingCustomer`; a customer's own cancellation (`customerCancel`, called only by the two routes that tell them) always owes it.
 */
export type OwedKind = "booking_confirmed" | "booking_cancelled_by_venue" | "booking_cancelled";

const asking = new AsyncLocalStorage<{ kind: OwedKind }>();

/** Run `work`: what it makes of this kind (a booking confirmed, a booking the venue cancels) owes its customer a message. */
export function owingCustomer<T>(kind: OwedKind, work: () => Promise<T>): Promise<T> {
  return asking.run({ kind }, work);
}

/**
 * Inside the transaction that makes the fact: write the row, where this kind is owed (`always`, or the caller's work runs
 * `owingCustomer` for it). Once per booking and kind; writing it again changes nothing.
 */
export async function noticeOwed(bookingId: number, kind: OwedKind, always = false): Promise<void> {
  if (!always && asking.getStore()?.kind !== kind) return;
  await getDb()
    .prepare("INSERT INTO notices_owed (kind, booking_id) VALUES (?, ?) ON CONFLICT (kind, booking_id) DO NOTHING")
    .run(kind, bookingId);
}
