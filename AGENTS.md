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

## Keeping the documentation true

A task is not finished until its documentation is. These rules apply to every
change:

1. **Documentation changes go with behaviour changes.** Adding, changing or
   removing behaviour updates its authoritative document
   ([index](docs/index.md)) in the same change.
2. **Keep [feature status](docs/product/feature-status.md) accurate.** Change a
   status when implementation or verification changes. Written code is not
   `IMPLEMENTED_AND_TESTED`; that status needs a test file in the row.
3. **Keep `README.md` short.** It links to detail; it does not hold it.
4. **Say it once.** Update the authoritative section and link to it from
   elsewhere rather than repeating it.
5. **Describe what is true now,** not the history of fixes. History belongs in
   a [decision record](docs/architecture/decisions/) or a
   [migration note](docs/archive/migrations/legacy-installs.md).
6. **Keep plans apart from what works.** Planned, blocked and deferred work
   lives in the [roadmap](docs/roadmap/roadmap.md) and is never described as
   operational.
7. **Say how something was verified.** A test against a fake gateway is not a
   live check; payments, WhatsApp, email, SMS, MyInvois, Google sign-in,
   off-site storage and smart locks stay `INTEGRATION_VERIFICATION_REQUIRED`
   until checked against the real service.
8. **Record limitations.** Known defects, restrictions and integration
   dependencies go in [known limitations](docs/roadmap/known-limitations.md),
   not out of sight.
9. **Never change a business rule silently.** When code and documentation
   disagree, find out which is intended and flag it (in known limitations, or
   to the person you work for) rather than picking one.
10. **Check references.** `npm run docs:check` must pass: links, file paths,
    npm scripts, environment variables, routes and the feature-status matrix
    ([documentation checks](docs/development/testing.md#documentation-checks)).
11. **Stay in scope.** Don't rewrite unrelated documents; keep what is useful.
12. **Documentation is an acceptance criterion.** Implementation, its document,
    its feature-status row and its tests change together.
