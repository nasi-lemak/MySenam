import crypto from "crypto";
import fs from "fs";
import path from "path";
import { backupDir } from "./backup.ts";
import { getDb, isEphemeral } from "./db.ts";
import { GENESIS, isChainEntry, nextEntry, type ChainEntry, type LedgerKind } from "./erasure-chain.ts";

// Loaded when needed: the restore script loads this file under plain Node, which resolves only imports that name their file.
const raiseAlert: typeof import("./alerts").raiseAlert = async (...args) => (await import("./alerts")).raiseAlert(...args);

/**
 * A restore must not bring back what retention or erasure already removed
 * (docs/operations/backups.md#after-a-restore; ADR 0024).
 *
 * A backup holds whatever was in the database when it was taken: an account
 * closed the next day, a document deleted the next week. Three things put
 * that right after a restore:
 *
 * - **The erasure ledger.** Every erasure is recorded (`erasure_ledger`) as a
 *   numbered, hash-chained entry (lib/erasure-chain.ts): an account's number
 *   and the moment it was created, the same for a participant erased with an
 *   account, and any change of the install's retention periods; no name,
 *   email or phone. Outside the database it is appended to
 *   `erasure-ledger.jsonl` beside the backup sets, which a restore does not
 *   overwrite, and copied off-site in signed segments within a minute and
 *   with every backup set (lib/erasure-ledger-offsite.ts), so it survives
 *   losing the server. After a restore every entry is applied again to the
 *   account or participant it names, if that one is back, and only if it was
 *   created at that moment, so a later one that happens to get the same
 *   number is never touched; and the newest retention periods are put back.
 * - **The retention run**, applied again straight away, so whatever had aged
 *   out since the backup goes again.
 * - **The start-up gate.** The restore script reads the ledger from every
 *   source it has, checks the chain from the restored copy's own newest
 *   entry, brings in what it can verify and records whether the ledger is
 *   shown complete (`erasure_ledger_recoveries`). The app, at its next start
 *   and before it serves anything (src/instrumentation-node.ts), applies the
 *   erasures and the retention policy again, and does not serve at all while
 *   that has not succeeded or a recovery that could not show the ledger
 *   complete has not been acknowledged (`restoreGate`).
 *
 * A restore done another way is caught too: entries in the file the
 * restored database does not have mean a restore happened.
 *
 * What this cannot do: an erasure made in the minute or so before the server
 * was lost, before its entry left the server, is in no surviving copy; the
 * restore cannot see it unless another record names a later number (a
 * newer backup's manifest, the owners' alert, the operator), and says so.
 * Copies inside backups themselves stay until those backups expire. Both are
 * stated in the privacy notice and the backups document.
 */

/** Ledger entries are kept this long: longer than any backup set is kept, locally or off-site. */
export const ERASURE_LEDGER_DAYS = 400;
export const RESTORE_FLAG = "restore_reapply_due";

/** An entry as the file and the database hold it. Lines written before migration 0161 have no number or hashes. */
export type LedgerEntry = ChainEntry | LegacyEntry;
export interface LegacyEntry {
  id: string;
  kind: "customer";
  subjectId: number;
  subjectCreatedAt: string;
  erasedAt: string;
  seq?: undefined;
}

/** The ledger's copy beside the backup sets; none for an in-memory database with no backup folder of its own. */
export function ledgerFile(): string | null {
  if (isEphemeral() && !process.env.MYSENAM_BACKUP_DIR) return null;
  return path.join(backupDir(), "erasure-ledger.jsonl");
}

/**
 * Read the file's entries; a line that is not one is skipped (a torn last
 * write). An entry written twice (a chained copy of a line from before
 * migration 0161) is read once, the chained one.
 */
export function readLedgerFile(file = ledgerFile()): LedgerEntry[] {
  if (!file || !fs.existsSync(file)) return [];
  const byId = new Map<string, LedgerEntry>();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LedgerEntry;
      const legacy =
        e.seq === undefined &&
        typeof e.id === "string" &&
        e.kind === "customer" &&
        Number.isInteger(e.subjectId) &&
        typeof e.subjectCreatedAt === "string" &&
        typeof e.erasedAt === "string";
      if (isChainEntry(e) || (legacy && !byId.has(e.id))) byId.set(e.id, e);
    } catch {
      // not an entry
    }
  }
  return [...byId.values()];
}

/** The file is there, empty if nothing was erased yet: a restore on this server then knows the ledger beside it is whole. */
export function ensureLedgerFile(): void {
  const file = ledgerFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, "", { mode: 0o600 });
  } catch (err) {
    console.error("[mysenam] could not create the erasure ledger beside the backups:", err instanceof Error ? err.message : err);
  }
}

interface Row {
  id: string;
  kind: LedgerKind;
  subject_id: number | null;
  subject_created_at: string | null;
  erased_at: Date | string;
  detail: string | null;
  seq: number;
  prev_hash: string;
  hash: string;
}

const COLUMNS = "id, kind, subject_id, subject_created_at, erased_at, detail, seq, prev_hash, hash";

export function fromRow(r: Row): ChainEntry {
  return {
    seq: Number(r.seq),
    id: r.id,
    kind: r.kind,
    subjectId: r.subject_id === null ? null : Number(r.subject_id),
    subjectCreatedAt: r.subject_created_at,
    erasedAt: new Date(r.erased_at).toISOString(),
    detail: r.detail,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

/** Entries in the database, in order; from a number on, where given. */
export async function ledgerEntries(afterSeq = 0): Promise<ChainEntry[]> {
  const rows = (await getDb().prepare(`SELECT ${COLUMNS} FROM erasure_ledger WHERE seq > ? ORDER BY seq`).all(afterSeq)) as Row[];
  return rows.map(fromRow);
}

/** The newest entry's number and hash, and how far the off-site copy reaches. */
export async function ledgerHead(): Promise<{ seq: number; hash: string; shippedSeq: number; shippedAt: string | null }> {
  const r = (await getDb().prepare("SELECT seq, hash, shipped_seq, shipped_at FROM erasure_ledger_head WHERE id = 1").get()) as
    | { seq: number; hash: string; shipped_seq: number; shipped_at: Date | string | null }
    | undefined;
  if (!r) return { seq: 0, hash: GENESIS, shippedSeq: 0, shippedAt: null };
  return { seq: Number(r.seq), hash: r.hash, shippedSeq: Number(r.shipped_seq), shippedAt: r.shipped_at ? new Date(r.shipped_at).toISOString() : null };
}

/**
 * Record an entry, inside the caller's transaction: the head is locked, the
 * next number taken and the entry chained to the one before. An account or
 * participant already in the ledger at that creation moment is not recorded
 * twice (applied again after a restore, it is the same erasure). The file
 * copy and the off-site copy follow once it committed (`appendToLedgerFile`).
 */
export async function recordLedgerEntry(
  kind: LedgerKind,
  what: { subjectId?: number | null; subjectCreatedAt?: string | null; detail?: string | null },
  /** Only for a recovery entry: the number after those it records as lost. */
  atSeq?: number
): Promise<ChainEntry | null> {
  const db = getDb();
  const subjectId = what.subjectId ?? null;
  const subjectCreatedAt = what.subjectCreatedAt ?? null;
  const head = (await db.prepare("SELECT seq, hash FROM erasure_ledger_head WHERE id = 1 FOR UPDATE").get()) as { seq: number; hash: string };
  if (subjectId !== null) {
    const already = await db
      .prepare("SELECT 1 FROM erasure_ledger WHERE kind = ? AND subject_id = ? AND subject_created_at = ?")
      .get(kind, subjectId, subjectCreatedAt);
    if (already) return null;
  }
  const entry = nextEntry(
    { seq: Number(head.seq), hash: head.hash },
    { id: crypto.randomUUID(), kind, subjectId, subjectCreatedAt, erasedAt: new Date().toISOString(), detail: what.detail ?? null },
    kind === "recovery" && atSeq !== undefined && atSeq > Number(head.seq) ? atSeq : Number(head.seq) + 1
  );
  await db
    .prepare(`INSERT INTO erasure_ledger (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(entry.id, entry.kind, entry.subjectId, entry.subjectCreatedAt, entry.erasedAt, entry.detail, entry.seq, entry.prevHash, entry.hash);
  await db.prepare("UPDATE erasure_ledger_head SET seq = ?, hash = ? WHERE id = 1").run(entry.seq, entry.hash);
  return entry;
}

/** An account erased (lib/privacy.ts eraseCustomer), by its number and the moment it was created. */
export async function recordErasure(subjectId: number, subjectCreatedAt: string): Promise<ChainEntry | null> {
  return recordLedgerEntry("customer", { subjectId, subjectCreatedAt });
}

/** How a participant's creation moment is written in the ledger: microseconds since 1970, exact. */
const PARTICIPANT_CREATED = "(extract(epoch from created_at) * 1000000)::bigint::text";

/** A participant erased with an account (lib/participants.ts), before its row goes. */
export async function recordParticipantErasure(participantId: number): Promise<ChainEntry | null> {
  const row = (await getDb().prepare(`SELECT ${PARTICIPANT_CREATED} AS created FROM participants WHERE id = ?`).get(participantId)) as
    | { created: string }
    | undefined;
  if (!row) return null;
  return recordLedgerEntry("participant", { subjectId: participantId, subjectCreatedAt: String(row.created) });
}

/**
 * Bring entries read from elsewhere (the file, an off-site segment) into the
 * database, each under its own number, and move the head to the newest. An
 * entry whose number is taken by a different entry is not brought in, and
 * counted: the caller says so.
 */
export async function bringIn(entries: ChainEntry[], shippedThrough = 0): Promise<{ added: number; clashed: number[] }> {
  const db = getDb();
  let added = 0;
  const clashed: number[] = [];
  await db.transaction(async () => {
    added = 0;
    clashed.length = 0;
    await db.prepare("SELECT seq FROM erasure_ledger_head WHERE id = 1 FOR UPDATE").get();
    for (const e of entries) {
      const there = (await db.prepare("SELECT id, hash FROM erasure_ledger WHERE seq = ? OR id = ?").get(e.seq, e.id)) as { id: string; hash: string } | undefined;
      if (there) {
        if (there.hash !== e.hash) clashed.push(e.seq);
        continue;
      }
      await db
        .prepare(`INSERT INTO erasure_ledger (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(e.id, e.kind, e.subjectId, e.subjectCreatedAt, e.erasedAt, e.detail, e.seq, e.prevHash, e.hash);
      added++;
    }
    const newest = (await db.prepare("SELECT seq, hash FROM erasure_ledger ORDER BY seq DESC LIMIT 1").get()) as { seq: number; hash: string } | undefined;
    if (newest)
      await db
        .prepare("UPDATE erasure_ledger_head SET seq = ?, hash = ?, shipped_seq = GREATEST(shipped_seq, ?) WHERE id = 1 AND seq <= ?")
        .run(newest.seq, newest.hash, shippedThrough, newest.seq);
  })();
  return { added, clashed };
}

/**
 * Once an erasure committed: append to the file beside the backups every
 * entry it does not have yet (this one, a participant erased with it, any an
 * earlier failure left out), and start the off-site copy. A failure is told
 * to the owners; the erasure stands.
 */
export async function appendToLedgerFile(entry: Pick<ChainEntry, "id">): Promise<void> {
  const file = ledgerFile();
  if (file) {
    try {
      const have = readLedgerFile(file);
      const newest = have.reduce((n, e) => Math.max(n, e.seq ?? 0), 0);
      const known = new Set(have.map((e) => e.id));
      const missing = (await ledgerEntries(newest)).filter((e) => !known.has(e.id));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (missing.length > 0) fs.appendFileSync(file, missing.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
    } catch (err) {
      console.error("[mysenam] could not write the erasure ledger beside the backups:", err instanceof Error ? err.message : err);
      await raiseAlert(
        "erasure-ledger",
        "The erasure ledger could not be written beside the backups",
        `An account was erased, but its entry (${entry.id}) could not be written to ${file}. A restore from an earlier backup would not erase it again until this is fixed.`
      );
    }
  }
  // Off-site at once where that is set up; the scheduler tries again each minute if this fails.
  const offsite = await import("./erasure-ledger-offsite");
  if (offsite.ledgerOffsiteConfig()) void offsite.shipLedger().catch(() => undefined);
}

export interface ReapplyResult {
  /** Entries looked at, from the database and the file together. */
  entries: number;
  /** Accounts and participants that came back with the restore and were erased again. */
  erasedAgain: number;
  /** Erasures that could not be applied again (credit or a pass in the restored copy, or a hold): the owners are told. */
  refused: { id: string; error: string }[];
  /** The retention periods put back from the ledger, where the restored copy had older ones. */
  policyRestored: boolean;
  /** What the retention run removed. */
  retention: number;
}

/**
 * Apply every recorded erasure again, then the newest retention periods,
 * then the retention policy. Safe to run any number of times: an account or
 * participant already gone is left alone, and so is one created at another
 * moment than the one erased.
 */
export async function reapplyErasures(): Promise<ReapplyResult> {
  const db = getDb();
  // What the file knows and the restored database does not: brought in, so the ledger is whole again.
  const fromFile = readLedgerFile();
  const chained = fromFile.filter(isChainEntry);
  if (chained.length > 0) await bringIn(chained);
  const known = new Set(((await db.prepare("SELECT id FROM erasure_ledger").all()) as { id: string }[]).map((r) => r.id));
  for (const e of fromFile)
    if (!isChainEntry(e) && !known.has(e.id)) {
      // A line from before migration 0161 the database lacks: recorded again under a number of its own.
      await db.transaction(async () => {
        await recordLedgerEntry("customer", { subjectId: e.subjectId, subjectCreatedAt: e.subjectCreatedAt });
      })();
    }
  const entries = await ledgerEntries();
  const { eraseCustomer, pruneOldData } = await import("./privacy");
  const result: ReapplyResult = { entries: entries.length, erasedAgain: 0, refused: [], policyRestored: false, retention: 0 };
  const outcome = async (id: string, text: string) =>
    db.prepare("UPDATE erasure_ledger SET reapplied_at = now(), reapply_outcome = ? WHERE id = ?").run(text.slice(0, 300), id);
  for (const e of entries) {
    if (e.kind === "customer") {
      const back = await db.prepare("SELECT 1 FROM users WHERE id = ? AND created_at = ?").get(e.subjectId, e.subjectCreatedAt);
      if (!back) continue;
      const erased = await eraseCustomer(e.subjectId!, { reapplying: true });
      await outcome(e.id, erased.ok ? "erased again" : `refused: ${erased.error}`);
      if (erased.ok) result.erasedAgain++;
      else result.refused.push({ id: e.id, error: erased.error });
    } else if (e.kind === "participant") {
      const back = await db.prepare(`SELECT 1 FROM participants WHERE id = ? AND ${PARTICIPANT_CREATED} = ?`).get(e.subjectId, e.subjectCreatedAt);
      if (!back) continue;
      try {
        const { eraseParticipant } = await import("./participants");
        await db.transaction(async () => {
          await eraseParticipant(e.subjectId!, "Erased again after a restore");
        })();
        await outcome(e.id, "erased again");
        result.erasedAgain++;
      } catch (err) {
        const error = err instanceof Error ? err.message.split("\n")[0] : String(err);
        await outcome(e.id, `refused: ${error}`);
        result.refused.push({ id: e.id, error });
      }
    }
  }
  // The newest retention periods the ledger knows, where the restored copy has others (lib/retention-policy.ts).
  const policy = [...entries].reverse().find((e) => e.kind === "retention_policy");
  if (policy?.detail) result.policyRestored = await (await import("./retention-policy")).applyPolicyFromLedger(policy.detail);
  result.retention = (await pruneOldData()).total;
  if (result.refused.length > 0)
    await raiseAlert(
      "erasure-reapply",
      "After a restore, some erasures could not be applied again",
      `${result.refused.length} erasure(s) recorded before could not be applied again to what came back with the restore:\n` +
        result.refused.map((r) => `ledger entry ${r.id}: ${r.error}`).join("\n") +
        "\nSettle what the restored copy says they hold, then erase them from the dashboard."
    );
  return result;
}

/**
 * At start-up: after a restore (the restore script's mark, or ledger entries
 * the database does not have), apply the erasures, the newest retention
 * periods and the retention policy again before anything is served. The mark
 * is taken away only once that succeeded: until then `restoreGate` keeps the
 * app from serving. Returns what it did, or null when there was nothing to
 * do. Never throws: a failure is told to the owners.
 */
export async function reapplyIfRestored(): Promise<ReapplyResult | null> {
  try {
    const db = getDb();
    const flagged = (await db.prepare(`SELECT value FROM settings WHERE key = '${RESTORE_FLAG}'`).get()) as { value: string } | undefined;
    let missing = 0;
    const fromFile = readLedgerFile();
    if (fromFile.length > 0) {
      const known = new Set(((await db.prepare("SELECT id FROM erasure_ledger").all()) as { id: string }[]).map((r) => r.id));
      missing = fromFile.filter((e) => !known.has(e.id)).length;
    }
    if (!flagged && missing === 0) return null;
    const result = await reapplyErasures();
    await db.prepare(`DELETE FROM settings WHERE key = '${RESTORE_FLAG}'`).run();
    console.log(
      `[mysenam] after a restore: ${result.erasedAgain} erased account(s) or participant(s) erased again, ${result.refused.length} refused, ${
        result.policyRestored ? "the newest retention periods put back, " : ""
      }${result.retention} record(s) removed by the retention policy.`
    );
    return result;
  } catch (err) {
    console.error("[mysenam] re-applying erasures and retention after a restore failed:", err);
    await raiseAlert("erasure-reapply", "After a restore, erasures and retention could not be applied again", err instanceof Error ? (err.stack ?? err.message) : String(err));
    return null;
  }
}

/**
 * Whether the app may serve: null when it may; otherwise why not and what to
 * do. It may not while a restore's erasures and retention have not been
 * applied again (the mark is still there), or while a restore that could not
 * show the ledger complete is not acknowledged (scripts/restore.mjs
 * --acknowledge-ledger).
 */
export async function restoreGate(): Promise<string | null> {
  const db = getDb();
  const open = (await db
    .prepare("SELECT backup, detail FROM erasure_ledger_recoveries WHERE state = 'blocked' AND acknowledged_at IS NULL ORDER BY id DESC LIMIT 1")
    .get()) as { backup: string; detail: string } | undefined;
  if (open)
    return (
      `The restore of ${open.backup} could not show the erasure ledger complete, so the app will not serve customer data yet.\n` +
      `${open.detail}\n` +
      "Find the erasures it cannot account for (the owners' erasure-ledger alerts, account-closure requests since the backup), then, with the app stopped:\n" +
      '  npm run restore -- --acknowledge-ledger "<who checked, and what was found>"\n' +
      "and start the app; erase from the dashboard anybody found who came back (docs/operations/backups.md#after-a-restore)."
    );
  if (await db.prepare(`SELECT 1 FROM settings WHERE key = '${RESTORE_FLAG}'`).get())
    return (
      "This database was restored, and the erasures and retention recorded since its backup have not been applied again yet " +
      "(see the error above). The app will not serve until they are: fix the cause and start it again (docs/operations/backups.md#after-a-restore)."
    );
  return null;
}

export interface Acknowledged {
  recoveries: number;
  /** Numbers recorded as lost, where the ledger was known to have reached further than could be verified. */
  lost: [number, number] | null;
}

/**
 * The operator acknowledges a restore that could not show the ledger
 * complete: why, and who. Where another record said the ledger had reached
 * further than could be verified, the numbers in between are recorded as
 * lost by a `recovery` entry, so the next entries do not take them again
 * and a later restore sees the gap explained rather than unexplained.
 */
export async function acknowledgeRecovery(reason: string, by: string): Promise<Acknowledged | { error: string }> {
  const why = reason.trim();
  if (why.length < 10) return { error: "Say who checked and what was found, in a sentence (at least 10 characters)." };
  const db = getDb();
  const open = (await db.prepare("SELECT id, verified_seq, known_seq FROM erasure_ledger_recoveries WHERE state = 'blocked' AND acknowledged_at IS NULL").all()) as {
    id: number;
    verified_seq: number;
    known_seq: number | null;
  }[];
  if (open.length === 0) return { error: "No restore is waiting to be acknowledged." };
  let lost: [number, number] | null = null;
  await db.transaction(async () => {
    lost = null;
    const head = await ledgerHead();
    const known = Math.max(...open.map((r) => Number(r.known_seq ?? 0)));
    if (known > head.seq) {
      lost = [head.seq + 1, known];
      // The recovery entry takes the number after the lost ones, and follows the last entry kept.
      await recordLedgerEntry("recovery", { detail: JSON.stringify({ lostFrom: head.seq + 1, lostTo: known, acknowledged: why.slice(0, 300) }) }, known + 1);
    }
    await db
      .prepare("UPDATE erasure_ledger_recoveries SET acknowledged_at = now(), acknowledged_by = ?, acknowledgement = ? WHERE state = 'blocked' AND acknowledged_at IS NULL")
      .run(by.slice(0, 200), why.slice(0, 2000));
  })();
  return { recoveries: open.length, lost };
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
