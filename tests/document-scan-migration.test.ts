import crypto from "crypto";
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { runStep } from "../src/lib/db-steps";

/**
 * Migration 0159 (ADR 0024, amended 27 October 2026) on an install with
 * supporting documents in every state the earlier code could leave them in:
 * stored before scanning existed (before 0142), taken unscanned under the
 * withdrawn opt-out, failed with no scanner, failed for a working scanner's
 * reason, and clean. None is released by it, none is removed, legacy ones
 * are marked, and those taken unscanned go back into quarantine.
 */

const DIR = path.join(__dirname, "..", "db", "migrations");
const FILES = fs.readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

async function run(db: PGlite, files: string[]): Promise<void> {
  for (const f of files) {
    const version = f.replace(/\.sql$/, "");
    await db.transaction(async (tx) => {
      await tx.exec(fs.readFileSync(path.join(DIR, f), "utf8"));
      await runStep(version, { query: async (sql, params) => ({ rows: (await tx.query(sql, params)).rows as Record<string, unknown>[] }) });
      // As the app's migration runner records it (lib/db.ts).
      await tx.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
    });
  }
}

const hex = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n", "latin1");

describe("migration 0159 on documents stored before scanning, taken unscanned, failed and clean", () => {
  it("releases nothing, removes nothing, marks legacy documents and puts those taken unscanned back in quarantine", async () => {
    const db = new PGlite({ extensions: { citext } });
    await db.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    await run(db, FILES.filter((f) => f < "0142"));
    const id = async (sql: string, params: unknown[] = []) => (await db.query<{ id: number }>(`${sql} RETURNING id`, params)).rows[0].id;
    const venue = await id("INSERT INTO venues (name, area, address, phone, time_zone) VALUES ('Old Pool', 'PJ', 'x', '031', 'Asia/Kuala_Lumpur')");
    const user = await id("INSERT INTO users (name, email, phone, password_hash) VALUES ('Lim Wei', 'lim@old.my', '0123000002', 'x')");
    const sport = ((await db.query<{ key: string }>("SELECT key FROM activities ORDER BY key LIMIT 1")).rows[0]).key;
    const requirement = await id("INSERT INTO approval_requirements (venue_id, sport, kind, document_label) VALUES ($1, $2, 'certification', 'Certificate')", [venue, sport]);
    const request = await id(
      "INSERT INTO approval_requests (requirement_id, venue_id, sport, user_id, name, phone, status, declared_adult, expires_at) VALUES ($1, $2, $3, $4, 'Lim Wei', '0123000002', 'pending', 1, now() + interval '14 days')",
      [requirement, venue, sport, user]
    );
    const doc = (created: string) =>
      id("INSERT INTO approval_documents (request_id, content_type, size, content, created_at) VALUES ($1, 'image/webp', $2, $3, $4)", [request, PDF.length, PDF, created]);
    // Stored before scanning existed.
    const before = await doc("2026-10-01T10:00:00Z");

    await run(db, FILES.filter((f) => f >= "0142" && f < "0159"));
    // What the earlier code left: taken unscanned under the opt-out (intact, and one whose bytes no longer match),
    // failed with no scanner, failed for a working scanner's reason, clean.
    const later = async (status: string, error: string | null, hash = hex(PDF)) =>
      id(
        `INSERT INTO approval_documents (request_id, content_type, size, content, sha256, scan_status, scanned_at, scan_attempts, scan_next_at, scan_error)
         VALUES ($1, 'image/webp', $2, $3, $4, $5, now(), 7, NULL, $6)`,
        [request, PDF.length, PDF, hash, status, error]
      );
    const optedOut = await later("not_scanned", null);
    const optedOutChanged = await later("not_scanned", null, "0".repeat(64));
    const noScanner = await later("failed", "unavailable: no scanner configured");
    const tooLarge = await later("failed", "too_large: size limit exceeded");
    await db.query("UPDATE approval_documents SET scan_status = 'failed', scanned_at = now(), scan_error = 'unavailable: no scanner configured' WHERE id = $1", [before]);
    const clean = await id(
      "INSERT INTO approval_documents (request_id, content_type, size, content, sha256, scan_status, scanned_at, scan_engine, scan_sha256) VALUES ($1, 'image/webp', $2, $3, $4, 'clean', now(), 'ClamAV', $4)",
      [request, PDF.length, PDF, hex(PDF)]
    );

    await run(db, FILES.filter((f) => f >= "0159"));

    const rows = (await db.query<{ id: number; scan_status: string; scan_failure: string | null; legacy_reason: string | null; bytes: number }>(
      "SELECT id, scan_status, scan_failure, legacy_reason, octet_length(content) AS bytes FROM approval_documents ORDER BY id"
    )).rows;
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(rows).toHaveLength(6);
    expect(by[before]).toMatchObject({ scan_status: "failed", scan_failure: "scanner_unavailable", legacy_reason: "before_scanning", bytes: PDF.length });
    expect(by[optedOut]).toMatchObject({ scan_status: "pending", scan_failure: null, legacy_reason: "scanning_off" });
    expect(by[optedOutChanged]).toMatchObject({ scan_status: "failed", scan_failure: "unscannable", legacy_reason: "scanning_off" });
    expect(by[noScanner]).toMatchObject({ scan_status: "failed", scan_failure: "scanner_unavailable", legacy_reason: null });
    expect(by[tooLarge]).toMatchObject({ scan_status: "failed", scan_failure: "unscannable", legacy_reason: null });
    expect(by[clean]).toMatchObject({ scan_status: "clean", legacy_reason: null });
    // Nothing is clean but what a scan passed, and `not_scanned` cannot be written again.
    expect(rows.filter((r) => r.scan_status === "clean").map((r) => r.id)).toEqual([clean]);
    await expect(db.query("UPDATE approval_documents SET scan_status = 'not_scanned' WHERE id = $1", [optedOut])).rejects.toThrow();
    // A failed document goes back into quarantine only with its bytes intact; its hash never changes.
    await db.query("UPDATE approval_documents SET scan_status = 'pending', scan_failure = NULL WHERE id = $1", [noScanner]);
    await expect(db.query("UPDATE approval_documents SET scan_status = 'pending', scan_failure = NULL WHERE id = $1", [optedOutChanged])).rejects.toThrow(/settled/);
    await expect(db.query("UPDATE approval_documents SET sha256 = $2 WHERE id = $1", [clean, "1".repeat(64)])).rejects.toThrow(/hash/);
  });
});
