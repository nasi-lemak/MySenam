-- READ ONLY. The manual-review table for bookings paid at the counter and then cancelled by the customer, from before a customer's
-- cancellation was written down as owed back (migration 0346, ADR 0074). It changes nothing: it lists, for a manager to review before the
-- pilot. Run it against a replica or the live database with:  psql "$DATABASE_URL" -f scripts/reconcile-counter-cancellations.sql
-- (add  -A -F ',' --csv  for a spreadsheet). How to read it: docs/features/payments-and-credit.md#owed-back-after-a-customer-cancels.
--
-- A row is a lead, not a proof. Before that change a customer's cancellation wrote the credit note (the tax document) and nothing else,
-- so nobody can say from the data whether the money was handed back at the counter at the time. Ask the customer or check the till of the
-- day; where it was not handed back, the manager decides how to settle it (a staff payout or credit is made by hand, not here). Nothing
-- is written, backfilled, created as a task or marked paid by this script, and it names no customer: the booking code and the venue are
-- the key (look the booking up in the dashboard, which is where its customer is shown to staff of that venue).
--
-- Listed: a booking cancelled, paid at the counter (cash, QR, transfer, card, or a tick whose method was never recorded; not an account's
-- charge), with a credit note, and
--   * no row on the list of counter money owed back (`counter_refunds_owed`),
--   * no payout (`counter_payouts`),
--   * no stored credit given by a member of staff for it (`wallet_entries.admin_id`), and
--   * no entry in the staff activity log as cancelled by a member of staff (staff and the venue's own cancellations are logged; a
--     customer's is not).
-- A test or demo booking is left out.
--
-- Columns:
--   venue                 the venue's name.
--   booking_code          the booking.
--   cancelled_on          the date of the credit note on the venue's calendar (the venue's zone, Asia/Kuala_Lumpur where none is stored):
--                         there is no cancelled-at column, so the credit note's date is the cancellation's.
--   amount_possibly_owed  the credit note's total in RM: what the cancellation sold back, after any late share the venue kept.
--   paid_with             how the customer paid (cash, qr, transfer, card), or "not recorded".
--   payout_evidence       "none found", or the staff activity-log actions that name this booking and say money was handed back
--                         (payment.paid_out, payment.owed_credited): the log may know what the payout list does not.
--   possible_duplicate    "no", or why handing the amount back again could pay twice: other credit notes on the booking (a move to a
--                         cheaper time, a place taken off, a price adjustment: part may already be back) or stored credit added for it.
--   staff_action          what to do, in words.
--   credit_note           the credit note's number, the tax document that records the cancellation.
SELECT v.name AS venue,
       b.code AS booking_code,
       to_char((cn.issued_at::timestamp AT TIME ZONE 'UTC') AT TIME ZONE COALESCE(v.time_zone, 'Asia/Kuala_Lumpur'), 'YYYY-MM-DD') AS cancelled_on,
       cn.total::float AS amount_possibly_owed,
       COALESCE(b.paid_via, 'not recorded') AS paid_with,
       CASE WHEN sa.actions IS NULL THEN 'none found' ELSE 'activity log: ' || sa.actions END AS payout_evidence,
       CASE
         WHEN oc.n > 0 AND wc.total > 0 THEN 'yes: ' || oc.n || ' other credit note(s) totalling RM' || to_char(oc.total, 'FM999990.00') || ' and RM' || to_char(wc.total, 'FM999990.00') || ' stored credit'
         WHEN oc.n > 0 THEN 'yes: ' || oc.n || ' other credit note(s) totalling RM' || to_char(oc.total, 'FM999990.00')
         WHEN wc.total > 0 THEN 'yes: RM' || to_char(wc.total, 'FM999990.00') || ' stored credit added for this booking'
         ELSE 'no'
       END AS possible_duplicate,
       CASE
         WHEN sa.actions IS NOT NULL OR oc.n > 0 OR wc.total > 0 THEN 'Check the evidence first: part or all of it may already be back. Hand back only what is still owed, once, and note it.'
         ELSE 'Ask the customer or check the till of that day. If it was not handed back, hand it back once and note it; if it was, leave it.'
       END AS staff_action,
       cn.number AS credit_note
  FROM bookings b
  JOIN courts c ON c.id = b.court_id
  JOIN venues v ON v.id = c.venue_id
  JOIN receipts cn ON cn.source = 'booking:' || b.id AND cn.kind = 'credit_note'
  LEFT JOIN LATERAL (SELECT COUNT(*) AS n, COALESCE(SUM(o.total), 0)::float AS total
                       FROM receipts o WHERE o.kind = 'credit_note' AND o.source LIKE 'booking:' || b.id || ':%') oc ON true
  LEFT JOIN LATERAL (SELECT COALESCE(SUM(w.amount), 0)::float AS total
                       FROM wallet_entries w WHERE w.booking_id = b.id AND w.amount > 0) wc ON true
  LEFT JOIN LATERAL (SELECT string_agg(DISTINCT s.action, ', ' ORDER BY s.action) AS actions
                       FROM staff_actions s WHERE s.booking_code = b.code AND s.action IN ('payment.paid_out', 'payment.owed_credited')) sa ON true
 WHERE b.status = 'cancelled'
   AND b.payment_status = 'paid'
   AND (b.paid_via IS NULL OR b.paid_via IN ('cash', 'qr', 'transfer', 'card'))
   AND b.account_id IS NULL
   AND NOT b.test AND b.demo = 0
   AND cn.total > 0
   AND NOT EXISTS (SELECT 1 FROM counter_refunds_owed o WHERE o.booking_id = b.id)
   AND NOT EXISTS (SELECT 1 FROM counter_payouts p WHERE p.booking_id = b.id)
   AND NOT EXISTS (SELECT 1 FROM wallet_entries w WHERE w.booking_id = b.id AND w.admin_id IS NOT NULL AND w.amount > 0)
   AND NOT EXISTS (SELECT 1 FROM staff_actions s WHERE s.booking_code = b.code AND s.action = 'booking.cancelled')
 ORDER BY v.name, cn.issued_at, b.code;
