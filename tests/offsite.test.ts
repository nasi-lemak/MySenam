import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";

process.env.MYSENAM_DB = ":memory:";

import {
  amzDate,
  copyOffsite,
  endpointLocation,
  fetchOffsiteSet,
  listOffsite,
  MAX_PARTS,
  MAX_UPLOAD,
  objectUrl,
  offsiteConfig,
  offsiteReadConfig,
  offsiteStatus,
  offsiteTransferCheck,
  signV4,
  uploadBackup,
} from "../src/lib/offsite";
import { createBackup, verifyBackupSet } from "../src/lib/backup";
import { keyIdOf, signatureValid, signBytes } from "../src/lib/backup-crypto";
import { getDb } from "../src/lib/db";
import type { OffsiteConfig } from "../src/lib/offsite";

/**
 * Off-site copies, sent to a stand-in storage server on this machine.
 *
 * The signature is pinned to the worked example in Amazon's own S3
 * documentation, so a signer that only agrees with itself still fails.
 */

describe("Signature Version 4", () => {
  it("matches Amazon's worked example for GET Object", () => {
    // From "Signature Calculations for the Authorization Header: Transferring
    // Payload in a Single Chunk", Amazon S3 API reference.
    const url = new URL("https://examplebucket.s3.amazonaws.com/test.txt");
    const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const auth = signV4({
      method: "GET",
      url,
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        range: "bytes=0-9",
        "x-amz-content-sha256": emptyHash,
        "x-amz-date": "20130524T000000Z",
      },
      payloadHash: emptyHash,
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(auth).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    );
  });

  it("writes the date the way AWS wants it", () => {
    expect(amzDate(new Date("2026-10-16T03:04:05.678Z"))).toBe("20261016T030405Z");
  });
});

describe("where a copy goes", () => {
  const config: OffsiteConfig = {
    endpoint: "https://acct.r2.cloudflarestorage.com",
    bucket: "venue-backups",
    region: "auto",
    accessKeyId: "id",
    secretAccessKey: "secret",
    prefix: "mysenam/",
  };

  it("is path-style, under the prefix", () => {
    expect(objectUrl(config, "mysenam-2026-10-16-030000.db").toString()).toBe(
      "https://acct.r2.cloudflarestorage.com/venue-backups/mysenam/mysenam-2026-10-16-030000.db"
    );
  });

  it("is off until all four settings are there", () => {
    const keys = [
      "OFFSITE_S3_ENDPOINT",
      "OFFSITE_S3_BUCKET",
      "OFFSITE_S3_ACCESS_KEY_ID",
      "OFFSITE_S3_SECRET_ACCESS_KEY",
    ];
    const saved = keys.map((k) => process.env[k]);
    try {
      for (const k of keys) delete process.env[k];
      expect(offsiteConfig()).toBeNull();
      process.env.OFFSITE_S3_ENDPOINT = "https://s3.example.com/";
      process.env.OFFSITE_S3_BUCKET = "b";
      process.env.OFFSITE_S3_ACCESS_KEY_ID = "i";
      expect(offsiteConfig()).toBeNull();
      process.env.OFFSITE_S3_SECRET_ACCESS_KEY = "s";
      expect(offsiteConfig()).toMatchObject({ endpoint: "https://s3.example.com", region: "auto" });
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  });

  it("reads the provider, region and country from a B2, S3 or R2 endpoint, and signs for that region by default", () => {
    expect(endpointLocation("https://s3.us-west-004.backblazeb2.com")).toEqual({ provider: "Backblaze B2", region: "us-west-004", country: "US" });
    expect(endpointLocation("https://s3.us-east-005.backblazeb2.com/")).toEqual({ provider: "Backblaze B2", region: "us-east-005", country: "US" });
    expect(endpointLocation("https://s3.eu-central-003.backblazeb2.com")).toMatchObject({ country: "NL" });
    expect(endpointLocation("https://s3.ap-southeast-5.amazonaws.com")).toEqual({ provider: "Amazon S3", region: "ap-southeast-5", country: "MY" });
    expect(endpointLocation("https://s3.ap-southeast-1.amazonaws.com")).toMatchObject({ country: "SG" });
    // R2 does not say where it keeps data in its address.
    expect(endpointLocation("https://acct.r2.cloudflarestorage.com")).toEqual({ provider: "Cloudflare R2", region: "auto", country: null });
    expect(endpointLocation("https://s3.example.com")).toBeNull();
    // A B2 region not known to this code: the provider is named, the country is not guessed.
    expect(endpointLocation("https://s3.ap-south-009.backblazeb2.com")).toEqual({ provider: "Backblaze B2", region: "ap-south-009", country: null });

    const saved = { ...process.env };
    try {
      process.env.OFFSITE_S3_ENDPOINT = "https://s3.us-west-004.backblazeb2.com";
      process.env.OFFSITE_S3_BUCKET = "b";
      process.env.OFFSITE_S3_ACCESS_KEY_ID = "i";
      process.env.OFFSITE_S3_SECRET_ACCESS_KEY = "s";
      delete process.env.OFFSITE_S3_REGION;
      expect(offsiteConfig()?.region).toBe("us-west-004");
      process.env.OFFSITE_S3_REGION = "us-west-004";
      expect(offsiteConfig()?.region).toBe("us-west-004");
    } finally {
      for (const k of Object.keys(process.env)) if (k.startsWith("OFFSITE_") && !(k in saved)) delete process.env[k];
    }
  });

  it("pauses when the endpoint's country is not the one declared: a typed country is checked against the address", async () => {
    try {
      process.env.OFFSITE_S3_ENDPOINT = "https://s3.us-west-004.backblazeb2.com";
      process.env.OFFSITE_S3_BUCKET = "b";
      process.env.OFFSITE_S3_ACCESS_KEY_ID = "i";
      process.env.OFFSITE_S3_SECRET_ACCESS_KEY = "s";
      process.env.OFFSITE_DATA_LOCATION = "MY";
      expect(offsiteTransferCheck()).toMatch(/Backblaze B2 us-west-004, in US, but OFFSITE_DATA_LOCATION says MY/);
      expect(await offsiteStatus()).toMatchObject({ paused: expect.stringMatching(/in US/), endpointSays: { provider: "Backblaze B2", country: "US" } });
      process.env.OFFSITE_DATA_LOCATION = "US";
      expect(offsiteTransferCheck()).toMatch(/OFFSITE_TRANSFER_APPROVED=US/);
    } finally {
      for (const k of Object.keys(process.env)) if (k.startsWith("OFFSITE_")) delete process.env[k];
    }
  });
});

describe("manifest signatures", () => {
  it("are Ed25519 over the manifest's bytes, checked against the public key alone", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
    const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const bytes = Buffer.from('{"database":{"file":"x.db"}}');
    const signed = signBytes(bytes, priv);
    expect(signed).toMatchObject({ alg: "ed25519", keyId: keyIdOf(pub) });
    expect(signatureValid(bytes, signed, pub)).toBe(true);
    expect(signatureValid(Buffer.from('{"database":{"file":"y.db"}}'), signed, pub)).toBe(false);
    const other = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(signatureValid(bytes, signed, other)).toBe(false);
    expect(signatureValid(bytes, { ...signed, signature: "AAAA" }, pub)).toBe(false);
    expect(signatureValid(bytes, "nonsense", pub)).toBe(false);
    // Only an Ed25519 key signs: an RSA key given by mistake is refused, not used.
    const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => signBytes(bytes, rsa)).toThrow(/Ed25519/i);
  });
});

describe("sending a copy", () => {
  let server: http.Server;
  let port = 0;
  let dir: string;
  let file: string;
  let reply: { status: number; body: string } = { status: 200, body: "" };
  const received: { url: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-"));
    file = path.join(dir, "mysenam-2026-10-16-030000.db");
    fs.writeFileSync(file, crypto.randomBytes(300_000));
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.push({ url: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(reply.status, { "content-type": "application/xml" });
        res.end(reply.body);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    received.length = 0;
    reply = { status: 200, body: "" };
    for (const k of Object.keys(process.env)) if (k.startsWith("OFFSITE_")) delete process.env[k];
  });

  const config = (): OffsiteConfig => ({
    endpoint: `http://127.0.0.1:${port}`,
    bucket: "backups",
    region: "us-east-1",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "secret",
    prefix: "venue/",
  });

  it("puts the whole file, signed over its own hash", async () => {
    const now = new Date("2026-10-16T03:00:00Z");
    const result = await uploadBackup({ name: path.basename(file), path: file }, config(), now);
    expect(result).toEqual({ ok: true, key: "venue/mysenam-2026-10-16-030000.db", bytes: 300_000 });

    const [put] = received;
    expect(put.url).toBe("/backups/venue/mysenam-2026-10-16-030000.db");
    expect(put.body.equals(fs.readFileSync(file))).toBe(true);
    const hash = crypto.createHash("sha256").update(put.body).digest("hex");
    expect(put.headers["x-amz-content-sha256"]).toBe(hash);
    expect(put.headers["content-length"]).toBe("300000");
    // Content-MD5 too: a bucket with Object Lock requires it, and the service checks the body against it.
    const md5 = crypto.createHash("md5").update(put.body).digest("base64");
    expect(put.headers["content-md5"]).toBe(md5);

    // The storage service would recompute this; so do we.
    const url = new URL(`http://127.0.0.1:${port}${put.url}`);
    const expected = signV4({
      method: "PUT",
      url,
      headers: {
        host: put.headers.host!,
        "content-length": "300000",
        "content-md5": md5,
        "content-type": "application/octet-stream",
        "x-amz-content-sha256": hash,
        "x-amz-date": "20261016T030000Z",
      },
      payloadHash: hash,
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      now,
    });
    expect(put.headers.authorization).toBe(expected);
  });

  it("says what the storage service objected to", async () => {
    reply = {
      status: 403,
      body: "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>",
    };
    const result = await uploadBackup({ name: path.basename(file), path: file }, config());
    expect(result).toEqual({
      ok: false,
      error: "Storage refused the upload (403 AccessDenied): Access Denied",
    });
  });

  it("says so when the file has gone", async () => {
    const result = await uploadBackup({ name: "gone.db", path: path.join(dir, "gone.db") }, config());
    expect(result.ok).toBe(false);
  });

  it("remembers the last copy, and the last failure, for the Backups panel", async () => {
    process.env.OFFSITE_S3_ENDPOINT = `http://127.0.0.1:${port}`;
    process.env.OFFSITE_S3_BUCKET = "backups";
    process.env.OFFSITE_S3_ACCESS_KEY_ID = "id";
    process.env.OFFSITE_S3_SECRET_ACCESS_KEY = "secret";
    process.env.OFFSITE_DATA_LOCATION = "MY";

    const ok = await copyOffsite({ name: path.basename(file), path: file });
    expect(ok?.ok).toBe(true);
    let status = await offsiteStatus();
    expect(status.configured).toBe(true);
    expect(status.lastCopied?.name).toBe(path.basename(file));
    expect(status.lastError).toBeNull();
    expect(JSON.stringify(status)).not.toContain("secret");

    reply = { status: 500, body: "<Error><Code>InternalError</Code></Error>" };
    await copyOffsite({ name: path.basename(file), path: file });
    status = await offsiteStatus();
    // The last good copy is still the last good copy.
    expect(status.lastCopied?.name).toBe(path.basename(file));
    expect(status.lastError?.error).toMatch(/500 InternalError/);
  });

  it("sends a snapshot's photos with it, and counts the copy failed if they do not go (S10)", async () => {
    process.env.OFFSITE_S3_ENDPOINT = `http://127.0.0.1:${port}`;
    process.env.OFFSITE_S3_BUCKET = "backups";
    process.env.OFFSITE_S3_ACCESS_KEY_ID = "id";
    process.env.OFFSITE_S3_SECRET_ACCESS_KEY = "secret";
    process.env.OFFSITE_DATA_LOCATION = "MY";
    const photos = path.join(dir, "mysenam-2026-10-16-030000.photos.tar.gz");
    fs.writeFileSync(photos, crypto.randomBytes(1_000));

    expect((await copyOffsite({ name: path.basename(file), path: file }, photos))?.ok).toBe(true);
    expect(received.map((r) => path.posix.basename(r.url))).toEqual(["mysenam-2026-10-16-030000.photos.tar.gz", "mysenam-2026-10-16-030000.db"]);
    expect(received[0].body.equals(fs.readFileSync(photos))).toBe(true);

    // The photos refused: the snapshot is not sent alone as if it were whole.
    received.length = 0;
    reply = { status: 403, body: "<Error><Code>AccessDenied</Code></Error>" };
    const failed = await copyOffsite({ name: path.basename(file), path: file }, photos);
    expect(failed?.ok).toBe(false);
    expect(failed && !failed.ok && failed.error).toMatch(/^photos: /);
    expect(received).toHaveLength(1);
    expect((await offsiteStatus()).lastError?.error).toMatch(/photos/);
  });

  it("sends nothing until the bucket's country is known, and nothing abroad until the transfer is approved and encrypted", async () => {
    process.env.OFFSITE_S3_ENDPOINT = `http://127.0.0.1:${port}`;
    process.env.OFFSITE_S3_BUCKET = "backups";
    process.env.OFFSITE_S3_ACCESS_KEY_ID = "id";
    process.env.OFFSITE_S3_SECRET_ACCESS_KEY = "secret";
    const copy = () => copyOffsite({ name: path.basename(file), path: file });

    expect(offsiteTransferCheck()).toMatch(/OFFSITE_DATA_LOCATION/);
    expect(await copy()).toMatchObject({ ok: false, error: expect.stringMatching(/paused until OFFSITE_DATA_LOCATION/) });
    expect(await offsiteStatus()).toMatchObject({ location: null, paused: expect.stringMatching(/OFFSITE_DATA_LOCATION/) });

    // A bucket in the United States, for a Malaysian install: a transfer abroad.
    process.env.OFFSITE_DATA_LOCATION = "us";
    expect(await copy()).toMatchObject({ ok: false, error: expect.stringMatching(/keeps data in US, outside Malaysia.*OFFSITE_TRANSFER_APPROVED=US/) });
    process.env.OFFSITE_TRANSFER_APPROVED = "SG";
    expect(offsiteTransferCheck()).toMatch(/OFFSITE_TRANSFER_APPROVED=US/);
    process.env.OFFSITE_TRANSFER_APPROVED = "US";
    expect(await copy()).toMatchObject({ ok: false, error: expect.stringMatching(/must be encrypted first/) });
    expect(received).toHaveLength(0);

    // At home, it goes; encryption is then the install's choice.
    process.env.OFFSITE_DATA_LOCATION = "MY";
    expect(offsiteTransferCheck()).toBeNull();
    expect((await copy())?.ok).toBe(true);
    expect(await offsiteStatus()).toMatchObject({ location: "MY", paused: null });
  });

  it("does nothing when it is not set up", async () => {
    expect(await copyOffsite({ name: path.basename(file), path: file })).toBeNull();
    expect(received).toHaveLength(0);
  });
});

/**
 * A stand-in for a Backblaze B2 bucket reached through its S3-compatible
 * API, behaving as B2 is documented to: application keys with capabilities
 * (writeFiles; listFiles and readFiles), restricted to a bucket and a name
 * prefix; Object Lock on, so an upload without Content-MD5 is refused and
 * nothing is ever deleted; every upload kept as a version; SigV4 checked
 * against each key's secret and the bucket's region. It is not B2: what it
 * shows is that the app asks only for what such keys allow. A test against
 * a real bucket is in the launch checklist.
 */
describe("a Backblaze B2 bucket (stand-in): upload-only key, separate read key, Object Lock, encryption", () => {
  const REGION = "us-west-004";
  const keys: Record<string, { secret: string; capabilities: string[]; prefix: string }> = {
    "004writeonly": { secret: "write-secret", capabilities: ["writeFiles"], prefix: "venue-a/" },
    "004readlist": { secret: "read-secret", capabilities: ["listFiles", "readFiles", "readFileRetentions"], prefix: "venue-a/" },
  };
  const versions = new Map<string, Buffer[]>();
  /** When each version was uploaded, by the bucket's clock; shifted to stand for an upload made hours later. */
  const stamps = new Map<string, string[]>();
  let clockAheadHours = 0;
  /** Off, the bucket answers a versions listing as R2 does: not implemented. */
  let listsVersions = true;
  /** Multipart uploads under way: their name and parts so far. */
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  /** A part number the bucket will find damaged (its MD5 not matching). */
  let damagePart = 0;
  const log: { method: string; key: string; path: string }[] = [];
  let server: http.Server;
  let endpoint = "";
  let work = "";
  let publicKeyFile = "";
  let privateKeyFile = "";

  const deny = (res: http.ServerResponse, status: number, code: string, message: string) =>
    res.writeHead(status, { "content-type": "application/xml" }).end(`<Error><Code>${code}</Code><Message>${message}</Message></Error>`);

  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "b2-"));
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 });
    publicKeyFile = path.join(work, "offsite-public.pem");
    privateKeyFile = path.join(work, "offsite-private.pem");
    fs.writeFileSync(publicKeyFile, publicKey.export({ type: "spki", format: "pem" }));
    fs.writeFileSync(privateKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const url = new URL(req.url!, "http://stand-in");
        const auth = String(req.headers.authorization ?? "");
        const m = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/.exec(auth);
        if (!m || !keys[m[1]]) return deny(res, 403, "InvalidAccessKeyId", "Unknown key");
        const [, id, , region, signed] = m;
        log.push({ method: req.method!, key: id, path: url.pathname });
        if (region !== REGION) return deny(res, 400, "AuthorizationHeaderMalformed", "Wrong region");
        // The signature, recomputed from the headers the request says it signed.
        const headers = Object.fromEntries(signed.split(";").map((h) => [h, String(req.headers[h] ?? "")]));
        const expected = signV4({
          method: req.method!,
          url: new URL(`${endpoint}${req.url}`),
          headers,
          payloadHash: String(req.headers["x-amz-content-sha256"]),
          region,
          service: "s3",
          accessKeyId: id,
          secretAccessKey: keys[id].secret,
          now: new Date(`${String(req.headers["x-amz-date"]).replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, "$1-$2-$3T$4:$5:$6Z")}`),
        });
        if (expected !== auth) return deny(res, 403, "SignatureDoesNotMatch", "Bad signature");
        const key = keys[id];
        const objectKey = decodeURIComponent(url.pathname.replace(/^\/backups\//, ""));
        if (req.method === "PUT" && url.searchParams.has("retention")) {
          // Changing a file's retention needs writeFileRetentions; shortening it under governance, bypassGovernance too.
          return deny(res, 403, "AccessDenied", "not entitled");
        }
        if (req.method === "HEAD") {
          if (!key.capabilities.includes("readFiles")) return res.writeHead(403).end();
          if (!versions.has(objectKey)) return res.writeHead(404).end();
          const lock = key.capabilities.includes("readFileRetentions")
            ? { "x-amz-object-lock-mode": "GOVERNANCE", "x-amz-object-lock-retain-until-date": new Date(Date.now() + 14 * 86_400_000).toISOString() }
            : {};
          return res.writeHead(200, lock).end();
        }
        if (req.method === "POST" && (url.searchParams.has("uploads") || url.searchParams.has("uploadId"))) {
          // A multipart upload, started or completed: B2's writeFiles covers both.
          if (!key.capabilities.includes("writeFiles")) return deny(res, 403, "AccessDenied", "not entitled");
          if (!objectKey.startsWith(key.prefix)) return deny(res, 403, "AccessDenied", "not entitled to that file name prefix");
          if (crypto.createHash("sha256").update(body).digest("hex") !== req.headers["x-amz-content-sha256"]) return deny(res, 400, "XAmzContentSHA256Mismatch", "SHA mismatch");
          if (url.searchParams.has("uploads")) {
            const id = `up${uploads.size + 1}`;
            uploads.set(id, { key: objectKey, parts: new Map() });
            return res.writeHead(200, { "content-type": "application/xml" }).end(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
          }
          const upload = uploads.get(url.searchParams.get("uploadId")!);
          if (!upload || upload.key !== objectKey) return deny(res, 404, "NoSuchUpload", "no such upload");
          const listed = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]+)<\/ETag>/g)].map((x) => [Number(x[1]), x[2]] as const);
          for (const [n, etag] of listed)
            if (!upload.parts.has(n) || etag !== `"${crypto.createHash("md5").update(upload.parts.get(n)!).digest("hex")}"`) return deny(res, 400, "InvalidPart", `part ${n}`);
          versions.set(objectKey, [...(versions.get(objectKey) ?? []), Buffer.concat(listed.map(([n]) => upload.parts.get(n)!))]);
          stamps.set(objectKey, [...(stamps.get(objectKey) ?? []), new Date(Date.now() + clockAheadHours * 3_600_000).toISOString()]);
          uploads.delete(url.searchParams.get("uploadId")!);
          return res.writeHead(200, { "content-type": "application/xml" }).end("<CompleteMultipartUploadResult/>");
        }
        if (req.method === "PUT") {
          if (!key.capabilities.includes("writeFiles")) return deny(res, 403, "AccessDenied", "not entitled");
          if (!objectKey.startsWith(key.prefix)) return deny(res, 403, "AccessDenied", "not entitled to that file name prefix");
          // Object Lock: an upload must say its MD5, and it must match.
          if (!req.headers["content-md5"]) return deny(res, 400, "InvalidRequest", "Content-MD5 is required for an object lock bucket");
          if (crypto.createHash("md5").update(body).digest("base64") !== req.headers["content-md5"]) return deny(res, 400, "BadDigest", "MD5 mismatch");
          if (crypto.createHash("sha256").update(body).digest("hex") !== req.headers["x-amz-content-sha256"]) return deny(res, 400, "XAmzContentSHA256Mismatch", "SHA mismatch");
          if (url.searchParams.has("uploadId")) {
            // One part of a multipart upload, checked as any upload is.
            const upload = uploads.get(url.searchParams.get("uploadId")!);
            const n = Number(url.searchParams.get("partNumber"));
            if (!upload || upload.key !== objectKey) return deny(res, 404, "NoSuchUpload", "no such upload");
            if (n === damagePart) return deny(res, 400, "BadDigest", "MD5 mismatch");
            upload.parts.set(n, body);
            return res.writeHead(200, { etag: `"${crypto.createHash("md5").update(body).digest("hex")}"` }).end();
          }
          versions.set(objectKey, [...(versions.get(objectKey) ?? []), body]);
          stamps.set(objectKey, [...(stamps.get(objectKey) ?? []), new Date(Date.now() + clockAheadHours * 3_600_000).toISOString()]);
          return res.writeHead(200).end();
        }
        if (req.method === "DELETE") return deny(res, 403, "AccessDenied", "file is locked");
        if (url.searchParams.has("versions")) {
          if (!listsVersions) return deny(res, 501, "NotImplemented", "versions are not supported");
          if (!key.capabilities.includes("listFiles")) return deny(res, 403, "AccessDenied", "not entitled");
          const prefix = url.searchParams.get("prefix") ?? "";
          if (!prefix.startsWith(key.prefix)) return deny(res, 403, "AccessDenied", "not entitled to that file name prefix");
          // Each name's newest version first, as S3 lists them.
          const listed = [...versions]
            .filter(([k]) => k.startsWith(prefix))
            .flatMap(([k, v]) => v.map((body, i) => `<Version><Key>${k}</Key><VersionId>v${i}</VersionId><IsLatest>${i === v.length - 1}</IsLatest><Size>${body.length}</Size><LastModified>${stamps.get(k)?.[i] ?? ""}</LastModified></Version>`).reverse());
          return res.writeHead(200, { "content-type": "application/xml" }).end(`<ListVersionsResult><IsTruncated>false</IsTruncated>${listed.join("")}</ListVersionsResult>`);
        }
        if (url.searchParams.get("list-type") === "2") {
          if (!key.capabilities.includes("listFiles")) return deny(res, 403, "AccessDenied", "not entitled");
          const prefix = url.searchParams.get("prefix") ?? "";
          if (!prefix.startsWith(key.prefix)) return deny(res, 403, "AccessDenied", "not entitled to that file name prefix");
          const contents = [...versions].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.at(-1)!.length}</Size><LastModified>2026-10-24T03:00:00Z</LastModified></Contents>`);
          return res.writeHead(200, { "content-type": "application/xml" }).end(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents.join("")}</ListBucketResult>`);
        }
        if (req.method === "GET") {
          if (!key.capabilities.includes("readFiles")) return deny(res, 403, "AccessDenied", "not entitled");
          const v = versions.get(objectKey);
          const asked = url.searchParams.get("versionId");
          const body = asked ? v?.[Number(asked.slice(1))] : v?.at(-1);
          return body ? res.writeHead(200).end(body) : deny(res, 404, "NoSuchKey", "not found");
        }
        return deny(res, 403, "AccessDenied", "not entitled");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(() => {
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("OFFSITE_")) delete process.env[k];
    log.length = 0;
    listsVersions = true;
    clockAheadHours = 0;
    damagePart = 0;
    uploads.clear();
    // Backups taken in the same second share a name: each test starts with an empty bucket.
    versions.clear();
    stamps.clear();
  });

  function asServer() {
    process.env.OFFSITE_S3_ENDPOINT = endpoint;
    process.env.OFFSITE_S3_BUCKET = "backups";
    process.env.OFFSITE_S3_REGION = REGION;
    process.env.OFFSITE_S3_PREFIX = "venue-a/";
    process.env.OFFSITE_S3_ACCESS_KEY_ID = "004writeonly";
    process.env.OFFSITE_S3_SECRET_ACCESS_KEY = "write-secret";
    process.env.OFFSITE_ENCRYPTION_PUBLIC_KEY_FILE = publicKeyFile;
    // B2 keeps data in the US, EU or Canada: a transfer abroad, approved and encrypted.
    process.env.OFFSITE_DATA_LOCATION = "US";
    process.env.OFFSITE_TRANSFER_APPROVED = "US";
  }
  /** The restore machine: the bucket's address and the read key only; no upload key, no public key. */
  function asRestorer(privateKey: string | null = privateKeyFile) {
    for (const k of Object.keys(process.env)) if (k.startsWith("OFFSITE_")) delete process.env[k];
    process.env.OFFSITE_S3_ENDPOINT = endpoint;
    process.env.OFFSITE_S3_BUCKET = "backups";
    process.env.OFFSITE_S3_REGION = REGION;
    process.env.OFFSITE_S3_PREFIX = "venue-a/";
    process.env.OFFSITE_S3_READ_ACCESS_KEY_ID = "004readlist";
    process.env.OFFSITE_S3_READ_SECRET_ACCESS_KEY = "read-secret";
    if (privateKey) process.env.OFFSITE_ENCRYPTION_PRIVATE_KEY_FILE = privateKey;
  }

  async function backupSet() {
    const taken = await createBackup({ dir: path.join(work, `backups-${Date.now()}`) });
    if (!taken.ok) throw new Error(taken.error);
    return taken;
  }

  it("is written with the upload-only key by single PUTs alone, encrypted, the manifest last; nothing read, listed or deleted", async () => {
    asServer();
    const taken = await backupSet();
    const sent = await copyOffsite(taken.file, taken.photos.file, taken.manifest);
    expect(sent).toMatchObject({ ok: true });
    expect(log.every((r) => r.method === "PUT" && r.key === "004writeonly")).toBe(true);
    const names = log.map((r) => r.path.split("/").pop());
    expect(names.at(-1)).toMatch(/\.manifest\.json$/);
    expect(names).toContain(`${taken.file.name}.enc`);
    // What the provider holds is ciphertext: not the database file, nor anything of it.
    const stored = versions.get(`venue-a/${taken.file.name}.enc`)!.at(-1)!;
    const plain = fs.readFileSync(taken.file.path);
    expect(stored.subarray(0, 6).toString()).toBe("MSBK1\n");
    expect(stored.includes(plain.subarray(0, 64))).toBe(false);
    expect((await offsiteStatus()).lastCopied).toMatchObject({ manifest: true, encrypted: true });
  });

  it("cannot be read back, listed or deleted with the upload key, so a stolen server key cannot read or destroy earlier copies", async () => {
    asServer();
    const taken = await backupSet();
    expect((await copyOffsite(taken.file, taken.photos.file, taken.manifest))?.ok).toBe(true);
    const config = offsiteConfig()!;
    await expect(fetchOffsiteSet(config, taken.file.name, path.join(work, "stolen"))).rejects.toThrow(/403 AccessDenied/);
    // Even if it tried: the bucket refuses a delete (Object Lock), and the key has no deleteFiles.
    const url = objectUrl(config, `${taken.file.name}.enc`);
    const now = new Date();
    const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": crypto.createHash("sha256").update("").digest("hex"), "x-amz-date": amzDate(now) };
    headers.authorization = signV4({ method: "DELETE", url, headers, payloadHash: headers["x-amz-content-sha256"], region: REGION, service: "s3", accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, now });
    const deleted = await fetch(url, { method: "DELETE", headers });
    expect(deleted.status).toBe(403);
    expect(versions.get(`venue-a/${taken.file.name}.enc`)).toHaveLength(1);
  });

  it("is restored with the separate read key and the private key: fetched, decrypted, every part checked against the manifest", async () => {
    asServer();
    const taken = await backupSet();
    expect((await copyOffsite(taken.file, taken.photos.file, taken.manifest))?.ok).toBe(true);
    asRestorer();
    const read = offsiteReadConfig()!;
    expect(read.accessKeyId).toBe("004readlist");
    const fetched = await fetchOffsiteSet(read, taken.file.name, path.join(work, "restore-ok"));
    expect(fetch).toBeDefined();
    expect(fs.readFileSync(fetched.snapshot).equals(fs.readFileSync(taken.file.path))).toBe(true);
    expect(await verifyBackupSet(fetched.snapshot)).toMatchObject({ ok: true });
    expect(log.filter((r) => r.method !== "PUT").every((r) => r.key === "004readlist" && r.method === "GET")).toBe(true);
    expect(fetched).toMatchObject({ versioned: true, rewritten: [] });
  });

  it("survives a stolen upload key writing a whole fake set over the real one: the first upload of each name is restored, and the rewrite reported", async () => {
    asServer();
    const real = await backupSet();
    expect((await copyOffsite(real.file, real.photos.file, real.manifest))?.ok).toBe(true);
    // The thief holds the upload key and the public key (both on the server), so can make a set that
    // checks out on its own — a different database under the real names — and upload it over the real one.
    await getDb().prepare("INSERT INTO settings (key, value) VALUES ('planted', 'by the thief')").run();
    const fake = await backupSet();
    expect(fs.readFileSync(fake.file.path).equals(fs.readFileSync(real.file.path))).toBe(false);
    const renamed = path.join(work, "fake");
    fs.mkdirSync(renamed, { recursive: true });
    const as = (from: string, name: string) => {
      const to = path.join(renamed, name);
      fs.copyFileSync(from, to);
      return to;
    };
    const manifest = JSON.parse(fs.readFileSync(fake.manifest, "utf8"));
    manifest.database.file = real.file.name;
    if (manifest.photos) manifest.photos.file = path.basename(real.photos.file!);
    const fakeManifest = path.join(renamed, path.basename(real.manifest));
    fs.writeFileSync(fakeManifest, JSON.stringify(manifest));
    expect(
      (await copyOffsite({ name: real.file.name, path: as(fake.file.path, real.file.name) }, as(fake.photos.file!, path.basename(real.photos.file!)), fakeManifest))?.ok
    ).toBe(true);
    expect(versions.get(`venue-a/${real.file.name}.enc`)).toHaveLength(2);

    asRestorer();
    const fetched = await fetchOffsiteSet(offsiteReadConfig()!, real.file.name, path.join(work, "after-theft"));
    expect(fs.readFileSync(fetched.snapshot).equals(fs.readFileSync(real.file.path))).toBe(true);
    expect(await verifyBackupSet(fetched.snapshot)).toMatchObject({ ok: true });
    expect(fetched.rewritten).toEqual(expect.arrayContaining([path.basename(real.manifest), `${real.file.name}.enc`]));
    expect((await listOffsite(offsiteReadConfig()!)).find((o) => o.name === `${real.file.name}.enc`)).toMatchObject({ rewritten: true });
  });

  it("is refused without the private key, with the wrong one, or once changed in the bucket", async () => {
    asServer();
    const taken = await backupSet();
    expect((await copyOffsite(taken.file, taken.photos.file, taken.manifest))?.ok).toBe(true);
    asRestorer(null);
    await expect(fetchOffsiteSet(offsiteReadConfig()!, taken.file.name, path.join(work, "no-key"))).rejects.toThrow(/OFFSITE_ENCRYPTION_PRIVATE_KEY_FILE/);
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 3072 }).privateKey.export({ type: "pkcs8", format: "pem" });
    const otherFile = path.join(work, "other-private.pem");
    fs.writeFileSync(otherFile, other);
    asRestorer(otherFile);
    await expect(fetchOffsiteSet(offsiteReadConfig()!, taken.file.name, path.join(work, "wrong-key"))).rejects.toThrow(/another key/);
    // A byte changed in the stored ciphertext: the authentication tag catches it.
    const key = `venue-a/${taken.file.name}.enc`;
    const changed = Buffer.from(versions.get(key)!.at(-1)!);
    changed[changed.length - 40] ^= 0xff;
    versions.set(key, [changed]);
    asRestorer();
    await expect(fetchOffsiteSet(offsiteReadConfig()!, taken.file.name, path.join(work, "changed"))).rejects.toThrow(/does not check out/);
    // A bucket that cannot list versions (R2): the current copy is all there is, and is checked the same way.
    listsVersions = false;
    await expect(fetchOffsiteSet(offsiteReadConfig()!, taken.file.name, path.join(work, "changed-unversioned"))).rejects.toThrow(/does not check out/);
  });

  it("signs the manifest with the server's Ed25519 key; the restore machine refuses a set without the signature or signed by another key", async () => {
    const signing = crypto.generateKeyPairSync("ed25519");
    const signingKey = path.join(work, "signing-private.pem");
    const signingPublic = path.join(work, "signing-public.pem");
    fs.writeFileSync(signingKey, signing.privateKey.export({ type: "pkcs8", format: "pem" }));
    fs.writeFileSync(signingPublic, signing.publicKey.export({ type: "spki", format: "pem" }));

    asServer();
    process.env.OFFSITE_SIGNING_KEY_FILE = signingKey;
    const taken = await backupSet();
    expect((await copyOffsite(taken.file, taken.photos.file, taken.manifest))?.ok).toBe(true);
    const names = log.map((r) => r.path.split("/").pop());
    expect(names.slice(-2)).toEqual([`${path.basename(taken.manifest)}.sig`, path.basename(taken.manifest)]);
    expect((await offsiteStatus()).lastCopied).toMatchObject({ signed: true });

    asRestorer();
    process.env.OFFSITE_SIGNING_PUBLIC_KEY_FILE = signingPublic;
    const fetched = await fetchOffsiteSet(offsiteReadConfig()!, taken.file.name, path.join(work, "signed"));
    expect(fetched).toMatchObject({ signature: "verified", uploadedLate: false, firstUploadedAt: expect.any(String) });

    // Without the public key the set still restores, said to be unchecked.
    delete process.env.OFFSITE_SIGNING_PUBLIC_KEY_FILE;
    expect(await fetchOffsiteSet(offsiteReadConfig()!, taken.file.name, path.join(work, "unchecked"))).toMatchObject({ signature: "unchecked" });

    // A thief with the upload key alone can upload a set, but cannot sign it: without the server's
    // private key, its set has no signature, or one that does not check out.
    const sigKey = `venue-a/${path.basename(taken.manifest)}.sig`;
    const sig = versions.get(sigKey)!;
    versions.delete(sigKey);
    process.env.OFFSITE_SIGNING_PUBLIC_KEY_FILE = signingPublic;
    await expect(fetchOffsiteSet(offsiteReadConfig()!, taken.file.name, path.join(work, "unsigned"))).rejects.toThrow(/no signature/);
    const forged = signBytes(Buffer.from("something else"), crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    versions.set(sigKey, [Buffer.from(JSON.stringify(forged))]);
    await expect(fetchOffsiteSet(offsiteReadConfig()!, taken.file.name, path.join(work, "forged"))).rejects.toThrow(/not signed by the server's key/);
    versions.set(sigKey, sig);
  });

  it("flags a set first uploaded long after it was made, as one sent by somebody holding the key later would be", async () => {
    asServer();
    const taken = await backupSet();
    clockAheadHours = 30;
    expect((await copyOffsite(taken.file, taken.photos.file, taken.manifest))?.ok).toBe(true);
    asRestorer();
    const fetched = await fetchOffsiteSet(offsiteReadConfig()!, taken.file.name, path.join(work, "late"));
    expect(fetched.uploadedLate).toBe(true);
    expect(Date.parse(fetched.firstUploadedAt!)).toBeGreaterThan(Date.now() + 29 * 3_600_000);
  });

  it("is checked end to end by scripts/verify-offsite.mjs, with synthetic data, both keys and every refusal", async () => {
    const signing = crypto.generateKeyPairSync("ed25519");
    const signingKey = path.join(work, "verify-signing.pem");
    const signingPublic = path.join(work, "verify-signing-public.pem");
    fs.writeFileSync(signingKey, signing.privateKey.export({ type: "pkcs8", format: "pem" }));
    fs.writeFileSync(signingPublic, signing.publicKey.export({ type: "spki", format: "pem" }));
    const report = path.join(work, "verify.json");
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      // Whatever the machine points at, the script backs up a database of its own.
      DATABASE_URL: "postgres://nobody@127.0.0.1:1/not-used",
      OFFSITE_S3_ENDPOINT: endpoint,
      OFFSITE_S3_BUCKET: "backups",
      OFFSITE_S3_REGION: REGION,
      OFFSITE_S3_PREFIX: "venue-a/",
      OFFSITE_S3_ACCESS_KEY_ID: "004writeonly",
      OFFSITE_S3_SECRET_ACCESS_KEY: "write-secret",
      OFFSITE_S3_READ_ACCESS_KEY_ID: "004readlist",
      OFFSITE_S3_READ_SECRET_ACCESS_KEY: "read-secret",
      OFFSITE_ENCRYPTION_PUBLIC_KEY_FILE: publicKeyFile,
      OFFSITE_ENCRYPTION_PRIVATE_KEY_FILE: privateKeyFile,
      OFFSITE_SIGNING_KEY_FILE: signingKey,
      OFFSITE_SIGNING_PUBLIC_KEY_FILE: signingPublic,
      OFFSITE_DATA_LOCATION: "US",
      OFFSITE_TRANSFER_APPROVED: "US",
    };
    const { spawn } = await import("child_process");
    const run = (extra: string[]) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, ["scripts/verify-offsite.mjs", ...extra], { env, cwd: process.cwd() });
        let out = "";
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (out += c));
        child.on("close", (code) => resolve({ code, out }));
      });

    // Without --go: says where, sends nothing.
    const dry = await run([]);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/Nothing sent/);
    expect(versions.size).toBe(0);

    const go = await run(["--go", "--size-mb", "1", "--report", report]);
    expect(go.out).not.toMatch(/write-secret|read-secret/);
    expect(go.code, go.out).toBe(0);
    const results = JSON.parse(fs.readFileSync(report, "utf8")).results as { check: string; outcome: string; detail: string }[];
    const outcome = (check: string) => results.find((r) => r.check === check)?.outcome;
    for (const check of [
      "transfer allowed",
      "upload with the upload key",
      "upload key cannot read",
      "upload key cannot list",
      "upload key cannot list versions",
      "upload key cannot delete (hide) a file",
      "upload key cannot delete a version",
      "upload key cannot change retention or bypass governance",
      "read key cannot delete a version",
      "Object Lock on the upload",
      "a rewrite is kept as a new version; the first upload is restored",
      "manifest check",
      "isolated restore drill",
      "1 MB up and back",
    ])
      expect(outcome(check), check).toBe("pass");
    expect(results.find((r) => r.check === "fetch with the read key")?.detail).toMatch(/signature verified/);
    expect(outcome("lifecycle rules")).toBe("manual");

    // A bucket that lets the upload key read: reported as a failure, and the exit says so.
    keys["004writeonly"].capabilities.push("readFiles");
    try {
      const loose = await run(["--go"]);
      expect(loose.code).toBe(1);
      expect(loose.out).toMatch(/FAIL\s+upload key cannot read/);
    } finally {
      keys["004writeonly"].capabilities.pop();
    }
  }, 120_000);

  it("is refused outside the key's prefix, and a file too big even in parts is refused before anything is sent", async () => {
    asServer();
    process.env.OFFSITE_S3_PREFIX = "venue-b/";
    const taken = await backupSet();
    const refused = await copyOffsite(taken.file, taken.photos.file, taken.manifest);
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/403 AccessDenied/) });
    expect((await offsiteStatus()).lastError?.error).toMatch(/AccessDenied/);
    // Parts of a byte, so 10,000 of them carry 10,000 bytes: a sparse file one byte over is refused by size, not read.
    const huge = path.join(work, "huge.tar.gz");
    fs.writeFileSync(huge, "");
    fs.truncateSync(huge, MAX_PARTS + 1);
    log.length = 0;
    expect(await uploadBackup({ name: "huge.tar.gz", path: huge }, offsiteConfig()!, new Date(), { single: 1, part: 1 })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/even in parts/),
    });
    expect(log).toHaveLength(0);
    expect(MAX_UPLOAD / 1024 ** 3).toBeGreaterThan(900);
  });

  it("sends a file larger than one upload in parts, each checked, with the upload-only key; nothing read, listed, deleted or aborted", async () => {
    asServer();
    const big = path.join(work, "photos-big.tar.gz");
    fs.writeFileSync(big, crypto.randomBytes(12_000));
    // Below one upload's size it is one PUT, as always.
    expect(await uploadBackup({ name: "small.tar.gz", path: big }, offsiteConfig()!)).toMatchObject({ ok: true, bytes: 12_000 });
    expect(log.map((r) => r.method)).toEqual(["PUT"]);
    log.length = 0;
    // Over it (made small here): started, three parts, completed.
    const sent = await uploadBackup({ name: "photos-big.tar.gz", path: big }, offsiteConfig()!, new Date(), { single: 5_000, part: 5_000 });
    expect(sent).toMatchObject({ ok: true, key: "venue-a/photos-big.tar.gz", bytes: 12_000, parts: 3 });
    expect(log.map((r) => r.method)).toEqual(["POST", "PUT", "PUT", "PUT", "POST"]);
    expect(log.every((r) => r.key === "004writeonly")).toBe(true);
    expect(versions.get("venue-a/photos-big.tar.gz")!.at(-1)!.equals(fs.readFileSync(big))).toBe(true);
    // Read back with the read key, it is the file.
    asRestorer();
    const read = offsiteReadConfig()!;
    const url = new URL(`${endpoint}/backups/venue-a/photos-big.tar.gz`);
    const now = new Date();
    const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": crypto.createHash("sha256").update("").digest("hex"), "x-amz-date": amzDate(now) };
    headers.authorization = signV4({ method: "GET", url, headers, payloadHash: headers["x-amz-content-sha256"], region: REGION, service: "s3", accessKeyId: read.accessKeyId, secretAccessKey: read.secretAccessKey, now });
    expect(Buffer.from(await (await fetch(url, { headers })).arrayBuffer()).equals(fs.readFileSync(big))).toBe(true);
  });

  it("stops at a part that arrives damaged, says which, and stores nothing", async () => {
    asServer();
    const big = path.join(work, "damaged.tar.gz");
    fs.writeFileSync(big, crypto.randomBytes(12_000));
    damagePart = 2;
    const sent = await uploadBackup({ name: "damaged.tar.gz", path: big }, offsiteConfig()!, new Date(), { single: 5_000, part: 5_000 });
    expect(sent).toMatchObject({ ok: false, error: expect.stringMatching(/^Part 2: Storage refused the upload \(400 BadDigest\)/) });
    expect(versions.has("venue-a/damaged.tar.gz")).toBe(false);
    // Left for the bucket's lifecycle rule: the upload key never aborts or deletes.
    expect(log.map((r) => r.method)).toEqual(["POST", "PUT", "PUT"]);
  });
});
