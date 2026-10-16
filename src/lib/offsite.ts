import crypto from "crypto";
import fs from "fs";
import http from "http";
import https from "https";
import { getDb } from "./db";
import type { BackupFile } from "./backup";

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

export function offsiteConfig(): OffsiteConfig | null {
  const endpoint = process.env.OFFSITE_S3_ENDPOINT;
  const bucket = process.env.OFFSITE_S3_BUCKET;
  const accessKeyId = process.env.OFFSITE_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.OFFSITE_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    bucket,
    // R2 accepts "auto"; S3 and B2 want the bucket's real region.
    region: process.env.OFFSITE_S3_REGION || "auto",
    accessKeyId,
    secretAccessKey,
    prefix: process.env.OFFSITE_S3_PREFIX ?? "mysenam/",
  };
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

/** The file's SHA-256, read in pieces: a database can be bigger than the memory there is. */
function fileHash(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Where a backup goes in the bucket, path-style, which every S3 workalike accepts. */
export function objectUrl(config: OffsiteConfig, name: string): URL {
  return new URL(`${config.endpoint}/${encodeSegment(config.bucket)}/${canonicalPath(config.prefix + name)}`);
}

export type UploadResult = { ok: true; key: string; bytes: number } | { ok: false; error: string };

/**
 * Send one snapshot. The body is streamed from disk, and its hash is signed,
 * so the storage service itself refuses a copy that arrived damaged.
 */
export async function uploadBackup(
  backup: Pick<BackupFile, "name" | "path">,
  config: OffsiteConfig,
  now = new Date()
): Promise<UploadResult> {
  let bytes: number;
  let payloadHash: string;
  try {
    bytes = fs.statSync(backup.path).size;
    payloadHash = await fileHash(backup.path);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Cannot read the backup" };
  }

  const url = objectUrl(config, backup.name);
  const headers: Record<string, string> = {
    host: url.host,
    "content-length": String(bytes),
    "content-type": "application/vnd.sqlite3",
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate(now),
  };
  headers.authorization = signV4({
    method: "PUT",
    url,
    headers,
    payloadHash,
    region: config.region,
    service: "s3",
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    now,
  });

  const key = config.prefix + backup.name;
  return new Promise((resolve) => {
    const send = url.protocol === "http:" ? http.request : https.request;
    const req = send(url, { method: "PUT", headers, timeout: 10 * 60_000 }, (res) => {
      let reply = "";
      res.on("data", (chunk) => (reply += chunk));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300)
          resolve({ ok: true, key, bytes });
        else {
          const code = reply.match(/<Code>([^<]+)<\/Code>/)?.[1];
          const message = reply.match(/<Message>([^<]+)<\/Message>/)?.[1];
          resolve({
            ok: false,
            error: `Storage refused the upload (${res.statusCode}${code ? ` ${code}` : ""})${message ? `: ${message}` : ""}`,
          });
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("The upload timed out.")));
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    fs.createReadStream(backup.path)
      .on("error", (err) => req.destroy(err))
      .pipe(req);
  });
}

// ------------------------------------------------------------- remembering

export interface OffsiteStatus {
  configured: boolean;
  /** Where copies go, without the credentials. */
  destination: string | null;
  lastCopied: { name: string; at: string; key: string } | null;
  lastError: { at: string; error: string } | null;
}

const STATUS_KEY = "offsite_status";

interface Stored {
  lastCopied: OffsiteStatus["lastCopied"];
  lastError: OffsiteStatus["lastError"];
}

function stored(): Stored {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(STATUS_KEY) as
    | { value: string }
    | undefined;
  try {
    return row ? (JSON.parse(row.value) as Stored) : { lastCopied: null, lastError: null };
  } catch {
    return { lastCopied: null, lastError: null };
  }
}

function remember(next: Stored): void {
  getDb()
    .prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(STATUS_KEY, JSON.stringify(next));
}

export function offsiteStatus(): OffsiteStatus {
  const config = offsiteConfig();
  const { lastCopied, lastError } = stored();
  return {
    configured: config !== null,
    destination: config ? `${config.endpoint}/${config.bucket}/${config.prefix}` : null,
    lastCopied,
    lastError,
  };
}

/**
 * Copy a snapshot off-site if that is set up, and write down how it went —
 * so a copy that has been failing quietly for a week is a red line on the
 * Backups panel, not a surprise on the day it is needed.
 */
export async function copyOffsite(
  backup: Pick<BackupFile, "name" | "path">
): Promise<UploadResult | null> {
  const config = offsiteConfig();
  if (!config) return null;
  const result = await uploadBackup(backup, config);
  const now = new Date().toISOString();
  const previous = stored();
  remember(
    result.ok
      ? { lastCopied: { name: backup.name, at: now, key: result.key }, lastError: null }
      : { lastCopied: previous.lastCopied, lastError: { at: now, error: result.error } }
  );
  return result;
}
