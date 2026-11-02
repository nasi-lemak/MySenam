# MCP server for AI assistants

Authoritative for using MySenam from an AI assistant (Claude, ChatGPT, Cursor
and other clients of the Model Context Protocol): the endpoint, its tools by
the authority each needs, how callers are recognised (a venue's key, or a
member of staff signed in from the assistant's connector), changing a venue's
settings, customers' personal data, limits, and how to connect. Decision
records: [ADR 0029](../architecture/decisions/0029-mcp-server-over-existing-functions.md)
(the server and its tools) and
[ADR 0030](../architecture/decisions/0030-oauth-sign-in-for-ai-assistants.md)
(signing in through an assistant's connector).

## What it is

`POST /api/mcp`, and `POST /api/mcp/staff` for a member of staff signed in
([below](#signing-in-from-an-ai-assistant)), (`src/app/api/mcp/route.ts`,
`src/app/api/mcp/staff/route.ts`, `src/lib/mcp/`) speak the Model
Context Protocol's Streamable HTTP transport, **stateless**: each POST carries
one JSON-RPC 2.0 message (or, as the 2025-03-26 version allowed, a batch) and
is answered with JSON. No session (`Mcp-Session-Id` is never set), no
server-sent events (`GET` and `DELETE` answer `405`), nothing cached between
requests or venues. The server is hand-written (`initialize`, `ping`,
`tools/list`, `tools/call`; notifications such as `notifications/initialized`
are accepted with `202`); it has tools only, no resources or prompts.

- **Versions.** `initialize` answers with the client's `protocolVersion` where
  it is one of `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, and
  otherwise with the newest of those, for the client to decide. A later request
  whose `MCP-Protocol-Version` header names another version is refused (`400`).
- **Errors.** Body not JSON: `-32700` (`400`); not a JSON-RPC 2.0 request:
  `-32600`; unknown method: `-32601`; unknown tool or `params`/`arguments` not
  an object: `-32602`. Arguments that do not validate, and every refusal of the
  application (a booking refused, a venue not found, a key that may not do
  that), are a tool result with `isError: true` whose text is the application's
  own sentence, with its refusal code in brackets where it has one.
- **Answers.** Each tool result is one text item: a short sentence for people,
  a blank line, then compact JSON. Times are minutes of the venue's business
  day (as in the [public API](external-api.md)) and also `HH:MM`.

## Who is calling

Only the `Authorization` header says who is calling. At `/api/mcp`:

- **No header:** the public tools only.
- **`Authorization: Bearer <key>`**: one of the venue's [API keys](external-api.md#public-api-and-webhooks),
  checked exactly as `/api/v1` checks it (`apiCaller` in `src/lib/api-keys.ts`:
  only the key's SHA-256 is looked up, a revoked key is refused at once, *last
  used* is updated). Any key's scope may connect; each tool asks for its own.
- **A header that is not a good key** (unknown, revoked, malformed, another
  scheme) is refused with `401` and `WWW-Authenticate: Bearer realm="mysenam",
  error="invalid_token"`, never answered as if nobody had called. A sign-in
  token is not a key here: it is refused the same way.

At `/api/mcp/staff`, only an access token from [signing in](#signing-in-from-an-ai-assistant)
for that address: none, or one that is not good, is `401` with
`WWW-Authenticate: Bearer resource_metadata="<site>/.well-known/oauth-protected-resource/api/mcp/staff"`
(and `error="invalid_token"` with the reason when one was sent), which is how
a connector finds where to sign in. An API key is not taken there.

A cookie never signs anybody in on either address: a staff member's session sent with no
key gets the public tools only, and the public tools ask the public routes
with no cookie at all. A request whose `Origin` (or `Sec-Fetch-Site:
cross-site`) is not the site's is refused (`403`) before anything else, as
the protocol's guidance against DNS rebinding asks: the allowed hosts are
`MYSENAM_URL`'s and, on a storefront, its own name, never merely the `Host`
the request carries (`foreignOrigin` in `src/lib/same-origin.ts`). Clients
that are not browsers send no `Origin` and are not affected.

**Limits.** Without a key, 60 requests a minute per address (`mcp` in
`src/lib/rate-limit.ts`); with one, the API's 120 a minute per key; signed
in, 120 a minute per connection. Past any of them, `429` with `Retry-After`.

## Tools

One registry (`src/lib/mcp/registry.ts`) names each tool's authority: `public`,
or the key scope it needs (`availability` < `read` < `write`), and for a
member of staff signed in, the OAuth scope it needs (`venue:read`,
`venue:book`, `venue:configure`) and, where the dashboard limits it to
managers, the dashboard action whose permission it follows (`staffMay` in
`src/lib/roles.ts`, for the person's role as it is at the call). The
configuration tools are for a signed-in person alone (`signedIn`): no key
reaches them. `tools/list` lists what the caller holds; a known tool beyond
it answers the API's own sentence (*This key can only read.*), without a key
that it needs one, and signed in that the connection was not allowed that
scope or that front desk cannot change it (`MANAGER_ONLY`).

### Public tools

No credentials; only what the public pages and routes already show, through
their own code (`src/lib/mcp/public-tools.ts`):

| Tool | Returns |
| --- | --- |
| `guide_business_types` | The 13 kinds of business of the [public guide](../features/venue-guide.md#the-public-guide), each with its activities and page. Marketplace only, as the guide is. |
| `guide_fit` | `{ businessTypes[], activities?[], locale? }` (`en`, `ms`, `zh`, `ta`): what the guide shows for that choice, from the same model (`fitView`) and presenters: capabilities under the guide's five labels (available now, with configuration, requires an external integration and which, requires the operator's approval, not currently supported, with what to do instead), activities with partial support and the catalogue's note, what is not supported for the choice and otherwise, the journeys, and the guide's and the application form's links carrying the choice. Unknown ids are left out and named. Marketplace only. |
| `search_venues` | `{ activity \| words, date?, area \| near{lat,lng,km?}, from?, to?, minutes?, sort? }`: the public search (`/api/search`, its own handler): live, publicly listed venues, each result the cheapest free court with its start, end, price, how many others are free and what its rules ask first. An area or a point is always required: never the whole country. |
| `venue_details` | `{ venueId }`: a live venue's page facts (name, area, address, phone, time zone, activities, hours by weekday, facilities, members only or not, the free-cancellation cutoff, rating, link). |
| `venue_availability` | `{ venueId, date?, activity? }`: the venue's day as its page's grid shows it to somebody signed out (`/api/availability`, its own handler): each court's lengths, starts and columns with price and whether free, and a closure. |

A draft, a suspended venue and a private one are *Venue not found.*; a
members-only venue answers as its public page does (`mayShowVenue` for nobody
signed in; a storefront shows only its own venues).

### Venue tools

With the venue's API key, for the key's venue only, or signed in, for the one
venue the person allowed: another venue's court or booking is not found
(`src/lib/mcp/venue-tools.ts`).

| Tool | Key scope | Signed in | Returns or does |
| --- | --- | --- | --- |
| `my_venue` | availability | `venue:read` | The venue as `GET /api/v1/venue` gives it (a court taking entries with no set time says so, read only: no tool lets anybody in), and whether personal data is shown to assistants |
| `my_availability` | availability | `venue:read` | `{ date?, activity? }`: each court's day as `GET /api/v1/availability` gives it |
| `my_bookings` | read | `venue:read` | `{ from, to? }` (at most 31 days): the bookings as `GET /api/v1/bookings` gives them |
| `my_booking` | read | `venue:read` | `{ code }`: one booking |
| `my_setup_status` | read | `venue:read`, a manager | `{ locale? }`: the [setup plan](../features/venue-guide.md#the-setup-plan) and [launch readiness](../features/venue-guide.md#launch-readiness) of the manager's guide (`setupView`, `buildSetupPlan`, `launchReadiness`), each step with its state and why it is shown, readiness in its six lists; never a percentage. Front desk does not have it, as on the dashboard |
| `my_playbook` | read | `venue:read` | `{ locale? }`: the [operating playbook](../features/venue-guide.md#the-operating-playbook) (`playbookFor`) as plain-text sections, the manager's for a key and the person's own role's signed in; links are said as their screens' names, no address |
| `create_booking` | write | `venue:book` | The fields of `POST /api/v1/bookings` (`games` in place of `end` on a court sold by the game), and `confirm` |
| `cancel_booking` | write | `venue:book` | `{ code, confirm }` |

**Writes** run the very code `/api/v1` runs (`bookThroughKey` and
`cancelThroughKey` in `src/lib/key-bookings.ts`): the same checks, refusals
and codes, the customer told as there, a key never overriding the venue's
policies or taking payment. Both are annotated `readOnlyHint: false`,
`destructiveHint: true`. **Without `confirm: true` nothing changes**: the tool
runs every check that changes nothing and answers a preview, for a booking
the court, date, times, price now (`quoteFor`, as the booking will be priced;
discounts asked for apply when booked) and what the customer will be told; for
a cancellation the booking and what cancelling does (in full, money paid
online, with credit or a pass back, a counter payment written down as owed
back, the customer told). Whether the time is still free, and the court's
booking rules on it, are known only when booking. Signed in, a member of staff
books and cancels through the same code, with the same limits as a key (no
override, no payment taken: the stricter of the two paths), whatever their
role.

**The staff activity log** names the key (`API key <id>`) for every call made
with one, or the person signed in, by name, as acting through the assistant
(*Maya through Claude (AI assistant)*, the client's name as it registered
itself) with their own staff id: a booking made or cancelled as
`booking.created` or `booking.cancelled` (*… through an AI assistant (MCP)*),
every other call, preview and refusal as `mcp.tool` (a key) or
`mcp.staff_tool` (signed in) with the tool's name and outcome, never its
arguments, so no customer's details are written there. A setting changed is
logged by the dashboard's own route, under the person's name as acting
through the assistant.

## Signing in from an AI assistant

claude.ai's and ChatGPT's custom connectors, and any MCP client that speaks
OAuth, cannot send a key in a header of their own: they sign a person in. A
member of staff signs in as themselves, chooses one venue and what the
assistant may do there, and the assistant then acts as them, no further than
their role allows. The authorization server is inside the app
(`src/lib/mcp/oauth.ts`; migration 0263; [ADR 0030](../architecture/decisions/0030-oauth-sign-in-for-ai-assistants.md)),
following the MCP authorization specification: OAuth 2.1, no service of its
own and no paid provider.

| Address | What it is |
| --- | --- |
| `/.well-known/oauth-protected-resource/api/mcp/staff` (and `/.well-known/oauth-protected-resource`) | RFC 9728: the resource `<site>/api/mcp/staff`, its authorization server (the site), the scopes |
| `/.well-known/oauth-authorization-server` | RFC 8414: the endpoints below; `code` with PKCE `S256` only, `refresh_token`, public clients (`none`), `iss` in the answer (RFC 9207) |
| `POST /api/oauth/register` | RFC 7591 dynamic registration: a public client, never a secret, whatever it asks for; redirect URIs `https`, or `http` on the same computer (`localhost`, `127.0.0.1`, `[::1]`), no fragment, at most five; the name it gives, cleaned of control and direction characters, 80 characters at most. 30 an hour per address |
| `/oauth/authorize` | The consent page (below) |
| `POST /api/oauth/token` | The code for tokens (with `code_verifier`, the same `client_id` and `redirect_uri`, and `resource` if sent), or a refresh token for new ones. 600 in ten minutes per address |
| `POST /api/oauth/revoke` | RFC 7009: the connection the token belongs to ends |

**Scopes.** Each says what the assistant may do, as the consent page says it:

| Scope | Tools | Who may allow it |
| --- | --- | --- |
| `venue:read` | `my_venue`, `my_availability`, `my_bookings`, `my_booking`, `my_playbook`, and `my_setup_status` for a manager | Anybody on the venue's staff |
| `venue:book` | `create_booking`, `cancel_booking` | Anybody on the venue's staff (front desk books and cancels on the dashboard too) |
| `venue:configure` | The [configuration tools](#changing-the-venues-settings) | A manager of the venue (a branch manager, a business manager, or the platform owner for that one venue) |

A client that asks for no scope is given `venue:read`. An unknown scope is
refused (`invalid_scope`).

**The authorization request** (`/oauth/authorize`, `src/app/oauth/authorize/page.tsx`,
which reads and decides through `GET`/`POST /api/oauth/authorize`):

- An unknown `client_id`, or a `redirect_uri` that is not exactly, character
  for character, one the client registered, is shown on the page and the
  browser is sent nowhere (no open redirect). Every other fault goes back to
  that registered address as an OAuth error with the `state`:
  `response_type` other than `code`, no `code_challenge` or a method other
  than `S256`, an unknown scope, a `resource` other than this site's
  `/api/mcp/staff` (`invalid_target`, RFC 8707).
- Nobody signed in as staff, or an account the install requires two-factor
  sign-in of that has not set it up: the staff sign-in (`/admin?next=…`),
  which comes back to the same request once signed in (with the code, where
  the account has two-factor sign-in on).
- Signed in: the page names the application by the name it registered,
  marked as not verified, the host it goes back to, the person, the venue to
  allow (one; somebody with several picks it) with their role there, and each
  scope asked for in plain words with a tick box; what their role there may
  not allow (`venue:configure` for front desk) is shown and cannot be ticked,
  and is refused on the server if sent. *Allow* or *Deny*; deny goes back with
  `access_denied`. The decision is a JSON `POST` from the page itself: the
  middleware's and the route's own same-origin check refuse another site's,
  and a form or plain-text body is refused (`403`). Allowed: a code for five
  minutes, logged (`oauth.granted`, with the client's name, the host and the
  scopes). The page is in the staff dictionaries (`oa.` in
  `src/lib/staff-i18n/settings.ts`), in English, Malay and Chinese.

**Tokens.** Random and opaque; only their SHA-256 is kept, as API keys are.
An access token lasts an hour; a refresh token 30 days and is replaced on
each use. A code or a refresh token used a second time ends the connection
(and is logged, `oauth.revoked`). Each connection (a grant) is one client,
one person, one venue, the role they had there when they allowed it, and the
scopes they allowed; its tokens are for `<site>/api/mcp/staff` alone.

**Checked on every call.** The person's staff record is read afresh on every
call and refresh, never taken from the token: the connection ends when the
account is removed, no longer manages the venue, or its role there is lower
than when they allowed it (a manager become front desk), and it does not come
back if the role does. Their password reset or changed, their two-factor
sign-in reset by a manager or from the console, or their account moved to a
new address, ends every connection of theirs, as it ends their other
sessions. While the install requires two-factor
sign-in of an account that has not set it up, its calls are refused. What the
role may do is the dashboard's own answer at the call (`staffMay`); tools act
through the person's record narrowed to the one venue, so the dashboard's
routes find it there and nowhere else. The platform owner acts as a manager
of the venue they chose, never as the owner of every one.

### Revoking

*AI assistants connected*, on the dashboard beside the account's own sign-in
settings (`AssistantsPanel.tsx`, `GET`/`POST /api/admin/assistants`), lists
every member of staff's own connections, and a manager's also everybody's at
the venues they manage: the client's name (not verified), the venue, whose it
is, what it may do, when it was connected and last used, and *Revoke*, which
ends it at once (`oauth.revoked`). The assistant can also revoke its own
token (`/api/oauth/revoke`). Removing the person, or taking the venue or their
role away, ends it too.

### Adding MySenam to claude.ai or ChatGPT

The address to give is `<site>/api/mcp/staff` (also shown on *Venues & staff →
API and webhooks*). In claude.ai, *Settings → Connectors → Add custom
connector*, with that address; in ChatGPT, a custom connector (developer mode)
with that address and OAuth. The assistant registers itself, opens the
consent page, and after *Allow* uses the tools the scopes reach. Both
providers' own instructions decide where these settings are; they change
over time. The address is the install's own (`MYSENAM_URL`), not a
storefront's.

## Changing the venue's settings

With `venue:configure`, a manager signed in can change the settings the
[setup journey](../features/venue-guide.md#the-setup-journey) changes, through
the very route handlers the dashboard and the journey call
(`src/lib/mcp/config-tools.ts`): the request is the dashboard's own, run as
the person, so the same validation, `MANAGER_ONLY`, refusals and their words,
effective dating and log entries apply, and no rule is written again.

| Tool | The dashboard's requests | Annotations |
| --- | --- | --- |
| `save_setup_answers` | `{ answers, rev }`: `POST /api/admin/guide/setup` (`answers`), refused with the answers now saved if somebody saved since | not destructive |
| `acknowledge_setup_step` | `{ step }`: `POST /api/admin/guide/setup` (`acknowledge`), a review step | not destructive, idempotent |
| `set_opening_hours` | `{ open, close, weekHours?, from? }`: now `PATCH /api/admin/venues/:id`; from a date `POST /api/admin/venues/:id/hours-changes`. Refused with every booking listed where bookings made would fall outside | destructive, idempotent |
| `set_court_rates` | `{ courtId, offPeakRate, peakRate, from? }`: now `PATCH /api/admin/courts/:id`; from a date `POST /api/admin/courts/:id/changes`. Bookings made keep their price | destructive, idempotent |
| `add_courts` | `{ sport, count \| name, noun?, offPeakRate, peakRate, capacity? }`: `POST /api/admin/courts` | not destructive |
| `set_peak_hours` | `{ weekdayFrom, weekdayUntil, weekendDays, weekendFrom, weekendUntil }`: `POST /api/admin/peak-rules` | destructive, idempotent |
| `set_booking_rules` | `{ level: venue \| sport \| court, sport?, courtId?, settings }`: `POST /api/admin/booking-policies` (never the business level, which reaches every branch) | destructive, idempotent |
| `set_cancellation_terms` | `{ cutoffHours?, lateKeep?, giveBack?, strikeLimit?, strikeDays?, onlineRefunds?, refundWithinDays?, reviewed? }`: `PATCH /api/admin/venues/:id` (the cutoff), `POST /api/admin/cancel-policy` (the terms as they are with those given), `POST /api/admin/guide/setup` (`acknowledge` the review), together or not at all | destructive, idempotent |

Every one is `readOnlyHint: false`, `openWorldHint: false`.

**Preview, then apply exactly that.** Without `confirm: true` the requests
run inside a transaction that is rolled back: the answer is the settings that
would change, from what to what (`changes`), the requests, a note where the
application does more (bookings keep their price; a dated change shows in the
playbook's *Coming later*), and a `previewToken`; or the route's refusal in
its own words and code, with the bookings it lists. `confirm: true` without
the token is refused (`MCP_PREVIEW_FIRST`). The token is a keyed hash
(`keyedHash`, `src/lib/secrets.ts`) of the connection, the arguments and the
saved settings the change concerns as they were at the preview; if those
changed since (somebody saved on the dashboard), or the arguments are not
the previewed ones, nothing is applied and the answer is the settings as they
are now (`MCP_PREVIEW_STALE`), for a new preview. A tool's requests apply
together in one transaction or not at all.

**Never through an assistant:** online-payment keys or accounts, staff
accounts and roles, API keys, assistants' connections, payouts, refunds,
tax, e-invoicing, going live, or deleting anything. Also left out, each still
on the dashboard: the venue's name, address, phone, map pin, photos and
facilities; weekday-only hours changes and closed days other than through
`weekHours`; holidays; member rates and an activity's own rates on a shared
court; a court's own hours; editing or withdrawing a change scheduled from a
date; the *details checked* tick of the checklist; inviting staff (the
journey's `staff` step); test bookings.

## Customers' personal data

Off by default (`venues.ai_personal_data`, migration 0262;
`src/lib/ai-personal-data.ts`). Off, every tool's booking reads as its code,
status, payment status, date and times, court, price and amounts paid, with
no `name`, `phone`, `email` or `participants`; `create_booking` still takes the
customer's name and phone as input, which is the caller's own data. On, bookings
read as `/api/v1` gives them. The same setting governs a member of staff signed
in through an assistant: the assistant sees customers' personal data only
where it is on, whatever the person could see on the dashboard.

Only a manager switches it, under *Venues & staff → API and webhooks*
(`POST /api/admin/integrations`, `action: "aiPersonalData"`; front desk is
refused as on all of that screen). The screen warns first that the assistant's
provider may process the data outside the country under its own terms, and
that whether to share it, and how to tell customers, is the venue's decision
and responsibility; MySenam does not decide that it is lawful. Who switched it
and when is kept with the setting and in the staff activity log
(`integration.ai_personal_data`). See [privacy](../architecture/privacy.md#ai-assistants).
The public API is not affected.

## Connecting

For claude.ai and ChatGPT, and any client that signs in, see
[above](#adding-mysenam-to-claudeai-or-chatgpt): `<site>/api/mcp/staff`.

With a key, the address is `<site>/api/mcp`. Keep a key in an environment variable on the
computer that runs the assistant, never in a chat. Examples, also shown on
*Venues & staff → API and webhooks*:

- **Claude Code:** `claude mcp add --transport http mysenam <site>/api/mcp --header "Authorization: Bearer $MYSENAM_API_KEY"` (no `--header` for the public tools).
- **Cursor** (`mcp.json`): `{ "mcpServers": { "mysenam": { "url": "<site>/api/mcp", "headers": { "Authorization": "Bearer ${env:MYSENAM_API_KEY}" } } } }`.
- **Claude Desktop** (`claude_desktop_config.json`), through the free
  `mcp-remote` bridge: `{ "mcpServers": { "mysenam": { "command": "npx", "args": ["-y", "mcp-remote", "<site>/api/mcp", "--header", "Authorization:${MYSENAM_AUTH}"], "env": { "MYSENAM_AUTH": "Bearer <key>" } } } }`.

The public guide ends with a short section, *Use MySenam from your AI
assistant*, giving the address (`src/components/fit/AiAssistants.tsx`).

**How it was verified:** by tests against the route handler
(`tests/mcp.test.ts`): the protocol, the public tools compared with the
guide's model and the public routes, keys, scopes, venues, limits, cookies and
`Origin`, personal data, previews and writes compared with `/api/v1`; and
signing in by tests against its route handlers (`tests/mcp-oauth.test.ts`):
the discovery documents, registration (redirect URIs, no secret, the limit),
the authorization request (exact return address, PKCE, state, scopes,
resource, deny, sign-in first, two-factor sign-in, what front desk may allow,
venues out of reach, the same-origin JSON decision), tokens (one use of a
code, the verifier, rotation and reuse, expiry, audience, revocation, only
hashes kept), the connection ending on a role dropped, a venue lost, a
removal and a two-factor reset, tools by scope and role, the staff log naming
the person, and the configuration tools against the dashboard's own routes
(the saved state compared, a stale preview, the stranded-bookings refusal,
dates shown in the playbook). Run on PGlite and on Postgres. Neither has been
tried from a real AI client (claude.ai, ChatGPT, Claude Code, Cursor) against
a public address; the examples follow each client's own instructions.

## Not built

- Clients registered by an address that is not `https` or the same computer
  (Cursor's and VS Code's own `cursor://` / `vscode://` addresses), clients
  identified by a metadata document (`client_id` as a URL) and confidential
  clients with a secret: only public clients that register themselves.
- Calls from a web page in a browser (no CORS on the token and registration
  endpoints; the discovery documents allow any site to read them).
- Signing in through a storefront's own address: connectors use the install's.
- An expiry of its own for a connection: it lasts while it is refreshed (30
  days between uses at most) and the person keeps the venue and role.
- Clients that registered but never connected are kept; registrations are
  only limited per address.
- Resources, prompts, server-sent events, sessions and the official SDK (a
  stateless tools-only server needs none; see the ADR).
- Waiting lists and taking one person off a booking are in the
  [public API](external-api.md) but not offered as tools.
