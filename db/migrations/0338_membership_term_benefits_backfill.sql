-- D6 / DEC-34 (ADR 0071): every membership sold before migration 0337 gets the benefits of its tier as they stand now, recorded as
-- `backfilled`. Deterministic and idempotent (only rows with no snapshot); a membership on no tier gets the plain snapshot (no
-- tier price level or window, the booking as its scope, no admission, no extension), which is what it gets today. Nothing earlier
-- is reconstructed or invented.
UPDATE memberships m
   SET benefits = jsonb_build_object(
         'ratePercent', t.rate_percent,
         'aheadDays', t.ahead_days,
         'scope', COALESCE(t.scope, 'booking'),
         'admitsEntry', COALESCE(t.admits_entry, FALSE),
         'admitsEntrySport', CASE WHEN COALESCE(t.admits_entry, FALSE) THEN t.admits_entry_sport ELSE NULL END,
         'extendOnSuspension', COALESCE(t.extend_on_suspension, FALSE)),
       benefits_version = t.version,
       benefits_source = 'backfilled'
  FROM membership_plans t
 WHERE t.id = m.tier_id AND m.benefits IS NULL;

UPDATE memberships
   SET benefits = jsonb_build_object('ratePercent', NULL, 'aheadDays', NULL, 'scope', 'booking', 'admitsEntry', FALSE,
                                     'admitsEntrySport', NULL, 'extendOnSuspension', FALSE),
       benefits_source = 'backfilled'
 WHERE benefits IS NULL AND tier_id IS NULL;
