# ADR 0017: Three ways to check a change, one runner, and staging by content digest

- **Status:** current, decided 2026-10-24. How to run them is
  [testing](../../development/testing.md#checking-a-change-and-releasing).
- **Context:** the suites run by hand on two databases, and CI has not run
  since the account's Actions budget stopped it. A change still needs to be
  seen running as it will in production, by several people at once, and the
  real payment, messaging and storage services need a way to be checked that
  cannot touch real customers or money.
- **Decision:**
  - **One runner** (`scripts/verify.mjs`) does the same checks here, on a
    staging machine and in CI, and writes what it tested: the commit, whether
    the tree was dirty, a digest of the exact content, each step's result. A
    step it could not run is reported blocked, never passed.
  - **Images by content digest.** The staging image is tagged and labelled
    with the digest of the source it was built from (tracked files,
    uncommitted changes, untracked files), built once and reused; a stale
    image is refused. No credential goes into the image or its build cache.
  - **Every resource a deployment makes carries its id and expiry**, and only
    resources carrying them are ever removed; teardown checks nothing is
    left. Tags are bookkeeping, not a security boundary: remote staging runs
    under a separate DigitalOcean team with a token scoped to droplets, tags
    and registry read, and refuses to spend until a cost is approved and
    capped.
  - **Synthetic data only**, made through the app where it has a way in. No
    production database is copied into staging or kept as a fixture.
  - **Real services are checked by a harness that refuses live credentials**
    and reports PASS, FAIL, PARTIAL or BLOCKED with what is missing; a
    service is live-verified only when its own run passes.
  - **Acceptance scenarios** drive several people's browsers through the real
    pages, with a screenshot of every step and a video and trace per person,
    runnable one at a time, against the build or a deployment.
- **Consequences:** a release can be tried end to end without a cloud
  account or a CI runner; remote staging and the real-service checks wait on
  credentials, and say so rather than passing.
