import { describe, expect, it } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { runStep } from "../src/lib/db-steps";

/**
 * Migration 0137 (lib/coach-schedule.ts) on an install where coaches already
 * have private links: each link keeps working, now looked up by its hash, for
 * a year; the plain token is gone from the database; a coach without a link
 * gets none.
 */

const DIR = path.join(__dirname, "..", "db", "migrations");
const FILES = fs.readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

async function run(db: PGlite, files: string[]): Promise<void> {
  for (const f of files) {
    const version = f.replace(/\.sql$/, "");
    await db.transaction(async (tx) => {
      await tx.exec(fs.readFileSync(path.join(DIR, f), "utf8"));
      await runStep(version, { query: async (sql, params) => ({ rows: (await tx.query(sql, params)).rows as Record<string, unknown>[] }) });
    });
  }
}

describe("migration 0137 on coaches with links already given", () => {
  it("keeps each link working by its hash for a year, and removes the plain token", async () => {
    const db = new PGlite({ extensions: { citext } });
    const before = FILES.filter((f) => f < "0137");
    await run(db, before);
    const venue = (await db.query<{ id: number }>("INSERT INTO venues (name, area, address, phone, time_zone) VALUES ('Old Hall', 'PJ', 'x', '031', 'Asia/Kuala_Lumpur') RETURNING id")).rows[0].id;
    const token = crypto.randomBytes(24).toString("base64url");
    await db.query("INSERT INTO coaches (venue_id, name, sports, rate, calendar_token) VALUES ($1, 'Ana', 'badminton', 80, $2)", [venue, token]);
    await db.query("INSERT INTO coaches (venue_id, name, sports, rate) VALUES ($1, 'Ben', 'badminton', 80)", [venue]);

    await run(db, FILES.filter((f) => f >= "0137"));

    const rows = (await db.query<{ name: string; calendar_token: string | null; link_hash: string | null; days: number | null }>(
      "SELECT name, calendar_token, link_hash, EXTRACT(EPOCH FROM link_expires_at - now()) / 86400 AS days FROM coaches ORDER BY name"
    )).rows;
    expect(rows[0].calendar_token).toBeNull();
    expect(rows[0].link_hash).toBe(crypto.createHash("sha256").update(token).digest("hex"));
    expect(Number(rows[0].days)).toBeGreaterThan(364);
    expect(rows[1]).toMatchObject({ calendar_token: null, link_hash: null, days: null });
    await db.close();
  });
});
