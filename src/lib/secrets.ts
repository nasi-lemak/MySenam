import crypto from "crypto";
import fs from "fs";
import path from "path";
import { dataDirectory, isEphemeral } from "./db.ts";

/**
 * Credentials kept in the database, encrypted.
 *
 * A venue's payment gateway key can create bills and, on some accounts, send
 * money out, so it is not left readable in the database file — which is the
 * file that is backed up, copied off the machine, and handed to whoever is
 * restoring it.
 *
 * The key that unlocks them is MYSENAM_SECRET when it is set. Otherwise one is
 * made on first use and kept in a file in the data folder, never in the database:
 * a backup then carries the locked credentials without the key, and an install
 * restored elsewhere asks for them to be entered again rather than handing
 * them over.
 */

const PREFIX = "v1:";

let cached: { source: string; key: Buffer } | null = null;
/** For an in-memory database, which has nowhere to keep a key file: one per process. */
let memoryMaterial: string | null = null;

function keyFile(): string | null {
  // Beside the database's folder, never inside the database: a backup carries
  // the locked credentials without what unlocks them.
  return isEphemeral() ? null : path.join(dataDirectory(), "secret.key");
}

function key(): Buffer {
  const fromEnv = process.env.MYSENAM_SECRET;
  const source = fromEnv ? `env:${fromEnv}` : `file:${keyFile() ?? "memory"}`;
  if (cached?.source === source) return cached.key;

  let material: string;
  if (fromEnv) {
    material = fromEnv;
  } else {
    const file = keyFile();
    if (file && fs.existsSync(file)) {
      material = fs.readFileSync(file, "utf8").trim();
    } else if (file) {
      material = crypto.randomBytes(32).toString("base64");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, material + "\n", { mode: 0o600 });
    } else {
      memoryMaterial ??= crypto.randomBytes(32).toString("base64");
      material = memoryMaterial;
    }
  }
  const derived = crypto.createHash("sha256").update(material).digest();
  cached = { source, key: derived };
  return derived;
}

/** Lock a credential for storage. */
export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/**
 * Unlock one, or null when it cannot be: sealed under a different key, which
 * is what an install restored onto another machine looks like.
 */
export function unseal(sealed: string): string | null {
  if (!sealed.startsWith(PREFIX)) return null;
  try {
    const raw = Buffer.from(sealed.slice(PREFIX.length), "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Forget the key, for tests that change where it comes from. */
export function resetSecretKey(): void {
  cached = null;
}

/**
 * A keyed hash, for something that must be checked later but never read
 * back — a one-time code. Without the key, the stored hash of a six-digit
 * code cannot simply be tried a million times over.
 */
export function keyedHash(purpose: string, data: string): string {
  return crypto.createHmac("sha256", key()).update(`${purpose}:${data}`).digest("hex");
}
