# Instructions for coding agents

MySenam is a sports-court booking app (Next.js 15, TypeScript, Postgres;
PGlite in development and tests). Start from [`docs/index.md`](docs/index.md),
which names the one authoritative document for each subject.

## Working on the code

- Run `npm run typecheck`, `npm run lint` and `npm test` before committing
  (`npm run verify -- fast` does all three on what changed); see
  [testing](docs/development/testing.md) for running the suite against Postgres
  as CI does, staging, and the acceptance scenarios.
- Staging and acceptance runs use synthetic data only: never copy a production
  database into them, keep a database with real customers as a fixture, or
  point a seed at one. Remove only resources labelled with your own deployment
  id; spend on a cloud provider only within an approved, capped amount.
- Real-service checks use test-mode or sandbox credentials from the
  environment's secret store, never live keys and never pasted into chat; a
  service is live-verified only when its own check passes against the real
  service. A scenario for something not built is not written as passing.
- Schema changes are new files in `db/migrations/`; never edit or delete an
  applied migration ([database](docs/architecture/database.md)).
- Never print secrets or connection strings, and never ask for a key in chat:
  use environment variables ([configuration](docs/development/configuration.md)).
- Competitions are configured by data: a new sport is a template and rules
  (`src/lib/competition-templates.ts`, `src/lib/tournament-rules.ts`), never
  an engine or a branch on the sport ([ADR 0013](docs/architecture/decisions/0013-competition-framework.md)).
  Results entered by players or officials go through `recordResult`, as
  staff's do. Box leagues check and rank results by the same rules
  (`scoreRefusal`, `standings`) through their own functions in
  `src/lib/leagues.ts`, since `recordResult` carries a tournament's
  progression and corrections; neither has checks of its own. Ratings
  (`src/lib/ratings.ts`) are a consumer of those results, never a scoring
  path: a rating is a pure function of the ledger of rated results, recomputed
  from it, never updated in place and never learned
  ([ADR 0031](docs/architecture/decisions/0031-ratings-from-a-ledger-of-results.md)).
  A child's rating is for their guardian only; being rated makes nobody
  findable. Leagues of teams
  do the same in `src/lib/team-leagues.ts` (a team match is made of games from
  the sport's template, scored by `scoreRefusal`, ranked by `standings`). Teams
  that persist (`src/lib/teams.ts`) are joined by both sides agreeing, by
  declared adults, and a child only through a guardian's account; a child's name
  is never public.
- Matchmaking is built on open games ([ADR 0016](docs/architecture/decisions/0016-matchmaking-on-open-games.md)):
  one row per person per game, every change that takes or frees a place under
  the game's row lock, suggestions by published rules with their reasons shown,
  no learned ranking. Being found or invited by strangers is opt-in and for
  declared adults only; minors are invited only through a group both sides
  agreed to. Joining books no court and moves no money: shares go to the venue.
- Personal data leaves the install's country only by a declared and approved
  path: off-site backups need `OFFSITE_DATA_LOCATION`, and abroad
  `OFFSITE_TRANSFER_APPROVED` and encryption
  ([privacy](docs/architecture/privacy.md#backups-held-abroad)). Never send it
  abroad by default, and never treat a legal question as settled in code.
  Backblaze B2 is the preferred off-site provider and S3 stays supported,
  through the one S3-compatible adapter ([ADR 0015](docs/architecture/decisions/0015-backblaze-b2-preferred-signed-backup-sets.md)).
  Private keys for decrypting backups stay off the server and out of Git,
  logs and ordinary production environment variables. Never give the upload
  key delete or retention powers.
- Ages, guardians' agreement and self-declared categories are the entrant's
  word: record them as declared, never as verified, and collect no identity
  documents.
- Tax treatments the app suggests are provisional starting points, never
  presented as verified; a venue's adviser's review is recorded, not assumed.

## Keeping the documentation true

A task is not finished until its documentation is. These rules apply to every
change; [documentation](docs/development/documentation.md) explains them, and
says which folder holds what. Before a substantial change, read the area's
feature document, decision records and known limitations.

1. **Documentation changes go with behaviour changes.** Adding, changing or
   removing behaviour updates its authoritative document
   ([index](docs/index.md)) in the same change: the feature document for a
   business rule, a decision record for an architectural decision, the
   operations documents for deployment or recovery.
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
6. **Keep plans apart from what works.** Planned (accepted), proposed (an
   idea), blocked and deferred work lives in the
   [roadmap](docs/roadmap/roadmap.md) and is never described as operational.
   When planned work is built, changed or deferred, update its roadmap row in
   the same change. Research and audit recommendations are not requirements
   until decided and written where they apply.
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
    A document added, moved or removed updates [the index](docs/index.md) and
    every link to it.
11. **Stay in scope.** Don't rewrite unrelated documents; keep what is useful.
    Look for an existing home before creating a file; a minor change needs no
    new document.
12. **Documentation is an acceptance criterion.** Implementation, its document,
    its feature-status row and its tests change together.
13. **Keep history.** Dated audits and research in `docs/audits/` and
    `docs/research/` keep their findings as written and are never deleted;
    their open items are tracked in [audits](docs/audits/index.md), the roadmap
    or known limitations. Superseded material goes to `docs/archive/`, linked
    to its replacement.
