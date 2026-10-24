import crypto from "crypto";
import fs from "fs";
import { pipeline } from "stream/promises";

/**
 * Backups encrypted before they leave the server, so the storage provider —
 * and anybody who takes the upload key — holds only ciphertext.
 *
 * Each file gets a fresh AES-256-GCM key, which is itself encrypted with an
 * RSA public key (RSA-OAEP with SHA-256). The server holds only the public
 * key: it can encrypt tonight's backup but not read last week's. The private
 * key lives with whoever restores (`OFFSITE_ENCRYPTION_PRIVATE_KEY_FILE`),
 * kept off the server and backed up somewhere safe: without it no off-site
 * copy can be read.
 *
 * File layout: "MSBK1\n" (6 bytes), the wrapped key's length (2 bytes,
 * big-endian), the wrapped key, a 12-byte IV, the ciphertext, and GCM's
 * 16-byte tag. A tampered or truncated file fails the tag check on
 * decryption, and is refused rather than restored.
 */

const MAGIC = Buffer.from("MSBK1\n");
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function readKeyFile(file: string | undefined): string | null {
  if (!file) return null;
  return fs.readFileSync(file, "utf8");
}

/** Encrypt `src` to `dest` for the holder of the private key matching `publicKeyPem`. */
export async function encryptFile(src: string, dest: string, publicKeyPem: string): Promise<void> {
  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(IV_BYTES);
  const wrapped = crypto.publicEncrypt({ key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, dataKey);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(wrapped.length);
  const cipher = crypto.createCipheriv("aes-256-gcm", dataKey, iv);
  const out = fs.createWriteStream(dest);
  out.write(Buffer.concat([MAGIC, length, wrapped, iv]));
  await pipeline(fs.createReadStream(src), cipher, out, { end: false });
  await new Promise<void>((resolve, reject) => out.end(cipher.getAuthTag(), (err?: Error | null) => (err ? reject(err) : resolve())));
}

/** Is this file one of ours, encrypted? */
export function isEncrypted(file: string): boolean {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(MAGIC.length);
    fs.readSync(fd, head, 0, MAGIC.length, 0);
    return head.equals(MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

/** Decrypt `src` to `dest` with the private key; throws if it is not ours, the key is wrong, or it was changed. */
export async function decryptFile(src: string, dest: string, privateKeyPem: string): Promise<void> {
  const size = fs.statSync(src).size;
  const fd = fs.openSync(src, "r");
  let headerEnd: number;
  let dataKey: Buffer;
  let iv: Buffer;
  let tag: Buffer;
  try {
    const head = Buffer.alloc(MAGIC.length + 2);
    fs.readSync(fd, head, 0, head.length, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Not an encrypted MySenam backup.");
    const wrappedLength = head.readUInt16BE(MAGIC.length);
    const wrapped = Buffer.alloc(wrappedLength);
    fs.readSync(fd, wrapped, 0, wrappedLength, head.length);
    iv = Buffer.alloc(IV_BYTES);
    fs.readSync(fd, iv, 0, IV_BYTES, head.length + wrappedLength);
    headerEnd = head.length + wrappedLength + IV_BYTES;
    if (size < headerEnd + TAG_BYTES) throw new Error("The encrypted backup is cut short.");
    tag = Buffer.alloc(TAG_BYTES);
    fs.readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES);
    try {
      dataKey = crypto.privateDecrypt({ key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, wrapped);
    } catch {
      throw new Error("This backup was encrypted for another key: the private key given cannot open it.");
    }
  } finally {
    fs.closeSync(fd);
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", dataKey, iv);
  decipher.setAuthTag(tag);
  const temporary = `${dest}.part`;
  try {
    await pipeline(fs.createReadStream(src, { start: headerEnd, end: size - TAG_BYTES - 1 }), decipher, fs.createWriteStream(temporary));
  } catch {
    fs.rmSync(temporary, { force: true });
    throw new Error("The encrypted backup does not check out: it was changed or damaged after it was made.");
  }
  fs.renameSync(temporary, dest);
}

/**
 * Signing what the server uploads, so a restore can tell a set the server
 * made from one somebody else put in the bucket. The server holds an Ed25519
 * private key (`OFFSITE_SIGNING_KEY_FILE`) and signs each set's manifest — the
 * manifest names every part's SHA-256, so it vouches for the whole set; the
 * restore machine holds only the public key (`OFFSITE_SIGNING_PUBLIC_KEY_FILE`).
 * This answers a stolen upload key on its own (from a leaked config, say),
 * which can upload but cannot sign. It cannot answer a taken-over server,
 * which holds the signing key too: there, what tells good from bad is when a
 * set was first uploaded, before the compromise (lib/offsite.ts).
 */
export interface ManifestSignature {
  alg: "ed25519";
  /** The first 16 hex characters of the SHA-256 of the public key, to tell keys apart after a rotation. */
  keyId: string;
  signature: string;
}

export function keyIdOf(publicKeyPem: string): string {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/** Sign these bytes with an Ed25519 private key. */
export function signBytes(bytes: Buffer, privateKeyPem: string): ManifestSignature {
  const key = crypto.createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("The signing key must be an Ed25519 private key.");
  return { alg: "ed25519", keyId: keyIdOf(crypto.createPublicKey(key).export({ type: "spki", format: "pem" }) as string), signature: crypto.sign(null, bytes, key).toString("base64") };
}

/** Do these bytes carry this signature from the holder of this public key? */
export function signatureValid(bytes: Buffer, signed: unknown, publicKeyPem: string): boolean {
  const s = signed as Partial<ManifestSignature> | null;
  if (!s || s.alg !== "ed25519" || typeof s.signature !== "string") return false;
  try {
    return crypto.verify(null, bytes, crypto.createPublicKey(publicKeyPem), Buffer.from(s.signature, "base64"));
  } catch {
    return false;
  }
}
