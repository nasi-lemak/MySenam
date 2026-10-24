# Instructions for coding agents

MySenam is a sports-court booking app (Next.js 15, TypeScript, Postgres;
PGlite in development and tests). Start from [`docs/index.md`](docs/index.md),
which names the one authoritative document for each subject.

## Working on the code

- Run `npm run typecheck`, `npm run lint` and `npm test` before committing; see
  [testing](docs/development/testing.md) for running the suite against Postgres
  as CI does.
- Schema changes are new files in `db/migrations/`; never edit or delete an
  applied migration ([database](docs/architecture/database.md)).
- Never print secrets or connection strings, and never ask for a key in chat:
  use environment variables ([configuration](docs/development/configuration.md)).
- Competitions are configured by data: a new sport is a template and rules
  (`src/lib/competition-templates.ts`, `src/lib/tournament-rules.ts`), never
  an engine or a branch on the sport ([ADR 0013](docs/architecture/decisions/0013-competition-framework.md)).
  Box leagues and results entered by players or officials use the same rules
  and `recordResult`, not checks of their own.
- Personal data leaves the install's country only by a declared and approved
  path: off-site backups need `OFFSITE_DATA_LOCATION`, and abroad
  `OFFSITE_TRANSFER_APPROVED` and encryption
  ([privacy](docs/architecture/privacy.md#backups-held-abroad)). Never send it
  abroad by default, and never treat a legal question as settled in code.
- Tax treatments the app suggests are provisional starting points, never
  presented as verified; a venue's adviser's review is recorded, not assumed.

## Keeping the documentation true

A task is not finished until its documentation is. These rules apply to every
change:

1. **Documentation changes go with behaviour changes.** Adding, changing or
   removing behaviour updates its authoritative document
   ([index](docs/index.md)) in the same change.
2. **Keep [feature status](docs/product/feature-status.md) accurate.** Add,
   change or remove its row when a capability is added, changed or removed,
   and change a status when implementation or verification changes. Written
   code is not `IMPLEMENTED_AND_TESTED`; that status needs a test file in the
   row that exercises the behaviour claimed. A table, route or helper alone is
   not a working feature. One row per independently verifiable capability:
   split a row only when it hides workflows in different states.
3. **Keep `README.md` short.** It links to detail; it does not hold it.
4. **Say it once.** Update the authoritative section and link to it from
   elsewhere rather than repeating it.
5. **Describe what is true now,** not the history of fixes. History belongs in
   a [decision record](docs/architecture/decisions/) or a
   [migration note](docs/archive/migrations/legacy-installs.md).
6. **Keep plans apart from what works.** Planned, blocked and deferred work
   lives in the [roadmap](docs/roadmap/roadmap.md) and is never described as
   operational. When planned work is built, changed or deferred, update its
   roadmap row in the same change.
7. **Say how something was verified.** A test against a fake gateway is not a
   live check; payments, WhatsApp, email, SMS, MyInvois, Google sign-in,
   off-site storage and smart locks stay `INTEGRATION_VERIFICATION_REQUIRED`
   until checked against the real service. A row whose workflow pays or messages
   through one of them names that integration row in its gaps.
   Suites run by hand are not CI: never record CI as passed unless a CI run
   on that commit passed. A restore drill on a test machine is not proof that
   production can be recovered.
8. **Record limitations.** Known defects, restrictions and integration
   dependencies go in [known limitations](docs/roadmap/known-limitations.md),
   not out of sight. A fixed one moves to *fixed since the audit* with its
   test; identifiers (S1, B2, M3…) are never reused or renumbered, and a new
   defect takes the next number of its letter.
9. **Never change a business rule silently.** When code and documentation
   disagree, find out which is intended and flag it (in known limitations, or
   to the person you work for) rather than picking one.
10. **Check references.** `npm run docs:check` must pass: links, file paths,
    npm scripts, environment variables, routes and the feature-status matrix
    ([documentation checks](docs/development/testing.md#documentation-checks)).
11. **Stay in scope.** Don't rewrite unrelated documents; keep what is useful.
12. **Documentation is an acceptance criterion.** Implementation, its document,
    its feature-status row and its tests change together.
