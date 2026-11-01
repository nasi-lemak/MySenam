# MCP server for AI assistants

Authoritative for using MySenam from an AI assistant (Claude, ChatGPT, Cursor
and other clients of the Model Context Protocol): the endpoint, its tools by
the authority each needs, how callers are recognised, customers' personal
data, limits, and how to connect. Decision record:
[ADR 0029](../architecture/decisions/0029-mcp-server-over-existing-functions.md).

## What it is

`POST /api/mcp` (`src/app/api/mcp/route.ts`, `src/lib/mcp/`) speaks the Model
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

Only the `Authorization` header says who is calling:

- **No header:** the public tools only.
- **`Authorization: Bearer <key>`**: one of the venue's [API keys](external-api.md#public-api-and-webhooks),
  checked exactly as `/api/v1` checks it (`apiCaller` in `src/lib/api-keys.ts`:
  only the key's SHA-256 is looked up, a revoked key is refused at once, *last
  used* is updated). Any key's scope may connect; each tool asks for its own.
- **A header that is not a good key** (unknown, revoked, malformed, another
  scheme) is refused with `401` and `WWW-Authenticate: Bearer realm="mysenam",
  error="invalid_token"`, never answered as if nobody had called.

A cookie never signs anybody in here: a staff member's session sent with no
key gets the public tools only, and the public tools ask the public routes
with no cookie at all. A request whose `Origin` (or `Sec-Fetch-Site:
cross-site`) is not the site's is refused (`403`) before anything else, as
the protocol's guidance against DNS rebinding asks: the allowed hosts are
`MYSENAM_URL`'s and, on a storefront, its own name, never merely the `Host`
the request carries (`foreignOrigin` in `src/lib/same-origin.ts`). Clients
that are not browsers send no `Origin` and are not affected.

**Limits.** Without a key, 60 requests a minute per address (`mcp` in
`src/lib/rate-limit.ts`); with one, the API's 120 a minute per key. Past
either, `429` with `Retry-After`.

## Tools

One registry (`src/lib/mcp/registry.ts`) names each tool's authority: `public`,
or the key scope it needs (`availability` < `read` < `write`). `tools/list`
lists what the caller holds; a known tool beyond it answers the API's own
sentence (*This key can only read.*) or, without a key, that it needs one.

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

With the venue's API key, for the key's venue only: another venue's court or
booking is not found (`src/lib/mcp/venue-tools.ts`).

| Tool | Scope | Returns or does |
| --- | --- | --- |
| `my_venue` | availability | The venue as `GET /api/v1/venue` gives it, and whether personal data is shown to assistants |
| `my_availability` | availability | `{ date?, activity? }`: each court's day as `GET /api/v1/availability` gives it |
| `my_bookings` | read | `{ from, to? }` (at most 31 days): the bookings as `GET /api/v1/bookings` gives them |
| `my_booking` | read | `{ code }`: one booking |
| `my_setup_status` | read | `{ locale? }`: the [setup plan](../features/venue-guide.md#the-setup-plan) and [launch readiness](../features/venue-guide.md#launch-readiness) of the manager's guide (`setupView`, `buildSetupPlan`, `launchReadiness`), each step with its state and why it is shown, readiness in its six lists; never a percentage |
| `my_playbook` | read | `{ locale? }`: the manager's [operating playbook](../features/venue-guide.md#the-operating-playbook) (`playbookFor`) as plain-text sections; links are said as their screens' names, no address |
| `create_booking` | write | The fields of `POST /api/v1/bookings`, and `confirm` |
| `cancel_booking` | write | `{ code, confirm }` |

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
booking rules on it, are known only when booking.

**The staff activity log** names the key (`API key <id>`) for every call made
with one: a booking made or cancelled as `booking.created` or
`booking.cancelled` (*… through an AI assistant (MCP)*), every other call,
preview and refusal as `mcp.tool` with the tool's name and outcome, never its
arguments, so no customer's details are written there.

## Customers' personal data

Off by default (`venues.ai_personal_data`, migration 0262;
`src/lib/ai-personal-data.ts`). Off, every tool's booking reads as its code,
status, payment status, date and times, court, price and amounts paid, with
no `name`, `phone`, `email` or `participants`; `create_booking` still takes the
customer's name and phone as input, which is the caller's own data. On, bookings
read as `/api/v1` gives them.

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

The address is `<site>/api/mcp`. Keep a key in an environment variable on the
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
`Origin`, personal data, previews and writes compared with `/api/v1`. It has
not been tried from a real AI client against a public address; the examples
follow each client's own instructions.

## Not built

- **Signing in through an AI provider's connector** (OAuth, for claude.ai and
  ChatGPT connectors, which do not send a custom header) and **changing a
  venue's settings through an assistant**: planned as a later layer, with their
  own authorities in the same registry. Until then a connector added without a
  key reaches the public tools only.
- Resources, prompts, server-sent events, sessions and the official SDK (a
  stateless tools-only server needs none; see the ADR).
- Waiting lists and taking one person off a booking are in the
  [public API](external-api.md) but not offered as tools.
