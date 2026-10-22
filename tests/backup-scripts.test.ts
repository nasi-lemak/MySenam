import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The command-line scripts, run the way an operator runs them: `node` loading
 * the TypeScript straight from src/, with no bundler to forgive an import Node
 * cannot resolve. A backup is taken and put back, so the only way back from
 * losing the database is exercised rather than assumed.
 *
 * Without TEST_DATABASE_URL the database is a PGlite folder; with it, the
 * file's own throwaway Postgres database (tests/setup-db.ts), through pg_dump
 * and pg_restore.
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

async function script(name: string, args: string[]) {
  try {
    const { stdout, stderr } = await run("node", [path.join("scripts", name), ...args], { cwd: ROOT, env });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

describe("the backup and restore scripts", () => {
  it("take a backup and put it back", async () => {
    const dir = path.join(work, "backups");
    const backup = await script("backup.mjs", ["--app-stopped", "--dir", dir]);
    expect(backup.out).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(backup.code).toBe(0);

    const files = fs.readdirSync(dir).filter((f) => /\.(dump|tar\.gz)$/.test(f));
    expect(files).toHaveLength(1);

    const restore = await script("restore.mjs", [path.join(dir, files[0]), "--force"]);
    expect(restore.code, restore.out).toBe(0);
    expect(restore.out).toMatch(/Restored: \d+ bookings/);
    expect(restore.out).toContain("What was there is kept in");
  }, 180_000);

  it("the SQLite import starts", async () => {
    // No file named: it should explain itself, not fail to load.
    const imported = await script("import-sqlite.mjs", []);
    expect(imported.out).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(imported.out).toMatch(/usage|sqlite/i);
  }, 60_000);
});
