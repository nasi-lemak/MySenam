# Documentation audit, 24 October 2026

A review of every document in the repository against the code and tests on
24 October 2026, and the reorganisation that followed. It changed
documentation only: no behaviour, schema, API or business rule. Where a
document and the code disagreed, the code was read and either the description
corrected with the evidence or the disagreement recorded for a decision. The
conventions it set are in [documentation](../development/documentation.md).

## What was there

| Where | Documents | Finding |
| ----- | --------- | ------- |
| `README.md`, `AGENTS.md` | 2 | Short and linking out, as intended; `AGENTS.md` had the documentation rules but no conventions for research, audits or proposals |
| `docs/` (product, features, architecture, integrations, development, operations, business, roadmap, archive) | 57, including the index and 18 decision records | Mostly current and authoritative; issues below |
| `docs/documentation-audit.md` | 1 | A dated audit (22 October) at the top of `docs/`, among maintained documents |
| `reports/` | 2 | The go-to-market report (18 October) and the launch audit (23 October), with spaces in their names, outside `docs/` and outside the documentation checks |
| `research_notes/MySenam go to market research/` | 6 | The research notes behind the report, snake_case names, outside `docs/` and the checks |

Each document was classified as maintained (describes what is true now),
historical (a dated record), research, or plan. None was found to be a
duplicate needing deletion; nothing was archived.

## What changed

### Moved, with their content unchanged

| From | To |
| ---- | -- |
| `reports/MySenam go to market research.md` | [`research/go-to-market/report.md`](../research/go-to-market/report.md) |
| `research_notes/MySenam go to market research/cost_inputs.md` | [`research/go-to-market/cost-inputs.md`](../research/go-to-market/cost-inputs.md) |
| `…/global_competitors.md` | [`research/go-to-market/global-competitors.md`](../research/go-to-market/global-competitors.md) |
| `…/malaysian_competitors.md` | [`research/go-to-market/malaysian-competitors.md`](../research/go-to-market/malaysian-competitors.md) |
| `…/pricing_and_validation.md` | [`research/go-to-market/pricing-and-validation.md`](../research/go-to-market/pricing-and-validation.md) |
| `…/product_audit.md` | [`research/go-to-market/product-audit.md`](../research/go-to-market/product-audit.md) |
| `…/segments.md` | [`research/go-to-market/segments.md`](../research/go-to-market/segments.md) |
| `reports/MySenam launch audit 2026-10-23.md` | [`audits/launch-2026-10-23.md`](launch-2026-10-23.md) |
| `docs/documentation-audit.md` | [`audits/documentation-2026-10-22.md`](documentation-2026-10-22.md) |

Each moved file gained a banner saying where it came from and that its
findings are unchanged. Relative links to code in the report and the product
audit were pointed at commit `77f0401`, the code the research read, so they
keep showing what was audited; one link to a never-committed coverage report
became plain text. `reports/` and `research_notes/` no longer exist; the
image build context leaves out `docs/research` and `docs/audits` as it left
out the old folders (`.dockerignore`).

### Added

- [Research overview](../research/go-to-market/index.md): what the research
  is, its evidence labels, and what became of each recommendation (built,
  not adopted, or never decided), from the code and documents of this date.
- [Audits](index.md): the list of audits and a tracker for every item the
  launch audit left open (fixed, unresolved, accepted, or no longer
  applicable), each pointing to where it is tracked.
- [Tournaments and leagues](../features/tournaments.md) and
  [open games and matchmaking](../features/matchmaking.md), split from
  `programmes.md` (below).
- [Documentation](../development/documentation.md): folder responsibilities,
  sources of truth, how statuses map to plain words, the feature-document
  outline, names, and how history is kept.
- [Business: pricing](../business/pricing.md#open-decisions): open decisions
  on what venues are charged at launch, and whether to run the research's
  validation plan.

### Split

`features/programmes.md` (784 lines) held four domains that change
independently. Tournaments and box leagues went to
[`tournaments.md`](../features/tournaments.md), open games and everything
around them to [`matchmaking.md`](../features/matchmaking.md); classes,
coaching and the women-only and men-only rule shared by all of them stayed in
[`programmes.md`](../features/programmes.md), kept under its name because an
applied migration's comment (`db/migrations/0099_competition_rules.sql`)
points to it, and migrations are never edited. Each new document starts with
its scope, roles, status link and decision records, and ends with the
capabilities it relies on, its code and tests, and its open questions.
Feature status's *Classes, coaching and programmes* section became three
sections to match, with the same rows.

### Relabelled

The [roadmap](../roadmap/roadmap.md) mixed accepted plans with ideas nobody
had committed to. It now marks each row `PLANNED`, `PROPOSED`, `BLOCKED` or
`DEFERRED`. Seven existing rows were ideas and became `PROPOSED`; seven gaps
the launch audit found but nothing tracked (an admin dashboard in Malay,
Chinese and Tamil; passes sold online; Malaysian gateways beyond Billplz;
IoT lighting; Apple sign-in; a native app and offline mode; live accounting
integration) were added as `PROPOSED`, not as commitments.

## Corrected from the code

| Document | It said | The code | Evidence |
| -------- | ------- | -------- | -------- |
| `programmes.md`, *What tournaments do not do* | No divisions, no eligibility check, no closing date, no score-dependent table points, no check-in, only staff enter results, no officials, a match moved only as a replay, box leagues not on the competition rules | All of these are built and described in the same document's own sections | `src/lib/competitions.ts`, `src/lib/match-reports.ts`, `moveMatch` in `src/lib/tournaments.ts`, `src/lib/leagues.ts` (rules from `src/lib/tournament-rules.ts`); `tests/divisions.test.ts`, `tests/match-reports.test.ts`, `tests/fixtures.test.ts`, `tests/leagues.test.ts` |
| Feature status, two tournament rows' gaps | "no deadline; no divisions or age groups"; "players cannot enter or confirm results; no officials; no check-in" | As above | As above |
| `booking.md`, changing the date or time | Refused for "an open game with players in it" | Refused for any booking with an `open_games` row, even a called-off game with nobody in it, for staff too; also refused for a lesson with a coach, and for a customer when friends have paid shares | `rescheduleBooking` in `src/lib/store.ts` (`RESCHEDULE_GAME`, `RESCHEDULE_COACH`, `RESCHEDULE_SHARED`) |

## Unresolved, recorded for a decision

- **Moving a booking that had an open game.** The code refuses it for
  everybody, for any game ever opened on it; the customer's message says the
  game has players in it and to ask the venue, who cannot move it to another
  time either. Which is intended is undecided; untested
  ([known limitations](../roadmap/known-limitations.md#booking-and-availability-b)).
- **Venue pricing.** The research recommended pilot prices; the code has
  court-count tiers at other values and a venue fee defaulting to zero, with
  no decision recorded either way
  ([business: pricing](../business/pricing.md#open-decisions)).
- Older open items (a series cancel skipping weeks inside the cutoff, two
  chargeback cases, inline scripts, the drafts of `/terms` and `/privacy`)
  remain where they were tracked ([audits](index.md#launch-audit-23-october-2026)).

## Gaps found

Recorded in [known limitations](../roadmap/known-limitations.md#gaps-in-verification-and-documentation)
where they are gaps in the product or its verification:

- No incident-response procedure beyond alerts and restoring.
- The open-game reschedule refusal has no test.

Documentation gaps, not recorded as product limitations:

- No customer-journey or user-role document beyond the overview's
  [who uses it](../product/overview.md#who-uses-it); journeys are spread
  across feature documents.
- [HTTP routes](../architecture/http-api.md) is a partial reference by its
  own description.
- [Booking time model](../architecture/interval-booking-review.md) is named
  as a review although it is the maintained description; not renamed here,
  to keep its many links.

## How it was checked

- `npm run docs:check` (`tests/docs.test.ts`): links and anchors in every
  document, repository paths, npm scripts, environment variables, routes, the
  feature-status matrix and defect identifiers. Dated audits and research
  now have their links checked but not the paths and scripts they name, which
  describe the repository as it was
  ([testing](../development/testing.md#documentation-checks)).
- `npm run typecheck` and `npm run lint`, since a source comment and the
  documentation test changed.
- Every claim corrected above was checked by reading the code it names; the
  research's recommendations were checked against the code and documents of
  this date. No test of application behaviour was added or changed, and no
  behaviour was verified beyond what the existing tests already show.
- Not checked: whether every sentence of every maintained document matches
  the code. The documents not named above were reviewed for structure,
  duplication and status claims, not re-verified line by line.
