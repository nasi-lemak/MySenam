# ADR 0014: Off-site backups are encrypted, located, and restored from their first upload

- **Status:** current. What operators set up is
  [backups](../../operations/backups.md#off-site-copies); the provider choice
  is in [launch providers](../../integrations/launch-providers.md#off-site-backups).
- **Context:** off-site copies went to any S3-compatible bucket with a key
  meant to be upload-only, and were readable by the provider. Checking the
  providers' documentation showed three things the design had assumed away:
  an upload-only key can still upload a new version over an existing name
  (and on Backblaze B2 hide it), which a lifecycle rule then deletes; buckets
  with Object Lock require `Content-MD5` on uploads; and Backblaze B2 and
  Cloudflare R2, the cheapest providers, have no region in Malaysia or
  Singapore, so using them sends customers' personal data abroad.
- **Decision:**
  - **Object Lock keeps the copies, not the key.** The bucket is configured
    with Object Lock (14 days, governance) and a lifecycle rule; the app
    sends `Content-MD5` with every PUT and never asks the upload key for
    anything else.
  - **A restore takes each name's first upload.** The server writes every
    name once, so where versions can be listed the restore fetches the
    earliest version and reports any name written again. Encryption alone
    would not catch this: a thief with the server's public key can make a
    fake set that decrypts and checks out.
  - **Copies are encrypted on the server** with a public key (AES-256-GCM per
    file, the key wrapped with RSA-OAEP); the private key lives only where
    restores happen. The provider, and anybody who takes over the server,
    holds ciphertext.
  - **Nothing leaves without a declared location.** `OFFSITE_DATA_LOCATION`
    must name the bucket's country; a country other than the install's needs
    `OFFSITE_TRANSFER_APPROVED` and encryption. The app does not judge the
    law; it refuses to make the transfer silently.
  - **Restores read with a separate key**, kept off the server.
- **Consequences:** an install with off-site copies set up before this
  pauses them until `OFFSITE_DATA_LOCATION` is set, and the Backups panel and
  the startup log say so. Amazon S3 in the install's own country is the
  recommendation; B2 works unchanged once a transfer is approved. A part
  over about 5 GB is still refused (no multipart upload). All of it is tested
  against stand-ins, not real buckets, until the launch checklist's off-site
  drill is run.
