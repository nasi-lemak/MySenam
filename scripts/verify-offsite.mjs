#!/usr/bin/env node
/**
 * Exercise a real off-site bucket — Backblaze B2, Amazon S3 or another
 * S3-compatible service — the way the app and a restore will use it, with
 * synthetic data only, and say what it allows that it should not.
 *
 *   node scripts/verify-offsite.mjs              # what would be checked, and where
 *   node scripts/verify-offsite.mjs --go [--size-mb 200] [--report verify.json]
 *
 * Run it on a test machine, not the production server: it needs both keys in
 * the environment — the upload key (OFFSITE_S3_ACCESS_KEY_ID, …) and the read
 * key (OFFSITE_S3_READ_ACCESS_KEY_ID, …) — and the private keys for
 * decryption. Whatever DATABASE_URL says, it backs up a fresh, empty database
 * of its own made here in memory: no customer data is ever sent. Use a prefix
 * of its own (OFFSITE_S3_PREFIX=verify/): what it uploads is held under Object
 * Lock until its retention ends, and cannot be removed before then.
 *
 * Checked: the endpoint's region and country against OFFSITE_DATA_LOCATION;
 * an encrypted, signed set uploaded with the upload key; that key refused a
 * read, a listing, a delete, a version delete and a retention change; the read
 * key refused a delete; the Object Lock mode and retain-until date on what was
 * uploaded; a second upload under the same name kept as a new version, with
 * the first one restored and the rewrite reported; the set fetched with the
 * read key, decrypted, checked against its manifest and restored in a drill
 * aside; with --size-mb, the time to upload and fetch back that much. The
 * bucket's lifecycle rules cannot be read with these keys: it says what to
 * look at by hand. Exits non-zero if anything failed. See
 * docs/operations/backups.md#verifying-a-real-bucket.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
};

// Synthetic only: a database of its own, in memory, and no photos — whatever this machine is set up for.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "verify-offsite-"));
delete process.env.DATABASE_URL;
process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_BACKUP_DIR = path.join(work, "backups");
process.env.MYSENAM_DATA_DIR = path.join(work, "data");
fs.mkdirSync(process.env.MYSENAM_DATA_DIR, { recursive: true });

const { createBackup, restoreDrill, verifyBackupSet } = await import("../src/lib/backup.ts");
const { decryptFile, encryptFile, readKeyFile } = await import("../src/lib/backup-crypto.ts");
const off = await import("../src/lib/offsite.ts");

const upload = off.offsiteConfig();
const read = off.offsiteReadConfig();
if (!upload || !read) {
  console.error("Both keys are needed: OFFSITE_S3_ENDPOINT, OFFSITE_S3_BUCKET, the upload key (OFFSITE_S3_ACCESS_KEY_ID, OFFSITE_S3_SECRET_ACCESS_KEY) and the read key (OFFSITE_S3_READ_ACCESS_KEY_ID, OFFSITE_S3_READ_SECRET_ACCESS_KEY).");
  process.exit(1);
}

const results = [];
const note = (outcome, check, detail = "") => {
  results.push({ check, outcome, detail });
  console.log(`${outcome.toUpperCase().padEnd(6)} ${check}${detail ? ` — ${detail}` : ""}`);
};

const where = off.endpointLocation(upload.endpoint);
note("info", "destination", `${upload.endpoint}/${upload.bucket}/${upload.prefix} (signing region ${upload.region})`);
note(
  "info",
  "endpoint names",
  where ? `${where.provider}${where.region ? ` ${where.region}` : ""}, ${where.country ? `in ${where.country}` : "country not stated in the address"}` : "a provider this code does not recognise: the country rests on OFFSITE_DATA_LOCATION alone"
);
const paused = off.offsiteTransferCheck();
if (paused) note("fail", "transfer allowed", paused);
else note("pass", "transfer allowed", `declared ${process.env.OFFSITE_DATA_LOCATION}${process.env.OFFSITE_TRANSFER_APPROVED ? `, approved ${process.env.OFFSITE_TRANSFER_APPROVED}` : ""}`);
if (!upload.prefix.includes("verify")) note("info", "prefix", `${upload.prefix || "(none)"} — a prefix of its own (verify/) keeps these locked test objects apart from real sets`);

if (!args.includes("--go")) {
  console.log("\nNothing sent. Run again with --go to upload a synthetic set and try each refusal.");
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(paused ? 1 : 0);
}
if (paused) process.exit(1);

/** A request signed with one of the two keys, outside the app's own helpers: for the things the app never does. */
async function raw(config, method, { name = null, query = {}, body = Buffer.alloc(0), headers = {} } = {}) {
  const url = name === null ? new URL(`${config.endpoint}/${encodeURIComponent(config.bucket)}`) : off.objectUrl(config, name);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const now = new Date();
  const payloadHash = crypto.createHash("sha256").update(body).digest("hex");
  const signed = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": off.amzDate(now), ...headers };
  if (body.length > 0) signed["content-md5"] = crypto.createHash("md5").update(body).digest("base64");
  signed.authorization = off.signV4({ method, url, headers: signed, payloadHash, region: config.region, service: "s3", accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, now });
  const res = await fetch(url, { method, headers: signed, body: body.length > 0 ? body : undefined });
  const text = await res.text();
  return { status: res.status, code: text.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? "", headers: res.headers };
}
const refused = (r) => r.status === 401 || r.status === 403;
const expectRefused = (check, r) =>
  refused(r) ? note("pass", check, `${r.status} ${r.code}`) : note("fail", check, `answered ${r.status} ${r.code}: this key can do more than it should`);

let snapshotName = null;
try {
  // 1. A synthetic set, as the server sends one.
  const taken = await createBackup();
  if (!taken.ok) throw new Error(taken.error);
  snapshotName = taken.file.name;
  let started = Date.now();
  const sent = await off.copyOffsite(taken.file, taken.photos.file, taken.manifest);
  if (!sent?.ok) throw new Error(`upload failed: ${sent?.error ?? "off-site copies are not set"}`);
  const status = await off.offsiteStatus();
  note("pass", "upload with the upload key", `${taken.file.name}, ${Date.now() - started} ms${status.lastCopied?.encrypted ? ", encrypted" : ", NOT encrypted"}${status.lastCopied?.signed ? ", manifest signed" : ", manifest not signed"}`);
  if (!status.lastCopied?.encrypted) note("fail", "encrypted before upload", "set OFFSITE_ENCRYPTION_PUBLIC_KEY_FILE");
  const stored = `${taken.file.name}${status.lastCopied?.encrypted ? ".enc" : ""}`;

  // 2. What the upload key must not do.
  expectRefused("upload key cannot read", await raw(upload, "GET", { name: stored }));
  expectRefused("upload key cannot list", await raw(upload, "GET", { query: { "list-type": "2", prefix: upload.prefix } }));
  expectRefused("upload key cannot list versions", await raw(upload, "GET", { query: { versions: "", prefix: upload.prefix } }));
  expectRefused("upload key cannot delete (hide) a file", await raw(upload, "DELETE", { name: stored }));

  // 3. The versions, read with the read key.
  const versions = await off.listOffsiteVersions(read);
  if (!versions) note("fail", "read key lists versions", "the bucket would not list versions: the first-upload protection is not available");
  const first = versions?.filter((v) => v.name === stored && !v.marker).at(-1);
  if (versions && !first) note("fail", "read key lists versions", `${stored} is not listed`);
  if (first) {
    note("pass", "read key lists versions", `${stored} version ${first.versionId}`);
    expectRefused("upload key cannot delete a version", await raw(upload, "DELETE", { name: stored, query: { versionId: first.versionId } }));
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const retention = Buffer.from(`<Retention xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Mode>GOVERNANCE</Mode><RetainUntilDate>${until}</RetainUntilDate></Retention>`);
    expectRefused(
      "upload key cannot change retention or bypass governance",
      await raw(upload, "PUT", { name: stored, query: { retention: "", versionId: first.versionId }, body: retention, headers: { "x-amz-bypass-governance-retention": "true" } })
    );
    expectRefused("read key cannot delete a version", await raw(read, "DELETE", { name: stored, query: { versionId: first.versionId } }));
    const head = await raw(read, "HEAD", { name: stored, query: { versionId: first.versionId } });
    const mode = head.headers.get("x-amz-object-lock-mode");
    const retainUntil = head.headers.get("x-amz-object-lock-retain-until-date");
    if (mode && retainUntil && Date.parse(retainUntil) > Date.now()) note("pass", "Object Lock on the upload", `${mode} until ${retainUntil}`);
    else if (mode || retainUntil) note("fail", "Object Lock on the upload", `mode ${mode ?? "none"}, until ${retainUntil ?? "none"}`);
    else note("manual", "Object Lock on the upload", "not shown to the read key (on B2 that needs readFileRetentions): check the file's retention in the provider's console");
  }

  // 4. Written again under the same name, as a thief with the upload key would: kept, and the first restored.
  const decoy = path.join(work, stored);
  fs.writeFileSync(decoy, crypto.randomBytes(4096));
  const again = await off.uploadBackup({ name: stored, path: decoy }, upload);
  if (!again.ok) note("info", "second upload under the same name", `refused: ${again.error}`);

  // 5. Fetched with the read key, decrypted, checked and restored aside.
  started = Date.now();
  const fetched = await off.fetchOffsiteSet(read, taken.file.name, path.join(work, "fetched"));
  note("pass", "fetch with the read key", `${fetched.files.length} files, ${Date.now() - started} ms, signature ${fetched.signature}${fetched.uploadedLate ? ", FIRST UPLOADED LATE" : ""}`);
  if (again.ok) {
    const firstKept = fetched.rewritten.includes(stored) && fs.readFileSync(fetched.snapshot).equals(fs.readFileSync(taken.file.path));
    note(
      firstKept ? "pass" : "fail",
      "a rewrite is kept as a new version; the first upload is restored",
      firstKept ? `rewritten: ${fetched.rewritten.join(", ")}` : "the copy fetched is not the one first uploaded"
    );
  }
  const check = await verifyBackupSet(fetched.snapshot);
  note(check.ok ? "pass" : "fail", "manifest check", check.ok ? "every part's hash matches" : check.problems.join("; "));
  const drill = await restoreDrill(fetched.snapshot);
  note(drill.ok ? "pass" : "fail", "isolated restore drill", drill.ok ? `${drill.ms} ms, ${Object.keys(drill.counts).length} tables counted` : drill.problems.join("; "));

  // 6. In parts, as a file over one upload's 5 GB goes: made small here (5 MiB parts, the least the providers take).
  const parted = path.join(work, `parts-${Date.now()}.bin`);
  fs.writeFileSync(parted, crypto.randomBytes(11 * 1024 * 1024));
  const inParts = await off.uploadBackup({ name: path.basename(parted), path: parted }, upload, new Date(), { single: 5 * 1024 * 1024, part: 5 * 1024 * 1024 });
  if (!inParts.ok) note("fail", "upload in parts with the upload key", inParts.error);
  else {
    await off.downloadObject(read, path.basename(parted), `${parted}.back`);
    const same = fs.readFileSync(parted).equals(fs.readFileSync(`${parted}.back`));
    note(same ? "pass" : "fail", "upload in parts with the upload key", `${inParts.parts} parts${same ? ", read back the same" : ", READ BACK DIFFERENT"}`);
  }

  // 7. How long a larger set takes, if asked.
  const mb = Number(flag("--size-mb") ?? 0);
  if (mb > 0) {
    const big = path.join(work, `throughput-${Date.now()}.bin`);
    const out = fs.openSync(big, "w");
    for (let i = 0; i < mb; i++) fs.writeSync(out, crypto.randomBytes(1024 * 1024));
    fs.closeSync(out);
    const publicKey = readKeyFile(process.env.OFFSITE_ENCRYPTION_PUBLIC_KEY_FILE);
    const privateKey = readKeyFile(process.env.OFFSITE_ENCRYPTION_PRIVATE_KEY_FILE);
    if (!publicKey || !privateKey) throw new Error("--size-mb needs both encryption keys");
    await encryptFile(big, `${big}.enc`, publicKey);
    started = Date.now();
    const put = await off.uploadBackup({ name: `${path.basename(big)}.enc`, path: `${big}.enc` }, upload);
    if (!put.ok) throw new Error(put.error);
    const up = (Date.now() - started) / 1000;
    started = Date.now();
    await off.downloadObject(read, `${path.basename(big)}.enc`, `${big}.back.enc`);
    const down = (Date.now() - started) / 1000;
    await decryptFile(`${big}.back.enc`, `${big}.back`, privateKey);
    const same = crypto.createHash("sha256").update(fs.readFileSync(big)).digest("hex") === crypto.createHash("sha256").update(fs.readFileSync(`${big}.back`)).digest("hex");
    note(same ? "pass" : "fail", `${mb} MB up and back`, `upload ${up.toFixed(1)} s (${(mb / up).toFixed(1)} MB/s), download ${down.toFixed(1)} s (${(mb / down).toFixed(1)} MB/s)${same ? "" : ", CONTENTS DIFFER"}`);
  }
} catch (err) {
  note("fail", "run", err instanceof Error ? err.message : String(err));
}

note("manual", "lifecycle rules", "in the provider's console: no rule may delete versions before the retention ends; hidden or old versions kept at least as long as Object Lock holds them; unfinished uploads in parts dropped after a day or two (B2: daysFromStartingToCancelingUnfinishedLargeFiles; S3: AbortIncompleteMultipartUpload), since the upload key never aborts them");
note("manual", "keys", "confirm in the console that the upload key has only writeFiles (B2) or s3:PutObject (S3) on this bucket and prefix, and that no key on the server can bypass governance");

const report = flag("--report");
if (report) fs.writeFileSync(report, JSON.stringify({ at: new Date().toISOString(), endpoint: upload.endpoint, bucket: upload.bucket, prefix: upload.prefix, snapshot: snapshotName, results }, null, 2));
fs.rmSync(work, { recursive: true, force: true });
const failed = results.filter((r) => r.outcome === "fail").length;
console.log(`\n${failed === 0 ? "No refusal missing and nothing failed." : `${failed} failed.`} Objects uploaded stay under ${upload.prefix} until their retention ends.`);
process.exit(failed === 0 ? 0 : 1);
