# ADR 0024: Supporting documents scanned before release; retention by configured purpose

- **Status:** current, decided 2026-10-26 by the product owner. Amended twice on 27 October 2026: fail closed, and clamd started on demand on the 2 GB Droplet (see [Changes](#changes)). Builds on
  [ADR 0021](0021-approval-retention-and-pdf-documents.md), whose structural
  checks, purposes and holds all stand; this record replaces its
  "not malware scanning" consequence and its fixed retention bounds. The rules
  people meet are in [security](../security.md#malware-scanning),
  [privacy](../privacy.md#applications-to-be-approved-for-an-activity),
  [backups](../../operations/backups.md#after-a-restore) and
  [deployment](../../operations/deployment.md#the-malware-scanner).
- **Context:** supporting documents (certificates, as PDFs or photos) were
  checked for their format and for the PDF features attacks use, but not
  scanned for malware, and a reviewer opens them on their own machine. The
  owner decided that they must be scanned, by a maintained open-source engine
  that fits the deployment (one DigitalOcean Droplet; Ubuntu 24.04, systemd,
  the app, Postgres and Caddy on it; the Docker image is used for staging)
  without a paid API. The owner also provisionally accepted 90 days after the
  final decision for documents and 365 days after final closure for closed
  application records as **product-policy defaults, not legal requirements**,
  subject to Malaysian and Singaporean legal review, and asked that they be
  configurable per install without country assumptions, shown as provisional
  until reviewed, and that a restore can never bring back for good what
  retention or erasure removed.

## Decision: scanning

- **Engine: ClamAV's daemon, clamd**, reached over TCP with its `INSTREAM`
  protocol (no npm dependency), behind one small interface
  (`src/lib/document-scanner.ts`) so another engine can replace it.
- **Lifecycle:** receive → size and count limits → format checked from the
  bytes (every ADR 0021 check) → stored in quarantine in the database
  (`pending`) → scanned by the server's own call → result recorded (status,
  engine and signature version, signature found, SHA-256 of the bytes
  scanned) → released (`clean`) only when the scan passed; `rejected` when it
  found something (bytes wiped at once, the fact kept); `failed` after a
  bounded number of tries; what is left of either removed after the install's
  quarantine period (7 days by default), unless a hold keeps the application
  and unless it failed only for want of a scanner (below). The fewest
  meaningful states: `pending`, `clean`, `rejected` and `failed`, a failure
  saying why (`scanner_unavailable` or `unscannable`).
- **Unavailable, timed out or inconclusive:** never clean; never downloadable
  or openable by anybody; an approval (or in-person step) that needs the
  document is refused while no document is released or one is still pending;
  the try is recorded and repeated after 1, 5, 30, 120, 360 and 720 minutes,
  seven tries in all over about 20 hours, then `failed`. A stream over the
  scanner's own size limit fails at once.
- **Two kinds of failure.** When the last try found no scanner (none
  configured, no connection, or a timeout or unreadable answer from a scanner
  that then does not answer at all), the document is `failed` with
  `scanner_unavailable`: kept, never released, never removed for that, and
  put back in quarantine automatically, within a minute, once a scanner
  answers. When a working scanner could not scan it, or its bytes no longer
  match their recorded hash, it is `unscannable`: terminal, and the
  quarantine period applies.
- **Safe retries.** The platform owner may have a failed document scanned
  again, with a reason: only while its bytes are there and their SHA-256
  matches the one recorded when they were checked (else a new upload is
  needed, and the document becomes `unscannable`), at most three times per
  document. A retry puts the same bytes back in quarantine (the one way back
  from a settled status the database allows, and only with the bytes
  intact); it never changes them and never releases the document. A retry of
  a document already waiting does nothing more. Every request, refused or
  not, is recorded with who, when, why and, once the scan settles, its
  outcome. Venue staff cannot retry: the scanner is the platform's to run,
  and the venue's remedy is to ask the applicant for another file.
- **Only the server releases a document.** No route takes a scan status. A
  scan claims the document first, so concurrent or repeated scans scan it
  once, and a result is written only while it is pending; the database refuses
  a clean status without a recorded scan of exactly the stored bytes, any
  change to a settled status but a failed document's return to quarantine
  with its bytes intact, any change to stored bytes but a rejected
  document's wipe, and any change to the recorded hash (migrations 0142 and
  0159).
- **Fail closed, no opt-out** (amended 27 October 2026). Supporting
  documents are safety and guardian application documents: none is released
  without a scan that passed, and there is no operator setting that releases
  or takes them unscanned (`MYSENAM_DOCUMENT_SCAN=off` is withdrawn and
  ignored, with a start-up warning). Exempting a lower-risk class of document
  would be a separate, documented platform-level policy, never a venue
  toggle; **there is none today**.
- **No scanner configured: documents are taken into quarantine**
  (`pending`), never released, and wait there until a scanner is configured
  and passes them; an application that needs one cannot be approved
  meanwhile, while applications without documents, and in-person steps,
  carry on. Chosen over refusing uploads because it serves both of the
  owner's aims: nothing a customer sent is lost (their application stands,
  and need not be made again once a scanner exists), and nothing is released
  unscanned. The cost, bytes held unscanned for a while, is bounded by the
  upload limits and by the application's own retention, and the owners are
  told hourly while documents wait. A production start warns.
- **Documents from before scanning** (stored before migration 0142, or taken
  unscanned under the withdrawn opt-out) are marked (`legacy_reason`), never
  treated as clean, kept until a scanner passes them, and removed only by
  their own retention, never because no scanner was there. Every removal is
  recorded with its rule (retention, quarantine or erasure).
- **Health:** the owner's panel shows reachability, engine, signature date and
  age, documents by state (waiting for a scan, waiting for a scanner,
  refused, unscannable), where legacy documents stand, and the failed
  documents with their retries and the action to scan one again; the
  scheduler alerts hourly (`document-scanner`) on an unreachable scanner,
  none configured while documents wait, signatures over 48 hours old or of
  unknown age, a backlog over an hour, documents waiting for a scanner, or
  unscannable ones. `/api/health` stays thin.
- **Where clamd runs** (amended 27 October 2026). Three deployment modes,
  every guarantee above the same in each: **on demand**, the default for the
  2 GB Droplet, where the app starts clamd itself as a child process when
  documents wait and no scanner answers, lets the quarantine and retry
  pipeline scan them, and stops it after an idle period with nothing waiting
  (`src/lib/clamd-on-demand.ts`); **always on**, clamd as a service, for 4 GB
  and more or a separate scanner machine; **none**, documents waiting. On
  demand: one clamd per machine (the scheduler's lease, and a lock file
  naming the app process, its clamd and the boot); started only while
  `MemAvailable` is above a threshold (1,200 MiB by default) and freshclam is
  not running, and freshclam, run from a timer, never while clamd is up
  (each marks before it looks, so the two never overlap); a start must
  answer PING within a bound or is killed and retried after a growing pause;
  a crash is recorded, its document stays pending; the owners are told of a
  failed start or crash at once, and of a start held back for 30 minutes;
  children are waited for and stopped with the app. Nothing is ever
  released because clamd could not be started. Health tells a clamd stopped
  on purpose from one that is down, reads the signatures' date from disk
  while it is stopped, and reports the last start, its load time and peak
  resident memory (`VmHWM`), and the last failure.
- **What a scan means:** no known signature matched; never that a file is
  harmless. Scanning supplements the structural checks and replaces none;
  nothing is rendered or previewed on the server; logs name a document's
  number and the signature, never contents or the applicant.

### The engines compared

Weighed for one 2–4 GB Droplet, no paid API, and personal data that must not
leave the install's country by default (AGENTS.md).

| | ClamAV daemon (clamd) — **chosen** | ClamAV per file (`clamscan`) | YARA with community rules | A public or paid scanning API | Proprietary engines' Linux editions |
| --- | --- | --- | --- | --- | --- |
| Runtime memory | Upwards of 1.2 GiB to load the signatures; 3 GiB minimum, 4 GiB preferred for the machine (ClamAV's documentation [1]). Measured 27 October 2026 with the official signatures: 969 MiB resident once loaded, 1,038 MiB peak through a reload in place; freshclam about 700 MiB at its peak with `TestDatabases yes`, about 320 MiB with `no` | The same signatures loaded for every scan: the same peak, each time | Small: only the rules loaded | None locally | Varies; not measured |
| Footprint and storage | Signature database a few hundred MB; the official container with it about 300 MB compressed, 456 MB uncompressed [1] | As clamd | Small | None | Varies |
| Signature updates | freshclam, from ClamAV's mirrors, checked hourly; clamd reloads by itself (in place with `ConcurrentDatabaseReload no`, which pauses scans instead of doubling memory [1]) | freshclam | No maintained general malware feed of ClamAV's breadth comes with it: rules to curate ourselves | The provider's | Usually a paid subscription |
| Start-up | Loads the database once, at start and on reload (the container allows up to 30 minutes by default [1]; measured: 15.5 s to load the official signatures in the development container) | Loads the database on every scan: far too slow per document | Fast | — | — |
| Scan latency | A document streamed from memory; measured with the official signatures: about 6 ms for a small PDF or the EICAR file, about 0.5 s for 5 MiB of random bytes | Dominated by loading the database | Fast | A network round trip, and a queue | — |
| Deployment | Ubuntu packages (`clamav-daemon`, `clamav-freshclam`) under systemd, or the official container; TCP on the loopback | A binary per call | A library or binary | An account and a key | Licence terms for servers |
| Failure and recovery | systemd restarts it; the app retries on a schedule; it holds no data of ours | No daemon to fail | — | Outages outside our control | — |
| Maintenance and licence | Maintained (Cisco Talos), GPL-2.0, free | As clamd | Maintained, BSD-3; the rules are the work | — | Not open source |
| Personal data | Stays on the machine | Stays | Stays | **Sent to a third party**, often abroad, and public services share uploads with their subscribers: refused | Stays |

Chosen: clamd, the only option that is maintained, open source, free and
broad without sending documents anywhere, at the cost of its memory. YARA
remains a possible complement for PDF heuristics, not a replacement.

[1] ClamAV documentation, *Docker*: <https://docs.clamav.net/manual/Installing/Docker.html> (memory, `ConcurrentDatabaseReload`, image sizes, `CLAMD_STARTUP_TIMEOUT`), read 2026-10-26.
Update frequency: ClamAV documentation, *Configuration*: <https://docs.clamav.net/manual/Usage/Configuration.html>.

### Consequences for the deployment

- **The 2 GB Droplet, with clamd on demand, is the recommendation**
  (amended 27 October 2026: the owner did not approve the 4 GB Droplet,
  USD 12 a month more, and asked that scanning use compute only when
  necessary). Measured in the development container with the official
  signatures (one container's figures, not a Droplet's): the production app
  about 334 MiB (proportional set size), Postgres about 100 MiB at rest,
  clamd about 970 MiB resident once loaded (1,038 MiB through a reload in
  place), freshclam about 700 MiB at its peak with `TestDatabases yes` and
  about 310–320 MiB with `no`. App, Postgres and clamd come to about
  1.45 GiB: a 2 GB Droplet holds that only if clamd is not resident while
  freshclam runs, nor while nothing waits, which is what the on-demand mode
  ensures. Started on demand by the app with the official signatures, clamd
  answered after 10.3–10.6 s, a document sent while it was stopped was
  released 10.4–10.7 s after it arrived when the scheduler's tick came at
  once (up to a minute more in production), and clamd's peak resident memory
  was 972 MiB. The cost is that delay for the first document after an idle
  period, and the swap file kept as a safety net, not capacity.
- **Always on** stays supported, and is the kit's default from 3.5 GB of
  memory: freshclam tests before clamd reloads, so about 1.7 GiB for both at
  the worst moment, which a 4 GB machine holds. The kit keeps freshclam's
  `TestDatabases yes` in both modes: `no` would save about 380 MiB at that
  peak, and freshclam would still verify each database's digital signature,
  but a database the engine cannot load would reach clamd untested, and a
  failed load would hold documents back until fixed. On demand it fits,
  since freshclam never runs beside clamd.
- `setup.sh --scanner=none` (formerly `--no-scanner`) leaves the scanner
  out, and documents then wait in quarantine, unopened, until one is set up.
- Documents stored before migration 0142 start `pending` and are scanned;
  without a scanner they wait, kept, until one is (migration 0159).

## Decision: retention

- **Purpose-based, as ADR 0021 set it**: the eligibility (the sign-off) apart
  from the application; documents only while a decision, review or appeal
  needs them; the record a set time after closing; holds for actual legal,
  safety, dispute or incident reasons.
- **Configurable per install**, without country assumptions
  (`retention_policy`, migration 0143): the platform owner sets documents
  (7–365 days after the decision), the review window (up to the documents'
  period), a closed application (30–2190 days) and the quarantine period for
  refused or unscannable documents (1–30 days). The defaults are the owner's
  provisional 90, 30, 365 and 7. **An activity may keep less, never more**
  than the install; the retention run never applies more than the install's
  period whatever an activity stores.
- **Provisional until reviewed**, as the deposit-tax review is: a review is
  recorded with who reviewed (name and firm), the day and the basis; until
  then the dashboard, the activity settings and the privacy notice say the
  periods are provisional; any change lapses it; every change and review is
  kept, never pruned. The app never states that the periods satisfy either
  country's PDPA; the open questions are listed for a lawyer in
  [privacy](../privacy.md#open-questions-for-professional-review-retention-and-documents).
- **Cleanup covers** documents (released, waiting, refused, failed), the
  application's record and history, the bare facts and access records after
  their own period, and documents left without an application. Documents and
  a guardian's name and declaration on an application made for a minor, or by
  an adult for somebody they manage (ADR 0022), go by the same rules as the
  application they belong to. There are no temporary uploads:
  everything is checked and scanned in memory, and the tests assert no
  temporary file is written.
- **A restore cannot bring back for good what was removed**, proportionately:
  every erasure is recorded in an **erasure ledger** (an account's number and
  creation moment, no contact details) in the database and in a file beside
  the backup sets, which a restore does not overwrite. The restore script
  marks the database; the app, at its next start and before it serves, erases
  again every account in the ledger that came back with the same creation
  moment, and runs the retention policy again. A restore done by hand is
  caught by ledger entries the database lacks. Copies inside backups stay
  until those backups expire, and the privacy notice says so.

## Alternatives considered

- **Accepting documents unscanned when no scanner is configured**, marked or
  not: refused. It was first kept as an explicit, visible operator opt-out;
  withdrawn on 27 October 2026, because the documents are safety and guardian
  documents and a venue or operator toggle should not decide that.
- **Refusing uploads while no scanner is configured** (this record's first
  choice): fails closed, but loses what the customer sent and their
  application with it; replaced by taking documents into quarantine.
- **Removing documents whose tries ran out with no scanner after the
  quarantine period**: would delete documents, legacy ones included, for want
  of infrastructure rather than by their retention; replaced by keeping them
  waiting and putting them back in quarantine when a scanner answers.
- **Scanning before storing, in the request:** a slow or absent scanner would
  fail the customer's whole application; quarantine with retries keeps the
  application and holds only the document.
- **Keeping documents in object storage with the scanner reading them
  there:** a second store to secure, scan and delete, for no gain at these
  sizes (ADR 0021).
- **Re-running only retention after a restore**, with no ledger: retention
  does not know who was erased, so erased accounts would come back.
- **Rewriting backup sets to remove erased people:** breaks their signatures
  and Object Lock, and costs far more than re-applying erasures on restore.
- **Copying the ledger off-site with each set:** would cover losing the
  server, but adds a second signed, encrypted object per set; not built now,
  and recorded as a limitation.
- **Resizing to the 4 GB Droplet with clamd always on:** the simplest, and
  documents released within seconds; not approved by the owner (USD 12 a
  month more). Kept as the always-on mode for any install that has the
  memory.
- **systemd socket activation with a stop timer** (clamd started on the
  first connection; the research note's option 0c): the start would happen
  inside a scan's connection, which would wait for the whole load; the app
  could not hold a start back for want of memory or while freshclam runs,
  nor tell a clamd stopped on purpose from one that is down. Replaced by the
  app starting and stopping clamd itself.
- **Scanning on separately allocated compute, or with a cloud scanning
  service** (the [research note](../../research/2026-10-27-document-storage-and-scanning-costs.md)):
  saves at most a few dollars a month for a new account, a token that can
  start machines, a second store or a paid, proprietary engine; not chosen.

## Verification

- Mocked scanner and stand-in sockets: every failure path, repeated and
  concurrent scans, forged results, retries exhausted, the opt-out, the
  refusal without a scanner, tenant isolation in each state, health and
  alerts (`tests/document-scanning.test.ts`).
- The real engine, clamd 1.5.4 from Ubuntu's packages, in the development
  container (`tests/document-scanning-engine.test.ts`): with a **locally
  generated test signature** for the EICAR string when the test starts its
  own clamd, and on 27 October 2026 also against a clamd loaded with
  **ClamAV's official signatures** (daily 28165, main 63, bytecode 339,
  fetched by freshclam over HTTPS with TLS verification on), which found the
  EICAR test file as `Eicar-Test-Signature`, refused it through the
  document lifecycle, released a plain PDF through the app, and scanned a
  document that had waited for a scanner once it was back. The official
  signatures find the EICAR file only as its standard defines it (the
  string at the start), not inside a PDF. freshclam's earlier failure there
  was the container's CA bundle sitting in a folder its `clamav` user could
  not read, not a network block. Signature updates over days, and the kit's
  set-up and memory on a real Droplet, are **not verified**.
- Fail closed, retries, legacy documents and recovery: stand-in scanner
  tests in `tests/document-scanning.test.ts` (no opt-out for a safety
  document and a guardian's document for a child; uploads with no scanner;
  retries authorised, integrity-checked, bounded, idempotent and recorded;
  automatic return to quarantine; legacy documents kept until their own
  deadline, recorded as retention; alerts) and the migration in
  `tests/document-scan-migration.test.ts`, on PGlite and Postgres.
- clamd on demand: a stand-in clamd (a Node process speaking enough of the
  protocol, told to hang, crash mid-scan or ignore SIGTERM) for every guard
  path, in `tests/clamd-on-demand.test.ts`: too little memory and freshclam
  running keep documents waiting and tell the owners; a hung start is killed
  (SIGKILL after an ignored SIGTERM, no zombie) and retried after a pause; a
  crash mid-scan leaves the document pending; an idle clamd stops; concurrent
  ticks and a second process start one clamd, and a clamd left by a dead app
  process is stopped by its pid; the app's shutdown stops it (a separate Node
  process, with and without a handler of its own); the kit's `freshclam.sh`
  and the app take turns. The real engine started on demand with the
  official signatures, in the development container:
  `tests/clamd-on-demand-engine.test.ts` (skipped, saying why, without
  `clamd` or the signatures). On PGlite and Postgres. The kit's set-up on a
  real Droplet, its memory there and the freshclam timer are **not
  verified**.
- Retention and restore: `tests/retention-policy.test.ts`,
  `tests/approval-retention.test.ts`, and the restore round trip in
  `tests/backup-scripts.test.ts`.

## Changes

- **27 October 2026.** By the product owner's decision: the operator
  opt-out (`MYSENAM_DOCUMENT_SCAN=off`, `not_scanned`) is withdrawn for
  supporting documents, which are all safety or guardian application
  documents; any exemption for a lower-risk class would be a separate
  platform-level policy, and there is none. With no scanner configured,
  documents are taken into quarantine instead of refused. A failure says
  why: waiting for a scanner (kept, put back in quarantine automatically
  once one answers) or unscannable (terminal). The platform owner may have a
  failed document scanned again, integrity-checked and bounded, with every
  request recorded. Documents from before scanning are marked, never treated
  as clean, and removed only by their own retention; every removal records
  its rule. Official signatures obtained and measured in the development
  container; the kit keeps `TestDatabases yes`. Migrations 0159–0160.
- **27 October 2026, later.** The owner did not approve the 4 GB Droplet and
  asked that scanning use compute only when necessary, every guarantee
  holding. Added the on-demand mode (the app starts clamd while documents
  wait and stops it when idle, behind a memory guard, never beside
  freshclam), the kit's `--scanner=on-demand|always-on|none` with a freshclam
  timer, health and alerts for it, and the measurements; the recommendation
  is now the 2 GB Droplet with clamd on demand. No migration.
