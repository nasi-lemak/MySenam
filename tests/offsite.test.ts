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
  objectUrl,
  offsiteConfig,
  offsiteStatus,
  signV4,
  uploadBackup,
} from "../src/lib/offsite";
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
    for (const k of Object.keys(process.env)) if (k.startsWith("OFFSITE_S3_")) delete process.env[k];
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

    // The storage service would recompute this; so do we.
    const url = new URL(`http://127.0.0.1:${port}${put.url}`);
    const expected = signV4({
      method: "PUT",
      url,
      headers: {
        host: put.headers.host!,
        "content-length": "300000",
        "content-type": "application/vnd.sqlite3",
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

    const ok = await copyOffsite({ name: path.basename(file), path: file });
    expect(ok?.ok).toBe(true);
    let status = offsiteStatus();
    expect(status.configured).toBe(true);
    expect(status.lastCopied?.name).toBe(path.basename(file));
    expect(status.lastError).toBeNull();
    expect(JSON.stringify(status)).not.toContain("secret");

    reply = { status: 500, body: "<Error><Code>InternalError</Code></Error>" };
    await copyOffsite({ name: path.basename(file), path: file });
    status = offsiteStatus();
    // The last good copy is still the last good copy.
    expect(status.lastCopied?.name).toBe(path.basename(file));
    expect(status.lastError?.error).toMatch(/500 InternalError/);
  });

  it("does nothing when it is not set up", async () => {
    expect(await copyOffsite({ name: path.basename(file), path: file })).toBeNull();
    expect(received).toHaveLength(0);
  });
});
