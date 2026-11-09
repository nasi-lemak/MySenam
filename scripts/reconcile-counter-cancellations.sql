-- READ ONLY. The manual-review table for bookings paid at the counter and then cancelled by the customer (or a person taken off them by the
-- customer or the venue's API key), from before a customer's cancellation was written down as owed back (migration 0346, ADR 0074). It
-- changes nothing: it lists, for a manager to review. Run it against a replica or the live database with:
-- psql "$DATABASE_URL" -f scripts/reconcile-counter-cancellations.sql
-- (add  -A -F ',' --csv  for a spreadsheet). How to read it: docs/features/payments-and-credit.md#owed-back-after-a-customer-cancels.
-- The same list is in the dashboard for a venue's managers, where each row's outcome is recorded once (ADR 0078,
-- lib/historical-counter-refunds.ts, which keeps these rules; tests/historical-counter-refunds.test.ts checks both list the same notes).
--
-- A row is a lead, not a proof. Before that change a customer's cancellation wrote the credit note (the tax document) and nothing else,
-- so nobody can say from the data whether the money was handed back at the counter at the time. Ask the customer or check the till of the
-- day; record what the evidence shows in the dashboard (*Bookings*, under the owed-back list). Nothing is written, backfilled, created as a
-- task or marked paid by this script, and it names no customer: the booking code and the venue are the key (look the booking up in the
-- dashboard, which is where its customer is shown to staff of that venue).
--
-- Listed, one row per CREDIT NOTE, written before migration 0346 was applied, above nothing, on a booking paid at the counter (cash, QR,
-- transfer, card, or a tick whose method was never recorded; not an account's charge), not a test or demo booking:
--   * a whole cancellation (the booking's credit note): the booking cancelled, and
--       - no row on the list of counter money owed back for the cancellation (`counter_refunds_owed`; a move's row is not one),
--       - no payout (`counter_payouts`) naming that credit note, or naming none (a payout from before payouts named their note may be it),
--       - no stored credit given by a member of staff for it (`wallet_entries.admin_id`; a move's or a withdrawal's credit is not it), and
--       - no entry in the staff activity log as cancelled by a member of staff (staff and the venue's own cancellations are logged; a
--         customer's is not);
--   * a person taken off by the customer or the venue's API key (the withdrawal's credit note): no owed row for that withdrawal, no payout
--     naming its credit note, no stored credit given by staff for it.
--
-- Columns:
--   venue                 the venue's name.
--   booking_code          the booking.
--   what                  "cancellation" (the whole booking) or "person taken off".
--   cancelled_on          the date of the credit note on the venue's calendar (the venue's zone, Asia/Kuala_Lumpur where none is stored):
--                         there is no cancelled-at column, so the credit note's date is the cancellation's.
--   amount_possibly_owed  the credit note's total in RM: what the cancellation sold back, after any late share the venue kept.
--   paid_with             how the customer paid (cash, qr, transfer, card), or "not recorded".
--   payout_evidence       "none found", or the staff activity-log actions that name this booking and say money was handed back
--                         (payment.paid_out, payment.owed_credited): the log may know what the payout list does not.
--   possible_duplicate    "no", or why handing the amount back again could pay twice: other credit notes on the booking (a move to a
--                         cheaper time, a place taken off, a price adjustment: part may already be back), stored credit added for it, or
--                         money already handed back at the counter on the booking.
--   staff_action          what to do, in words.
--   credit_note           the credit note's number, the tax document that records the cancellation.
WITH cand AS (
  SELECT 'cancellation' AS what, b.id AS booking_id, cn.id AS note_id
    FROM bookings b JOIN receipts cn ON cn.kind = 'credit_note' AND cn.source = 'booking:' || b.id
   WHERE b.status = 'cancelled'
     AND b.payment_status = 'paid'
     AND (b.paid_via IS NULL OR b.paid_via IN ('cash', 'qr', 'transfer', 'card'))
     AND b.account_id IS NULL
     AND NOT b.test AND b.demo = 0
     AND cn.total > 0
     AND (cn.issued_at::timestamp AT TIME ZONE 'UTC') < COALESCE((SELECT applied_at FROM schema_migrations WHERE version = '0346_customer_cancel_counter_owed'), 'infinity'::timestamptz)
     AND NOT EXISTS (SELECT 1 FROM counter_refunds_owed o WHERE o.booking_id = b.id AND o.move_refund_id IS NULL AND o.withdrawal_id IS NULL)
     AND NOT EXISTS (SELECT 1 FROM counter_payouts p WHERE p.booking_id = b.id AND (p.credit_note_id IS NULL OR p.credit_note_id = cn.id))
     AND NOT EXISTS (SELECT 1 FROM wallet_entries w WHERE w.booking_id = b.id AND w.admin_id IS NOT NULL AND w.amount > 0
                        AND w.move_refund_id IS NULL AND w.withdrawal_id IS NULL)
     AND NOT EXISTS (SELECT 1 FROM staff_actions s WHERE s.booking_code = b.code AND s.action = 'booking.cancelled')
  UNION ALL
  SELECT 'person taken off', b.id, cn.id
    FROM place_withdrawals pw JOIN bookings b ON b.id = pw.booking_id
    JOIN receipts cn ON cn.kind = 'credit_note' AND cn.source = 'booking:' || b.id || ':place:' || pw.id
   WHERE pw.by_kind IN ('customer', 'api') AND pw.paid
     AND b.payment_status = 'paid'
     AND (b.paid_via IS NULL OR b.paid_via IN ('cash', 'qr', 'transfer', 'card'))
     AND b.account_id IS NULL
     AND NOT b.test AND b.demo = 0
     AND cn.total > 0
     AND (cn.issued_at::timestamp AT TIME ZONE 'UTC') < COALESCE((SELECT applied_at FROM schema_migrations WHERE version = '0346_customer_cancel_counter_owed'), 'infinity'::timestamptz)
     AND NOT EXISTS (SELECT 1 FROM counter_refunds_owed o WHERE o.withdrawal_id = pw.id)
     AND NOT EXISTS (SELECT 1 FROM counter_payouts p WHERE p.credit_note_id = cn.id)
     AND NOT EXISTS (SELECT 1 FROM wallet_entries w WHERE w.withdrawal_id = pw.id AND w.admin_id IS NOT NULL AND w.amount > 0)
)
SELECT v.name AS venue,
       b.code AS booking_code,
       cand.what,
       to_char((cn.issued_at::timestamp AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(v.time_zone, 'Asia/Kuala_Lumpur'), 'YYYY-MM-DD') AS cancelled_on,
       cn.total::float AS amount_possibly_owed,
       COALESCE(b.paid_via, 'not recorded') AS paid_with,
       CASE WHEN sa.actions IS NULL THEN 'none found' ELSE 'activity log: ' || sa.actions END AS payout_evidence,
       CASE
         WHEN oc.n > 0 OR wc.total > 0 OR pc.total > 0 THEN 'yes: ' || concat_ws(' and ',
           CASE WHEN oc.n > 0 THEN oc.n || ' other credit note(s) totalling RM' || to_char(oc.total, 'FM999990.00') END,
           CASE WHEN wc.total > 0 THEN 'RM' || to_char(wc.total, 'FM999990.00') || CASE WHEN oc.n > 0 THEN ' stored credit' ELSE ' stored credit added for this booking' END END,
           CASE WHEN pc.total > 0 THEN 'RM' || to_char(pc.total, 'FM999990.00') || ' already handed back at the counter on this booking' END)
         ELSE 'no'
       END AS possible_duplicate,
       CASE
         WHEN sa.actions IS NOT NULL OR oc.n > 0 OR wc.total > 0 OR pc.total > 0 THEN 'Check the evidence first: part or all of it may already be back. Record only what the evidence shows, once.'
         ELSE 'Ask the customer or check the till of that day, then record in the dashboard what the evidence shows: handed back then, or handed back now. Not enough evidence: record nothing.'
       END AS staff_action,
       cn.number AS credit_note
  FROM cand
  JOIN receipts cn ON cn.id = cand.note_id
  JOIN bookings b ON b.id = cand.booking_id
  JOIN courts c ON c.id = b.court_id
  JOIN venues v ON v.id = c.venue_id
  LEFT JOIN LATERAL (SELECT COUNT(*) AS n, COALESCE(SUM(o.total), 0)::float AS total
                       FROM receipts o WHERE o.kind = 'credit_note' AND o.id <> cn.id
                        AND (o.source = 'booking:' || b.id OR o.source LIKE 'booking:' || b.id || ':%')) oc ON true
  LEFT JOIN LATERAL (SELECT COALESCE(SUM(w.amount), 0)::float AS total
                       FROM wallet_entries w WHERE w.booking_id = b.id AND w.amount > 0) wc ON true
  LEFT JOIN LATERAL (SELECT COALESCE(SUM(p.amount), 0)::float AS total
                       FROM counter_payouts p WHERE p.booking_id = b.id) pc ON true
  LEFT JOIN LATERAL (SELECT string_agg(DISTINCT s.action, ', ' ORDER BY s.action) AS actions
                       FROM staff_actions s WHERE s.booking_code = b.code AND s.action IN ('payment.paid_out', 'payment.owed_credited')) sa ON true
 ORDER BY v.name, cn.issued_at, b.code, cn.number;
