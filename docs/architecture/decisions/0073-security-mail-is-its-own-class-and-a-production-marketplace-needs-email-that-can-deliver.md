# ADR 0073: Security mail is its own class with an allowance of its own; a production marketplace with email that cannot deliver refuses sign-up and forgotten-password requests, honestly

- **Status:** current, decided 2026-11-07 for the final operational hardening round on the pilot-readiness limitations L1 (security mail swept up by the daily limit), L2 (no start-up check
  that email is set up) and L4 (the per-address limits on a shared network), as an authorised readiness gate, not a new feature; built in migrations 0343 and 0344. What the person sees is in
  [authentication](../authentication.md#signing-up) and [forgotten passwords](../authentication.md#forgotten-passwords); the mail is in
  [messaging](../../integrations/messaging.md#security-mail); the setup is in the [SES checklist](../../operations/email-ses-checklist.md); the settings are in
  [configuration](../../development/configuration.md); the routes are in [the HTTP API](../http-api.md). Builds on [ADR 0056](0056-outbox-reliability-messages-survive-outages-and-stops.md)
  (the outbox) and [ADR 0064](0064-credentials-follow-their-owners-two-factor-by-default-and-counted-attempts.md) (the production-marketplace default and the synthetic-data declaration). Every number below
  is a constant or a setting named here, and is open to the owner to change.
- **Context:** the outbox held every kind of message that is not on its short lists of exceptions to eight a day per recipient, counted over everything. A password-reset link and a sign-up link were
  `account_email`, which is not on those lists, so an address that had been sent eight booking mails in a day (a busy tournament day) was written off at its next reset request: the message was marked
  `abandoned`, its link forgotten, and the page said "check your email". The same kind served invitations, guardians' requests and applications, so it could not simply be exempted. Separately, a
  production marketplace could start with no email provider at all, or with `MYSENAM_SEND=log`, and the sign-up and forgotten-password pages answered "check your email" with nothing ever sent (or with the link in the
  server log). The pilot-readiness assessment listed both as manual safeguards.

## Decision 1: security-critical mail is a kind of its own, `auth_email`

- It is used only by: a **sign-up** link and the notice an existing account is sent in its place (`src/lib/registration.ts`); a **password reset** link, for customers and staff (`src/lib/password-reset.ts`); the notice
  that a staff member's **two-factor sign-in was reset** (`src/lib/two-factor-reset.ts`); and the notice to the old address that a staff account's **address was moved** (`src/lib/staff-accounts.ts`). Staff and player
  invitations, guest invitations, guardians' requests, membership suspensions, team invitations and an application's address check stay `account_email`: they are not what gets a person into, or back into, their own account.
- It is handled **everywhere `account_email` is**: its link is never shown to staff and never kept once the message has gone, been given up or been written off (`forStaff`, `FORGET_ACCOUNT_LINK`); it is never readdressed
  and never put back in the queue by staff (`retryMessage`, "send again everything that failed"); it is given up once its link has run out.
- A message past its allowance, a refusal and a link that ran out are all `abandoned` with the reason, visible in the platform's messages. `abandoned` is this outbox's one terminal "given up" status; there is no separate
  `failed` for a permanent refusal (`failed` means "waiting to be tried again").

## Decision 2: its own allowance, counted apart, so neither class starves the other

- **Ordinary mail no longer counts it.** The day's limit for ordinary mail (8) is counted without `auth_email`; an attacker asking for reset links for a victim never uses up the victim's booking confirmations.
- **It has an allowance of its own:** `MYSENAM_AUTH_MAIL_PER_RECIPIENT_PER_DAY`, default **10**, 5 to 100, counted among security mail alone, over everything written, sent or not. Ten is the most that the request-side
  limits below can ask for in practice (three links an hour from a reset, five a day from a sign-up) with room for the notices of a security change, and above the old eight, so the ordinary limit's failure is not
  reproduced for mail the person is waiting for.
- **Past it, nothing is promised:** the message is written `abandoned` ("Not sent: already 10 sign-in and account emails to this address today (the allowance for security mail)…"), is never recorded as sent, and the
  link it would have carried is **void** (a reset's `used_at`, a sign-up link's `replaced_at`), so a link nobody holds cannot be used. The platform's owners get the `auth-mail-ceiling` alert (once in six hours,
  never naming the address), because a legitimate person locked out by it needs a human ([recovery](../../integrations/messaging.md#security-mail)). The person is told what everybody is told.
- **The request-side limits stay**, and two are added so a link is not made twice for one wish. A **cooldown** of 60 seconds after a link was made (`AUTH_MAIL_COOLDOWN_SECONDS`), and **no second link while the first
  email has not gone** (`queued` or `failed`, link still valid): the one waiting is sent as soon as the provider takes it, which is what a person clicking again during an outage needs. The three-an-hour cap per
  reset account (a link lives 30 minutes, so at most three are open at once: that is the cap on open challenges) and the three-an-hour and five-a-day caps per sign-up address are unchanged. A message is linked to its
  challenge by `message_id` (migration 0344); a challenge from before it has none and is treated as one whose email is no longer waiting.
- **Concurrency:** the check, the token and the email are one transaction under an advisory lock on the account (reset) or the address (sign-up); twelve requests that arrive together, on several workers, make one link
  and one email (tested on PGlite and Postgres). The reply is written before any of this and is the same whatever happens ([no enumeration](../authentication.md#forgotten-passwords)).

## Decision 3: honest about delivery; tried again soon while the link lives

- "Sent" is recorded only when the provider accepted the message (the transport returned). A temporary failure is `failed`, tried again after **1, 2, 5 and then every 10 minutes** (ordinary mail waits 1, 5, 30 then 120),
  because a 30-minute link must be tried again within its life; a permanent refusal is given up at once with the reason; a link that ran out before it could be delivered is dropped unsent ("it ran out before it could go")
  and the owners get the `auth-mail-expired` alert, because that person has to ask again.
- The sign-up page no longer says "We have sent an email": it says one is on its way. The reset page already said "a link is on its way". Neither says an account exists.

## Decision 4: one validator for the install's email, and a production marketplace that cannot deliver says so

- `src/lib/email-config.ts` reads the environment and returns a state: `not_configured`, `invalid` (half of SES, a region that is not one, an SMTP address that is not one, a sender that is not an address), `contradictory`
  (SES and SMTP both set: the app uses SES and ignores SMTP), `missing_sender`, `log_only` (`MYSENAM_SEND=log`), `configured_unverified` and `delivery_verified`. Problems name settings and never their values.
- **"Reachable" is a separate, explicit call** (`checkProviderReachable`; the owner's `POST /api/admin/system {"check":"email"}`; the verification script): Amazon SES's account call, or an SMTP connection and sign-in.
  Never at start-up, on a page load or in the tests; it never sends a message; reachable is not delivered.
- **"Delivery verified" is recorded by the operator, from a controlled check, never inferred.** `node scripts/verify-integrations.mjs email --send` to an address the operator controls prints a fingerprint of the
  provider (SES region or SMTP host and port) and the sender address; once a person has confirmed in that inbox that the message arrived (not in spam, SPF/DKIM/DMARC passing), the operator sets
  `MAIL_DELIVERY_VERIFIED` to it. A different provider or sender gives a different fingerprint, so the install returns to "configured, unverified". An environment setting was chosen over a table and an owner button because it
  needs no migration, cannot be set by a request, is reviewed with the deployment like every other secret-adjacent setting, and costs one line; its limit is that it does not record who confirmed or when.
- **Policy.** On a **production marketplace** (`NODE_ENV=production` and `MYSENAM_MARKETPLACE=on`, as the staff two-factor default reads it), every state that cannot deliver, `log_only` included, **refuses** a sign-up request and a
  forgotten-password request (customers and staff) with `503` `EMAIL_UNAVAILABLE` ("Sign-up and password reset are not available right now. Please contact the venue you booked with, or try again later."), the same for every
  address, before anything is written. The start-up log says so as an error and the owners get a `config:email` alert. The one exception is `MYSENAM_SEND=log` with `MYSENAM_SYNTHETIC_DATA=on` (staging and acceptance installs
  holding synthetic data only), honoured and flagged; there is no other bypass. `configured_unverified` does not refuse: requests queue and are tried (a production marketplace has to be able to start its pilot), and the
  owners' alert says delivery has not been verified until it is. An install that is not a marketplace is warned and not refused. **There is no mode that switches authentication off**, so the "warn only" case is the venue's
  own install.
- **An upgrade can switch sign-up off.** A production marketplace that was running with no email provider (or the log) stops taking these requests when this version starts, and says why in the log and to the owners.
  That is the intended outcome of the gate, not a regression: those requests were never answered.

## Decision 5: the owner can see it

- `GET /api/admin/system` returns `email`: the configuration state and its problems; the last hour's tries (accepted, refused, the share refused); the email waiting and the age of the oldest (a venue's bulk news
  excluded); and the email given up in the last day, security mail apart and the part of it held by the allowance. The scheduler looks after each outbox pass, at most every five minutes, and raises `email:failing` (at least
  5 tries in the hour and at least half refused) and `email:backlog` (the oldest waiting 30 minutes or more), cleared when they stop. `messages.last_attempt_at` (migration 0343) is stamped as a message is claimed.
- Tokens, links and credentials are never logged or kept in alerts; a captured log across a full reset flow, a failure and a recovery holds none (`tests/email-config.test.ts`).

## Decision 6: shared networks

- The request limits count the client address (`x-forwarded-for`): sign-up requests **5 an hour** and reset requests **30 an hour** per address, and the pages that use a link share the sign-in limit of **10 in 10 minutes**
  per address. Many customers behind one venue network count together. Two are now settings read at start (`MYSENAM_SIGNUPS_PER_ADDRESS_PER_HOUR`, `MYSENAM_RESETS_PER_ADDRESS_PER_HOUR`, 1 to 1000); the sign-in limit is
  not changed, since it also guards passwords. The effect is documented in [security](../security.md#rate-limiting).

## What was left open

- Bounces and complaints are not read back; the first live SES check has not been run (`INTEGRATION_VERIFICATION_REQUIRED`: email). A bounce on a reset address is invisible to MySenam.
- Whether 10 a day, a 60-second cooldown, and 5 attempts an hour of "failing" are the right numbers; whether owners want a tool to send a legitimate person a new link by hand (today a person asks again once the day's
  count falls, or uses Google where the account has it).
- Whether `MAIL_DELIVERY_VERIFIED` should be a recorded owner action (who, when) instead of a setting.
- A reset's ordinary `reset.sent` page still reads "a link is on its way" when the install is configured but unverified; it says nothing about delivery being proved, by design.
