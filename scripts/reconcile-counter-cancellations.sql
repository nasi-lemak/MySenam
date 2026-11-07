-- READ ONLY. Bookings paid at the counter and then cancelled by the customer, from before a customer's cancellation was written down as
-- owed back (migration 0346, ADR 0074). It changes nothing: it lists, for a manager to review. Run it against a replica or the live
-- database with:  psql "$DATABASE_URL" -f scripts/reconcile-counter-cancellations.sql
-- How to read it: docs/features/payments-and-credit.md#owed-back-after-a-customer-cancels.
--
-- A row is a lead, not a proof. Before that change a customer's cancellation wrote the credit note (the tax document) and nothing
-- else, so nobody can say from the data whether the money was handed back at the counter at the time. Ask the customer or the till
-- of the day; where it was not handed back, the manager decides how to settle it (a staff payout or credit is made by hand, not here).
-- Nothing is written, backfilled or marked paid by this script.
--
-- Listed: a booking cancelled, paid at the counter (cash, QR, transfer, card, or a tick whose method was never recorded; not an account's
-- charge), with a credit note, and
--   * no row on the list of counter money owed back (`counter_refunds_owed`),
--   * no payout (`counter_payouts`),
--   * no stored credit given by a member of staff for it (`wallet_entries.admin_id`), and
--   * no entry in the staff activity log as cancelled by a member of staff (staff and the venue's own cancellations are logged; a
--     customer's is not).
-- A test or demo booking is left out. `amount` is the credit note's total, what the cancellation sold back (after any late share).
SELECT v.name AS venue,
       b.code,
       b.name AS customer,
       b.phone,
       b.date AS booking_date,
       cn.total::float AS amount,
       b.paid_via,
       cn.number AS credit_note,
       cn.issued_at AS credit_note_issued_at,
       b.late_cancelled = 1 AS late_cancellation
  FROM bookings b
  JOIN courts c ON c.id = b.court_id
  JOIN venues v ON v.id = c.venue_id
  JOIN receipts cn ON cn.source = 'booking:' || b.id AND cn.kind = 'credit_note'
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
