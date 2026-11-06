import { getDb } from "./db";

/**
 * Whose an online payment (alias `p`) provably is: the account's own bookings, top-ups, membership, pass, place in an open game or
 * tournament entry. Takes `userId` six times. Shared by the erasure and the data export, so each says the same.
 */
export const PAYMENTS_OF_USER = `(p.id IN (SELECT payment_id FROM online_payment_bookings WHERE booking_id IN (SELECT id FROM bookings WHERE user_id = ?))
               OR p.topup_user_id = ? OR p.member_user_id = ? OR p.pass_user_id = ?
               OR p.game_player_id IN (SELECT id FROM open_game_players WHERE user_id = ?)
               OR p.tournament_entry_id IN (SELECT id FROM tournament_entries WHERE user_id = ?))`;

/** The webhook deliveries (alias `d`) about the account's bookings: their payload names the booking by its code. Takes `userId` once. */
export const DELIVERIES_OF_USER = `EXISTS (SELECT 1 FROM bookings b WHERE b.user_id = ? AND d.payload LIKE '%"code":"' || b.code || '"%')`;

/**
 * What an erased customer left in the records that are kept for other reasons (audit 9, G6; docs/architecture/privacy.md#erasure).
 *
 * Money rows stay (an online payment's amount, its refunds, who it was for in the books); the person in them does not:
 *
 * - **Online payments** (`online_payments`): the payer's name and number, on every payment that is provably theirs: one for their
 *   bookings, their top-ups, their membership or pass, their place in an open game or a tournament. The row, its amount, its
 *   refunds and its gateway bill stay.
 * - **Messages** (`messages`): to their account's email, to the number their account proved, or about their bookings. What was
 *   sent keeps its kind, its status and when, as the venue's count of messages sent (and what WhatsApp charged) needs, but not
 *   the address or number, the subject, the text or its parameters. One still waiting to go is given up, so nothing is
 *   sent to them after.
 * - **Webhook deliveries** (`webhook_deliveries`): what a venue's own systems were sent about their bookings. One not yet sent
 *   is dropped, and one that was sent keeps only that it was.
 * - **Urgent notices** (`urgent_notices`): the name, number and email on a "your booking was cancelled or moved" notice for
 *   their bookings.
 *
 * Nothing is matched by a phone number alone: a number is not proof (it is shared and reassigned), so a guest's rows that merely
 * carry the same number are not touched; the number their account has proved is theirs.
 *
 * Run inside the erasure's transaction, before their bookings stop being linked to them. The same rules, applied by age, are
 * the retention run's (lib/privacy.ts RULES: the payers after `bookingIdentityDays`, messages and deliveries after theirs).
 */
export async function eraseTracesOfUser(userId: number, email: string): Promise<void> {
  const db = getDb();
  const theirBookings = "SELECT id FROM bookings WHERE user_id = ?";

  await db
    .prepare(
      `UPDATE online_payments p
          SET payer_name = CASE WHEN p.payer_name IS NULL THEN NULL ELSE '(removed)' END, payer_phone = NULL
        WHERE (p.payer_name IS NOT NULL AND p.payer_name <> '(removed)' OR p.payer_phone IS NOT NULL) AND ${PAYMENTS_OF_USER}`
    )
    .run(userId, userId, userId, userId, userId, userId);

  await db
    .prepare(
      `UPDATE messages
          SET status = CASE WHEN status IN ('queued', 'failed') THEN 'abandoned' ELSE status END,
              last_error = CASE WHEN status IN ('queued', 'failed') THEN 'The recipient was erased before it was sent.' ELSE NULL END,
              recipient = '(removed)', subject = CASE WHEN subject IS NULL THEN NULL ELSE '(removed)' END,
              body = '(removed)', params = NULL, calendar = NULL, delivery_error = NULL
        WHERE booking_id IN (${theirBookings})
           OR (channel = 'email' AND lower(recipient) = lower(?))
           OR (channel = 'whatsapp' AND phone_key(recipient) <> ''
               AND phone_key(recipient) IN (SELECT phone_key(verified_phone) FROM users WHERE id = ? AND verified_phone IS NOT NULL))`
    )
    .run(userId, email, userId);

  // What a venue's own systems were sent about their bookings: one not yet sent is dropped, one that was keeps only that it was.
  await db.prepare(`DELETE FROM webhook_deliveries d WHERE d.delivered_at IS NULL AND d.attempts < 8 AND ${DELIVERIES_OF_USER}`).run(userId);
  await db
    .prepare(
      `UPDATE webhook_deliveries d
          SET payload = jsonb_build_object('id', d.payload::jsonb -> 'id', 'type', d.payload::jsonb -> 'type', 'created', d.payload::jsonb -> 'created', 'erased', true)::text
        WHERE ${DELIVERIES_OF_USER}`
    )
    .run(userId);

  await db
    .prepare(
      `UPDATE urgent_notices SET name = '(removed)', phone = '', email = NULL, summary = '(removed)', summary_phrase = NULL
        WHERE booking_id IN (${theirBookings})`
    )
    .run(userId);
}
