import crypto from "crypto";
import fs from "fs";
import path from "path";
import { raiseAlert } from "./alerts";
import { backupDir } from "./backup";
import { getDb, isEphemeral } from "./db";

/**
 * A restore must not bring back what retention or erasure already removed
 * (docs/operations/backups.md#after-a-restore; ADR 0024).
 *
 * A backup holds whatever was in the database when it was taken: an account
 * closed the next day, a document deleted the next week. Two things put that
 * right after a restore:
 *
 * - **The erasure ledger.** Every erasure is recorded (`erasure_ledger`) and,
 *   outside the database, appended to `erasure-ledger.jsonl` beside the backup
 *   sets, which a restore does not overwrite. An entry is the account's number
 *   and the moment it was created: no name, email or phone. After a restore,
 *   every entry is applied again to the account it names, if that account is
 *   back, and only if it was created at that moment, so a later account that
 *   happens to get the same number is never touched.
 * - **The retention run**, applied again straight away, so whatever had aged
 *   out since the backup goes again.
 *
 * The restore script marks the database (`restore_reapply_due`); the app does
 * both at its next start, before it serves anything (src/instrumentation-node.ts).
 * A restore done another way is caught too: entries in the file the restored
 * database does not have mean a restore happened.
 *
 * What this cannot do: an erasure made after the last copy of the ledger
 * file left the server is lost with the server (the file is not copied
 * off-site), and copies inside backups themselves stay until those backups
 * expire. Both are stated in the privacy notice and the backups document.
 */

/** Ledger entries are kept this long: longer than any backup set is kept, locally or off-site. */
export const ERASURE_LEDGER_DAYS = 400;
export const RESTORE_FLAG = "restore_reapply_due";

export interface LedgerEntry {
  id: string;
  kind: "customer";
  subjectId: number;
  subjectCreatedAt: string;
  erasedAt: string;
}

/** The ledger's copy beside the backup sets; none for an in-memory database with no backup folder of its own. */
export function ledgerFile(): string | null {
  if (isEphemeral() && !process.env.MYSENAM_BACKUP_DIR) return null;
  return path.join(backupDir(), "erasure-ledger.jsonl");
}

/** Read the file's entries; a line that is not one is skipped (a torn last write). */
export function readLedgerFile(file = ledgerFile()): LedgerEntry[] {
  if (!file || !fs.existsSync(file)) return [];
  const out: LedgerEntry[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LedgerEntry;
      if (typeof e.id === "string" && e.kind === "customer" && Number.isInteger(e.subjectId) && typeof e.subjectCreatedAt === "string" && typeof e.erasedAt === "string")
        out.push(e);
    } catch {
      // not an entry
    }
  }
  return out;
}

/**
 * Record an erasure in the database, inside the erasure's own transaction
 * (lib/privacy.ts eraseCustomer). The file copy is written once it committed
 * (`appendToLedgerFile`).
 */
export async function recordErasure(subjectId: number, subjectCreatedAt: string): Promise<LedgerEntry> {
  const entry: LedgerEntry = { id: crypto.randomUUID(), kind: "customer", subjectId, subjectCreatedAt, erasedAt: new Date().toISOString() };
  await getDb()
    .prepare("INSERT INTO erasure_ledger (id, kind, subject_id, subject_created_at, erased_at) VALUES (?, ?, ?, ?, ?)")
    .run(entry.id, entry.kind, entry.subjectId, entry.subjectCreatedAt, entry.erasedAt);
  return entry;
}

/** Append an entry to the file beside the backups. A failure is told to the owners; the erasure stands. */
export async function appendToLedgerFile(entry: LedgerEntry): Promise<void> {
  const file = ledgerFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (err) {
    console.error("[mysenam] could not write the erasure ledger beside the backups:", err instanceof Error ? err.message : err);
    await raiseAlert(
      "erasure-ledger",
      "The erasure ledger could not be written beside the backups",
      `An account was erased, but its entry (${entry.id}) could not be written to ${file}. A restore from an earlier backup would not erase it again until this is fixed.`
    );
  }
}

export interface ReapplyResult {
  /** Entries looked at, from the database and the file together. */
  entries: number;
  /** Accounts that came back with the restore and were erased again. */
  erasedAgain: number;
  /** Erasures that could not be applied again (credit or a pass in the restored copy, or a hold): the owners are told. */
  refused: { id: string; error: string }[];
  /** What the retention run removed. */
  retention: number;
}

/**
 * Apply every recorded erasure again, then the retention policy. Safe to run
 * any number of times: an account already gone is left alone, and so is an
 * account created at another moment than the one erased.
 */
export async function reapplyErasures(): Promise<ReapplyResult> {
  const db = getDb();
  const fromFile = readLedgerFile();
  // What the file knows and the restored database does not: put back, so the ledger is whole again.
  for (const e of fromFile)
    await db
      .prepare("INSERT INTO erasure_ledger (id, kind, subject_id, subject_created_at, erased_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING")
      .run(e.id, e.kind, e.subjectId, e.subjectCreatedAt, e.erasedAt);
  const entries = (await db.prepare("SELECT id, subject_id, subject_created_at FROM erasure_ledger ORDER BY erased_at, id").all()) as {
    id: string;
    subject_id: number;
    subject_created_at: string;
  }[];
  const { eraseCustomer, pruneOldData } = await import("./privacy");
  const result: ReapplyResult = { entries: entries.length, erasedAgain: 0, refused: [], retention: 0 };
  for (const e of entries) {
    const back = await db.prepare("SELECT 1 FROM users WHERE id = ? AND created_at = ?").get(e.subject_id, e.subject_created_at);
    if (!back) continue;
    const erased = await eraseCustomer(e.subject_id, { reapplying: true });
    const outcome = erased.ok ? "erased again" : `refused: ${erased.error}`;
    await db.prepare("UPDATE erasure_ledger SET reapplied_at = now(), reapply_outcome = ? WHERE id = ?").run(outcome.slice(0, 300), e.id);
    if (erased.ok) result.erasedAgain++;
    else result.refused.push({ id: e.id, error: erased.error });
  }
  result.retention = (await pruneOldData()).total;
  if (result.refused.length > 0)
    await raiseAlert(
      "erasure-reapply",
      "After a restore, some erasures could not be applied again",
      `${result.refused.length} account(s) erased before came back with the restore and could not be erased again:\n` +
        result.refused.map((r) => `ledger entry ${r.id}: ${r.error}`).join("\n") +
        "\nSettle what the restored copy says they hold, then erase them from the dashboard."
    );
  return result;
}

/**
 * At start-up: after a restore (the restore script's mark, or ledger entries
 * the database does not have), apply the erasures and the retention policy
 * again before anything is served. Returns what it did, or null when there
 * was nothing to do. Never throws: a failure is told to the owners.
 */
export async function reapplyIfRestored(): Promise<ReapplyResult | null> {
  try {
    const db = getDb();
    const flagged = (await db.prepare(`DELETE FROM settings WHERE key = '${RESTORE_FLAG}' RETURNING value`).get()) as { value: string } | undefined;
    let missing = 0;
    const fromFile = readLedgerFile();
    if (fromFile.length > 0) {
      const known = new Set(((await db.prepare("SELECT id FROM erasure_ledger").all()) as { id: string }[]).map((r) => r.id));
      missing = fromFile.filter((e) => !known.has(e.id)).length;
    }
    if (!flagged && missing === 0) return null;
    const result = await reapplyErasures();
    console.log(
      `[mysenam] after a restore: ${result.erasedAgain} erased account(s) erased again, ${result.refused.length} refused, ${result.retention} record(s) removed by the retention policy.`
    );
    return result;
  } catch (err) {
    console.error("[mysenam] re-applying erasures and retention after a restore failed:", err);
    await raiseAlert("erasure-reapply", "After a restore, erasures and retention could not be applied again", err instanceof Error ? (err.stack ?? err.message) : String(err));
    return null;
  }
}

/** Entries past their time: from the database (in the retention run) and the file (rewritten without them). */
export async function pruneErasureLedger(): Promise<void> {
  await getDb().prepare(`DELETE FROM erasure_ledger WHERE erased_at < now() - make_interval(days => ${ERASURE_LEDGER_DAYS})`).run();
}

/** The file, without entries past their time. Written to a temporary name, then renamed over the old one. */
export function pruneLedgerFile(now = Date.now()): void {
  const file = ledgerFile();
  if (!file || !fs.existsSync(file)) return;
  const cutoff = now - ERASURE_LEDGER_DAYS * 86_400_000;
  const all = readLedgerFile(file);
  const kept = all.filter((e) => Date.parse(e.erasedAt) >= cutoff);
  if (kept.length === all.length) return;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, kept.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** How many entries the next retention run would remove from the database. */
export async function ledgerDue(): Promise<number> {
  const row = (await getDb()
    .prepare(`SELECT COUNT(*)::int AS n FROM erasure_ledger WHERE erased_at < now() - make_interval(days => ${ERASURE_LEDGER_DAYS})`)
    .get()) as { n: number };
  return row.n;
}
