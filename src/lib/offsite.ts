import path from "path";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import https from "https";
import os from "os";
import { getDb } from "./db.ts";
import type { BackupFile } from "./backup";
import { decryptFile, encryptFile, readKeyFile, signBytes, signatureValid } from "./backup-crypto.ts";
import { region } from "./region.ts";
import { englishOf, said, type StaffText } from "./staff-text.ts";

/**
 * Copies of the backups somewhere that is not this machine.
 *
 * A snapshot beside the database survives a bad deploy and a mistyped DELETE.
 * It does not survive the disk. So each one is also sent to object storage —
 * Cloudflare R2, Backblaze B2, Amazon S3, anything that speaks the S3 API — as
 * a plain upload, signed here rather than through an SDK, since one PUT is all
 * this needs.
 *
 * Nothing here deletes anything off-site. Old copies are expired by the
 * bucket's own lifecycle rule, which means the key this install holds can be
 * one that may only upload: somebody who takes over the server cannot reach
 * back and wipe the copies that would undo it.
 */

export interface OffsiteConfig {
  /** https://<account>.r2.cloudflarestorage.com, https://s3.<region>.backblazeb2.com… */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Prepended to each file's name, e.g. `mysenam/`. */
  prefix: string;
}

/** Where an endpoint's data is kept, where the endpoint itself says: the provider, its region, and that region's country. */
export interface EndpointLocation {
  provider: "Backblaze B2" | "Amazon S3" | "Cloudflare R2";
  region: string | null;
  /** ISO country of the region; null where the provider does not tie the endpoint to one (R2). */
  country: string | null;
}

/** B2 regions by the prefix of their name (`us-west-004`), and where each is. */
const B2_REGIONS: Record<string, string> = { "us-west": "US", "us-east": "US", "eu-central": "NL", "ca-east": "CA" };
/** The AWS regions MySenam is likely to use, and their countries; others read as unknown. */
const AWS_REGIONS: Record<string, string> = {
  "ap-southeast-1": "SG",
  "ap-southeast-5": "MY",
  "ap-southeast-2": "AU",
  "ap-northeast-1": "JP",
  "ap-south-1": "IN",
  "eu-west-1": "IE",
  "eu-west-2": "GB",
  "eu-central-1": "DE",
};

/**
 * The provider, region and country an endpoint names. A Backblaze B2 account
 * lives in one region, named in its S3 endpoint (`s3.us-west-004.backblazeb2.com`);
 * an Amazon S3 regional endpoint names its region. Null for an endpoint that
 * says nothing (a custom S3-compatible service). This is what the
 * endpoint says, so it is checked against `OFFSITE_DATA_LOCATION` rather than
 * the typed country being trusted alone.
 */
export function endpointLocation(endpoint: string): EndpointLocation | null {
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return null;
  }
  const b2 = /^s3\.([a-z]+-[a-z]+)-(\d{3})\.backblazeb2\.com$/.exec(host);
  if (b2) return { provider: "Backblaze B2", region: `${b2[1]}-${b2[2]}`, country: B2_REGIONS[b2[1]] ?? null };
  const aws = /(?:^|\.)s3[.-]([a-z]{2}-[a-z]+-\d)\.amazonaws\.com$/.exec(host);
  if (aws) return { provider: "Amazon S3", region: aws[1], country: AWS_REGIONS[aws[1]] ?? (aws[1].startsWith("us-") ? "US" : null) };
  if (host.endsWith(".r2.cloudflarestorage.com")) return { provider: "Cloudflare R2", region: "auto", country: null };
  return null;
}

/**
 * Where copies go and the key the server uploads with. Works with any
 * S3-compatible service: Backblaze B2, the preferred provider
 * (`https://s3.<region>.backblazeb2.com`, e.g. `us-west-004`), Amazon S3
 * (`https://s3.<region>.amazonaws.com`), Cloudflare R2 (region `auto`). The
 * signing region defaults to the one the endpoint names. The key
 * should be one that may only upload (B2: `writeFiles` on this bucket and
 * prefix; S3: `s3:PutObject` alone): the server never reads, lists or
 * deletes off-site. Such a key can still upload a new version over an
 * existing name, so the bucket's Object Lock is what keeps earlier copies
 * (docs/operations/backups.md), and a restore takes each name's first
 * version (`fetchOffsiteSet`).
 */
export function offsiteConfig(): OffsiteConfig | null {
  const endpoint = process.env.OFFSITE_S3_ENDPOINT;
  const bucket = process.env.OFFSITE_S3_BUCKET;
  const accessKeyId = process.env.OFFSITE_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.OFFSITE_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    bucket,
    region: signingRegion(endpoint),
    accessKeyId,
    secretAccessKey,
    prefix: process.env.OFFSITE_S3_PREFIX ?? "mysenam/",
  };
}

/** S3 and B2 want the bucket's real region, which their endpoints name; R2 accepts "auto". `OFFSITE_S3_REGION` wins where set. */
function signingRegion(endpoint: string): string {
  return process.env.OFFSITE_S3_REGION || endpointLocation(endpoint)?.region || "auto";
}

/**
 * The key a restore reads with: `OFFSITE_S3_READ_ACCESS_KEY_ID` and
 * `OFFSITE_S3_READ_SECRET_ACCESS_KEY` where set (B2: `listFiles` and
 * `readFiles`; S3: `s3:ListBucket` and `s3:GetObject`), kept on the machine
 * that restores, not the server; otherwise the upload key, which on a
 * properly restricted key will be refused.
 */
export function offsiteReadConfig(): OffsiteConfig | null {
  const base = offsiteConfig() ?? offsiteConfigWithout();
  if (!base) return null;
  const id = process.env.OFFSITE_S3_READ_ACCESS_KEY_ID;
  const secret = process.env.OFFSITE_S3_READ_SECRET_ACCESS_KEY;
  return id && secret ? { ...base, accessKeyId: id, secretAccessKey: secret } : offsiteConfig();
}

/** The bucket's address without an upload key: on a restore machine that holds only the read key. */
function offsiteConfigWithout(): OffsiteConfig | null {
  const endpoint = process.env.OFFSITE_S3_ENDPOINT;
  const bucket = process.env.OFFSITE_S3_BUCKET;
  if (!endpoint || !bucket || !process.env.OFFSITE_S3_READ_ACCESS_KEY_ID) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    bucket,
    region: signingRegion(endpoint),
    accessKeyId: "",
    secretAccessKey: "",
    prefix: process.env.OFFSITE_S3_PREFIX ?? "mysenam/",
  };
}

/**
 * What one PUT may carry: 5 GiB on S3, 5 GB on B2, 4.995 GiB on R2 — so a
 * little under the smallest. A larger file goes up in parts (a multipart
 * upload, which S3, B2 and R2 all take through the same S3 API).
 */
export const MAX_SINGLE_PUT = Math.floor(4.99 * 1024 ** 3);

/**
 * Each part of a multipart upload: 100 MiB, inside every provider's limits
 * (at least 5 MiB but the last, at most 5 GiB) and B2's recommended size, so
 * a failed part costs little to send again.
 */
export const PART_BYTES = 100 * 1024 ** 2;

/** The most parts one upload may have, on every provider. */
export const MAX_PARTS = 10_000;

/** The largest file one upload carries, in parts: about 976 GiB. */
export const MAX_UPLOAD = PART_BYTES * MAX_PARTS;

/**
 * Whether copies may be sent where the bucket is. Nothing is sent until
 * `OFFSITE_DATA_LOCATION` says which country the bucket keeps data in (the
 * provider's region, not its head office). A bucket in this install's own
 * country needs nothing more. A bucket abroad is a transfer of customers'
 * personal data out of the country (Malaysia PDPA s129, Singapore PDPA
 * s26), so it also needs `OFFSITE_TRANSFER_APPROVED` set to that same
 * country — recorded once the safeguards are in place (a data processing
 * agreement, a transfer assessment, the privacy notice; see
 * docs/architecture/privacy.md#backups-held-abroad) — and client-side
 * encryption, so the provider holds only ciphertext. Returns why not, or
 * null when copies may go.
 */
export function offsiteTransferCheck(): string | null {
  const why = offsiteTransferPause();
  return why && englishOf(why);
}

/** The same, as a phrase a staff screen says in the staff language. */
export function offsiteTransferPause(): StaffText | null {
  const location = process.env.OFFSITE_DATA_LOCATION?.trim().toUpperCase();
  const home = region();
  if (!location) return said("srv.offsite.noLocation");
  // A typed country is checked against the region the endpoint itself names.
  const named = process.env.OFFSITE_S3_ENDPOINT ? endpointLocation(process.env.OFFSITE_S3_ENDPOINT) : null;
  if (named?.country && named.country !== location)
    return said("srv.offsite.mismatch", { provider: named.provider, region: String(named.region), country: named.country, location });
  if (location === home.country) return null;
  if (process.env.OFFSITE_TRANSFER_APPROVED?.trim().toUpperCase() !== location)
    return said("srv.offsite.notApproved", { location, home: home.name });
  if (!process.env.OFFSITE_ENCRYPTION_PUBLIC_KEY_FILE) return said("srv.offsite.notEncrypted", { location, home: home.name });
  return null;
}

// ------------------------------------------------------------- signing

const hex = (data: crypto.BinaryLike) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key: crypto.BinaryLike, data: string) =>
  crypto.createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding, as SigV4 wants each path segment. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export function canonicalPath(pathname: string): string {
  return pathname
    .split("/")
    .map((s) => encodeSegment(decodeURIComponent(s)))
    .join("/");
}

/** `20130524T000000Z` */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * AWS Signature Version 4, for one request.
 *
 * `headers` must already hold every header to be signed, `host` and
 * `x-amz-date` and `x-amz-content-sha256` among them. Returns the value of the
 * Authorization header.
 */
export function signV4(input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}): string {
  const stamp = amzDate(input.now);
  const day = stamp.slice(0, 8);
  const names = Object.keys(input.headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower = Object.fromEntries(
    Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")])
  );
  const query = [...input.url.searchParams]
    .map(([k, v]) => [encodeSegment(k), encodeSegment(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [
    input.method,
    canonicalPath(input.url.pathname),
    query,
    names.map((n) => `${n}:${lower[n]}\n`).join(""),
    names.join(";"),
    input.payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, hex(canonical)].join("\n");
  const key = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), input.service),
    "aws4_request"
  );
  const signature = crypto.createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
}

// ------------------------------------------------------------- uploading

/**
 * The file's SHA-256 (signed, for SigV4) and MD5 (sent as Content-MD5, which
 * a bucket with Object Lock requires on S3 and which every S3-compatible
 * service checks), read in pieces: a database can be bigger than the memory
 * there is. A part of it, where `start` and `end` (inclusive) are given.
 */
function fileHashes(file: string, range?: { start: number; end: number }): Promise<{ sha256: string; md5: string }> {
  return new Promise((resolve, reject) => {
    const sha = crypto.createHash("sha256");
    const md5 = crypto.createHash("md5");
    fs.createReadStream(file, range)
      .on("data", (chunk) => {
        sha.update(chunk);
        md5.update(chunk);
      })
      .on("error", reject)
      .on("end", () => resolve({ sha256: sha.digest("hex"), md5: md5.digest("base64") }));
  });
}

/** Where a backup goes in the bucket, path-style, which every S3 workalike accepts. */
export function objectUrl(config: OffsiteConfig, name: string): URL {
  return new URL(`${config.endpoint}/${encodeSegment(config.bucket)}/${canonicalPath(config.prefix + name)}`);
}

export type UploadResult = { ok: true; key: string; bytes: number; parts?: number } | { ok: false; error: string };

type Reply = { status: number; etag: string | null; body: string };

/**
 * One signed request to the bucket, its body a buffer or a stretch of a file
 * streamed from disk, its SHA-256 signed (and its MD5 sent, where given).
 */
function signedRequest(
  config: OffsiteConfig,
  input: { method: string; url: URL; sha256: string; md5?: string; body: Buffer | { file: string; start: number; end: number }; now: Date }
): Promise<Reply> {
  const length = Buffer.isBuffer(input.body) ? input.body.length : input.body.end - input.body.start + 1;
  const headers: Record<string, string> = {
    host: input.url.host,
    "content-length": String(length),
    ...(input.md5 ? { "content-md5": input.md5 } : {}),
    "content-type": Buffer.isBuffer(input.body) ? "application/xml" : "application/octet-stream",
    "x-amz-content-sha256": input.sha256,
    "x-amz-date": amzDate(input.now),
  };
  headers.authorization = signV4({
    method: input.method,
    url: input.url,
    headers,
    payloadHash: input.sha256,
    region: config.region,
    service: "s3",
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    now: input.now,
  });
  return new Promise((resolve, reject) => {
    const send = input.url.protocol === "http:" ? http.request : https.request;
    const req = send(input.url, { method: input.method, headers, timeout: 10 * 60_000 }, (res) => {
      let reply = "";
      res.on("data", (chunk) => (reply += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, etag: (res.headers.etag as string | undefined) ?? null, body: reply }));
    });
    req.on("timeout", () => req.destroy(new Error("The upload timed out.")));
    req.on("error", reject);
    if (Buffer.isBuffer(input.body)) req.end(input.body);
    else
      fs.createReadStream(input.body.file, { start: input.body.start, end: input.body.end })
        .on("error", (err) => req.destroy(err))
        .pipe(req);
  });
}

/** What the storage service said, from its status and its XML error. */
function refusedBy(reply: Reply): string {
  const code = reply.body.match(/<Code>([^<]+)<\/Code>/)?.[1];
  const message = reply.body.match(/<Message>([^<]+)<\/Message>/)?.[1];
  return `Storage refused the upload (${reply.status}${code ? ` ${code}` : ""})${message ? `: ${message}` : ""}`;
}

/** A 2xx with no error inside it: S3 can answer a multipart upload's completion 200 and still have failed. */
const accepted = (reply: Reply) => reply.status >= 200 && reply.status < 300 && !/<Error>/.test(reply.body);

/**
 * Send one file: with a single signed PUT up to about 5 GB, in parts above
 * that (a multipart upload: start, each part, complete). Either way the upload
 * key only writes: nothing is read back, listed, deleted or aborted, so a key
 * that may only upload is enough; an upload left unfinished (the server
 * stopped part-way) is dropped by the bucket's lifecycle rule
 * ([backups](../../docs/operations/backups.md)). Each body is streamed from
 * disk with its SHA-256 signed and its MD5 sent, so the storage service itself
 * refuses a file or part that arrived damaged.
 */
export async function uploadBackup(
  backup: Pick<BackupFile, "name" | "path">,
  config: OffsiteConfig,
  now = new Date(),
  sizes: { single?: number; part?: number } = {}
): Promise<UploadResult> {
  const single = sizes.single ?? MAX_SINGLE_PUT;
  const partBytes = sizes.part ?? PART_BYTES;
  let bytes: number;
  try {
    bytes = fs.statSync(backup.path).size;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Cannot read the backup" };
  }
  if (bytes > partBytes * MAX_PARTS)
    return { ok: false, error: `${backup.name} is ${(bytes / 1024 ** 3).toFixed(1)} GiB: more than one upload can carry, even in parts. Keep photos in a photo bucket instead.` };
  const url = objectUrl(config, backup.name);
  const key = config.prefix + backup.name;
  // A long upload signs each request with the time it is sent.
  const started = Date.now();
  const at = () => new Date(now.getTime() + (Date.now() - started));
  try {
    if (bytes <= single) {
      const { sha256, md5 } = await fileHashes(backup.path);
      const reply = await signedRequest(config, { method: "PUT", url, sha256, md5, body: { file: backup.path, start: 0, end: bytes - 1 }, now: at() });
      return accepted(reply) ? { ok: true, key, bytes } : { ok: false, error: refusedBy(reply) };
    }

    const empty = Buffer.alloc(0);
    const begun = await signedRequest(config, { method: "POST", url: withQuery(url, { uploads: "" }), sha256: hex(empty), body: empty, now: at() });
    const uploadId = begun.body.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
    if (!accepted(begun) || !uploadId) return { ok: false, error: refusedBy(begun) };
    const etags: string[] = [];
    for (let start = 0, number = 1; start < bytes; start += partBytes, number++) {
      const range = { start, end: Math.min(start + partBytes, bytes) - 1 };
      const { sha256, md5 } = await fileHashes(backup.path, range);
      const part = await signedRequest(config, {
        method: "PUT",
        url: withQuery(url, { partNumber: String(number), uploadId }),
        sha256,
        md5,
        body: { file: backup.path, ...range },
        now: at(),
      });
      if (!accepted(part) || !part.etag) return { ok: false, error: `Part ${number}: ${refusedBy(part)}` };
      etags.push(part.etag);
    }
    const list = Buffer.from(
      `<CompleteMultipartUpload>${etags.map((etag, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`).join("")}</CompleteMultipartUpload>`
    );
    const done = await signedRequest(config, {
      method: "POST",
      url: withQuery(url, { uploadId }),
      sha256: hex(list),
      md5: crypto.createHash("md5").update(list).digest("base64"),
      body: list,
      now: at(),
    });
    return accepted(done) ? { ok: true, key, bytes, parts: etags.length } : { ok: false, error: refusedBy(done) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The upload failed" };
  }
}

function withQuery(url: URL, params: Record<string, string>): URL {
  const out = new URL(url);
  for (const [k, v] of Object.entries(params)) out.searchParams.set(k, v);
  return out;
}

// ------------------------------------------------------------- remembering

export interface OffsiteStatus {
  configured: boolean;
  /** Where copies go, without the credentials. */
  destination: string | null;
  /** The country the bucket keeps data in, as declared (`OFFSITE_DATA_LOCATION`). */
  location: string | null;
  /** What the endpoint itself names: provider, region and country, where it says (`endpointLocation`). */
  endpointSays: EndpointLocation | null;
  /** Why copies are not being sent, where they may not go (`offsiteTransferCheck`). */
  paused: string | null;
  /** The same, as a phrase a staff screen says in the staff language. */
  pausedPhrase: StaffText | null;
  /** `manifest`: the set's manifest went too, so the copy can be checked whole when it is fetched back. */
  lastCopied: { name: string; at: string; key: string; manifest?: boolean; encrypted?: boolean; signed?: boolean; largestBytes?: number } | null;
  lastError: { at: string; error: string } | null;
}

const STATUS_KEY = "offsite_status";

interface Stored {
  lastCopied: OffsiteStatus["lastCopied"];
  lastError: OffsiteStatus["lastError"];
}

async function stored(): Promise<Stored> {
  const row = await getDb().prepare("SELECT value FROM settings WHERE key = ?").get(STATUS_KEY) as
    | { value: string }
    | undefined;
  try {
    return row ? (JSON.parse(row.value) as Stored) : { lastCopied: null, lastError: null };
  } catch {
    return { lastCopied: null, lastError: null };
  }
}

async function remember(next: Stored): Promise<void> {
  await getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(STATUS_KEY, JSON.stringify(next));
}

export async function offsiteStatus(): Promise<OffsiteStatus> {
  const config = offsiteConfig();
  const { lastCopied, lastError } = await stored();
  const why = config ? offsiteTransferPause() : null;
  return {
    configured: config !== null,
    destination: config ? `${config.endpoint}/${config.bucket}/${config.prefix}` : null,
    location: process.env.OFFSITE_DATA_LOCATION?.trim().toUpperCase() || null,
    endpointSays: config ? endpointLocation(config.endpoint) : null,
    paused: why && englishOf(why),
    pausedPhrase: why,
    lastCopied,
    lastError,
  };
}

/**
 * Copy a backup set off-site if that is set up, and write down how it went —
 * so a copy that has been failing quietly for a week is a red line on the
 * Backups panel, not a surprise on the day it is needed. The photos and the
 * database go first and the manifest last: a manifest in the bucket means
 * every part it names was accepted, so a half-sent set is recognisable as one.
 */
export async function copyOffsite(
  backup: Pick<BackupFile, "name" | "path">,
  /** The snapshot's photos archive (lib/backup.ts): a copy is not whole without it. */
  photos?: string | null,
  /** The set's manifest (lib/backup.ts), sent last. */
  manifest?: string | null
): Promise<UploadResult | null> {
  const config = offsiteConfig();
  if (!config) return null;
  const paused = offsiteTransferCheck();
  if (paused) return await rememberCopy(backup, { ok: false, error: paused }, Boolean(manifest), false);
  // Encrypted before it leaves, where a public key is given: the database and photos as `<name>.enc`; the
  // manifest (hashes and counts, no personal data) stays readable, marked so a restore knows to decrypt.
  const publicKey = readKeyFile(process.env.OFFSITE_ENCRYPTION_PUBLIC_KEY_FILE);
  const scratch = publicKey ? fs.mkdtempSync(path.join(os.tmpdir(), "mysenam-offsite-")) : null;
  let signScratch: string | null = null;
  try {
    const prepare = async (file: Pick<BackupFile, "name" | "path">): Promise<Pick<BackupFile, "name" | "path">> => {
      if (!publicKey || !scratch) return file;
      const sealed = path.join(scratch, `${file.name}.enc`);
      await encryptFile(file.path, sealed, publicKey);
      return { name: `${file.name}.enc`, path: sealed };
    };
    let manifestFile: Pick<BackupFile, "name" | "path"> | null = manifest ? { name: path.basename(manifest), path: manifest } : null;
    if (manifestFile && scratch) {
      const marked = path.join(scratch, manifestFile.name);
      fs.writeFileSync(marked, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestFile.path, "utf8")), offsite: { encrypted: "rsa-oaep-sha256+aes-256-gcm" } }, null, 2));
      manifestFile = { name: manifestFile.name, path: marked };
    }
    // The manifest signed, where a signing key is given: a detached signature, sent just before the manifest.
    const signingKey = readKeyFile(process.env.OFFSITE_SIGNING_KEY_FILE);
    let signatureFile: Pick<BackupFile, "name" | "path"> | null = null;
    if (manifestFile && signingKey) {
      const dir = scratch ?? fs.mkdtempSync(path.join(os.tmpdir(), "mysenam-offsite-"));
      signScratch = scratch ? null : dir;
      signatureFile = { name: `${manifestFile.name}.sig`, path: path.join(dir, `${manifestFile.name}.sig`) };
      fs.writeFileSync(signatureFile.path, JSON.stringify(signBytes(fs.readFileSync(manifestFile.path), signingKey)));
    }
    const parts: { label: string; file: Pick<BackupFile, "name" | "path"> }[] = [
      ...(photos ? [{ label: "photos", file: await prepare({ name: path.basename(photos), path: photos }) }] : []),
      { label: "database", file: await prepare(backup) },
      ...(signatureFile ? [{ label: "signature", file: signatureFile }] : []),
      ...(manifestFile ? [{ label: "manifest", file: manifestFile }] : []),
    ];
    const largest = Math.max(...parts.map((p) => fs.statSync(p.file.path).size));
    let result: UploadResult = { ok: false, error: "nothing sent" };
    for (const part of parts) {
      const sent = await uploadBackup(part.file, config);
      result = sent.ok || part.label === "database" ? sent : { ok: false, error: `${part.label}: ${sent.error}` };
      if (!sent.ok) break;
    }
    if (result.ok) result = { ok: true, key: config.prefix + parts.find((p) => p.label === "database")!.file.name, bytes: parts.reduce((n, p) => n + fs.statSync(p.file.path).size, 0) };
    return await rememberCopy(backup, result, Boolean(manifest), Boolean(publicKey), { signed: Boolean(signatureFile), largestBytes: largest });
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    if (signScratch) fs.rmSync(signScratch, { recursive: true, force: true });
  }
}

/** A part this much of the single-upload limit is close to it: the Backups panel and an alert say so before it is refused. */
export const NEAR_LIMIT = 0.8;

async function rememberCopy(
  backup: Pick<BackupFile, "name" | "path">,
  result: UploadResult,
  manifest: boolean,
  encrypted: boolean,
  more: { signed?: boolean; largestBytes?: number } = {}
): Promise<UploadResult> {
  const now = new Date().toISOString();
  const previous = await stored();
  await remember(
    result.ok
      ? { lastCopied: { name: backup.name, at: now, key: result.key, manifest, encrypted, ...more }, lastError: null }
      : { lastCopied: previous.lastCopied, lastError: { at: now, error: result.error } }
  );
  return result;
}

// ------------------------------------------------------------- reading back

/**
 * Reading the bucket is for whoever restores, on the machine they restore
 * on, with a key that may read: the server's own key need only upload
 * (above). These sign a GET the same way as the upload.
 */
function signedGet(config: OffsiteConfig, url: URL, now = new Date()): Record<string, string> {
  const payloadHash = hex("");
  const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate(now) };
  headers.authorization = signV4({
    method: "GET",
    url,
    headers,
    payloadHash,
    region: config.region,
    service: "s3",
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    now,
  });
  return headers;
}

function refusal(status: number | undefined, reply: string, what: string): string {
  const code = reply.match(/<Code>([^<]+)<\/Code>/)?.[1];
  const message = reply.match(/<Message>([^<]+)<\/Message>/)?.[1];
  return `Storage refused the ${what} (${status}${code ? ` ${code}` : ""})${message ? `: ${message}` : ""}`;
}

function get(config: OffsiteConfig, url: URL): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === "http:" ? http.get : https.get;
    const req = send(url, { headers: signedGet(config, url), timeout: 10 * 60_000 }, resolve);
    req.on("timeout", () => req.destroy(new Error("The download timed out.")));
    req.on("error", reject);
  });
}

export interface OffsiteObject {
  /** Its name under the prefix, as it was uploaded. */
  name: string;
  bytes: number;
  lastModified: string;
  /**
   * Written more than once, or hidden or deleted since: the server writes
   * each name once, so a second version is somebody else's. Only known where
   * the bucket's versions can be listed.
   */
  rewritten?: boolean;
}

export interface OffsiteVersion {
  name: string;
  versionId: string;
  bytes: number;
  lastModified: string;
  /** A delete marker (S3) or hide marker (B2): a name made to look gone. */
  marker: boolean;
}

/**
 * Every version of everything under the prefix (ListObjectVersions), each
 * name's newest first, as S3 lists them. Null where the bucket keeps no
 * versions (R2) or the read key may not list them: a restore then has only
 * the current copy of each name to go on.
 */
export async function listOffsiteVersions(config: OffsiteConfig): Promise<OffsiteVersion[] | null> {
  const found: OffsiteVersion[] = [];
  let keyMarker: string | null = null;
  let versionMarker: string | null = null;
  do {
    const url = new URL(`${config.endpoint}/${encodeSegment(config.bucket)}`);
    url.searchParams.set("versions", "");
    url.searchParams.set("prefix", config.prefix);
    if (keyMarker) url.searchParams.set("key-marker", keyMarker);
    if (versionMarker) url.searchParams.set("version-id-marker", versionMarker);
    const res = await get(config, url);
    let reply = "";
    for await (const chunk of res) reply += chunk;
    if (!res.statusCode || res.statusCode >= 300) return null;
    for (const [, kind, block] of reply.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)) {
      const key = unescapeXml(block.match(/<Key>([^<]+)<\/Key>/)?.[1] ?? "");
      found.push({
        name: key.slice(config.prefix.length),
        versionId: block.match(/<VersionId>([^<]+)<\/VersionId>/)?.[1] ?? "null",
        bytes: Number(block.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0),
        lastModified: block.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] ?? "",
        marker: kind === "DeleteMarker",
      });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(reply);
    keyMarker = truncated ? unescapeXml(reply.match(/<NextKeyMarker>([^<]+)<\/NextKeyMarker>/)?.[1] ?? "") || null : null;
    versionMarker = truncated ? reply.match(/<NextVersionIdMarker>([^<]+)<\/NextVersionIdMarker>/)?.[1] ?? null : null;
  } while (keyMarker);
  return found;
}

const unescapeXml = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Each name's first upload, and whether anything came after it. */
function firstVersions(versions: OffsiteVersion[]): Map<string, { first: OffsiteVersion | null; rewritten: boolean }> {
  const byName = new Map<string, OffsiteVersion[]>();
  for (const v of versions) byName.set(v.name, [...(byName.get(v.name) ?? []), v]);
  return new Map(
    [...byName].map(([name, all]) => {
      const uploads = all.filter((v) => !v.marker);
      // Listed newest first, so the last upload listed is the first made.
      return [name, { first: uploads.at(-1) ?? null, rewritten: all.length > 1 }];
    })
  );
}

/**
 * What is in the bucket under this install's prefix, oldest name first: from
 * the versions where they can be listed — so a name hidden or written over
 * by somebody with the upload key still shows, flagged — otherwise from
 * ListObjectsV2.
 */
export async function listOffsite(config: OffsiteConfig): Promise<OffsiteObject[]> {
  const versions = await listOffsiteVersions(config);
  if (versions) {
    return [...firstVersions(versions)]
      .filter(([, v]) => v.first)
      .map(([name, v]) => ({ name, bytes: v.first!.bytes, lastModified: v.first!.lastModified, rewritten: v.rewritten }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  const found: OffsiteObject[] = [];
  let token: string | null = null;
  do {
    const url = new URL(`${config.endpoint}/${encodeSegment(config.bucket)}`);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", config.prefix);
    if (token) url.searchParams.set("continuation-token", token);
    const res = await get(config, url);
    let reply = "";
    for await (const chunk of res) reply += chunk;
    if (!res.statusCode || res.statusCode >= 300) throw new Error(refusal(res.statusCode, reply, "listing"));
    for (const [, block] of reply.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = block.match(/<Key>([^<]+)<\/Key>/)?.[1] ?? "";
      found.push({
        name: unescapeXml(key).slice(config.prefix.length),
        bytes: Number(block.match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0),
        lastModified: block.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] ?? "",
      });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(reply) ? reply.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? null : null;
  } while (token);
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Download one object (a given version of it, if named) to a file, through a temporary name: a cut-off download leaves nothing that looks whole. */
export async function downloadObject(config: OffsiteConfig, name: string, dest: string, versionId?: string): Promise<void> {
  const url = objectUrl(config, name);
  if (versionId && versionId !== "null") url.searchParams.set("versionId", versionId);
  const res = await get(config, url);
  if (!res.statusCode || res.statusCode >= 300) {
    let reply = "";
    for await (const chunk of res) reply += chunk;
    throw new Error(refusal(res.statusCode, reply, `download of ${name}`));
  }
  const temporary = path.join(path.dirname(dest), `.tmp-${path.basename(dest)}`);
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(temporary);
    res.on("error", reject).pipe(out).on("error", reject).on("finish", () => resolve());
  });
  fs.renameSync(temporary, dest);
}

export interface FetchedSet {
  snapshot: string;
  files: string[];
  /** Whether the bucket's versions could be listed, so each part is its first upload. */
  versioned: boolean;
  /** Names written more than once, or hidden, since the server uploaded them: the first upload was used. */
  rewritten: string[];
  /** "verified": the manifest carries the signature of the server's key; "unchecked": no public key given to check it with. */
  signature: "verified" | "unchecked";
  /** When the manifest was first uploaded, where versions can be listed. */
  firstUploadedAt: string | null;
  /** First uploaded much later than the manifest says the set was made: perhaps not the server's own. */
  uploadedLate: boolean;
}

/** A set is copied off-site straight after it is made; one first uploaded later than this after its own time is suspect. */
const LATE_UPLOAD_HOURS = 6;

/**
 * Bring one backup set down from the bucket into a folder: its manifest
 * first, then every part the manifest names. Checking that the parts hash to
 * what the manifest says is `verifyBackupSet` (lib/backup.ts), which the
 * restore script runs before anything is restored.
 *
 * Where the bucket keeps versions, each name is fetched as first uploaded.
 * The server writes every name once, so a later version came from somebody
 * else — perhaps with a stolen upload key, which can write over a name
 * (and, holding the public key, even write a whole consistent fake set) but
 * not remove what Object Lock keeps. Such names are reported.
 */
export async function fetchOffsiteSet(config: OffsiteConfig, snapshot: string, dir: string): Promise<FetchedSet> {
  fs.mkdirSync(dir, { recursive: true });
  const manifestName = snapshot.replace(/\.(dump|tar\.gz)$/, ".manifest.json");
  const files: string[] = [];
  const listed = await listOffsiteVersions(config);
  const firsts = listed ? firstVersions(listed) : null;
  const rewritten: string[] = [];
  const fetchOne = async (name: string, dest: string) => {
    if (!firsts) return downloadObject(config, name, dest);
    const found = firsts.get(name);
    if (!found?.first) throw new Error(`${name} is not in the bucket${found ? " (only a delete or hide marker is)" : ""}.`);
    if (found.rewritten) rewritten.push(name);
    await downloadObject(config, name, dest, found.first.versionId);
  };
  const manifestFile = path.join(dir, manifestName);
  await fetchOne(manifestName, manifestFile);
  files.push(manifestFile);
  // Signed by the server's key, where the restore machine holds its public half: a set somebody else uploaded is refused.
  const signingPublic = readKeyFile(process.env.OFFSITE_SIGNING_PUBLIC_KEY_FILE);
  if (signingPublic) {
    const sigFile = path.join(dir, `${manifestName}.sig`);
    try {
      await fetchOne(`${manifestName}.sig`, sigFile);
    } catch {
      throw new Error("This set's manifest has no signature, and OFFSITE_SIGNING_PUBLIC_KEY_FILE asks for one: it may not be a set the server made.");
    }
    const signed = JSON.parse(fs.readFileSync(sigFile, "utf8")) as unknown;
    fs.rmSync(sigFile, { force: true });
    if (!signatureValid(fs.readFileSync(manifestFile), signed, signingPublic))
      throw new Error("This set's manifest is not signed by the server's key (OFFSITE_SIGNING_PUBLIC_KEY_FILE): it may not be a set the server made. Choose an earlier set.");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as {
    createdAt?: string;
    database: { file: string };
    photos: { file: string } | null;
    offsite?: { encrypted?: string };
  };
  const firstUploadedAt = firsts?.get(manifestName)?.first?.lastModified || null;
  const madeAt = manifest.createdAt ? Date.parse(manifest.createdAt) : NaN;
  const uploadedLate = firstUploadedAt !== null && !Number.isNaN(madeAt) && Date.parse(firstUploadedAt) - madeAt > LATE_UPLOAD_HOURS * 3_600_000;
  if (manifest.database.file !== snapshot) throw new Error(`The manifest in the bucket is for ${manifest.database.file}, not ${snapshot}.`);
  const privateKey = manifest.offsite?.encrypted ? readKeyFile(process.env.OFFSITE_ENCRYPTION_PRIVATE_KEY_FILE) : null;
  if (manifest.offsite?.encrypted && !privateKey)
    throw new Error("This set was encrypted before upload: set OFFSITE_ENCRYPTION_PRIVATE_KEY_FILE to the private key to decrypt it.");
  for (const part of [manifest.database.file, ...(manifest.photos ? [manifest.photos.file] : [])]) {
    const dest = path.join(dir, part);
    if (privateKey) {
      // Fetched encrypted, then opened; the plain file is what the manifest's hashes are checked against.
      const sealed = `${dest}.enc`;
      await fetchOne(`${part}.enc`, sealed);
      await decryptFile(sealed, dest, privateKey);
      fs.rmSync(sealed, { force: true });
    } else await fetchOne(part, dest);
    files.push(dest);
  }
  return {
    snapshot: path.join(dir, snapshot),
    files,
    versioned: firsts !== null,
    rewritten,
    signature: signingPublic ? "verified" : "unchecked",
    firstUploadedAt,
    uploadedLate,
  };
}
