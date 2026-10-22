# Upgrading an install from before Postgres or before the rename

Still needed by any install created before MySenam moved to Postgres, or before it was renamed from MudahTempah. Not needed for new installs.

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
