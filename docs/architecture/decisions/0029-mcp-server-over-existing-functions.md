# ADR 0029: An MCP server over the existing functions

- **Status:** current, decided 2026-11-01 (the owner: business owners should
  be able to adopt and use MySenam through their own AI assistant). How it
  works is [the MCP server](../../integrations/mcp.md).
- **Context:** AI assistants (Claude, ChatGPT, Cursor…) reach outside services
  through the Model Context Protocol. Three layers were approved: public tools
  with no credentials (the business-fit guide, search, a venue's public page
  and day); a venue's own tools with its existing API key; and later, signing
  in through an AI provider's connector (OAuth) and changing settings. The
  risk is a second description of the business, or a second set of rules, for
  the assistant: answers that drift from what the pages and the API say, data
  the pages would not show, or a booking path with checks of its own.
- **Decision:**
  - **One tool registry** (`src/lib/mcp/registry.ts`), each tool naming the
    authority it needs: `public`, or an API key's scope (`availability`,
    `read`, `write`). The server lists and runs a tool only for a caller holding
    its authority. Layer 3 adds authorities here (a signed-in person, a
    settings scope) under the same rule; nothing else changes.
  - **No second business logic.** Public tools answer through the code of the
    pages and routes they mirror: the public guide's model and presenters
    (`fitView`, `presentChip`), and the public routes' own handlers
    (`/api/search`, `/api/availability`) asked with a request that carries no
    cookie and no key. Venue tools call what `/api/v1` and the dashboard call:
    the booking and cancellation paths were moved out of the API's routes into
    `src/lib/key-bookings.ts` so the route and the tool run the same function;
    the setup status and playbook are `setupView` and `playbookFor`. A tool
    only shapes the answer (fewer fields, times also as `HH:MM`).
  - **Stateless**, JSON over Streamable HTTP: no session, no event stream, no
    cache across requests or venues.
  - **Bearer only.** The `Authorization` header is the only credential, checked
    as the API checks keys; a bad one is refused, never taken as anonymous. A
    cookie never authenticates, and a foreign `Origin` is refused.
  - **Writes ask first.** `create_booking` and `cancel_booking` change nothing
    without `confirm: true`; they answer a preview from the same checks.
  - **Personal data off by default**, a venue setting only a manager turns on,
    with a plain warning that the AI provider may process it abroad and that
    the venue is responsible. The app records the choice and never treats it as
    lawful.
  - **Hand-written protocol, not the SDK.** A tools-only stateless server needs
    four methods; the official SDK would have added a dependency tree (its HTTP
    server packages) for no feature used here. Revisit if resources, prompts,
    sessions or the OAuth layer make the SDK worth it.
- **Consequences:** an assistant sees what a person would see on the same
  path, refused for the same reasons in the same words; a change to a rule
  reaches the assistant with no change here. The tests compare tool answers
  with the pages, routes and `/api/v1` (`tests/mcp.test.ts`). Not yet tried
  from a real AI client against a public address. OAuth connectors and
  changing settings were planned here as layer 3, and were then built as
  [ADR 0030](0030-oauth-sign-in-for-ai-assistants.md) decided (1 November
  2026): new authorities in this registry, as this record expected, and the
  protocol still hand-written.
