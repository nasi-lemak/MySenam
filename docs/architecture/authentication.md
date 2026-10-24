# Authentication and sessions

Authoritative for customer and staff sign-in, sessions, two-factor sign-in, Google sign-in, phone checks and password resets.

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
enforced on every admin route, is in [tenancy and roles](tenancy.md).

Customer accounts are separate (`users`, `src/lib/auth.ts`): an email and
scrypt-hashed password, or Google sign-in, and an HTTP-only session cookie.
A booking needs no account; a weekly series, stored credit, passes bought
online and the personal-data export do.

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
- Turning it on or off goes in the staff activity log.
- **Lost both phone and recovery codes:** somebody with authority over the
  account resets it from *Venues & staff* (a platform owner; a business
  manager for their own business's staff; only another owner for an owner).
  They must have two-factor on themselves and enter their own current code,
  and they write down how they knew it was really that person. The reset
  clears the account's two-factor, signs it out everywhere, voids any sign-in
  half done, is recorded (`two_factor_resets`, and the staff activity log), and
  is emailed to the account and to every platform owner, so a reset somebody
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
  Failing both, a new account is made, with no password and no phone number.
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
  same either way, and the email is sent without waiting on it so the timing
  does not tell either. An account gets at most three links an hour, and the
  endpoints share the sign-in rate limit.
- Customers get the email in their language; staff emails are in English.

Signed in, a password is changed from the account page (*Change password*,
under *Sign out*) or the admin dashboard (under *Sign out*). The current
password is needed, and every other session ends; this one stays. An account
made with Google has no password, so it can set one without giving one —
then it can sign in with email too.

The links go out by email (`SMTP_URL` and `MAIL_FROM`). An install with no email set up cannot
send them; with `MYSENAM_SEND=log` they are written to the server log instead,
which is how to test it locally.
