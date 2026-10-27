-- A promo code's last use is taken once, by the database (lib/store.ts
-- `applyPromo`; docs/features/pricing.md#promo-codes).
--
-- The uses were counted inside the claiming transaction, which is
-- serializable, and that is still done. This makes the limit hold whatever
-- the isolation level and whichever path claims the code: each use counts
-- itself on the code's own row (`used_count`), and a code may never count
-- more uses than it allows. Two requests for the last use update the same
-- row; the second sees the first's use and is refused (or, serializable,
-- retried and then refused). Giving a use back (a cancelled booking) counts
-- it back.

ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS used_count INTEGER NOT NULL DEFAULT 0;
UPDATE promo_codes p SET used_count = (SELECT COUNT(*) FROM promo_uses u WHERE u.promo_id = p.id);
-- Not checked against what was there before (a limit is never lowered, but nothing earlier is refused for it).
ALTER TABLE promo_codes DROP CONSTRAINT IF EXISTS promo_codes_used_within_limit;
ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_used_within_limit CHECK (max_uses IS NULL OR used_count <= max_uses) NOT VALID;

CREATE OR REPLACE FUNCTION promo_uses_count() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE promo_codes SET used_count = used_count + 1 WHERE id = NEW.promo_id;
    RETURN NEW;
  END IF;
  UPDATE promo_codes SET used_count = GREATEST(0, used_count - 1) WHERE id = OLD.promo_id;
  RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS promo_uses_counted ON promo_uses;
CREATE TRIGGER promo_uses_counted AFTER INSERT OR DELETE ON promo_uses
  FOR EACH ROW EXECUTE FUNCTION promo_uses_count();
