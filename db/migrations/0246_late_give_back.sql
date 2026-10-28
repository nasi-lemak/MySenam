-- Past the free-cancellation cutoff, where the venue does not let customers
-- cancel late online for a share back (late_cancel_keep NULL), it may still
-- let them give the court back: cancelled online, nothing refunded, the slot
-- offered again and the waiting list told (lib/cancel-policy.ts;
-- docs/features/booking.md#late-cancellations-and-strikes). Off by default:
-- past the cutoff a customer calls the venue, as before.
ALTER TABLE venues ADD COLUMN IF NOT EXISTS late_give_back BOOLEAN NOT NULL DEFAULT false;
