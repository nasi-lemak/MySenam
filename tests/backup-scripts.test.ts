import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import sharp from "sharp";
import { promisify } from "util";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The command-line scripts, run the way an operator runs them: `node` loading
 * the TypeScript straight from src/, with no bundler to forgive an import Node
 * cannot resolve. A backup is taken and put back, so the only way back from
 * losing the database is exercised rather than assumed: what comes back is
 * compared, row for row and photo for photo, with what was backed up.
 *
 * Without TEST_DATABASE_URL the database is a PGlite folder; with it, the
 * file's own throwaway Postgres database (tests/setup-db.ts), through pg_dump
 * and pg_restore. This file opens the same database to fill and read it,
 * closing it before each script runs (PGlite is one process's database).
 */

const run = promisify(execFile);
const ROOT = path.join(__dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "mysenam-scripts-"));
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

const env = {
  ...process.env,
  DATABASE_URL: process.env.TEST_DATABASE_URL ? process.env.DATABASE_URL : `pglite:${path.join(work, "pglite")}`,
  MYSENAM_DATA_DIR: work,
  MYSENAM_DB: "",
};
// This process uses the same database and data folder as the scripts.
process.env.DATABASE_URL = env.DATABASE_URL;
process.env.MYSENAM_DATA_DIR = work;
delete process.env.MYSENAM_DB;

async function script(name: string, args: string[]) {
  try {
    const { stdout, stderr } = await run("node", [path.join("scripts", name), ...args], { cwd: ROOT, env });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

/** Every table a restore must bring back as it was, whole, with each customer's balance. */
const TABLES = ["venues", "courts", "users", "bookings", "claims", "wallet_entries", "receipts", "online_payments", "venue_photos"];

async function fingerprint() {
  const { getDb } = await import("../src/lib/db");
  const db = getDb();
  const tables: Record<string, string> = {};
  for (const t of TABLES)
    tables[t] = ((await db.prepare(`SELECT COALESCE(json_agg(t ORDER BY t.id)::text, '[]') AS rows FROM ${t} t`).get()) as { rows: string }).rows;
  const balances = (await db
    .prepare("SELECT user_id, SUM(amount)::float8 AS balance FROM wallet_entries GROUP BY user_id ORDER BY user_id")
    .all()) as { user_id: number; balance: number }[];
  const dir = path.join(work, "photos");
  const photos: Record<string, string> = {};
  if (fs.existsSync(dir))
    for (const f of (fs.readdirSync(dir, { recursive: true }) as string[]).sort()) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isFile()) photos[f] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  await db.close();
  return { tables, balances, photos };
}

describe("the backup and restore scripts", () => {
  it("take a backup and put back exactly what was in it: bookings, payments, balances, venue settings and photos", async () => {
    const store = await import("../src/lib/store");
    const { addPhoto, removePhoto, venuePhotos } = await import("../src/lib/photos");
    const { ensureBootstrapAdmin, listAdmins } = await import("../src/lib/admin-auth");
    const { registerUser } = await import("../src/lib/auth");
    const { addDays, todayISO } = await import("../src/lib/time");

    // What a venue has: its settings, a customer with credit, a booking paid from it, a photo.
    await ensureBootstrapAdmin();
    const adminId = (await listAdmins())[0].id;
    const venue = (await store.listVenues())[0];
    expect((await store.updateVenue(venue.id, { name: "Restored Arena", cancelCutoffHours: 6 })).ok).toBe(true);
    const reg = await registerUser({ name: "Kept Customer", email: "kept@restore.my", phone: "0175550101", password: "a long enough password" });
    if (!reg.ok) throw new Error(reg.error);
    await store.topUpWallet({ userId: reg.user.id, amount: 50, adminId });
    const made = await store.createBooking({ courtId: venue.courts[0].id, date: addDays(todayISO(), 4), hours: [10], name: "Kept Customer", phone: reg.user.phone, userId: reg.user.id });
    if (!made.ok) throw new Error(made.error);
    expect((await store.payBookingFromWallet(made.booking.id)).ok).toBe(true);
    const picture = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 60, b: 40 } } }).jpeg().toBuffer();
    const added = await addPhoto(venue.id, picture, { caption: "Court one" });
    if (!added.ok) throw new Error(added.error);
    const before = await fingerprint();
    expect(Object.keys(before.photos).length).toBeGreaterThan(0);
    expect(before.balances.find((b) => b.user_id === reg.user.id)?.balance).toBe(35);

    const dir = path.join(work, "backups");
    const backup = await script("backup.mjs", ["--app-stopped", "--dir", dir]);
    expect(backup.out).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(backup.code, backup.out).toBe(0);
    const files = fs.readdirSync(dir).filter((f) => /^mysenam-[\d-]+\.(dump|tar\.gz)$/.test(f));
    expect(files).toHaveLength(1);
    // The photos went with it.
    expect(fs.readdirSync(dir)).toContain(files[0].replace(/\.(dump|tar\.gz)$/, ".photos.tar.gz"));

    // Then things go wrong: the booking is cancelled and refunded, the venue
    // renamed, the photo deleted, and what is left of the photos folder lost.
    expect((await store.cancelBooking(made.booking.code, reg.user.phone)).ok).toBe(true);
    expect((await store.updateVenue(venue.id, { name: "Changed Since" })).ok).toBe(true);
    expect((await removePhoto(venue.id, (await venuePhotos(venue.id))[0].id)).ok).toBe(true);
    fs.rmSync(path.join(work, "photos"), { recursive: true, force: true });
    const changed = await fingerprint();
    expect(changed.tables.bookings).not.toBe(before.tables.bookings);
    expect(changed.photos).toEqual({});

    const restore = await script("restore.mjs", [path.join(dir, files[0]), "--force"]);
    expect(restore.code, restore.out).toBe(0);
    expect(restore.out).toMatch(/Restored: \d+ bookings, [1-9]\d* photos/);
    expect(restore.out).toContain("What was there is kept in");

    // Row for row, balance for balance and photo for photo, what was backed up.
    const after = await fingerprint();
    for (const t of TABLES) expect(after.tables[t], t).toBe(before.tables[t]);
    expect(after.balances).toEqual(before.balances);
    expect(after.photos).toEqual(before.photos);
    // And the app reads it back as it was.
    expect((await store.findBookingByCode(made.booking.code))?.status).toBe("confirmed");
    expect(await store.getWalletBalance(reg.user.id)).toBe(35);
    expect((await store.listVenues()).find((v) => v.id === venue.id)?.name).toBe("Restored Arena");
    expect((await venuePhotos(venue.id))[0].caption).toBe("Court one");
    const { getDb } = await import("../src/lib/db");
    await getDb().close();
  }, 240_000);

  it("drill a backup set fetched back from off-site storage, refuse one that is damaged, and refuse to restore under a running app", async () => {
    // A bucket that keeps what is put in it, lists it and serves it back.
    const bucket = new Map<string, Buffer>();
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const url = new URL(req.url!, "http://x");
        if (req.method === "PUT") {
          bucket.set(decodeURIComponent(url.pathname), Buffer.concat(chunks));
          res.writeHead(200).end();
        } else if (url.searchParams.get("list-type") === "2") {
          const prefix = `${url.pathname}/${url.searchParams.get("prefix")}`;
          const contents = [...bucket]
            .filter(([k]) => k.startsWith(prefix))
            .map(([k, v]) => `<Contents><Key>${k.slice(url.pathname.length + 1)}</Key><Size>${v.length}</Size><LastModified>2026-10-24T03:00:00Z</LastModified></Contents>`);
          res.writeHead(200, { "content-type": "application/xml" }).end(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents.join("")}</ListBucketResult>`);
        } else if (bucket.has(decodeURIComponent(url.pathname))) {
          res.writeHead(200).end(bucket.get(decodeURIComponent(url.pathname)));
        } else res.writeHead(404, { "content-type": "application/xml" }).end("<Error><Code>NoSuchKey</Code></Error>");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const offsite = {
      OFFSITE_S3_ENDPOINT: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      OFFSITE_S3_BUCKET: "backups",
      OFFSITE_S3_ACCESS_KEY_ID: "id",
      OFFSITE_S3_SECRET_ACCESS_KEY: "secret",
      OFFSITE_S3_PREFIX: "drill/",
      OFFSITE_DATA_LOCATION: "MY",
    };
    Object.assign(process.env, offsite);
    Object.assign(env, offsite);
    try {
      const { createBackup } = await import("../src/lib/backup");
      const { copyOffsite } = await import("../src/lib/offsite");
      const { getDb } = await import("../src/lib/db");
      const dir = path.join(work, "backups-offsite");
      const taken = await createBackup({ dir });
      if (!taken.ok) throw new Error(taken.error);
      expect((await copyOffsite(taken.file, taken.photos.file, taken.manifest))?.ok).toBe(true);
      // The manifest went last.
      expect([...bucket.keys()].at(-1)).toMatch(/\.manifest\.json$/);
      const before = await fingerprint();

      const listed = await script("fetch-backup.mjs", ["--list"]);
      expect(listed.code, listed.out).toBe(0);
      expect(listed.out).toContain(`${taken.file.name}`);
      expect(listed.out).toContain("whole (manifest)");

      const fetchedDir = path.join(work, "fetched");
      const fetched = await script("fetch-backup.mjs", [taken.file.name, "--to", fetchedDir]);
      expect(fetched.code, fetched.out).toBe(0);
      expect(fetched.out).toContain("every part matches its manifest");
      expect(fs.readFileSync(path.join(fetchedDir, taken.file.name)).equals(fs.readFileSync(taken.file.path))).toBe(true);

      const drill = await script("restore.mjs", [path.join(fetchedDir, taken.file.name), "--drill"]);
      expect(drill.code, drill.out).toBe(0);
      expect(drill.out).toMatch(new RegExp(`Restored aside in [\\d.]+ s: \\d+ venues, .*${taken.bookings} bookings`));
      expect(drill.out).toContain("Drill passed");
      expect(await fingerprint()).toEqual(before);

      // Damaged in the bucket: fetched, found out, and not restorable.
      const photosKey = [...bucket.keys()].find((k) => k.endsWith(".photos.tar.gz"))!;
      bucket.set(photosKey, Buffer.concat([bucket.get(photosKey)!, Buffer.from("x")]));
      const damaged = await script("fetch-backup.mjs", [taken.file.name, "--to", path.join(work, "fetched-damaged")]);
      expect(damaged.code).not.toBe(0);
      expect(damaged.out).toMatch(/not whole[\s\S]*photos\.tar\.gz is not what was backed up/);
      const refused = await script("restore.mjs", [path.join(work, "fetched-damaged", taken.file.name), "--force", "--app-stopped"]);
      expect(refused.code).not.toBe(0);
      expect(refused.out).toMatch(/not whole, so nothing was restored/);
      const drilledDamaged = await script("restore.mjs", [path.join(work, "fetched-damaged", taken.file.name), "--drill"]);
      expect(drilledDamaged.code).not.toBe(0);
      expect(drilledDamaged.out).toContain("The drill failed");

      // An app instance still holds the scheduler's lease: nothing is replaced.
      await getDb()
        .prepare("INSERT INTO settings (key, value) VALUES ('scheduler_lease', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .run(`web-1|${Date.now() + 3 * 60_000}`);
      const leased = await fingerprint();
      const underApp = await script("restore.mjs", [taken.file.path, "--force"]);
      expect(underApp.code).not.toBe(0);
      expect(underApp.out).toContain("looks to be running");
      expect(await fingerprint()).toEqual(leased);
    } finally {
      server.close();
      for (const k of Object.keys(offsite)) {
        delete process.env[k];
        delete (env as Record<string, string | undefined>)[k];
      }
    }
  }, 240_000);

  it("the SQLite import starts", async () => {
    // No file named: it should explain itself, not fail to load.
    const imported = await script("import-sqlite.mjs", []);
    expect(imported.out).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(imported.out).toMatch(/usage|sqlite/i);
  }, 60_000);
});
