# ADR 0024: Supporting documents scanned before release; retention by configured purpose

- **Status:** current, decided 2026-10-26 by the product owner. Builds on
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
  quarantine period (7 days by default), unless a hold keeps the application.
  The fewest meaningful states: `pending`, `clean`, `rejected`, `failed`, and
  `not_scanned` only under the explicit opt-out below.
- **Unavailable, timed out or inconclusive:** never clean; never downloadable
  or openable by anybody; an approval (or in-person step) that needs the
  document is refused while no document is released or one is still pending;
  the try is recorded and repeated after 1, 5, 30, 120, 360 and 720 minutes,
  seven tries in all over about 20 hours, then `failed`. A stream over the
  scanner's own size limit fails at once.
- **Only the server releases a document.** No route takes a scan status. A
  scan claims the document first, so concurrent or repeated scans scan it
  once, and a result is written only while it is pending; the database refuses
  a clean status without a recorded scan of exactly the stored bytes, any
  change to a settled status, and any change to stored bytes but a rejected
  document's wipe (migration 0142).
- **No scanner configured: documents are refused** (`SCAN_UNAVAILABLE`,
  nothing of the application kept), never accepted as if scanned. An operator
  may opt out explicitly (`MYSENAM_DOCUMENT_SCAN=off`): documents are then
  stored `not_scanned` and shown as *not checked for malware* to the applicant
  and every reviewer, and may be opened and approved. Refusing by default
  keeps the safe path the one that needs no decision; the opt-out exists for
  development and for an install that knowingly cannot run clamd, and makes
  that choice visible on every document rather than silent. A configured
  scanner always wins over it. A production start warns about either.
- **Health:** the owner's panel shows reachability, engine, signature date and
  age, and documents by state; the scheduler alerts hourly
  (`document-scanner`) on an unreachable scanner, signatures over 48 hours old
  or of unknown age, a backlog over an hour, failures, or scanning off or
  missing while documents arrive. `/api/health` stays thin.
- **What a scan means:** no known signature matched; never that a file is
  harmless. Scanning supplements the structural checks and replaces none;
  nothing is rendered or previewed on the server; logs name a document's
  number and the signature, never contents or the applicant.

### The engines compared

Weighed for one 2–4 GB Droplet, no paid API, and personal data that must not
leave the install's country by default (AGENTS.md).

| | ClamAV daemon (clamd) — **chosen** | ClamAV per file (`clamscan`) | YARA with community rules | A public or paid scanning API | Proprietary engines' Linux editions |
| --- | --- | --- | --- | --- | --- |
| Runtime memory | Upwards of 1.2 GiB to load the signatures; 3 GiB minimum, 4 GiB preferred for the machine (ClamAV's documentation [1]) | The same signatures loaded for every scan: the same peak, each time | Small: only the rules loaded | None locally | Varies; not measured |
| Footprint and storage | Signature database a few hundred MB; the official container with it about 300 MB compressed, 456 MB uncompressed [1] | As clamd | Small | None | Varies |
| Signature updates | freshclam, from ClamAV's mirrors, checked hourly; clamd reloads by itself (in place with `ConcurrentDatabaseReload no`, which pauses scans instead of doubling memory [1]) | freshclam | No maintained general malware feed of ClamAV's breadth comes with it: rules to curate ourselves | The provider's | Usually a paid subscription |
| Start-up | Loads the database once, at start and on reload (the container allows up to 30 minutes by default [1]; not measured here with the official signatures) | Loads the database on every scan: far too slow per document | Fast | — | — |
| Scan latency | A document streamed from memory; measured here only against a one-signature test database | Dominated by loading the database | Fast | A network round trip, and a queue | — |
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

- The 2 GB Droplet is too small with clamd beside the app (about 250 MB) and
  Postgres (about 300 MB): the kit recommends the 4 GB Droplet, USD 24 a
  month instead of USD 12. Nothing was provisioned; resizing is the owner's
  decision. `setup.sh --no-scanner` keeps the 2 GB machine, and documents are
  then refused (or taken unscanned by the opt-out).
- Documents stored before migration 0142 start `pending` and are scanned;
  without a scanner they fail after their tries.

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
  not: refused as the default, because the safe path should not depend on a
  setting being made; kept only as an explicit, visible opt-out.
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

## Verification

- Mocked scanner and stand-in sockets: every failure path, repeated and
  concurrent scans, forged results, retries exhausted, the opt-out, the
  refusal without a scanner, tenant isolation in each state, health and
  alerts (`tests/document-scanning.test.ts`).
- The real engine, clamd 1.5.4 from Ubuntu's packages, in the development
  container, with the EICAR test file
  (`tests/document-scanning-engine.test.ts`): freshclam could not fetch the
  official signatures from that container, so the test uses a **locally
  generated test signature** for the EICAR string. The official signatures,
  their updates, memory, start-up time and scan latency with them, and the
  kit's set-up on a real Droplet are **not verified**.
- Retention and restore: `tests/retention-policy.test.ts`,
  `tests/approval-retention.test.ts`, and the restore round trip in
  `tests/backup-scripts.test.ts`.
