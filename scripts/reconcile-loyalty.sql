-- READ ONLY. Free hours for regulars (lib/loyalty.ts) that may have been given twice before the grant was made
-- idempotent (migration 0320, ADR 0066). It changes nothing: it lists, for a person to review. Run it against a replica or
-- the live database with:  psql "$DATABASE_URL" -f scripts/reconcile-loyalty.sql
-- How to read it: docs/features/pricing.md#a-free-hour-for-regulars. A listing is a lead, not a proof: the venue may have
-- changed or switched off "every N hours" since, and the dates compare against the UTC day.

-- 1. A number with more free hours recorded than its played, paid hours earn at the venue's present rule
--    (rewards_given > earned_now), or at a venue that has since switched the free hour off (earned_now is NULL).
WITH played AS (
  SELECT c.venue_id, b.phone_key, SUM(b.end_min - b.start_min) / 60.0 AS hours
    FROM bookings b JOIN courts c ON c.id = b.court_id
   WHERE b.date < to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD')
     AND b.status = 'confirmed' AND b.no_show = 0 AND b.demo = 0 AND NOT b.test
     AND b.class_id IS NULL AND b.payment_status = 'paid' AND b.total_price > 0 AND b.phone_key <> ''
     AND NOT EXISTS (SELECT 1 FROM pass_entries pe JOIN loyalty_rewards lr ON lr.pass_id = pe.pass_id WHERE pe.booking_id = b.id)
   GROUP BY c.venue_id, b.phone_key
), given AS (
  SELECT venue_id, phone_key, COUNT(*) AS rewards_given, ARRAY_AGG(pass_id ORDER BY id) AS pass_ids, MIN(created_at) AS first_given, MAX(created_at) AS last_given
    FROM loyalty_rewards GROUP BY venue_id, phone_key
)
SELECT g.venue_id, v.name AS venue, g.phone_key, g.rewards_given, v.loyalty_every,
       CASE WHEN v.loyalty_every IS NULL THEN NULL ELSE FLOOR(COALESCE(p.hours, 0) / v.loyalty_every)::int END AS earned_now,
       COALESCE(p.hours, 0)::float AS paid_hours_played, g.pass_ids, g.first_given, g.last_given
  FROM given g JOIN venues v ON v.id = g.venue_id LEFT JOIN played p ON p.venue_id = g.venue_id AND p.phone_key = g.phone_key
 WHERE v.loyalty_every IS NULL OR g.rewards_given > FLOOR(COALESCE(p.hours, 0) / v.loyalty_every)
 ORDER BY g.venue_id, g.phone_key;

-- 2. Free-hour passes that no reward row points at: issued, then the run stopped before recording it (a later run gave another).
SELECT p.venue_id, p.id AS pass_id, p.code, p.holder_name, p.holder_phone, p.created_at, p.status
  FROM passes p
 WHERE p.name = 'Loyalty: one free hour' AND p.price = 0 AND p.admin_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM loyalty_rewards lr WHERE lr.pass_id = p.id)
 ORDER BY p.venue_id, p.id;
