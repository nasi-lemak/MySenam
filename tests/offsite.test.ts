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
  fetchOffsiteSet,
  listOffsite,
  MAX_SINGLE_PUT,
  objectUrl,
  offsiteConfig,
  offsiteReadConfig,
  offsiteStatus,
  offsiteTransferCheck,
  signV4,
  uploadBackup,
} from "../src/lib/offsite";
import { createBackup, verifyBackupSet } from "../src/lib/backup";
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
    "004readlist": { secret: "read-secret", capabilities: ["listFiles", "readFiles"], prefix: "venue-a/" },
  };
  const versions = new Map<string, Buffer[]>();
  /** Off, the bucket answers a versions listing as R2 does: not implemented. */
  let listsVersions = true;
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
        if (req.method === "PUT") {
          if (!key.capabilities.includes("writeFiles")) return deny(res, 403, "AccessDenied", "not entitled");
          if (!objectKey.startsWith(key.prefix)) return deny(res, 403, "AccessDenied", "not entitled to that file name prefix");
          // Object Lock: an upload must say its MD5, and it must match.
          if (!req.headers["content-md5"]) return deny(res, 400, "InvalidRequest", "Content-MD5 is required for an object lock bucket");
          if (crypto.createHash("md5").update(body).digest("base64") !== req.headers["content-md5"]) return deny(res, 400, "BadDigest", "MD5 mismatch");
          if (crypto.createHash("sha256").update(body).digest("hex") !== req.headers["x-amz-content-sha256"]) return deny(res, 400, "XAmzContentSHA256Mismatch", "SHA mismatch");
          versions.set(objectKey, [...(versions.get(objectKey) ?? []), body]);
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
            .flatMap(([k, v]) => v.map((body, i) => `<Version><Key>${k}</Key><VersionId>v${i}</VersionId><IsLatest>${i === v.length - 1}</IsLatest><Size>${body.length}</Size><LastModified>2026-10-24T03:00:0${i}Z</LastModified></Version>`).reverse());
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
    // Backups taken in the same second share a name: each test starts with an empty bucket.
    versions.clear();
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

  it("is refused outside the key's prefix, and a file too big for one upload is refused before anything is sent", async () => {
    asServer();
    process.env.OFFSITE_S3_PREFIX = "venue-b/";
    const taken = await backupSet();
    const refused = await copyOffsite(taken.file, taken.photos.file, taken.manifest);
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/403 AccessDenied/) });
    expect((await offsiteStatus()).lastError?.error).toMatch(/AccessDenied/);
    // A sparse file just over the limit: refused by size, not read.
    const huge = path.join(work, "huge.tar.gz");
    fs.writeFileSync(huge, "");
    fs.truncateSync(huge, MAX_SINGLE_PUT + 1);
    log.length = 0;
    expect(await uploadBackup({ name: "huge.tar.gz", path: huge }, offsiteConfig()!)).toMatchObject({ ok: false, error: expect.stringMatching(/about 5 GB/) });
    expect(log).toHaveLength(0);
  });
});
