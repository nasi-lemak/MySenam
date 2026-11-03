-- Court time that is over, moved out of the table every booking is checked
-- against (docs/architecture/database.md "Archiving past claims"; ADR 0004).
--
-- `claims` has one row for every interval a court was ever held, and cannot be
-- partitioned by month (an exclusion constraint on a partitioned table must
-- include the partition key by equality, which a booking past midnight
-- crosses). Once a claim has ended and what held it is finished or cancelled,
-- it decides nothing: no new claim can overlap time that has gone. A job
-- (lib/claims-archive.ts, off unless CLAIMS_ARCHIVE_AFTER_DAYS is set) moves
-- such claims here, in batches, each batch one transaction.
--
-- Same columns, in the same order, as `claims`: the same checks, none of what
-- makes a live claim expensive (no exclusion constraint, no capacity or
-- separation triggers, no gap rows). The foreign keys stay, with the same
-- cascades, so deleting a booking, a waiting-list entry, an application, a
-- court or a venue deletes what it held here too, as it did there (erasure and
-- retention reach the archive without a rule of their own); a booking's is
-- checked at commit, as every row pointing at a booking is (0206).
CREATE TABLE IF NOT EXISTS claims_archive (LIKE claims INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE claims_archive ADD PRIMARY KEY (id);
-- When it was moved. After the columns of `claims`, and not in the view below.
ALTER TABLE claims_archive ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE claims_archive ADD CONSTRAINT claims_archive_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE;
ALTER TABLE claims_archive ADD CONSTRAINT claims_archive_court_id_fkey FOREIGN KEY (court_id) REFERENCES courts(id) ON DELETE CASCADE;
ALTER TABLE claims_archive ADD CONSTRAINT claims_archive_space_id_fkey FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE;
ALTER TABLE claims_archive ADD CONSTRAINT claims_archive_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE claims_archive ADD CONSTRAINT claims_archive_class_id_fkey FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE;
ALTER TABLE claims_archive ADD CONSTRAINT claims_archive_block_id_fkey FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE;
ALTER TABLE claims_archive ADD CONSTRAINT claims_archive_outage_id_fkey FOREIGN KEY (outage_id) REFERENCES court_outages(id) ON DELETE CASCADE;
ALTER TABLE claims_archive ADD CONSTRAINT claims_archive_waitlist_id_fkey FOREIGN KEY (waitlist_id) REFERENCES waitlist(id) ON DELETE CASCADE;
ALTER TABLE claims_archive ADD CONSTRAINT claims_archive_move_id_fkey FOREIGN KEY (move_id) REFERENCES game_moves(id) ON DELETE CASCADE;
ALTER TABLE claims_archive ADD CONSTRAINT claims_archive_approval_id_fkey FOREIGN KEY (approval_id) REFERENCES approval_requests(id) ON DELETE CASCADE;

-- By venue, resource and date. The space and court ones are what the day's
-- board reads for a date long past (the same two reads as `claims`, by space
-- or court and then by the moment the time ends), and what deleting a court or
-- a space needs to find what it held.
CREATE INDEX IF NOT EXISTS idx_claims_archive_venue ON claims_archive (venue_id, lower(during));
CREATE INDEX IF NOT EXISTS idx_claims_archive_space ON claims_archive (space_id, (COALESCE(upper(occupied), 'infinity'::timestamptz))) WHERE space_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_archive_court ON claims_archive (court_id, (COALESCE(upper(occupied), 'infinity'::timestamptz)));
-- The newest end first: what the integrity check reads to see that nothing
-- which could still matter was moved.
CREATE INDEX IF NOT EXISTS idx_claims_archive_ends ON claims_archive ((COALESCE(upper(occupied), 'infinity'::timestamptz)));
-- What each kind of claim belongs to: deleting it deletes its archived claims.
CREATE INDEX IF NOT EXISTS idx_claims_archive_booking ON claims_archive (booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_archive_class ON claims_archive (class_id) WHERE class_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_archive_block ON claims_archive (block_id) WHERE block_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_archive_outage ON claims_archive (outage_id) WHERE outage_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_archive_offer ON claims_archive (waitlist_id) WHERE waitlist_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_archive_move ON claims_archive (move_id) WHERE move_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_archive_approval ON claims_archive (approval_id) WHERE approval_id IS NOT NULL;

-- What the archive job reads to find claims that have ended, oldest first:
-- only claims with an end (an outage with no last day never has one).
CREATE INDEX IF NOT EXISTS idx_claims_ended ON claims ((upper(occupied))) WHERE NOT upper_inf(occupied);

-- Every claim there ever was, live or moved: what a reader of the past asks
-- (a day long gone, a report over a past period). Readers that only look from
-- now on keep to `claims`. The columns are listed, so a column added to
-- `claims` later is not in the view until it is added here and to the archive
-- (tests/claims-archive.test.ts fails until it is).
CREATE OR REPLACE VIEW claims_all AS
  SELECT id, venue_id, court_id, space_id, places, kind, booking_id, class_id, block_id, outage_id, waitlist_id, during, occupied,
         buffer_before, buffer_after, active, expires_at, created_at, move_id, approval_id, separation_before, separation_after, facility_wide
    FROM claims
  UNION ALL
  SELECT id, venue_id, court_id, space_id, places, kind, booking_id, class_id, block_id, outage_id, waitlist_id, during, occupied,
         buffer_before, buffer_after, active, expires_at, created_at, move_id, approval_id, separation_before, separation_after, facility_wide
    FROM claims_archive;
