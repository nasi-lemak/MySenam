# ADR 0003: Scheduled work runs in the app, under a lease

- **Status:** current. Supersedes the earlier rule "set `MYSENAM_SCHEDULER=off`
  on all but one instance".
- **Context:** hosts such as Render cannot run cron against a web service's
  disk, and some work cannot wait for the next visitor (waitlist offers,
  unpaid holds, reminders, the nightly backup).
- **Decision:** `next start` ticks once a minute (`src/lib/scheduler.ts`) and
  does what is due. With several instances, only the holder of a lease row in
  `settings` works; it renews every minute and another instance takes over
  within three minutes of it stopping. `MYSENAM_SCHEDULER=off` hands the work
  to an external cron.
- **Consequences:** no extra infrastructure; a stopped scheduler shows as a
  `503` from `/api/health` after ten minutes.
- **Known limitations:** work is at-least-once; jobs must be idempotent (the
  outbox claims each message before sending). With the scheduler off, most of
  its work happens only lazily when requests trigger it.
