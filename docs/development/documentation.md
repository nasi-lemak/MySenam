# Documentation

How MySenam's documentation is organised and kept true. [`AGENTS.md`](../../AGENTS.md)
states the rules briefly; this is where they are explained. The map of
subjects to documents is [`docs/index.md`](../index.md).

## Where things go

Each folder has one job. A document lives in one place; other documents link
to it rather than repeating it.

| Folder | Holds | Not |
| ------ | ----- | --- |
| [`product/`](../product/) | What MySenam is, who uses it, its terms, rules that span features, the marketplace, regions and tax, and [feature status](../product/feature-status.md) | How one capability behaves in detail |
| [`features/`](../features/) | How each capability behaves now: one specification per domain | Plans, research, design rationale |
| [`architecture/`](../architecture/) | How the system is built: data, tenancy, sign-in, security, privacy, and [decision records](../architecture/decisions/) | Product rules |
| [`integrations/`](../integrations/) | External services: what is sent, how it is set up, what it costs | Whether a live account was proven (that is feature status) |
| [`development/`](../development/) | Working on the code: setup, configuration, testing, these conventions | |
| [`operations/`](../operations/) | Running it: deployment, backups and recovery, monitoring | |
| [`business/`](../business/) | Commercial decisions: venue pricing, open business decisions | Market research |
| [`roadmap/`](../roadmap/) | [Roadmap](../roadmap/roadmap.md) (work not built) and [known limitations](../roadmap/known-limitations.md) (what is wrong, missing or unverified) | Anything that works |
| [`research/`](../research/) | Dated research: competitors, costs, segments, feasibility, with sources | Requirements |
| [`audits/`](../audits/) | Dated assessments and where their findings stand ([audits](../audits/index.md)) | Maintained descriptions |
| [`archive/`](../archive/) | Superseded material kept for reference, marked as such and linking to its replacement | Anything current |

The line between them:

- **Research** explains why a capability may be valuable.
- **Feature documents** describe how a capability behaves.
- **Architecture** explains how the system is designed; a cross-cutting
  decision is a decision record, not something each feature redefines.
- **Audits** record what was found at one time.
- **The roadmap** tracks work not yet done, and known limitations what is
  wrong now.
- **Operations** explain how to run, maintain and recover the system.

So a tournament's fee is in [tournaments](../features/tournaments.md), which
links to [payments and credit](../features/payments-and-credit.md) for how
paying and refunds work; what competitors charge for tournaments is research;
a missing tournament feature found by an audit stays in that audit and, if
accepted, becomes a roadmap row.

## Sources of truth

The code and its tests are what MySenam does. A document describes them; it
does not make anything true by saying it.

- **Status comes from evidence.** A capability's status is in
  [feature status](../product/feature-status.md), with its code and the tests
  that exercise it. Do not infer a status from a document, a route, a table
  or a migration alone.
- **When a document and the code disagree,** read the code and its tests.
  Correct a description that is simply wrong, with the evidence. If it is
  not clear which one is intended, do not choose: record the disagreement in
  [known limitations](../roadmap/known-limitations.md) (or ask) and leave the
  behaviour alone.
- **Research and audits are not requirements.** A recommendation becomes a
  requirement only when it is decided and written where it applies (a
  feature document, a business document or the roadmap), linking back.

## Statuses

Feature status uses the statuses defined in
[its legend](../product/feature-status.md#statuses); the roadmap has its own
([roadmap](../roadmap/roadmap.md)). In plain words:

| Plain words | Where and how it is recorded |
| ----------- | ---------------------------- |
| Implemented and verified | `IMPLEMENTED_AND_TESTED`, with a test file that exercises the claim. Tests run against stand-ins for external services: that is not live verification |
| Implemented but not fully verified | `IMPLEMENTED_UNTESTED`, or `INTEGRATION_VERIFICATION_REQUIRED` until checked against the real service |
| Partially implemented | `PARTIALLY_IMPLEMENTED`, with what is missing in its gaps |
| Planned | A roadmap row marked `PLANNED` (accepted, not built); `BLOCKED` or `DEFERRED` where that applies |
| Proposed | A roadmap row marked `PROPOSED`: an idea, not a commitment. Never in feature status |

No document calls anything production-ready. What production needs is in
[deployment](../operations/deployment.md#before-going-live-what-only-a-live-account-can-prove)
and [known limitations](../roadmap/known-limitations.md#production-readiness).

## A feature document

Start with what it is authoritative for, a link to its rows in feature
status, and any decision record behind it. Then cover, where they apply:

1. purpose and scope, and what belongs elsewhere;
2. who uses it (roles);
3. the workflows;
4. business rules and invariants;
5. states and how they change;
6. who may do what;
7. validation and limits;
8. edge cases and failures;
9. other features it relies on (link them, do not redefine them);
10. the code;
11. the tests;
12. its status (link to feature status rather than repeating it);
13. open decisions and known limitations (link to known limitations and the
    roadmap).

Simple features need few of these; [tournaments](../features/tournaments.md)
and [open games and matchmaking](../features/matchmaking.md) show most of
them. Describe what is true now. Planned work goes in the roadmap, not in a
"coming soon" paragraph.

Split a document when it holds separate domains that people change
independently, not to make it shorter; keep small related features
together.

## Names

Lowercase kebab-case (`payments-and-credit.md`), descriptive, and dated where
the document is a record of one time (`launch-2026-10-23.md`). Use `index.md`
only for a page that is genuinely the overview of its folder. Do not rename a
file without a reason; when one moves, update every link to it (the
documentation checks find the broken ones).

## History is kept, not rewritten

- **Audits and research are dated records.** Their findings are never edited
  to match later code. A banner at the top may say where the file came from
  and where its findings now stand; the tracking itself is in
  [audits](../audits/index.md) and the research's
  [overview](../research/go-to-market/index.md). Links to code from such a
  record point to the commit it read.
- **The documentation checks** follow every link in these records but not
  the paths and scripts they name, which may since have moved
  ([testing](testing.md#documentation-checks)).
- **Superseded material** goes to [`archive/`](../archive/), marked as such and
  linking to its replacement, when it holds something worth keeping; a plain
  correction does not need an archive copy. Git history is not a substitute
  for keeping a record that matters.
- **Decision records** are never deleted; a reversed one is marked
  superseded and links to its successor.
- **Defect identifiers** (S1, B2, M3…) are never reused or renumbered.

## Adding or moving a document

Look for an existing home first; most changes belong in a document that
exists. A new document is added to [`docs/index.md`](../index.md), and to its
folder's index where there is one. Run `npm run docs:check`.
