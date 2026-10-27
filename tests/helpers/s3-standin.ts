import crypto from "crypto";
import http from "http";
import { signV4 } from "../../src/lib/offsite";

/**
 * A stand-in for an S3-compatible bucket on this machine, behaving as the
 * Backblaze B2 stand-in in tests/offsite.test.ts does, for more than one
 * bucket: application keys with capabilities (writeFiles; listFiles and
 * readFiles), each limited to a bucket and a name prefix; SigV4 checked
 * against each key's secret; Object Lock on, so an upload needs Content-MD5
 * and nothing is ever deleted; every upload kept as a version, listed newest
 * first. It is not B2 or S3: it shows that the app asks only for what such
 * keys allow, and lets a test damage, rewrite or remove what is stored.
 */

export interface StandinKey {
  secret: string;
  capabilities: ("writeFiles" | "listFiles" | "readFiles")[];
  bucket: string;
  prefix: string;
}

export interface Standin {
  endpoint: string;
  region: string;
  /** `bucket/key` → every version, oldest first. */
  versions: Map<string, Buffer[]>;
  /** Every request: method, key id, bucket/key. */
  log: { method: string; key: string; object: string }[];
  close(): Promise<void>;
}

export async function startStandin(keys: Record<string, StandinKey>, region = "us-west-004"): Promise<Standin> {
  const versions = new Map<string, Buffer[]>();
  const stamps = new Map<string, string[]>();
  const log: Standin["log"] = [];
  let endpoint = "";
  const deny = (res: http.ServerResponse, status: number, code: string, message: string) =>
    res.writeHead(status, { "content-type": "application/xml" }).end(`<Error><Code>${code}</Code><Message>${message}</Message></Error>`);
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url!, "http://stand-in");
      const auth = String(req.headers.authorization ?? "");
      const m = /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/.exec(auth);
      if (!m || !keys[m[1]]) return deny(res, 403, "InvalidAccessKeyId", "Unknown key");
      const [, id, , signedRegion, signed] = m;
      const [, bucket, ...rest] = url.pathname.split("/");
      const objectKey = decodeURIComponent(rest.join("/"));
      log.push({ method: req.method!, key: id, object: `${bucket}/${objectKey}` });
      if (signedRegion !== region) return deny(res, 400, "AuthorizationHeaderMalformed", "Wrong region");
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
      if (bucket !== key.bucket) return deny(res, 403, "AccessDenied", "not entitled to that bucket");
      const full = `${bucket}/${objectKey}`;
      if (req.method === "PUT") {
        if (!key.capabilities.includes("writeFiles")) return deny(res, 403, "AccessDenied", "not entitled");
        if (!objectKey.startsWith(key.prefix)) return deny(res, 403, "AccessDenied", "not entitled to that file name prefix");
        if (!req.headers["content-md5"]) return deny(res, 400, "InvalidRequest", "Content-MD5 is required for an object lock bucket");
        if (crypto.createHash("md5").update(body).digest("base64") !== req.headers["content-md5"]) return deny(res, 400, "BadDigest", "MD5 mismatch");
        if (crypto.createHash("sha256").update(body).digest("hex") !== req.headers["x-amz-content-sha256"]) return deny(res, 400, "XAmzContentSHA256Mismatch", "SHA mismatch");
        versions.set(full, [...(versions.get(full) ?? []), body]);
        stamps.set(full, [...(stamps.get(full) ?? []), new Date().toISOString()]);
        return res.writeHead(200).end();
      }
      if (req.method === "DELETE") return deny(res, 403, "AccessDenied", "file is locked");
      const listPrefix = url.searchParams.get("prefix") ?? "";
      if (url.searchParams.has("versions") || url.searchParams.get("list-type") === "2") {
        if (!key.capabilities.includes("listFiles")) return deny(res, 403, "AccessDenied", "not entitled");
        if (!listPrefix.startsWith(key.prefix)) return deny(res, 403, "AccessDenied", "not entitled to that file name prefix");
        const mine = [...versions].filter(([k]) => k.startsWith(`${bucket}/${listPrefix}`)).map(([k, v]) => [k.slice(bucket.length + 1), v, stamps.get(k) ?? []] as const);
        if (url.searchParams.has("versions")) {
          const listed = mine.flatMap(([k, v, s]) =>
            v.map((b, i) => `<Version><Key>${k}</Key><VersionId>v${i}</VersionId><IsLatest>${i === v.length - 1}</IsLatest><Size>${b.length}</Size><LastModified>${s[i] ?? ""}</LastModified></Version>`).reverse()
          );
          return res.writeHead(200, { "content-type": "application/xml" }).end(`<ListVersionsResult><IsTruncated>false</IsTruncated>${listed.join("")}</ListVersionsResult>`);
        }
        const contents = mine.map(([k, v, s]) => `<Contents><Key>${k}</Key><Size>${v.at(-1)!.length}</Size><LastModified>${s.at(-1) ?? ""}</LastModified></Contents>`);
        return res.writeHead(200, { "content-type": "application/xml" }).end(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents.join("")}</ListBucketResult>`);
      }
      if (req.method === "GET") {
        if (!key.capabilities.includes("readFiles")) return deny(res, 403, "AccessDenied", "not entitled");
        const v = versions.get(full);
        const asked = url.searchParams.get("versionId");
        const found = asked ? v?.[Number(asked.slice(1))] : v?.at(-1);
        return found ? res.writeHead(200).end(found) : deny(res, 404, "NoSuchKey", "not found");
      }
      return deny(res, 403, "AccessDenied", "not entitled");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { endpoint, region, versions, log, close: () => new Promise<void>((r) => server.close(() => r())) };
}
