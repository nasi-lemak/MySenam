# Authentication and sessions

Authoritative for customer sign-up, customer and staff sign-in, sessions, two-factor sign-in, Google sign-in, phone checks and password resets.

## Admin access

`/admin` is protected by operator accounts (scrypt-hashed passwords, HTTP-only
session cookies) held in the `admins` table. On a fresh database the first
platform owner is created automatically:

- Email: `ADMIN_EMAIL`, default `admin@mysenam.my`
- Password: `ADMIN_PASSWORD`, default `mysenam-admin` in development only

**In production the default password opens nothing.** With `NODE_ENV=production`
no owner is created unless `ADMIN_PASSWORD` is set, is not the published
default and is at least 12 characters; the server logs why and the install
stays locked until it is set. Signing in with the published default is
refused for any account. An owner created earlier that still has the default
is given `ADMIN_PASSWORD` at the next start (and signed out everywhere), which
is how an older install gets its owner back: set it, restart
(`adminPasswordProblem`, `replaceDefaultOwnerPasswords` in
`src/lib/admin-auth.ts`). Once signed in, the owner can add venues and issue
staff accounts from the *Venues & staff* tab.

Staff accounts are a platform owner (no venue, no business), a business
manager (a business, every branch of it), or branch staff at one venue, who
are a manager or front desk. What each may see and do, and how that is
enforced on every admin route, is in [tenancy and roles](tenancy.md). Each
account may have a language of its own (English, Malay or Chinese), set by
whoever makes it or by the person with the dashboard's language switch
([regions](../product/regions-and-tax.md#a-language-of-their-own-for-staff-and-coaches)).

Customer accounts are separate (`users`, `src/lib/auth.ts`): an email and
scrypt-hashed password, or Google sign-in, and an HTTP-only session cookie.
An account with a password is made by a link emailed to its address
([signing up](#signing-up)).
Signing in, a customer's or staff's, hashes the password given even when no
account has the address or the account has no password, so a wrong address
takes about as long as a wrong password
([no account enumeration](security.md#no-account-enumeration)).
A booking needs no account; a weekly series, stored credit, passes bought
online and the personal-data export do.

**Coaches reviewing approval applications** do so signed in to their own
customer account, which a manager links to the coach record by the account's
email (`coaches.user_id`, *Courts & rates → Online applications*); the
account's approvals page lists what that venue named them for, and every
decision records the coach and the account. A coach's private schedule link
(`/coach/<token>`) shows their lessons and takes their hours, and decides no
application ([ADR 0020](decisions/0020-approval-to-booking-payment-and-authority.md)).
Customer accounts have no two-factor sign-in.

## Two-factor sign-in

Staff accounts can change payment keys, refund money and read every
customer's number, so each can add a second step to signing in: a six-digit
code from an authenticator app (Google Authenticator, 1Password, Authy and the
like; RFC 6238 time-based codes), set up from *Two-factor sign-in* at the top
of the admin dashboard by scanning a QR code.

- **Signing in** with it on takes the password, then the code. The password
  alone earns a five-minute ticket, not a session, and five wrong codes void
  it. A code is good once: the same one twice is refused.
- **Recovery codes**, ten, are shown once when it is turned on, for a lost
  phone; each signs in once, and new ones can be made (which voids the old).
  Only their hashes are kept, and the app's secret is sealed like payment keys.
- **Compulsory** with `MYSENAM_STAFF_2FA` (`owners`, `managers` or `all`): an
  account without it can sign in only to set it up, and cannot turn it off.
  It is staff nowhere else until it has: not in the admin routes
  (`requireAdmin`), and not where a public route or page recognises staff
  (`getActingStaff`, `getActingStaffByToken` in `src/lib/admin-auth.ts`): the
  counter booking or enrolling through `/api/bookings` and
  `/api/classes/enrol`, staff-only rooms and the manager's override in
  `/api/availability`, a preview of a venue not yet open, a platform invoice's
  page. Asking one of those for what only staff do (an override, paid at the
  counter) answers `403` `TWO_FACTOR_REQUIRED`; anything else is answered as
  for anybody signed out (`tests/staff-two-factor-gate.test.ts`).
- Turning it on or off goes in the staff activity log.
- **Lost both phone and recovery codes:** somebody with authority over the
  account resets it from *Venues & staff* (a platform owner; a business
  manager for their own business's staff; only another owner for an owner).
  They must have two-factor on themselves and enter their own current code,
  and they write down how they knew it was really that person. The reset
  clears the account's two-factor, signs it out everywhere, voids any sign-in
  half done, is recorded (`two_factor_resets`, and the staff activity log), and
  is emailed to the account and to every platform owner, each in their own
  language ([regions](../product/regions-and-tax.md#a-language-of-their-own-for-staff-and-coaches)), so a reset somebody
  was talked into is seen at once. Nobody resets their own. The last owner,
  with nobody above them, is reset on the server:
  `npm run reset-two-factor -- <email> --reason "…"`, which is recorded and
  emailed the same way (`src/lib/two-factor-reset.ts`,
  `tests/two-factor-reset.test.ts`).

## Session cookies

Both session cookies (`ms_session`, `ms_admin`) are `HttpOnly`, `SameSite=Lax`,
site-wide, and `Secure` — but only when the request is actually on HTTPS.
Marking `Secure` on a plain-HTTP deployment would stop the browser sending the
cookie at all, so the flag follows the connection rather than a build-time
guess: the request's own protocol, or `x-forwarded-proto` behind a proxy.
`SECURE_COOKIES=1` forces it on for a proxy that sets no such header.

Every place that issues a session cookie (signing in, Google, a password
reset) goes through one `sessionCookieOptions()` helper, so another cannot
quietly ship without the flags.

Sessions last 30 days for customers and 7 for staff (`SESSION_DAYS` in
`src/lib/auth.ts` and `src/lib/admin-auth.ts`), to the second. They are rows
in `sessions` and `admin_sessions` that hold the SHA-256 of the token, not the
token (`sessionKey`), so a backup or a read of the table hands out no live
sign-in; migration `0086_session_tokens.sql` converted sessions already issued.

**Requests from another site.** Session cookies are `SameSite=Lax`, which
keeps them off cross-site `POST`s in current browsers. Behind that, a request
to `/api/` that changes something and carries a sign-in cookie is refused
with `403` when its `Origin` is another site or its `Sec-Fetch-Site` says
`cross-site` ([security](security.md#requests-from-another-site)). There is
no CSRF token.

## Signing up

A customer account with a password is made by a link emailed to its address,
so the sign-up form never says whether an address already has an account
(the owner's decision of 28 October 2026; `src/lib/registration.ts`). Google
sign-in and signing in with a password are unchanged, and nobody has to use
one rather than the other.

- **The form** (*Register* at `/login`) asks for the email address only and
  always answers the same: *check your email*, `202 {ok: true}`, no cookie,
  whether the address is new, has an account, has a link already out, or has
  had its fill of emails. Nothing else is taken before the address is proved:
  a name, number or password kept for an address nobody has proved would be
  data about somebody who may not have asked, and a password set before then
  is what Google sign-in has to clear (below). The reply waits only on writing
  the request down (`registration_requests`); finding out whether an account
  holds the address, and what to send, happen afterwards, in the background
  and on the scheduler's next tick, as a [forgotten password's](#forgotten-passwords)
  request does, so the time taken does not tell either. A request not worked
  through within a link's life is dropped.
- **The email**, through the outbox in the language the page was in, held
  like a password reset's (no venue's, its text not kept once sent, never
  readdressed, not sent once its link would have run out):
  - an address no account holds gets a link to `/register` to finish;
  - an address with an account gets a notice saying it already has one, that
    nothing was made or changed, with a link to sign in and one to ask for a
    password reset (to set a first password, for an account made with Google),
    and, where the account uses Google and the install offers it, to continue
    with Google. It carries no token: nothing in it creates an account, sets a
    password or joins a sign-in method.
- **The link** is 24 random bytes, kept only as a keyed hash
  (`registration_links`), never logged. It works **once**, for **60
  minutes**: twice a reset's, since mail can be slow and nothing exists yet to
  take over. Only the **newest** for an address works: asking again replaces
  it, and the database allows one open link per address. The page shows the
  address and asks for the name, phone number and password (at least 8
  characters), as signing up always has; the browser that asked is taken back
  where it was, another browser to the account page. The page sends no
  `Referer`, and the token goes in request bodies, not addresses.
- **One account per address.** Using the link and making the account are one
  transaction; the unique address on `users` is the backstop. The same link
  used twice at once, a replaced link, or a link for an address that has an
  account by now (another link, Google, staff) makes nothing, and every link
  that cannot be used gets one answer, `REGISTRATION_INVALID`, which says to
  sign in or ask for a new link. Whoever holds a link was sent it at the
  address, so that says nothing they could not find out.
- **Limits.** Asking counts against the registration limit per client
  address ([rate limiting](security.md#rate-limiting)); an address is sent at
  most 3 emails an hour and 5 a day, links and notices together
  (`registration_links`, kept a day for the count), past which requests are
  answered the same and nothing is sent; the outbox's daily cap per recipient
  stands behind both. Checking and using a link count against the sign-in
  limit, as a reset does. The form's hidden field, filled in only by scripts,
  gets the same answer, and nothing is sent.

An account records when its address was proved (`email_confirmed_at`,
migration 0224): made by this link, made by Google with an address Google has
verified, or given its password by a reset link emailed to it. Google sign-in
keeps the password of such an account when it joins it (below); accounts made
before migration 0224, and never reset since, have no such record. Tests and
the demo make accounts directly with
`registerUser` (`src/lib/auth.ts`), which no route exposes.

## Signing in with Google

With `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set, the sign-in page
offers *Continue with Google* above the email and password form, which stays.

- **The flow** is OpenID Connect's authorisation code with PKCE, a `state`
  tying the answer to the browser that asked (kept for ten minutes in an
  HTTP-only cookie) and a `nonce` tying the ID token to the request. The token
  comes straight from Google's token endpoint over TLS; its issuer, audience,
  expiry and nonce are checked. Nothing of Google's but the person's id, email
  and name is kept, and no Google token at all.
- **Which account.** Google's id for the person, which never changes, finds
  it. The first time, an existing account with the same email is joined to it
  only if Google says it has verified that email — otherwise anybody could
  create a Google account with somebody else's address and walk into theirs.
  An address Google has not verified is refused whether or not an account has
  it, in the same words, so the answer says nothing about accounts. Joining
  clears the account's password and signs it out everywhere, since whoever
  set it may have registered the address before its owner, unless the
  address was proved first (above), when the password is the owner's and
  stays. Failing both, a new account is made, with no password and no phone
  number; a [sign-up link](#signing-up) still out for that address can no
  longer be used, and an account made for the address at the same moment by
  another route is joined instead (`tests/sign-in.test.ts`,
  `tests/registration.test.ts`).
- **Only at the main address.** Google sends people back to the one redirect
  registered with it, so the button is not shown on a venue's own storefront
  domain, where the session would land on another site.
- **Staff** still sign in with email and password, so a venue's dashboard is
  never tied to somebody's personal Google account.

Set it up in Google Cloud: *APIs & Services → Credentials → Create OAuth
client ID → Web application*, with the redirect URI above, and the consent
screen published. Apple's *Sign in with Apple* fits the same shape
(`user_identities` already allows `apple`) once there is an Apple developer
account to configure it with.

## Checking a customer's phone number

A venue rings the number on a booking, confirmations go to it, limits and
blocks are kept by it, and league box-mates are given it — so an account
proves it holds its number, once. *Verify your phone number* offers two ways:

- **Verify via WhatsApp** (recommended). The customer taps the button;
  WhatsApp opens with *Verify my number: V-K7P2QX* ready to send to the
  platform's number; they press send. The message arriving, through the
  webhook, from the number being proved is the proof — stronger than a typed
  code, since it can only come from that phone. Nothing is sent to the
  customer, so it costs nothing and cannot be used to make the site message
  strangers. The page carries on by itself once the message arrives (it checks
  every few seconds); the token lasts 15 minutes. Needs
  `WHATSAPP_CHAT_NUMBER` and `WHATSAPP_APP_SECRET` with the webhook subscribed
  (see *Customers who ask on WhatsApp*).
- **Verify via SMS.** A six-digit code by text, through Twilio or any
  HTTP-GET gateway (`SMS_*`). Every text starts `RM0` and names the site. A
  local Malaysian aggregator is usually several times cheaper per message than
  Twilio for Malaysian numbers. Where no SMS gateway is set up but WhatsApp
  sending is, this option sends the code on WhatsApp instead (an
  authentication template, below).
- **A ceiling on codes.** Codes cost money, so the whole site sends at most
  `MYSENAM_PHONE_CODES_PER_DAY` (300) in a day; past that, customers are asked
  to verify via WhatsApp, and the platform owner is emailed once that day.

- **When.** Not at sign-in: before the first thing that needs it — booking,
  enrolling in a class, opening or joining a game, entering a tournament,
  joining a league — the account is sent to *Your phone number*, and then
  straight back to the same court, day and hour. An account made with Google
  adds its number there.
- **The code** lasts 10 minutes and allows 5 tries; an account may ask for 3
  an hour (6 WhatsApp verifications) and a number be sent 5 a day, so nobody
  can use it to flood a phone. Only a keyed hash of the code is stored, and
  codes are deleted after a day by the retention run
  ([privacy](privacy.md#retention)), or sooner when a new one is asked for.
- **Checked stays checked** until the number on the account changes. If
  another account proves the same number, the first loses its check: only one
  of them can be holding that phone now.
- **Staff see** a ✓ beside a booking's number when it was booked from an
  account that proved that number.
- **Sign-offs rely on it.** An activity sign-off recorded against a number
  counts online only for an account that has proved that number (or that
  staff linked it to): a typed number is not enough
  ([activities](../features/activities.md#sign-offs)).
- **Guests** booking one court without an account are not asked, any more
  than at a counter; weekly series already need an account.
- **On** whenever either way is set up (`MYSENAM_PHONE_CHECK=off` turns it
  off). With neither, there is nothing to check with, and numbers are taken
  as given, as before.
- **The template**, only for codes on WhatsApp. In WhatsApp Manager create a template named
  `mysenam_login_code` (or set `WHATSAPP_CODE_TEMPLATE`), category
  *Authentication*, with the *Copy code* button, in English and Malay. Meta
  writes the wording of authentication templates itself; the code goes in as
  its one parameter.

## Forgotten passwords

*Forgot your password?* sits under both sign-in forms — the customer one at
`/login` and the staff one at `/admin` — so a forgotten password is not a
message to whoever runs the site (`src/lib/password-reset.ts`).

- It emails a link to `/reset-password`. The link works **once**, for **30
  minutes**; using it voids any other link still out for that account.
- Only a keyed hash of the token is stored (`password_resets.token_hash`), so a
  copy of the database cannot be used to take an account over. The reset page
  sends no `Referer`, so the token in its address is not passed on.
- Setting a new password **signs the account out everywhere**, then signs in
  the browser that used the link. Whoever had the old password no longer has
  a session.
- The form never says whether an address has an account: the reply is the
  same either way, and so is the work it waits on. The request is written
  down (`password_reset_requests`) and the reply sent; finding the account,
  making the link and queuing its email happen afterwards, in the background
  and on the scheduler's next tick, so the time taken does not tell either.
  A request not worked through within the link's 30 minutes is dropped, and
  the address is kept only until it is worked through. An account gets at
  most three links an hour, and the endpoints share the sign-in rate limit.
- Customers get the email in the language they asked in. Staff get it in
  their own language (`admins.locale`, else the install's first staff
  language, [regions](../product/regions-and-tax.md#a-language-of-their-own-for-staff-and-coaches)),
  whatever the browser that asked was reading; its link opens the reset page
  in the same language (`?lang=`). The language is looked up only with the
  account, after the reply, so it says nothing about whether one exists.

Signed in, a password is changed from the account page (*Change password*,
under *Sign out*) or the admin dashboard (under *Sign out*). The current
password is needed, and every other session ends; this one stays. An account
made with Google has no password, so it can set one without giving one —
then it can sign in with email too.

The links go out by email (`SMTP_URL` and `MAIL_FROM`). An install with no email set up cannot
send them; with `MYSENAM_SEND=log` they are written to the server log instead,
which is how to test it locally.
