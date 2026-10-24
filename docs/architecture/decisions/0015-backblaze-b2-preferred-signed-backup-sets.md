# ADR 0015: Backblaze B2 is the preferred off-site provider; backup sets are signed and watched

- **Status:** current, decided 2026-10-24. It supersedes the recommendation
  in [ADR 0014](0014-off-site-backups-encrypted-and-located.md) and the
  earlier [launch providers](../../integrations/launch-providers.md#off-site-backups)
  text that Amazon S3 in the install's own country be used for off-site
  backups; the rest of ADR 0014 stands. What operators set up is
  [backups](../../operations/backups.md#off-site-copies).
- **Context:** the operator chose Backblaze B2 for the Malaysian and
  Singaporean installs, accepting that it has no region in Asia, so every
  off-site copy is a transfer of personal data abroad. That made three
  things matter more than before:
  - whether the country the operator declares is the one the copies
    actually go to;
  - whether a set in the bucket was made by the server, given that the
    upload key can write new versions;
  - whether anybody notices when copies stop, since they now stop by design
    whenever the transfer safeguards are not in place.
- **Decision:**
  - **B2 is preferred; S3 stays supported.** There is no B2-specific code
    path: the same S3-compatible adapter (single signed PUTs with
    `Content-MD5`, an upload-only key, a separate read key, client-side
    encryption, first-version restore) serves B2, S3 and other compatible
    stores. Existing S3 configurations work unchanged.
  - **The recommended region is US West**, chosen at account sign-up. It is
    the shortest trans-Pacific path from Malaysia and Singapore of the four
    B2 regions (estimated, not measured), and its US jurisdiction is the
    same as US East's. The region cannot be changed afterwards, so it is
    recorded in deployment configuration as the endpoint and
    `OFFSITE_DATA_LOCATION=US`.
  - **The endpoint is checked against the declared country.** A B2 or S3
    endpoint names its region; the app reads the country from it and pauses
    copies when it disagrees with `OFFSITE_DATA_LOCATION`. The signing
    region is read from the endpoint too. An endpoint the app does not
    recognise still relies on the declaration.
  - **Manifests are signed.** With `OFFSITE_SIGNING_KEY_FILE` the server
    signs each set's manifest with Ed25519, and uploads the signature beside
    it. The restore machine, holding only the public key, refuses a set
    without a valid signature. This is a standard primitive: no new
    cryptography. It tells a set the server made apart from one uploaded
    with a stolen upload key alone. It does not help against somebody who
    controls the server, who can sign; for that, the provider's own upload
    time, which the uploader cannot set, selects a recovery point from
    before the compromise (`fetch-backup --list --before`), and a set first
    uploaded more than six hours after it was made is flagged.
  - **Backup health is one state, alerted on.** Active, on this server only,
    behind the recovery-point target, paused or failing, with the age of the
    newest copy that would survive losing the server. The owners are alerted
    past `MYSENAM_BACKUP_RPO_HOURS` (default 26) and when a set nears the
    single-upload limit.
  - **Object Lock stays governance mode, 14 days.** The upload and read keys
    never hold `bypassGovernance`, `writeFileRetentions` or `deleteFiles`, so
    governance protects against a stolen application key exactly as
    compliance would. A mistake can still be corrected by the account
    owner. Compliance mode would only add protection against a taken-over
    Backblaze account, at the cost of copies nobody can remove.
- **Consequences:**
  - A real bucket has to be exercised before B2 is called verified;
    `scripts/verify-offsite.mjs` does it with synthetic data and both keys.
  - Account and billing data at Backblaze is held in the US whatever the
    region.
  - Whether Backblaze's click-through terms meet Singapore's and Malaysia's
    transfer rules is for a lawyer
    ([privacy](../privacy.md#backups-held-abroad)).
  - A server compromise that goes unnoticed for longer than the retention
    leaves only sets made after it.
