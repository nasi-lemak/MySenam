import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startStandin, type Standin } from "./helpers/s3-standin";

/**
 * The off-site erasure ledger in a disaster recovery, with the real scripts
 * (scripts/backup.mjs, scripts/fetch-backup.mjs, scripts/restore.mjs) run as
 * an operator runs them, and a stand-in bucket (tests/helpers/s3-standin.ts:
 * an upload-only key on the server, a read key on the restore machine).
 * docs/operations/backups.md#after-a-restore; ADR 0024.
 *
 * This process is the server: it erases, and copies the ledger off-site. The
 * scripts are the restore machine: they hold only the read key, the
 * encryption private key and the signing public key. "The server is lost"
 * is the backup folder, with the ledger beside it, deleted.
 *
 * Without TEST_DATABASE_URL the database is a PGlite folder; with it, the
 * file's own throwaway Postgres database (tests/setup-db.ts), through pg_dump
 * and pg_restore. PGlite is one process's database, so this file closes it
 * before each script runs.
 */

const run = promisify(execFile);
const ROOT = path.join(__dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "mysenam-ledger-restore-"));
let bucket: Standin;

const env: Record<string, string | undefined> = {
  ...process.env,
  DATABASE_URL: process.env.TEST_DATABASE_URL ? process.env.DATABASE_URL : `pglite:${path.join(work, "pglite")}`,
  MYSENAM_DATA_DIR: work,
  MYSENAM_DB: "",
};
process.env.DATABASE_URL = env.DATABASE_URL;
process.env.MYSENAM_DATA_DIR = work;
delete process.env.MYSENAM_DB;
for (const k of Object.keys(env)) if (k.startsWith("OFFSITE_")) delete env[k];

const backups = path.join(work, "backups");
const keyFile = (name: string, pem: string) => {
  fs.writeFileSync(path.join(work, name), pem);
  return path.join(work, name);
};

/** Point the server (this process) and the restore machine (the scripts) at the bucket, under a prefix of each test's own. */
function offsite(prefix: string, server: Record<string, string> = {}) {
  const common = { OFFSITE_S3_ENDPOINT: bucket.endpoint, OFFSITE_S3_BUCKET: "backups", OFFSITE_S3_REGION: bucket.region, OFFSITE_S3_PREFIX: prefix };
  for (const k of Object.keys(process.env)) if (k.startsWith("OFFSITE_")) delete process.env[k];
  Object.assign(process.env, common, {
    OFFSITE_S3_ACCESS_KEY_ID: "upload",
    OFFSITE_S3_SECRET_ACCESS_KEY: "u",
    OFFSITE_DATA_LOCATION: "US",
    OFFSITE_TRANSFER_APPROVED: "US",
    OFFSITE_ENCRYPTION_PUBLIC_KEY_FILE: path.join(work, "enc-pub.pem"),
    OFFSITE_SIGNING_KEY_FILE: path.join(work, "sign.pem"),
    ...server,
  });
  for (const k of Object.keys(env)) if (k.startsWith("OFFSITE_")) delete env[k];
  Object.assign(env, common, {
    OFFSITE_S3_READ_ACCESS_KEY_ID: "read",
    OFFSITE_S3_READ_SECRET_ACCESS_KEY: "r",
    OFFSITE_ENCRYPTION_PRIVATE_KEY_FILE: path.join(work, "enc.pem"),
    OFFSITE_SIGNING_PUBLIC_KEY_FILE: path.join(work, "sign-pub.pem"),
  });
}

beforeAll(async () => {
  bucket = await startStandin({
    upload: { secret: "u", capabilities: ["writeFiles"], bucket: "backups", prefix: "" },
    read: { secret: "r", capabilities: ["listFiles", "readFiles"], bucket: "backups", prefix: "" },
  });
  const sign = crypto.generateKeyPairSync("ed25519");
  const enc = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  keyFile("sign.pem", sign.privateKey.export({ type: "pkcs8", format: "pem" }) as string);
  keyFile("sign-pub.pem", sign.publicKey.export({ type: "spki", format: "pem" }) as string);
  keyFile("enc-pub.pem", enc.publicKey.export({ type: "spki", format: "pem" }) as string);
  keyFile("enc.pem", enc.privateKey.export({ type: "pkcs8", format: "pem" }) as string);
});
afterAll(async () => {
  await bucket.close();
  fs.rmSync(work, { recursive: true, force: true });
});

async function script(name: string, args: string[]) {
  try {
    const { stdout, stderr } = await run("node", [path.join("scripts", name), ...args], { cwd: ROOT, env: env as NodeJS.ProcessEnv });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

const lib = async () => ({
  db: (await import("../src/lib/db")).getDb(),
  ledger: await import("../src/lib/erasure-ledger"),
  offsite: await import("../src/lib/erasure-ledger-offsite"),
  privacy: await import("../src/lib/privacy"),
});

async function customer(tag: string) {
  const { registerUser } = await import("../src/lib/auth");
  const made = await registerUser({ name: `Restore ${tag}`, email: `${tag}@ledger-restore.test`, phone: `0178${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

const present = async (table: string, id: number) => Boolean(await (await lib()).db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id));

/** A backup set with the backup script (the app stopped), copied off-site as the server does after each one. */
async function backupAndCopy(): Promise<string> {
  const { db } = await lib();
  await db.close();
  const before = new Set(fs.existsSync(backups) ? fs.readdirSync(backups) : []);
  const made = await script("backup.mjs", ["--app-stopped"]);
  expect(made.code, made.out).toBe(0);
  const name = fs.readdirSync(backups).find((f) => !before.has(f) && /^mysenam-[\d-]+\.(dump|tar\.gz)$/.test(f))!;
  const { copyOffsite } = await import("../src/lib/offsite");
  const { manifestOf } = await import("../src/lib/backup");
  const file = path.join(backups, name);
  expect((await copyOffsite({ name, path: file }, null, manifestOf(file)))?.ok).toBe(true);
  return name;
}

/** Everything copied off-site that can be. */
async function shipped() {
  const { ledger, offsite } = await lib();
  await vi.waitFor(
    async () => {
      await offsite.shipLedger();
      const head = await ledger.ledgerHead();
      expect(head.shippedSeq).toBe(head.seq);
    },
    { timeout: 10_000, interval: 100 }
  );
}

/** The server is lost: its backups, and the ledger beside them, gone. A new machine fetches the set from the bucket. */
async function loseServerAndFetch(name: string, to: string): Promise<string> {
  const { db } = await lib();
  await db.close();
  fs.rmSync(backups, { recursive: true, force: true });
  const fetched = await script("fetch-backup.mjs", [name, "--to", to]);
  expect(fetched.code, fetched.out).toBe(0);
  return path.join(to, name);
}

describe("restoring after the server is lost", () => {
  it("replays the erasures made after the backup from the off-site ledger alone, puts back the newest periods, re-runs retention, and serves nothing until acknowledged", async () => {
    offsite("venue1/");
    const { db, privacy } = await lib();
    const { createAdmin } = await import("../src/lib/admin-auth");
    const { addManaged } = await import("../src/lib/managed-people");
    const { setRetentionPolicy, retentionPolicy } = await import("../src/lib/retention-policy");
    const owner = await createAdmin({ name: "Restore Owner", email: "owner@ledger-restore.test", password: "a long enough password", venueId: null });
    if (!owner.ok) throw new Error(owner.error);
    const leaving = await customer("leaving");
    const child = await addManaged(leaving.id, { displayName: "Leaving Child", relationship: "parent", authority: true });
    if (!child.ok) throw new Error(child.error);
    const alsoLeaving = await customer("also-leaving");
    const staying = await customer("staying");
    // Due to go under the retention policy, and not gone yet when the backup is taken.
    await db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('expired-before-backup', ?, datetime('now', '-2 days'))").run(staying.id);
    const name = await backupAndCopy();

    // After the backup: two accounts closed (one with the child only it acted for), the periods shortened; all copied off-site.
    expect((await privacy.eraseCustomer(leaving.id)).ok).toBe(true);
    expect((await privacy.eraseCustomer(alsoLeaving.id)).ok).toBe(true);
    expect((await setRetentionPolicy(owner.admin, { documentDays: 45 })).ok).toBe(true);
    await shipped();
    const head = await (await lib()).ledger.ledgerHead();

    const set = await loseServerAndFetch(name, path.join(work, "fetched-1"));
    const restored = await script("restore.mjs", [set, "--force", "--app-stopped"]);
    // Restored, but not complete by itself: the ledger beside the backups went with the server.
    expect(restored.code, restored.out).toBe(3);
    expect(restored.out).toMatch(new RegExp(`verified to entry ${head.seq}; \\d+ entries brought in`));
    expect(restored.out).toContain("off-site segment(s) (signatures verified)");
    expect(restored.out).toContain("applies again the 3 erasure(s) recorded since this backup");
    expect(restored.out).toContain("The ledger beside the backups is not here");
    expect(restored.out).toContain("--acknowledge-ledger");
    // The restored copy has them all back; the app will not serve it.
    const after = await lib();
    expect(await present("users", leaving.id)).toBe(true);
    expect(await present("participants", child.person.id)).toBe(true);
    expect(await after.ledger.restoreGate()).toMatch(/could not show the erasure ledger complete/);
    await after.db.close();

    const acknowledged = await script("restore.mjs", ["--acknowledge-ledger", "Checked the erasure-ledger alerts and closure requests since the backup: none missing."]);
    expect(acknowledged.code, acknowledged.out).toBe(0);
    expect(acknowledged.out).toContain("Acknowledged by");

    // The app's start: every erasure applied again, the newest periods back, retention re-run; then it may serve.
    const started = await lib();
    const result = await started.ledger.reapplyIfRestored();
    expect(result).toMatchObject({ erasedAgain: 3, refused: [], policyRestored: true });
    expect(await started.ledger.restoreGate()).toBeNull();
    expect(await present("users", leaving.id)).toBe(false);
    expect(await present("users", alsoLeaving.id)).toBe(false);
    expect(await present("participants", child.person.id)).toBe(false);
    expect(await present("users", staying.id)).toBe(true);
    expect(await started.db.prepare("SELECT 1 FROM sessions WHERE token = 'expired-before-backup'").get()).toBeUndefined();
    expect((await retentionPolicy()).documentDays).toBe(45);
    const recovery = (await started.db.prepare("SELECT state, acknowledged_by, acknowledgement FROM erasure_ledger_recoveries ORDER BY id DESC LIMIT 1").get()) as Record<string, string>;
    expect(recovery).toMatchObject({ state: "blocked", acknowledgement: expect.stringContaining("Checked the erasure-ledger alerts") });
  }, 300_000);

  it("finds the newest entries missing when a newer backup's manifest names an entry the off-site ledger lacks; after acknowledgement they are recorded as lost", async () => {
    offsite("venue2/");
    const shippedOne = await customer("shipped-one");
    const neverLeft = await customer("never-left");
    const first = await backupAndCopy();
    const { privacy } = await lib();
    expect((await privacy.eraseCustomer(shippedOne.id)).ok).toBe(true);
    await shipped();
    // The ledger's copies start failing (its key may not upload), and the next erasure never leaves the server…
    offsite("venue2/", { OFFSITE_LEDGER_S3_ACCESS_KEY_ID: "read", OFFSITE_LEDGER_S3_SECRET_ACCESS_KEY: "r" });
    expect((await privacy.eraseCustomer(neverLeft.id)).ok).toBe(true);
    const { ledger, offsite: off, db } = await lib();
    await vi.waitFor(async () => expect((await off.ledgerOffsiteStatus()).lastError).not.toBeNull(), { timeout: 10_000, interval: 100 });
    const head = await ledger.ledgerHead();
    expect(head.shippedSeq).toBe(head.seq - 1);
    // …but the next backup set does, and its signed manifest names the newest entry.
    await backupAndCopy();
    await db.close();

    const set = await loseServerAndFetch(first, path.join(work, "fetched-2"));
    const restored = await script("restore.mjs", [set, "--force", "--app-stopped"]);
    expect(restored.code, restored.out).toBe(3);
    expect(restored.out).toMatch(new RegExp(`The newest backup set in the bucket \\(mysenam-[\\d-]+\\.manifest\\.json\\) says the ledger had reached entry ${head.seq}; the verified ledger reaches ${head.seq - 1}`));
    const acknowledged = await script("restore.mjs", ["--acknowledge-ledger", "Entry missing: the closure request of 27 October, to be erased again by hand."]);
    expect(acknowledged.code, acknowledged.out).toBe(0);
    expect(acknowledged.out).toContain(`Entries ${head.seq}–${head.seq} are recorded as lost`);

    const started = await lib();
    expect(await started.ledger.reapplyIfRestored()).toMatchObject({ erasedAgain: 1 });
    expect(await started.ledger.restoreGate()).toBeNull();
    expect(await present("users", shippedOne.id)).toBe(false);
    // The one that never left the server came back: what the acknowledgement is for. The owner erases it by hand.
    expect(await present("users", neverLeft.id)).toBe(true);
    // Its number is not taken again.
    expect(await started.ledger.ledgerHead()).toMatchObject({ seq: head.seq + 1 });
    expect((await started.ledger.ledgerEntries(head.seq - 1))[0]).toMatchObject({ kind: "recovery", seq: head.seq + 1 });
  }, 300_000);

  it("finds a missing or changed segment, applies nothing past it, and serves nothing until acknowledged; whole, it replays everything", async () => {
    offsite("venue3/");
    const people = [await customer("y1"), await customer("y2"), await customer("y3")];
    const name = await backupAndCopy();
    const { privacy } = await lib();
    for (const p of people) {
      expect((await privacy.eraseCustomer(p.id)).ok).toBe(true);
      await shipped();
    }
    const segments = [...bucket.versions.keys()].filter((k) => k.startsWith("backups/venue3/erasure-ledger/") && k.endsWith(".enc")).sort();
    expect(segments.length).toBeGreaterThanOrEqual(3);
    const middle = segments.at(-2)!;
    const kept = bucket.versions.get(middle)!;
    const set = await loseServerAndFetch(name, path.join(work, "fetched-3"));

    // A segment removed from the bucket: a gap.
    bucket.versions.delete(middle);
    let restored = await script("restore.mjs", [set, "--force", "--app-stopped"]);
    expect(restored.code, restored.out).toBe(3);
    expect(restored.out).toMatch(/the chain stops at \d+: entry \d+ is missing/);
    let now = await lib();
    // Nothing past the gap is applied, and the app does not serve the copy that still has them.
    await now.ledger.reapplyIfRestored();
    expect(await present("users", people[0].id)).toBe(false);
    expect(await present("users", people[2].id)).toBe(true);
    expect(await now.ledger.restoreGate()).toMatch(/could not show the erasure ledger complete/);
    await now.db.close();

    // The segment's only copy changed in the bucket: refused.
    const changed = Buffer.from(kept[0]);
    changed[changed.length - 20] ^= 1;
    bucket.versions.set(middle, [changed]);
    restored = await script("restore.mjs", [set, "--force", "--app-stopped"]);
    expect(restored.code, restored.out).toBe(3);
    expect(restored.out).toMatch(/Off-site segment ledger-[\d-]+T\d+Z\.json was refused: The encrypted backup does not check out/);
    now = await lib();
    expect(await now.ledger.restoreGate()).not.toBeNull();
    await now.db.close();

    // Whole again, acknowledged on the same command: every erasure comes back off-site, and is applied.
    bucket.versions.set(middle, kept);
    restored = await script("restore.mjs", [set, "--force", "--app-stopped", "--acknowledge-ledger", "New machine after losing the server; alerts checked, nothing newer."]);
    expect(restored.code, restored.out).toBe(0);
    now = await lib();
    expect(await now.ledger.reapplyIfRestored()).toMatchObject({ erasedAgain: 3, refused: [] });
    expect(await now.ledger.restoreGate()).toBeNull();
    for (const p of people) expect(await present("users", p.id)).toBe(false);
    await now.db.close();
  }, 300_000);
});
