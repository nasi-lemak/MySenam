import { getDb } from "./db";
import {
  MESSAGES_PER_RECIPIENT_PER_DAY,
  messageById,
  sentToday,
  transport,
  type OutboxMessage,
} from "./outbox";
import { phoneNumber } from "./phone-check";
import { refundCredit, spendCredit } from "./whatsapp-credit";

/**
 * A customer who opened the chat with us, from the confirmation screen.
 *
 * WhatsApp lets a business answer a customer who wrote first with plain text;
 * starting the conversation takes an approved template. Meta has charged for
 * templates and not for replies — reportedly no longer always so — and a
 * reply is paid for from the venue's credit like any other message. So the confirmation screen offers "Send it to my
 * WhatsApp", which opens a chat with the booking code typed in, and the
 * confirmation itself waits a few minutes (lib/outbox.ts). If the customer
 * sends it in that time, the confirmation goes as the reply, free, and the
 * template never does. If they write later, they get the latest message about
 * the booking again, also free.
 *
 * Only to the number the booking was made with: a code alone is not enough to
 * be told about somebody else's booking.
 */

const CODE = /\b(MS|SR)-[A-Z2-9]{6}\b/i;
const CONFIRMATIONS = ["booking_confirmed", "booking_series_confirmed", "class_enrolled"];

export interface ChatAnswer {
  answered: boolean;
  /** The message sent as the reply. */
  message?: OutboxMessage;
  /** Why nothing was sent, for the log. */
  reason?: string;
}

/** The bookings a code names, if they were made with this number. */
async function bookingsFor(code: string, from: string): Promise<number[]> {
  const column = code.startsWith("SR-") ? "series_code" : "code";
  const rows = (await getDb()
    .prepare(`SELECT id, phone FROM bookings WHERE upper(${column}) = ? ORDER BY id`)
    .all(code)) as { id: number; phone: string }[];
  const sender = phoneNumber(from);
  if (!sender) return [];
  return rows.filter((r) => phoneNumber(r.phone) === sender).map((r) => r.id);
}

/** Answer a customer's message to the platform's number. */
export async function answerChat(from: string, text: string): Promise<ChatAnswer> {
  const code = text.match(CODE)?.[0].toUpperCase();
  if (!code) return { answered: false, reason: "no booking code" };
  const ids = await bookingsFor(code, from);
  if (ids.length === 0) return { answered: false, reason: "no booking with that code for this number" };
  const post = transport();
  if (!post) return { answered: false, reason: "no transport" };
  const db = getDb();
  const list = ids.map(() => "?").join(",");

  // The confirmation still waiting: claimed for the reply, so the template
  // that would have followed is never sent.
  const held = (await db
    .prepare(
      `SELECT id FROM messages
        WHERE booking_id IN (${list}) AND channel = 'whatsapp' AND status IN ('queued','failed') AND free = 0
          AND kind IN (${CONFIRMATIONS.map(() => "?").join(",")})
        ORDER BY id LIMIT 1`
    )
    .get(...ids, ...CONFIRMATIONS)) as { id: number } | undefined;
  if (held) {
    const claimed = await db
      .prepare(
        `UPDATE messages SET free = 1, next_attempt_at = datetime('now', '+1 day')
          WHERE id = ? AND status IN ('queued','failed') AND free = 0`
      )
      .run(held.id);
    if (claimed.changes === 1) {
      const message = (await messageById(held.id))!;
      // Paid for like any WhatsApp message: Meta may charge for a reply too.
      if (!(await spendCredit(message.venueId, message.id))) {
        await db.prepare("UPDATE messages SET free = 0, next_attempt_at = datetime('now') WHERE id = ?").run(held.id);
        return { answered: false, reason: "no WhatsApp credit" };
      }
      try {
        await post.send(message);
      } catch (err) {
        await refundCredit(message.venueId, message.id);
        // Back to the queue as the template it was.
        await db
          .prepare("UPDATE messages SET free = 0, next_attempt_at = datetime('now'), last_error = ? WHERE id = ?")
          .run(err instanceof Error ? err.message : String(err), held.id);
        return { answered: false, reason: "the reply could not be sent" };
      }
      await db
        .prepare(
          "UPDATE messages SET status = 'sent', attempts = attempts + 1, sent_at = datetime('now'), last_error = NULL WHERE id = ?"
        )
        .run(held.id);
      return { answered: true, message: (await messageById(held.id))! };
    }
  }

  // Nothing waiting: the latest word about the booking, again, as a reply.
  const latest = (await db
    .prepare(
      `SELECT id FROM messages WHERE booking_id IN (${list}) AND channel = 'whatsapp' AND status = 'sent'
        ORDER BY id DESC LIMIT 1`
    )
    .get(...ids)) as { id: number } | undefined;
  if (!latest) return { answered: false, reason: "nothing to send about it yet" };
  const original = (await messageById(latest.id))!;
  if ((await sentToday("whatsapp", original.recipient)) >= MESSAGES_PER_RECIPIENT_PER_DAY)
    return { answered: false, reason: "daily limit for this number" };
  const info = await db
    .prepare(
      `INSERT INTO messages (booking_id, venue_id, kind, channel, recipient, locale, subject, body, params, status, free, next_attempt_at)
       VALUES (?, ?, ?, 'whatsapp', ?, ?, ?, ?, ?, 'queued', 1, datetime('now', '+1 day'))`
    )
    .run(
      original.bookingId,
      original.venueId,
      original.kind,
      original.recipient,
      original.locale,
      original.subject,
      original.body,
      original.params ? JSON.stringify(original.params) : null
    );
  const id = info.lastInsertRowid as number;
  if (!(await spendCredit(original.venueId, id))) {
    await db.prepare("UPDATE messages SET status = 'abandoned', last_error = 'Not sent: no WhatsApp credit left.' WHERE id = ?").run(id);
    return { answered: false, reason: "no WhatsApp credit" };
  }
  try {
    await post.send((await messageById(id))!);
  } catch (err) {
    await refundCredit(original.venueId, id);
    await db
      .prepare("UPDATE messages SET status = 'abandoned', attempts = 1, last_error = ? WHERE id = ?")
      .run(err instanceof Error ? err.message : String(err), id);
    return { answered: false, reason: "the reply could not be sent" };
  }
  await db.prepare("UPDATE messages SET status = 'sent', attempts = 1, sent_at = datetime('now') WHERE id = ?").run(id);
  return { answered: true, message: (await messageById(id))! };
}
