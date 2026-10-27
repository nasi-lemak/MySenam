# Where to store and scan supporting documents, and at what cost (retrieved 2026-10-27)

> **Research record, 27 October 2026.** Not maintained: prices are as read
> that day and will move. It answers one question from the owner and ends in
> a recommendation, which is **not a decision**: nothing here changes how
> MySenam behaves. What is decided and built is in
> [ADR 0024](../architecture/decisions/0024-documents-scanned-before-release-retention-by-purpose.md)
> and [deployment: the malware scanner](../operations/deployment.md#the-malware-scanner).
> Nothing was signed up for, provisioned or tested against a real service.

## The question

The owner asked whether MySenam should "keep the core booking server small,
use private object storage for uploads, perform cheap preliminary validation
and scan asynchronously using independently allocated compute only when
necessary", rather than add ClamAV to the booking server, which the
deployment kit says needs the 4 GB Droplet (+US$12 a month).

Labels, as in the [go-to-market research](go-to-market/index.md):

- **VERIFIED**: read on the provider's own page, documentation or price list
  (or in MySenam's code) on 2026-10-27.
- **REPORTED**: from a third party or a search summary; not cross-checked.
- **ESTIMATE / ASSUMPTION / UNKNOWN**: the researcher's model or inference, or
  nothing found.

Prices are in US dollars, excluding tax. "Permanent" free allowances are those
the provider describes as monthly with no end date; time-limited ones are
called out.

## Answer in one paragraph

At 100 to 2,000 uploads a month, everything the owner's architecture would
save is **US$5 to 11 a month**, and it needs a second store, a new upload
flow, scanner orchestration, signature caching and new failure modes, all of
which ADR 0024's built and tested design does not have. The structural checks
MySenam runs (images redrawn as WebP with sharp, PDFs inflated and inspected)
need the whole file on a Node server anyway, so direct-to-bucket uploads and
edge validation remove almost no work from the booking server. The simplest
secure option wins: **keep documents in Postgres and clamd on the app
Droplet, and resize to the 4 GB Droplet**. What does change the picture is
backups, not scanning: at around 2,000 uploads a month the documents make
every nightly dump about 10 GB and the 14 local dumps no longer fit the
4 GB Droplet's disk. That is the point to move document **bytes** (not the
scanner) to a private bucket in the same region as the Droplet. If the owner
will not run clamd on the booking server at all, the cheapest and least
operated fallback is Amazon S3 in Singapore or Malaysia with GuardDuty
Malware Protection for S3 (under US$1 a month at these volumes), which
needs the owner to revisit ADR 0024's "open-source engine, no paid API".

## What MySenam does today (read in the code, VERIFIED)

- One DigitalOcean Droplet in Singapore (SGP1) runs Postgres, the app and
  Caddy; the kit installs `clamav-daemon` and `clamav-freshclam`, listening on
  the loopback, with `ConcurrentDatabaseReload no`, `StreamMaxLength 12M`,
  `MaxThreads 2`, and 2 GB of swap
  ([kit](../../deploy/digitalocean/README.md#what-it-costs),
  [`setup.sh`](../../deploy/digitalocean/setup.sh)). It recommends the 4 GB /
  2 vCPU Droplet when the scanner is installed.
- Up to 3 documents per application, each at most 10 MB; PDFs of at most 20
  pages with an inflation budget of 40 MB; images redrawn as WebP (at most
  2000 px) with sharp; PDFs kept as sent after their checks
  ([`approval-documents.ts`](../../src/lib/approval-documents.ts),
  [`approvals.ts`](../../src/lib/approvals.ts)).
- Documents are stored in Postgres in quarantine (`pending`), scanned by the
  server over clamd's `INSTREAM` protocol from memory, released only on a
  clean result bound to the SHA-256 of the stored bytes, retried on a
  schedule, and watched for signature age and backlog
  ([`document-scanner.ts`](../../src/lib/document-scanner.ts),
  [`document-scanning.ts`](../../src/lib/document-scanning.ts)).
- Nightly `pg_dump` sets, 14 kept on the server by default, copied off-site
  (Backblaze B2 preferred, US West, encrypted on the server;
  [backups](../operations/backups.md),
  [ADR 0015](../architecture/decisions/0015-backblaze-b2-preferred-signed-backup-sets.md)).
  Documents in Postgres are in every one of them.
- The app already signs S3 requests itself (SigV4 in `offsite.ts`, reused by
  the venue photo bucket in `photo-store.ts`); it has no presigned-URL code.

## Prices and limits read

All retrieved **2026-10-27**.

| # | Item | Figure | Label | Source |
|---|---|---|---|---|
| 1 | DigitalOcean Basic Droplets | 2 GiB/1 vCPU/50 GiB **$12/mo** ($0.01786/h); 2 GiB/2 vCPU $18; **4 GiB/2 vCPU/80 GiB $24/mo** ($0.03571/h); 4,000 GiB transfer on the 4 GiB plan. No Basic plan between 2 and 4 GiB is listed | VERIFIED | [DO Droplet pricing](https://www.digitalocean.com/pricing/droplets) |
| 2 | Droplet billing | Per second from 1 January 2026, minimum 60 seconds or $0.01, whichever is higher; capped at 672 hours a month; **powered-off Droplets are still billed**: only destroying one stops billing | VERIFIED | [DO Droplet pricing docs](https://docs.digitalocean.com/products/droplets/details/pricing/) |
| 3 | Droplet snapshots; block volumes | Snapshots $0.06/GB-month; volumes $0.10/GiB-month | VERIFIED | [DO Droplet pricing](https://www.digitalocean.com/pricing/droplets), [DO volumes](https://www.digitalocean.com/pricing/volumes) |
| 4 | DigitalOcean Functions | 128 MB to **1 GB** of memory, 15 minutes, 48 MB built function | VERIFIED | [DO Functions limits](https://docs.digitalocean.com/products/functions/details/limits/) |
| 5 | DigitalOcean Spaces | $5/mo for 250 GiB and 1 TiB out, then $0.02/GiB and $0.01/GiB; available in **SGP1** | VERIFIED | [Spaces pricing](https://www.digitalocean.com/pricing/spaces-object-storage), [Spaces availability](https://docs.digitalocean.com/products/spaces/details/availability/) |
| 6 | Spaces presigned PUT, per-bucket keys | Presigned PUTs work, Content-Type must match the signature; scoped per-bucket keys not confirmed | REPORTED / UNKNOWN | [DO community threads](https://www.digitalocean.com/community/questions/can-i-upload-to-spaces-using-a-signed-url) |
| 7 | Backblaze B2 storage | **$6.95/TB-month** (was $6 until 1 May 2026); first 10 GB always free | VERIFIED | [B2 pricing](https://www.backblaze.com/cloud-storage/pricing), [Backblaze announcement, 17 March 2026](https://www.backblaze.com/blog/?p=112830) |
| 8 | B2 transactions and egress | Class A, B and C calls **free** since 1 May 2026 (Event Notifications excepted; the pricing page still lists Class D at $0.004 per 10,000 beyond 2,500 a day); egress free up to 3× average storage, then $0.01/GB; free without limit to partners including Cloudflare | VERIFIED | Same as #7 |
| 9 | B2 regions | US East, US West, EU Central, CA East: **none in Asia**; region fixed at sign-up | VERIFIED | [B2 data regions](https://www.backblaze.com/docs/cloud-storage-data-regions) |
| 10 | B2 S3 API uploads | Presigned upload and download URLs supported; **browser POST uploads (POST policy) not supported**; PutObject takes Object Lock and SSE headers; Content-MD5 and `x-amz-checksum-*` not documented on the page | VERIFIED | [B2 S3-compatible API](https://www.backblaze.com/docs/cloud-storage-s3-compatible-api), [B2 PutObject](https://www.backblaze.com/apidocs/s3-put-object) |
| 11 | B2 and SDK checksum headers | Requests carrying `x-amz-sdk-checksum-algorithm` rejected with HTTP 400; Content-MD5 used instead | REPORTED | [Percona forum](https://forums.percona.com/t/unsupported-header-x-amz-checksum-algorithm-breaks-pitr-backup/24758) |
| 12 | Cloudflare R2 | $0.015/GB-month; Class A $4.50/M, Class B $0.36/M; free 10 GB-month, 1 M Class A, 10 M Class B a month (no end date stated); egress free | VERIFIED | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| 13 | R2 location | Location hints (`apac` among them) are "best effort and not a guarantee"; jurisdictions only EU, FedRAMP and US; **nothing guarantees Singapore or Malaysia** | VERIFIED | [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/) |
| 14 | R2 presigned URLs | PUT supported, expiry 1 s to 7 days, Content-Type can be signed; POST form uploads not supported | VERIFIED | [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) |
| 15 | R2 event notifications | `object-create` / `object-delete` to a Queue; needs a queue and a consumer | VERIFIED | [R2 event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/) |
| 16 | Workers limits | **128 MB** memory per isolate; CPU 10 ms (Free), up to 5 min (Paid); request body 100 MB on Free/Pro | VERIFIED | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| 17 | Cloudflare Queues | $0.40 per million 64 KB operations; Free plan 10,000 a day, Paid 1 M a month included | VERIFIED | [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) |
| 18 | Cloudflare Containers | GA 13 April 2026. Instance `standard-1`: 1/2 vCPU, **4 GiB**, 8 GB disk (`basic` is 1 GiB). $0.000020/vCPU-s (active CPU only), $0.0000025/GiB-s and $0.00000007/GB-s (provisioned while running), 10 ms granularity; included with the **$5/mo Workers Paid** plan: 375 vCPU-min, 25 GiB-h, 200 GB-h | VERIFIED | [Containers pricing](https://developers.cloudflare.com/containers/pricing/), [GA changelog](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/) |
| 19 | Fly.io Machines | Billed per second while started; shared-cpu-1x 1 GB $6.70/30 days, additional RAM $6.00/GB/30 days, shared-cpu-2x 2 GB $13.39 (Ashburn base); Singapore (`sin`) multiplier 1.269; stopped Machines $0.15/GB-month of root filesystem; volumes $0.15/GB-month; no free allowance for new organisations (trial of 2 machine-hours or 7 days only) | VERIFIED | [Fly.io pricing](https://docs.fly.io/about/pricing) |
| 20 | Hetzner Cloud Singapore | From 15 June 2026: CPX12 $0.0288/h ($17.99/mo); **CPX22 $0.0497/h ($30.99/mo)**, excluding IPv4; billed per started hour, powered-off servers billed until deleted | VERIFIED | [Hetzner price adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), [Hetzner billing FAQ](https://docs.hetzner.com/cloud/billing/faq/) |
| 21 | Hetzner CPX22 size | 2 vCPU, 4 GB | REPORTED | [vpsbenchmarks](https://www.vpsbenchmarks.com/hosters/hetzner/plans/cpx22) |
| 22 | GitHub Actions | GitHub Free: 2,000 minutes a month for private repositories; Linux 2-core $0.006/min beyond | VERIFIED | [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) |
| 23 | GuardDuty Malware Protection for S3 | **Singapore: $0.135/GB scanned, $0.000323 per object; Malaysia: $0.11475/GB, $0.00027455 per object**; first 1 GB and 1,000 objects a month free in each Region (a monthly allowance, no end date; not a trial). Tagging, S3 requests and EventBridge billed separately. Usable without enabling GuardDuty | VERIFIED | AWS price list API, GuardDuty offer, ap-southeast-1 and ap-southeast-5 (published 2026-10-08), [GuardDuty pricing](https://aws.amazon.com/guardduty/pricing/), [Malware Protection for S3 pricing](https://docs.aws.amazon.com/guardduty/latest/ug/pricing-malware-protection-for-s3-guardduty.html) |
| 24 | GuardDuty behaviour | Scans each new object or new version in the bucket's own Region, in an isolated VPC; results to EventBridge and, optionally, an object tag (`NO_THREATS_FOUND`, `THREATS_FOUND`, `UNSUPPORTED`, `ACCESS_DENIED`, `FAILED`); at-least-once results; 100 GB maximum object; engine is AWS's own plus a third party's (Bitdefender), signatures updated every 15 minutes; scan latency not published | VERIFIED | [How it works](https://docs.aws.amazon.com/guardduty/latest/ug/how-malware-protection-for-s3-gdu-works.html), [scan results](https://docs.aws.amazon.com/guardduty/latest/ug/monitoring-malware-protection-s3-scans-gdu.html), [quotas](https://docs.aws.amazon.com/guardduty/latest/ug/malware-protection-s3-quotas-guardduty.html), [engine](https://docs.aws.amazon.com/guardduty/latest/ug/guardduty-malware-detection-scan-engine.html) |
| 25 | Amazon S3 Standard | Singapore $0.025/GB-month, PUT $0.005/1,000, GET $0.004/10,000; Malaysia $0.0225/GB-month, PUT $0.0045/1,000, GET $0.0036/10,000; tags $0.0065 per 10,000 a month; internet egress Singapore $0.12/GB after a free 100 GB a month across AWS | VERIFIED | AWS price list API, AmazonS3 and AWSDataTransfer offers (published 2026-10-15 and 2026-09-16); [S3 pricing](https://aws.amazon.com/s3/pricing/) |
| 26 | AWS Free Tier | Now credits-based: up to $200 of credits, free plan for 6 months: **time-limited**, not counted below | VERIFIED | [S3 pricing](https://aws.amazon.com/s3/pricing/) |
| 27 | EventBridge | AWS service events ingested free on the default bus; the price of S3 events opted in to EventBridge is not stated | VERIFIED / UNKNOWN | [EventBridge pricing](https://aws.amazon.com/eventbridge/pricing/) |
| 28 | ClamAV memory | "Upwards of 1.2 GiB" to load the signatures; a concurrent reload "upwards of 2.4 GiB" briefly; minimum 3 GiB, preferably 4 GiB for the machine; `CLAMD_STARTUP_TIMEOUT` default 1,800 s | VERIFIED | [ClamAV: Docker](https://docs.clamav.net/manual/Installing/Docker.html) |
| 29 | ClamAV signature download | Measured by HTTP HEAD on database.clamav.net: `main.cvd` 89.1 MB (16 Dec 2025), `daily.cvd` 23.4 MB (26 Oct 2026), `bytecode.cvd` 0.3 MB: **about 113 MB for a cold start** | VERIFIED (HEAD only, no download) | `https://database.clamav.net/` |
| 30 | freshclam limits | HTTP 429 when downloading "too quickly or too much"; an outdated engine checks at most 6 times a day; only freshclam and cvdupdate are supported, other downloads "may be rate limited, or blocked"; "try not to download the entire database set … on a regular basis"; share one signature volume between containers | VERIFIED | [freshclam FAQ](https://docs.clamav.net/faq/faq-freshclam.html), [ClamAV: Docker](https://docs.clamav.net/manual/Installing/Docker.html) |
| 31 | freshclam `TestDatabases` | Default yes: freshclam loads each new database into memory before it replaces the old one | REPORTED (man page) | [freshclam.conf(5)](https://man.archlinux.org/man/freshclam.conf.5.en) |
| 32 | clamd start-up time | No official or reputable measurement found; a 2026 tutorial reports about 1 GB RSS for ClamAV 1.4.3, without timing | UNKNOWN | [computingforgeeks](https://computingforgeeks.com/install-clamav-ubuntu-2604/) |

## Workload assumptions

These are the inputs to every figure below (ASSUMPTION unless stated).

- **Uploads:** 100, 500 and 2,000 a month; average 1.5 MB, a few at 10 MB.
  Monthly inflow 0.15, 0.75 and 3.0 GB. Images are redrawn as WebP of at most
  2000 px, which usually makes them smaller, so 1.5 MB is conservative.
- **Applications:** about 1.5 documents each, so about 67, 333 and 1,333
  applications a month, arriving one at a time (low concurrency).
- **Stored:** documents are kept until the decision plus the default 90 days
  (ADR 0024); with decisions in about two weeks, each document is held about
  3.5 months, so about **0.5, 2.6 and 10.5 GB** are stored at any time.
- **Reads:** each document read once to scan and about twice by reviewers.
- **On-demand scanner sessions:** one per burst of uploads, coalesced over
  15 minutes: about **60, 300 and 700 sessions** a month. A Droplet session
  is billed about 10 minutes (create, boot, signature update, clamd load,
  scan, a short idle, destroy); a Fly.io Machine or Cloudflare container
  session about 5 minutes (start from stopped). ESTIMATE: clamd's load time
  with the official signatures has not been measured (row 32).
- **Backups:** 14 local dumps and about 15 off-site sets (ADR 0015's 14-day
  lock plus the lifecycle rule); PDFs and WebP barely compress, so documents
  add their full size to each dump.

## The options

### Option 0: documents in Postgres, clamd on the app Droplet (built)

**0a. 4 GB Droplet (the kit's recommendation).** +$12.00 a month, flat
(row 1). Scans start within seconds of an upload; a hot clamd streams a 10 MB
document in seconds (ESTIMATE; measured here only against a test signature).
Nothing new to build; operations are `apt` updates and freshclam, already
installed, monitored and alerted on. The +$12 also doubles the vCPUs (helps
`next build` and `pg_dump`), and gives 80 GB of disk and 4,000 GiB of
transfer.

Peak memory deserves one check on a real Droplet: the kit sets
`ConcurrentDatabaseReload no` (so clamd never holds two copies), but freshclam's
default `TestDatabases yes` (row 31) loads each new database in the freshclam
process too, so for a minute after an update the machine may hold about
1.2 GiB (clamd) + about 1.2 GiB (freshclam's test) + about 0.55 GB (app and
Postgres) + the system: roughly 3.2 GiB of the 4 GiB plan's ~3.8 GiB
(ESTIMATE). It fits, with the 2 GB swap as a margin. Measuring it, and
`TestDatabases no` if needed, is cheaper than any architecture change.

**Backups are where Option 0 grows.** Every dump carries every stored
document:

| Uploads a month | Documents stored | 14 local dumps (documents only) | Off-site, about 15 sets | B2 cost of that ($6.95/TB) |
|---|---|---|---|---|
| 100 | ≈0.5 GB | ≈7 GB | ≈8 GB | ≈$0.00–0.06 |
| 500 | ≈2.6 GB | ≈37 GB | ≈39 GB | ≈$0.27 |
| 2,000 | ≈10.5 GB | **≈147 GB: does not fit the 80 GB disk** | ≈158 GB | ≈$1.10 |

At 2,000 uploads a month the operator would have to lower
`MYSENAM_BACKUP_KEEP` (to about 4, ≈42 GB), add a DigitalOcean volume
(150 GiB ≈ $15/mo, row 3), or move document bytes to a bucket. Nightly
off-site uploads would also be about 10 GB each from Singapore to the US, and
a restore would download about 10 GB more, lengthening recovery. At 100 and
500 a month none of this matters.

**0b. clamd on the 2 GB Droplet with swap.** $0 extra. Not recommended for
production: ClamAV documents 3 GiB as the minimum (row 28); clamd (≈1.2 GiB),
the app (≈250 MB), Postgres (≈300 MB) and the system need more than the
≈1.9 GiB usable, so the machine pages continuously and Postgres loses its
page cache; each signature update adds freshclam's test load; `next build`
during a deploy needs swap already. The kit's set-up warns on less than 3 GiB
for this reason.

**0c. clamd only while a document is pending, on the same Droplet.** $0
extra. clamd started on demand (the kit already uses systemd socket
activation, which starts clamd on the first connection) and stopped by a timer
once the queue is empty; freshclam still keeps signatures fresh (with
`TestDatabases no`). The 1.2 GiB peak is unchanged, only shorter: during a
batch the 2 GB machine swaps exactly as in 0b, and a batch that coincides with
a deploy or the nightly backup risks the out-of-memory killer. Each batch
waits for clamd to load (UNKNOWN, row 32; ESTIMATE 30 s to 2 min on one shared
vCPU). Health checks would have to tell "stopped on purpose" from "down", and
ADR 0024's hourly alert on an unreachable scanner would change. A workable
stop-gap below about 100 uploads a month, not a design to keep.

### Option A: Backblaze B2 document bucket, presigned uploads, on-demand scanner

**Storage and transfer** are almost free: ≈$0.00 / $0.02 / $0.07 a month
(beyond the 10 GB free if the account also holds the backups), no transaction
charges since May 2026, and scanner and reviewer reads (≈3× inflow) within
the free 3× egress (rows 7–8). A separate bucket and keys from the backups,
versioning on, a lifecycle rule for non-current versions, and keys limited to
the bucket and prefix are all available.

**But B2 has no region in Asia (row 9).** Documents (certificates, sometimes
of minors) would be stored in the US, Canada or the Netherlands **as
plaintext to Backblaze** (a browser upload cannot carry the server's
client-side encryption; SSE-B2 is Backblaze's key). That is a new transfer
abroad, which AGENTS.md says happens only by a declared and approved path,
never by default; the backup analysis in
[privacy](../architecture/privacy.md#backups-held-abroad) relies on
encryption with a key Backblaze never holds, which would not apply. This
alone makes B2 the wrong store for documents unless the owner decides
otherwise with legal advice.

**Presigned direct uploads gain little here:**

- B2 and R2 have no POST policy (rows 10, 14), so no
  `content-length-range`; size can be bound only by a signed `Content-Length`
  (enforcement by B2 not documented: UNKNOWN), and B2 reportedly rejects the
  SDK checksum headers (row 11). The server must therefore read the object
  back, check its size, and hash it itself.
- MySenam's checks need the whole file on a Node server: sharp redraws images
  (so an image becomes a new, server-made object, and the raw upload must be
  deleted), and PDFs are inflated up to 40 MB to look for active content. So
  every byte still passes through the booking server; direct upload saves
  only the inbound request (≤30 MB, against a 2,000–4,000 GiB transfer
  allowance) and adds CORS, an "awaiting upload" state, orphaned raw uploads
  and expiry handling.
- "Cheap preliminary validation" at the edge cannot do these checks: a Worker
  has 128 MB of memory and no sharp (row 16). The cheap checks (size, count,
  magic bytes, declared type) already run in the app before anything is
  stored.

**On-demand scanner compute**, compared for a 4 GB scanner (clamd needs 3–4
GiB; 2 GB is too tight once freshclam tests an update):

| Compute | Per session | 60 / 300 / 700 sessions | Idle cost | Notes |
|---|---|---|---|---|
| DigitalOcean Droplet created per batch (s-2vcpu-4gb, SGP1) | 10 min ≈ $0.006, billed at the **$0.01 minimum** (row 2) | $0.60 / $3.00 / $7.00 | Snapshot ≈ 3 GB × $0.06 ≈ $0.18 | Powered-off Droplets are billed, so it must be created and destroyed each time; the booking server needs a DO token that can create Droplets (a spending and takeover risk); a Droplet left behind costs up to $24 a month, the same as the upgrade; create-to-ready latency of minutes (ESTIMATE) |
| Fly.io Machine, shared-cpu-2x 4 GB in `sin`, started and stopped | 5 min ≈ $0.0037 (≈$0.0447/h, row 19) | $0.22 / $1.12 / $2.61 | ≈$0.25 (stopped root filesystem and a 1 GB signature volume) | A new paid account; a token that can only start and stop that Machine; a persistent volume keeps signatures, so freshclam fetches only differences. clamd has no TLS or authentication, so it needs a tunnel or a small authenticated front |
| Hetzner Cloud CPX22, Singapore | A full hour, $0.0497 (row 20) | $2.98 / $14.91 / $30.99 (monthly cap) | Snapshot, IPv4 | Hourly rounding and Singapore prices make it the dearest; a new account |
| DigitalOcean Functions | — | — | — | **Unsuitable:** 1 GB maximum memory (row 4) |
| Cloudflare Workers | — | — | — | **Unsuitable:** 128 MB (row 16) |
| GitHub Actions | Free minutes (2,000) | $0 | $0 | **Rejected:** customer documents (some of minors) would go to GitHub-hosted runners, outside any declared path, and into a CI system the owner has deferred; logs and artifacts add places to delete from |
| Small always-on scanner Droplet (2 GB) | — | $12.00 | $12.00 | The same price as the upgrade, a second server to patch, and too little memory for clamd plus freshclam's test (row 28) |

**Signature updates** are the hidden cost of a cold scanner: about 113 MB per
start (row 29). At 700 starts a month that is about 79 GB from ClamAV's CDN,
which its documentation asks people not to do and may rate-limit (row 30). A
cold scanner needs a persistent signature volume (Fly), a recent snapshot
(DigitalOcean, still a large daily diff after a few days), or a private
mirror kept by cvdupdate on the app Droplet (≈113 MB of disk). Signature age
must be checked at each session, since nobody sees an idle scanner's age.

**Option A in total:** about $0.8 / $3.2 / $7.3 a month with the DigitalOcean
compute, or $0.5 / $1.4 / $2.9 with Fly.io, against $12. Savings of $5 to 11
a month, for the largest amount of new code and operations of any option,
and a transfer abroad.

### Option B: Cloudflare R2, Workers, event notifications and Queues, Containers

- Workers Paid **$5.00** a month, needed for Containers (row 18).
- R2 within the free tier (≤10 GB stored; ≈$0.01 at 10.5 GB); Queues within
  the included operations.
- Containers `standard-1` (4 GiB) for 5 minutes = 0.33 GiB-hours of memory;
  the included 25 GiB-hours cover about 75 sessions: $0.00 / $0.68 / $1.87
  for memory, with disk and active CPU a few cents.
- **Total ≈ $5.00 / $5.70 / $6.95 a month.**

Workers cannot run ClamAV (128 MB); Containers can (4 GiB) but have no
persistent disk, so signatures come either baked into an image (rebuilt and
pushed daily, which needs the CI the owner deferred) or downloaded at each
start (row 30's problem). R2 cannot be held to Singapore or Malaysia (row 13),
and where a container runs is Cloudflare's choice, so this is also a transfer
abroad by default. Savings of $5 to 7 a month over Option 0a, with two
platforms added.

### Option C: Amazon S3 with GuardDuty Malware Protection for S3

- S3 Standard in Singapore: $0.01 / $0.07 / $0.26 for storage; requests and
  tags under $0.02 (row 25).
- GuardDuty: within the monthly free 1 GB and 1,000 objects at 100 and 500
  uploads; at 2,000 uploads (3 GB, 2,000 objects) ≈ 2 GB × $0.135 + 1,000 ×
  $0.000323 = **$0.59** in Singapore, $0.50 in Malaysia (row 23).
- EventBridge: service events free; the app can instead read the object's
  result tag, so no event plumbing is required (row 27).
- Reviewer downloads through the app: within the free 100 GB of egress.
- **Total ≈ $0.01 / $0.09 / $0.87 a month.** The time-limited AWS credits
  (row 26) are not counted.

What this buys: no scanner memory, no signatures, no compute to run, and a
scan in the bucket's Region: Singapore, the Droplet's own city, or **Malaysia
(ap-southeast-5), which would keep a Malaysian install's documents in
Malaysia**, something the Singapore Droplet does not do today. Scan latency is
not published (UNKNOWN).

What it costs besides money: a new AWS account and IAM (a role for GuardDuty,
a bucket policy refusing reads of objects not tagged `NO_THREATS_FOUND`, a key
for the app), AWS as a processor of documents, and a proprietary, paid
engine: ADR 0024 chose "a maintained open-source engine … without a paid
API" and refused paid scanning APIs mainly because public services send
documents abroad and share them. GuardDuty does neither (it scans in the
bucket's Region in an isolated environment, row 24), but it is still paid and
closed, so choosing it is the owner's decision to revisit ADR 0024, not an
implementation detail. `UNSUPPORTED` results (password-protected PDFs, for
example) would have to count as failed, never clean.

## Cost comparison

Monthly US dollars over today's 2 GB Droplet. ESTIMATES from the rows and
assumptions above; "≈0" means under one cent.

| | 100 uploads | 500 uploads | 2,000 uploads | Idle cost | Scan latency | New code and operations | Data location |
|---|---|---|---|---|---|---|---|
| **0a. 4 GB Droplet, Postgres, clamd (built)** | **12.00** | **12.27** | **13.10** + a disk remedy (0 to 15) | 12.00 | Seconds | None; resize | Singapore, as now |
| 0b. 2 GB + swap | 0 | 0 | 0 (+ disk remedy) | 0 | Seconds, when not swapping | Small; unsafe | Singapore |
| 0c. clamd on demand, same Droplet | 0 | 0 | 0 (+ disk remedy) | 0 | +30 s to 2 min (ESTIMATE) | Moderate; swap risk | Singapore |
| A. B2 + presigned + DO Droplet per batch | ≈0.80 | ≈3.20 | ≈7.30 | ≈0.20 | Minutes | Large | **Abroad** (US/CA/NL) |
| A′. B2 + presigned + Fly.io Machine | ≈0.50 | ≈1.40 | ≈2.90 | ≈0.25 | Under 2 min (ESTIMATE) | Large; new account | **Abroad** (store) |
| B. R2 + Queues + Containers | 5.00 | ≈5.70 | ≈6.95 | 5.00 | Under 2 min (ESTIMATE) | Large; new platform | **Not guaranteed** |
| C. S3 + GuardDuty (Singapore or Malaysia) | ≈0.01 | ≈0.09 | ≈0.87 | ≈0 | Not published | Moderate; new account, ADR change | Singapore or Malaysia |
| Storage move only: Spaces SGP1, clamd stays (0a) | 17.00 | 17.00 | 17.00 | 17.00 | Seconds | Moderate | Singapore |

Per line, for the options with a bucket:

| Line | A (B2, DO compute) at 100 / 500 / 2,000 | B (R2, Containers) | C (S3, GuardDuty, Singapore) |
|---|---|---|---|
| Storage | 0 / 0.02 / 0.07 | 0 / 0 / ≈0.01 | 0.01 / 0.07 / 0.26 |
| Requests | 0 (free since May 2026) | 0 (within free) | ≈0 / ≈0.01 / ≈0.02 |
| Transfer | 0 (within 3×) | 0 | 0 (within 100 GB) |
| Edge | 0 (none) | 5.00 (Workers Paid) | 0 |
| Queue or events | 0 (scheduler polls) | 0 (within included) | 0 (tags polled) |
| Scanner | 0.60 / 3.00 / 7.00 | 0 / 0.68 / 1.87 | 0 / 0 / 0.59 |
| Signature updates | Mirror or snapshot needed; ≈0 in money | Image rebuilds (CI) or CDN pulls | AWS's |
| Idle | ≈0.18 (snapshot) | 5.00 | ≈0 |
| Backups | Documents leave the dumps; the bucket needs its own versioning and lifecycle, and erasures and restores must reach it | Same | Same |

The money differences are **$5 to 12 a month**. The engineering in A, B or C
(below) is weeks of work and a permanent second system to secure and watch;
by AGENTS.md's own measure, the simplest secure option wins.

## Security requirements, by option

Every option must keep these. Option 0a has them built and tested
(ADR 0024's verification; mocked scanner and a real clamd with a test
signature, **not** the official signatures or a real Droplet). A bucket-based
option would need each one rebuilt:

| Requirement | Option 0a (built) | What a bucket option must add |
|---|---|---|
| Quarantine by default | `pending` in Postgres | Objects under a quarantine prefix or tag, never readable by browsers; for C, a bucket policy refusing GetObject unless tagged clean |
| Authenticated upload authorisation | The application route, signed in | A short-lived presigned PUT per document, one key per object, issued only to the applicant, or (simpler) uploads through the app as now |
| Signature (magic bytes) and size validation, restricted formats | In memory before storing | Read the object back, check size and bytes, redraw images, inspect PDFs, then write the kept object; delete the raw upload |
| A real malware scan | clamd | clamd elsewhere (A, B) or GuardDuty (C) |
| Clean result bound to the exact object; no replacement after scanning | Database refuses a clean status without a scan of exactly the stored SHA-256, and any change to stored bytes (migration 0142) | Record the object's **version id** and SHA-256; versioning on; the app's write key used only by the server; reads always of the recorded version, re-hashed before release; presigned PUT keys unusable after the upload completes (short expiry; any later PUT creates a version nobody references) |
| Rejected, failed and pending inaccessible; no public URLs | Downloads only of `clean` (or visible `not_scanned`) through the app | The same: downloads proxied through the app (no presigned GET to browsers), bucket private, no public access |
| Tenant and role authorisation | App checks per venue and role | Unchanged, provided every read goes through the app |
| Safe retries | Claim, bounded tries, idempotent results | GuardDuty's results are at-least-once (row 24); results matched by version id |
| Audit | Access records and history | Unchanged, plus provider access logs if wanted |
| Retention and deletion | Rows wiped by retention and erasure | Delete **all versions**; a sweep for orphaned objects (raw uploads, objects without a row after a restore); the erasure ledger must also delete objects |
| Scanner failure and signature freshness monitoring | Hourly `document-scanner` alert, 48-hour signature age | For an on-demand scanner, age checked at each session and "stopped on purpose" told apart from "down"; for C, alerts on `FAILED`/`UNSUPPORTED`/`ACCESS_DENIED` and on objects never tagged |

## Recommendation

**Recommended: Option 0a as built.** Keep documents in Postgres and clamd on
the app Droplet; resize to the 4 GB / 2 vCPU Droplet ($24 instead of $12),
which ADR 0024 already leaves to the owner. Before taking real documents,
measure on that Droplet what ADR 0024 lists as unverified: clamd's memory and
load time with the official signatures, the peak during a freshclam update
(and whether `TestDatabases no` is needed), and scan time for a 10 MB PDF.

**When to revisit:** when stored documents pass about 3 GB (roughly 500
uploads a month held for 90 days), or local backups approach half the disk.
Then move the document **bytes** to a private bucket in the Droplet's region,
keeping clamd on the Droplet and uploads through the app. DigitalOcean Spaces
in SGP1 ($5 a month, same provider and city, no new country; rows 5–6) or S3
in Singapore or Malaysia (cents) are the candidates; B2 and R2 are not,
because they would put documents abroad by default.

**Fallback, if the owner will not run clamd on the booking server:** Option C,
S3 in Singapore (or Malaysia for a Malaysian install) with GuardDuty Malware
Protection for S3, uploads through the app. Under $1 a month at 2,000
uploads, no memory or signatures to manage, in-country storage and scanning.
It requires the owner to revise ADR 0024 (a paid, proprietary engine; AWS as a
processor of documents). If the owner wants to keep an open-source engine
off the booking server, Option A′ with a Fly.io Machine in Singapore and the
documents in Spaces SGP1 (not B2) is the least costly, at about $5–8 a month
including Spaces and the most new code of all.

Until either is chosen and built, the safe default stands: without a scanner
the app refuses documents.

## What would need the owner's approval

- Resizing to the 4 GB Droplet (+$12 a month): the recommendation.
- Any new paid account or service: DigitalOcean Spaces ($5 a month), an AWS
  account (S3, GuardDuty), Fly.io, Cloudflare Workers Paid ($5), Hetzner.
- Any additional server or on-demand compute, and any API token on the
  booking server that can create or start machines.
- Storing documents outside the install's declared hosting location (B2,
  R2, Cloudflare Containers): a declared and approved transfer path and legal
  review, as for backups ([privacy](../architecture/privacy.md#backups-held-abroad)).
- A scanning engine other than clamd, or a paid one: a revision of ADR 0024.
- Retention of documents inside a bucket's backups or versions, if any.

## What MySenam code would change for a bucket

Not needed for the recommendation. For the storage move (and for Option C):

- **A document store interface** beside the scanner's: Postgres bytes as now,
  or an S3-compatible bucket reusing the SigV4 signing in `offsite.ts` (as
  `photo-store.ts` does), with its own endpoint, bucket and keys, and the
  endpoint checked against the declared location as off-site copies are.
- **Uploads through the app, unchanged for the applicant**: the server checks
  and prepares in memory as now, PUTs the kept bytes with Content-MD5 to a
  random key, and records key, **version id**, size and SHA-256 in a migration
  that adds those columns (a new migration file, never an edit). Presigned
  browser uploads only if a measured need appears: they add an
  awaiting-upload state, CORS, a raw-upload sweep and server read-back.
- **Scan trigger**: the existing scheduler (`scanDueDocuments`) reads the
  recorded version, verifies its SHA-256, streams it to clamd and records the
  result as now; for C, it reads the version's GuardDuty tag instead and maps
  `NO_THREATS_FOUND` to clean, `THREATS_FOUND` to rejected, anything else to a
  failed try.
- **Downloads** stream the recorded version through the app, re-hashed, for
  released documents only.
- **Retention, erasure and restore** delete every version of an object, sweep
  objects without a row, and the erasure ledger's replay after a restore
  deletes objects too; backups then no longer carry documents, and backups
  and privacy documents must say where documents are and that a restore does
  not bring back deleted ones.
- **Health**: the panel and alert gain the bucket's reachability.

## Observations outside the question

- The deployment kit's README still says off-site copies go to Cloudflare R2
  ("free under 10 GB") and tells the operator to create an R2 bucket, while
  [ADR 0015](../architecture/decisions/0015-backblaze-b2-preferred-signed-backup-sets.md)
  makes Backblaze B2 the preferred provider. Flagged, not changed here.
- The kit leaves freshclam's `TestDatabases` at its default; whether that
  matters on 4 GB is for the measurement above.
- DigitalOcean has no region in Malaysia; a Malaysian install's data is
  already in Singapore. S3's Malaysia region would be the only option here
  that keeps documents in Malaysia.

## Sources

Every source is linked in the table of prices and limits above, all read on
27 October 2026. The AWS figures are from AWS's public price list files
(`pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<offer>/current/<region>/index.json`
for AmazonGuardDuty, AmazonS3 and AWSDataTransfer, Regions ap-southeast-1 and
ap-southeast-5), because the regional tables on the S3 pricing page did not
load as text. ClamAV file sizes are from HTTP HEAD requests to
database.clamav.net; nothing was downloaded.

## Addendum (27 October 2026, measured)

Added the same day, after the note above was written; the findings above
stand as written. The owner did not approve the 4 GB Droplet and chose clamd
on the 2 GB Droplet, started only when necessary, with every guarantee kept.
That is close to option 0c, built differently: the app starts and stops clamd
itself (not systemd socket activation), behind a memory guard, never beside
freshclam, so health can tell "stopped on purpose" from "down". What is
decided and built is in
[ADR 0024](../architecture/decisions/0024-documents-scanned-before-release-retention-by-purpose.md)
and [deployment: choosing how clamd runs](../operations/deployment.md#choosing-how-clamd-runs).

Measured in the development container (4 vCPU, Intel Xeon 2.1 GHz, 16 GB;
**not a Droplet**), ClamAV 1.5.4 with the official signatures (daily 28165,
main 63, bytecode 339), the kit's clamd settings:

| What | Measured | Label |
|---|---|---|
| Production app, Postgres at rest | about 334 MiB (proportional set size); about 100 MiB | VERIFIED (this container) |
| clamd resident once loaded; through a reload in place | 969–972 MiB; 1,038 MiB | VERIFIED (this container) |
| freshclam peak, `TestDatabases yes` / `no` | about 700 MiB / about 310–320 MiB | VERIFIED (this container) |
| clamd started by the app, start to PONG (three runs) | 10.3–10.6 s; 11.3 s held to one CPU; 15.5 s in an earlier measurement | VERIFIED (this container) |
| A document sent while clamd was stopped, to its clean result | 10.4–10.7 s when the scheduler's tick came at once; in production up to a minute more for the next tick | VERIFIED (this container) |
| clamd's peak resident memory (`VmHWM`) in those runs | 972 MiB | VERIFIED (this container) |

So option 0c's unknown (row 32) is answered for this container: about
10–16 s to load, not "30 s to 2 min" (that ESTIMATE may still hold on a
shared vCPU). Its memory concern is met by never running clamd and freshclam
together and starting clamd only while 1,200 MiB is free: app, Postgres and
clamd come to about 1.45 GiB, which a 2 GB Droplet holds only on those terms.
Still **not verified**: the kit on a real Droplet, its `MemAvailable` there
with the app and Postgres running, clamd's load time on its vCPU, and the
freshclam timer over days.
