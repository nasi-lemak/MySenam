import crypto from "crypto";
import fs from "fs";
import path from "path";
import { dataDirectory } from "./db";
import { amzDate, canonicalPath, signV4 } from "./offsite";

/**
 * Where venue photos are kept.
 *
 * With a bucket set up (PHOTOS_S3_*: Cloudflare R2, Backblaze B2, Amazon S3,
 * anything that speaks the S3 API), there. It is its own bucket, apart from
 * the backups': photos are public and backups must never be, and the backup
 * key may only upload, where photos must also be read and removed. With
 * PHOTOS_PUBLIC_URL as well — the bucket's public address or a domain in
 * front of it — browsers fetch them from there; without it, through this
 * server.
 *
 * With no bucket, in the data folder, under photos/. Fine for one server;
 * put the folder on a disk that survives a redeploy, as for everything else
 * in it. Either way photos are not in the database, so the nightly backup
 * does not grow with them.
 */

export interface PhotoStore {
  kind: "s3" | "disk";
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

export interface PhotoBucket {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function photoBucket(): PhotoBucket | null {
  const endpoint = process.env.PHOTOS_S3_ENDPOINT;
  const bucket = process.env.PHOTOS_S3_BUCKET;
  const accessKeyId = process.env.PHOTOS_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.PHOTOS_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint: endpoint.replace(/\/+$/, ""), bucket, region: process.env.PHOTOS_S3_REGION || "auto", accessKeyId, secretAccessKey };
}

/** Where a browser fetches a stored file. */
export function photoUrl(key: string): string {
  const base = process.env.PHOTOS_PUBLIC_URL?.replace(/\/+$/, "");
  return base && photoBucket() ? `${base}/${key}` : `/photos/${key}`;
}

const sha256 = (data: crypto.BinaryLike) => crypto.createHash("sha256").update(data).digest("hex");

function s3Store(config: PhotoBucket): PhotoStore {
  const call = async (method: "PUT" | "GET" | "DELETE", key: string, body?: Buffer) => {
    const url = new URL(`${config.endpoint}/${encodeURIComponent(config.bucket)}/${canonicalPath(key)}`);
    const now = new Date();
    const payloadHash = sha256(body ?? "");
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate(now),
      ...(body ? { "content-type": "image/webp", "cache-control": "public, max-age=31536000, immutable" } : {}),
    };
    headers.authorization = signV4({
      method,
      url,
      headers,
      payloadHash,
      region: config.region,
      service: "s3",
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      now,
    });
    const { host: _host, ...sent } = headers;
    return fetch(url, { method, headers: sent, body: body ? new Uint8Array(body) : undefined });
  };
  return {
    kind: "s3",
    async put(key, body) {
      const res = await call("PUT", key, body);
      if (!res.ok) throw new Error(`Photo storage refused the upload (${res.status}).`);
    },
    async get(key) {
      const res = await call("GET", key);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Photo storage refused (${res.status}).`);
      return Buffer.from(await res.arrayBuffer());
    },
    async remove(key) {
      const res = await call("DELETE", key);
      if (!res.ok && res.status !== 404) throw new Error(`Photo storage refused to delete (${res.status}).`);
    },
  };
}

function diskStore(root: string): PhotoStore {
  // Keys are made here, never taken from a request unchecked; this is the second lock.
  const file = (key: string) => {
    const full = path.resolve(root, key);
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error("Not a photo.");
    return full;
  };
  return {
    kind: "disk",
    async put(key, body) {
      const f = file(key);
      await fs.promises.mkdir(path.dirname(f), { recursive: true });
      // Written aside and moved, so nobody is ever served half a file.
      await fs.promises.writeFile(`${f}.part`, body);
      await fs.promises.rename(`${f}.part`, f);
    },
    async get(key) {
      try {
        return await fs.promises.readFile(file(key));
      } catch {
        return null;
      }
    },
    async remove(key) {
      await fs.promises.rm(file(key), { force: true });
    },
  };
}

export function photoStore(): PhotoStore {
  const bucket = photoBucket();
  return bucket ? s3Store(bucket) : diskStore(path.join(dataDirectory(), "photos"));
}
