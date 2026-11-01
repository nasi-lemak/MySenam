# ADR 0030: Signing staff in from AI assistants with an authorization server inside the app

- **Status:** current, decided 2026-11-01 (the owner: business owners should
  use MySenam from their own AI assistant; layer 3 of
  [ADR 0029](0029-mcp-server-over-existing-functions.md) approved). How it
  works is [the MCP server](../../integrations/mcp.md#signing-in-from-an-ai-assistant).
- **Context:** claude.ai's and ChatGPT's custom connectors, and other MCP
  clients, cannot send a venue's API key in a header of their own; the MCP
  authorization specification has them sign a person in with OAuth 2.1
  (discovery, dynamic client registration, PKCE, resource indicators). Signed
  in, the owner wants the assistant to do what that person may do, including
  changing the venue's settings, through the same functions, permissions,
  validation, logging and effective dating as the dashboard, with a preview
  and an explicit confirmation for every change. The risks: a second way in
  that is weaker than the dashboard's sign-in; a token that outlives the
  person's place at the venue; an assistant acting beyond the person's role;
  a second set of rules for changing settings; a change applied that is not
  the one previewed.
- **Decision:**
  - **An authorization server inside the app**, no new service, no paid
    identity provider (`src/lib/mcp/oauth.ts`, migration 0263). RFC 9728 and
    RFC 8414 discovery, RFC 7591 registration of public clients only (no
    secret issued, redirect URIs `https` or the same computer, rate-limited),
    the `code` grant with PKCE `S256` required and refresh tokens, RFC 8707
    `resource` bound to the one signed-in MCP address, RFC 7009 revocation,
    RFC 9207 `iss`.
  - **A second MCP address for signing in**, `/api/mcp/staff`, which always
    answers `401` with `resource_metadata` without a good token, so a
    connector learns to sign in; `/api/mcp` keeps serving the public tools
    without credentials and a venue's key with one. A token is for its
    address alone.
  - **The consent page reuses the staff sign-in**, two-factor sign-in
    included: somebody not signed in signs in and comes back. It names the
    client by its own unverified name, the host it returns to, the venue (one
    per connection), the role and each scope in plain words. Front desk may
    allow only what front desk does (`venue:read`, `venue:book`);
    `venue:configure` is a manager's. The decision is a same-origin JSON
    request; the browser is sent back only to a registered address, matched
    exactly.
  - **Tokens hashed, grants bound and re-checked.** Tokens are random and
    opaque, kept only as SHA-256 like API keys; an access token lasts an hour,
    refresh tokens rotate and a second use of one (or of a code) ends the
    grant. A grant is one client, one person, one venue, their role there at
    the time and the scopes allowed. On every call the person's staff record
    is read afresh: removed, without the venue, or with a lower role, the
    grant ends for good; a password reset or change, a two-factor reset or a
    move to a new address ends them as it ends sessions. The role a tool checks is the record's, never
    the token's.
  - **Acting as the person.** Tools that changed nothing through a key keep
    their code; the caller is the person's one venue, the staff log names
    them as acting through the assistant (*Maya through Claude (AI
    assistant)*) with their own staff id. Bookings through an assistant go
    through the API's path (no override, no payment), whatever the role.
  - **Settings through the dashboard's own route handlers.** A configuration
    tool turns its arguments into the dashboard's requests and runs those
    handlers as the person: `requireAdmin` finds them through
    `asDelegate` (`src/lib/admin-auth.ts`, an `AsyncLocalStorage` set only by
    the MCP server after checking the token), their record narrowed to the
    one venue and named as acting through the assistant; the request carries
    no cookie and the real path, so `MANAGER_ONLY` applies as on the
    dashboard. No setting has logic of its own here.
  - **Preview by rollback, apply only what was previewed.** Without
    `confirm: true` the requests run in a transaction that is rolled back,
    so the preview is what the routes would do, refusals included. Applying
    needs the preview's token, a keyed hash of the connection, the arguments
    and the saved settings concerned; if they changed, nothing is applied and
    the current settings are returned. One tool's requests apply together or
    not at all.
  - **Out of reach of an assistant:** payment keys and accounts, staff,
    roles, API keys, assistants' connections, payouts, refunds, tax,
    e-invoicing, going live, deleting.
- **Consequences:** an assistant signed in can do no more than its person on
  the dashboard, at one venue, and is refused in the dashboard's words; a
  change to a setting's rules reaches it with no change here. Running a
  route's handler inside an outer transaction makes its own transactions
  savepoints; a handler that did work outside the database (a message sent
  directly rather than through the outbox) would not be rolled back by a
  preview, so only handlers that write the database alone are wrapped (those
  listed in the MCP document). The platform owner signs in for one venue as
  its manager, never as the owner of all. Tested against the route handlers
  (`tests/mcp-oauth.test.ts`) on PGlite and Postgres; not tried from a real
  claude.ai or ChatGPT connector against a public address.
