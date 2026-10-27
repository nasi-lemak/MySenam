# Upgrading an install from before Postgres or before the rename

Still needed by any install created before MySenam moved to Postgres, or before it was renamed from MudahTempah, and by one upgraded across migration 0090 with courts out of service at a venue open past midnight. Not needed for new installs.

## Moving from SQLite

Before Postgres, an install kept everything in one SQLite file
(`data/mysenam.db`, or wherever `MYSENAM_DB` pointed). Started on this version,
such an install **refuses to start**, and says why, rather than open a new,
empty database beside the old one and look to its staff as if everything had
gone. To bring it across:

1. Stop the old app, so nothing is written to the file halfway through.
2. Set `DATABASE_URL` (and `MYSENAM_DATA_DIR`), and remove `MYSENAM_DB`.
3. Run:

   ```bash
   npm run import-sqlite -- /var/data/mysenam.db
   ```

It copies every table, keeping every id, so booking codes, links and the ledger
still line up. It runs as one transaction, so if anything does not fit, nothing
is changed. Then it counts every table on both sides. Saved payment keys are
locked with the old install's `secret.key`, so that is brought across from
beside the file too, unless `MYSENAM_SECRET` is set, in which case it must hold
the old value. It refuses a database that already has customers, bookings or
staff of its own unless told `--force`, which wipes them first.

## Renamed from MudahTempah

The project was renamed to **MySenam**. Everything user-facing moved with it —
the wordmark, page titles, calendar invites, WhatsApp share text and the
booking-code prefix (new codes read `MS-…`). Four notes for an existing
install:

- Booking codes already issued keep their `MT-` prefix and still resolve; lookup
  matches the whole code, never the prefix.
- The SQLite file became `data/mysenam.db`, set by `MYSENAM_DB`. Both that and
  the older `data/mudahtempah.db` / `MUDAHTEMPAH_DB` are recognised by the
  check described in *Moving from SQLite*, and brought across the same way.
- Session cookies are now `ms_session` and `ms_admin`, so everyone signed in
  under the old names has to sign in once more.
- The bootstrap owner's default email is now `admin@mysenam.my`. That default
  only applies to a *fresh* database — an install created before the rename
  keeps the account it already has at `admin@mudahtempah.my`.

## Outages from before migration 0090

Migration 0090 turned each court's outage into a claim on whole calendar days
of its dates. An outage made since covers every minute of each business day,
the hours after midnight included (`claimOutage` in `src/lib/outages.ts`). So
at a venue open past midnight, an outage carried over from the half-hour diary
leaves the late hours of its last night (after midnight) bookable.

The repair is an explicit step, not part of the migration or of start-up: a
booking may have been sold in those hours since, and nothing should be
cancelled or overlapped without staff seeing it. After upgrading:

1. Open *Courts → Out of service* at each venue that stays open past midnight.
   An outage missing those hours says *The late hours of its last night, after
   midnight, can still be booked.*
2. Press *Close those hours too* (`PATCH /api/admin/outages`,
   `repairLateHours`). It claims whatever of those hours is free, the way a
   court taken out now would (a staff block there gives way, as it does when a
   court is taken out), and lists any booking or class sold there since. Those
   are left exactly as they are, and the outage does not cover their time.
3. Move the bookings listed, or let them be. Pressing it again later, once they
   are over, moved or cancelled, closes their hours too; it never takes the same
   time twice. Each repair is in the activity log.

Outages that are over, that have no last day (*until further notice*), or at
venues that close by midnight need nothing. The same step serves an outage
whose venue came to stay open past midnight after it was made.

## Venue lists from before migration 0175

Before migration 0175 a members-only or private venue's list matched the phone
number on a customer's account; on an install without phone checks that was
the number as typed. Migration 0175 adds the account an entry is linked to
(`venue_access_list.user_id`) and links nothing, so after upgrading an entry
counts online only for an account that has proved its number
([who a venue is for](../../features/booking.md#who-a-venue-is-for-public-members-only-private)).
On an install without phone checks, every resident who booked online with a
typed number is refused online until staff link their account: open *Venues &
staff → Who it is for* at each members-only or private venue, and use *Link
account* on each row the editor marks *not linked: counter only* (or add the
account when re-adding the person). Residents' guests invited before the
upgrade are unlinked too; the resident can invite them again with their account
email. Staff at the counter book everyone as before.
