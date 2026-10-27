import crypto from "crypto";
import { logAction } from "./activity";
import { isOwner, type Admin } from "./admin-auth";
import { raiseAlert } from "./alerts";
import { getDb } from "./db";
import { documentScanner, scanMode, type ScanErrorKind, type ScanMode } from "./document-scanner";

/**
 * Supporting documents, scanned before anybody can open them
 * (docs/architecture/security.md#malware-scanning; ADR 0024, amended
 * 27 October 2026).
 *
 * received → size and count limits → its format checked from its bytes
 * (lib/approval-documents.ts, every ADR 0021 check) → stored in quarantine,
 * in the database, `pending` → scanned by the server's own call to the
 * scanner → the result recorded → released (`clean`) only when the scan
 * passed; `rejected` (the scanner found something: its bytes wiped at once,
 * the fact kept) or `failed` (no answer after a bounded number of tries:
 * never released).
 *
 * - **Fail closed, no opt-out.** Supporting documents are safety and guardian
 *   application documents: none is released without a scan. With no scanner
 *   configured, documents are still taken into quarantine, so nothing sent
 *   is lost, and wait there.
 * - **Two kinds of failure.** `scanner_unavailable`: the last try found no
 *   scanner (none configured, or it did not answer). The document is kept,
 *   never released, and put back in quarantine by itself once a scanner
 *   answers (`requeueWaitingDocuments`); it is never removed because no
 *   scanner was there, only by its own retention. `unscannable`: a working
 *   scanner could not scan it (too large for its limits, no answer for this
 *   document, or an answer it could not read), or its bytes no longer match
 *   their hash. Terminal: the quarantine period removes it
 *   (lib/approval-retention.ts), unless the platform owner has it scanned
 *   again first.
 * - **Safe retries.** The platform owner may have a failed document scanned
 *   again (`retryDocumentScan`), at most `MAX_MANUAL_RETRIES` times, with a
 *   reason: only if its bytes are still there and match the hash recorded
 *   when they were checked; otherwise a new upload is needed. A retry puts
 *   the same bytes back in quarantine: it never changes them and never
 *   releases the document (the database allows that one way back, and only
 *   with the bytes intact: migration 0159). Every request, refused or not,
 *   and its outcome, is recorded (`approval_document_scan_retries`).
 * - **Only the server sets a result.** No route takes a status; the only
 *   write that releases a document is `settle` below, after the configured
 *   scanner answered for exactly the stored bytes (their SHA-256 is checked
 *   and recorded), and the database refuses a clean status without that
 *   record (migration 0142).
 * - **Idempotent.** A scan claims the document for a short while first; a
 *   second scan of the same document at the same time, a repeated or late
 *   result, or a scan after it settled changes nothing. A retry of a document
 *   already back in quarantine does nothing more.
 * - **Bounded.** An unavailable, timed-out or inconclusive scan is tried
 *   again on a schedule (`RETRY_MINUTES`), at most `MAX_SCAN_ATTEMPTS` times
 *   in a round (about a day), then the document fails.
 *
 * Logs name a document by its number and the signature found, never its
 * contents or the applicant.
 */

export type ScanStatus = "pending" | "clean" | "rejected" | "failed";
export type ScanFailure = "scanner_unavailable" | "unscannable";

/** What may be opened, and counts towards a document an approval needs. */
export const RELEASED: ScanStatus[] = ["clean"];

/** Minutes to wait after each failed try before the next; after the last, the document has failed. */
export const RETRY_MINUTES = [1, 5, 30, 120, 360, 720];
export const MAX_SCAN_ATTEMPTS = RETRY_MINUTES.length + 1;
/** How many times the platform owner may have one document scanned again. */
export const MAX_MANUAL_RETRIES = 3;
/** A claimed scan is somebody else's for this long (longer than a scan may take). */
const CLAIM_SECONDS = 120;
/** Signatures older than this are reported to the owners: freshclam has stopped. */
export const SIGNATURES_MAX_AGE_HOURS = 48;
/** A document still pending after this is reported: the scanner is behind or down. */
export const BACKLOG_MINUTES = 60;

const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

async function addSystemEvent(requestId: number, action: string, reason: string | null): Promise<void> {
  await getDb()
    .prepare("INSERT INTO approval_events (request_id, actor, actor_name, action, reason) VALUES (?, 'system', 'MySenam', ?, ?)")
    .run(requestId, action, reason);
}

/** The outcome of a retry still open on a document, written once its scan settles. */
async function closeRetry(documentId: number, outcome: "clean" | "rejected" | "failed_scanner_unavailable" | "failed_unscannable"): Promise<void> {
  await getDb()
    .prepare("UPDATE approval_document_scan_retries SET outcome = ?, settled_at = now() WHERE document_id = ? AND outcome = 'queued'")
    .run(outcome, documentId);
}

/**
 * Scan one document, if it is pending and nobody else is scanning it; record
 * the result. Returns its status afterwards. Never throws for the scanner's
 * sake: a scanner that is away is a failed try, retried later.
 */
export async function scanDocument(id: number): Promise<ScanStatus | null> {
  const db = getDb();
  const claimed = (await db
    .prepare(
      `UPDATE approval_documents SET scan_claimed_until = now() + make_interval(secs => ${CLAIM_SECONDS})
        WHERE id = ? AND scan_status = 'pending' AND (scan_claimed_until IS NULL OR scan_claimed_until < now())
        RETURNING id, request_id, content, sha256, scan_attempts`
    )
    .get(id)) as { id: number; request_id: number; content: Uint8Array; sha256: string | null; scan_attempts: number } | undefined;
  if (!claimed) return currentStatus(id);
  const content = Buffer.from(claimed.content);
  const hash = sha256(content);
  // The bytes must be the ones stored when the document was checked: if not, no scan can vouch for them.
  if (claimed.sha256 !== null && claimed.sha256 !== hash) return failTry(claimed, "inconclusive", "integrity: content does not match its hash", "unscannable");
  const scanner = documentScanner();
  if (!scanner) return failTry(claimed, "unavailable", "no scanner configured");
  let verdict;
  try {
    verdict = await scanner.scan(content);
  } catch {
    verdict = { kind: "error" as const, error: "unavailable" as const, detail: "scanner threw" };
  }
  if (verdict.kind === "clean") return settle(claimed, hash, { status: "clean", engine: verdict.engine });
  if (verdict.kind === "found") return settle(claimed, hash, { status: "rejected", engine: verdict.engine, finding: verdict.finding });
  // Too large for the scanner's limits will not get better by waiting.
  if (verdict.error === "too_large") return failTry(claimed, verdict.error, verdict.detail, "unscannable");
  // No answer, or one it could not read: the scanner's fault if it no longer answers at all, else this document's.
  let error: ScanErrorKind = verdict.error;
  if (error !== "unavailable") {
    const state = await scanner.status().catch(() => ({ reachable: false }));
    if (!state.reachable) error = "unavailable";
  }
  return failTry(claimed, error, verdict.detail);
}

async function currentStatus(id: number): Promise<ScanStatus | null> {
  const row = (await getDb().prepare("SELECT scan_status FROM approval_documents WHERE id = ?").get(id)) as { scan_status: ScanStatus } | undefined;
  return row?.scan_status ?? null;
}

type Claimed = { id: number; request_id: number; scan_attempts: number };

/** Record a settled result, only while the document is still pending (a late or repeated result changes nothing). */
async function settle(
  doc: Claimed,
  hash: string,
  result: { status: "clean"; engine: string } | { status: "rejected"; engine: string; finding: string }
): Promise<ScanStatus | null> {
  const db = getDb();
  const done = await db.transaction(async () => {
    const changed =
      result.status === "rejected"
        ? await db
            .prepare(
              `UPDATE approval_documents SET scan_status = 'rejected', content = ?, scanned_at = now(), scan_engine = ?, scan_finding = ?,
                 scan_sha256 = ?, scan_attempts = scan_attempts + 1, scan_next_at = NULL, scan_claimed_until = NULL, scan_error = NULL
                WHERE id = ? AND scan_status = 'pending'`
            )
            .run(Buffer.alloc(0), result.engine.slice(0, 200), result.finding, hash, doc.id)
        : await db
            .prepare(
              `UPDATE approval_documents SET scan_status = 'clean', scanned_at = now(), scan_engine = ?, scan_sha256 = ?,
                 scan_attempts = scan_attempts + 1, scan_next_at = NULL, scan_claimed_until = NULL, scan_error = NULL
                WHERE id = ? AND scan_status = 'pending'`
            )
            .run(result.engine.slice(0, 200), hash, doc.id);
    if (changed.changes === 0) return false;
    if (result.status === "rejected") await addSystemEvent(doc.request_id, "scan_rejected", null);
    await closeRetry(doc.id, result.status);
    return true;
  })();
  if (done && result.status === "rejected")
    // The document's number and the signature's name: never its contents or whose it is.
    console.warn(`[mysenam] supporting document ${doc.id} was refused by the malware scan (${result.finding}); its content was removed.`);
  return currentStatus(doc.id);
}

/**
 * A try that gave no answer: tried again later, or, once the tries are used
 * up (or at once, for a failure `final` names), failed: waiting for a scanner
 * when the last try found none, unscannable otherwise.
 */
async function failTry(doc: Claimed, error: ScanErrorKind, detail: string, final?: ScanFailure): Promise<ScanStatus | null> {
  const db = getDb();
  const attempts = doc.scan_attempts + 1;
  const failure: ScanFailure | null = final ?? (attempts >= MAX_SCAN_ATTEMPTS ? (error === "unavailable" ? "scanner_unavailable" : "unscannable") : null);
  const wait = RETRY_MINUTES[Math.min(attempts, RETRY_MINUTES.length) - 1];
  const done = await db.transaction(async () => {
    const changed = await db
      .prepare(
        failure
          ? `UPDATE approval_documents SET scan_status = 'failed', scan_failure = '${failure}', scanned_at = now(), scan_attempts = ?, scan_error = ?, scan_next_at = NULL, scan_claimed_until = NULL
              WHERE id = ? AND scan_status = 'pending'`
          : `UPDATE approval_documents SET scan_attempts = ?, scan_error = ?, scan_next_at = now() + make_interval(mins => ${wait}), scan_claimed_until = NULL
              WHERE id = ? AND scan_status = 'pending'`
      )
      .run(attempts, `${error}: ${detail}`.slice(0, 200), doc.id);
    if (changed.changes === 0) return false;
    if (failure === "unscannable") await addSystemEvent(doc.request_id, "scan_failed", null);
    if (failure) await closeRetry(doc.id, failure === "unscannable" ? "failed_unscannable" : "failed_scanner_unavailable");
    return true;
  })();
  if (done)
    console.error(
      `[mysenam] scanning supporting document ${doc.id} ${
        failure === "unscannable" ? "failed for good" : failure ? "failed: it waits for a scanner" : "failed, to be tried again"
      } (try ${attempts}): ${error}`
    );
  return currentStatus(doc.id);
}

/**
 * Scan these documents now, one after another (just after they were stored),
 * waiting at most `waitMs` for them: a slow scanner keeps the customer
 * waiting no longer than that. A scan still running then finishes and
 * records its result by itself; one that never answers is retried by the
 * scheduler.
 */
export async function scanDocuments(ids: number[], waitMs = 20_000): Promise<void> {
  if (ids.length === 0) return;
  const all = (async () => {
    for (const id of ids) await scanDocument(id);
  })().catch((err) => console.error("[mysenam] scanning supporting documents failed:", err instanceof Error ? err.message : err));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([all, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
  clearTimeout(timer);
}

/** The scheduler's part: documents whose next try is due, oldest first, a few at a time. */
export async function scanDueDocuments(limit = 20): Promise<{ scanned: number }> {
  const due = (await getDb()
    .prepare(
      `SELECT id FROM approval_documents
        WHERE scan_status = 'pending' AND (scan_next_at IS NULL OR scan_next_at <= now()) AND (scan_claimed_until IS NULL OR scan_claimed_until < now())
        ORDER BY scan_next_at NULLS FIRST, id LIMIT ?`
    )
    .all(limit)) as { id: number }[];
  for (const d of due) await scanDocument(d.id);
  return { scanned: due.length };
}

// ------------------------------------------------------------ scanning again

type RetryOutcome = "queued" | "refused_not_failed" | "refused_bytes_gone" | "refused_integrity" | "refused_limit";
/** Where a retry ended: refused at once, or queued and then settled by its scan. */
export type ScanRetryOutcome = RetryOutcome | "clean" | "rejected" | "failed_scanner_unavailable" | "failed_unscannable";

interface LockedDocument {
  id: number;
  request_id: number;
  venue_id: number;
  scan_status: ScanStatus;
  scan_failure: ScanFailure | null;
  bytes: number;
  intact: boolean;
}

/** A document, locked for the rest of the transaction, with whether its bytes are there and match their hash. */
async function lockDocument(id: number): Promise<LockedDocument | undefined> {
  return (await getDb()
    .prepare(
      `SELECT d.id, d.request_id, r.venue_id, d.scan_status, d.scan_failure, octet_length(d.content)::int AS bytes,
              (d.sha256 IS NOT NULL AND octet_length(d.content) > 0 AND d.sha256 = encode(sha256(d.content), 'hex')) AS intact
         FROM approval_documents d JOIN approval_requests r ON r.id = d.request_id
        WHERE d.id = ? FOR UPDATE OF d`
    )
    .get(id)) as LockedDocument | undefined;
}

async function recordRetry(
  documentId: number,
  kind: "manual" | "recovery",
  by: { adminId: number | null; name: string },
  reason: string,
  outcome: RetryOutcome
): Promise<void> {
  await getDb()
    .prepare(
      `INSERT INTO approval_document_scan_retries (document_id, kind, admin_id, by_name, reason, outcome, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ${outcome === "queued" ? "NULL" : "now()"})`
    )
    .run(documentId, kind, by.adminId, by.name, reason, outcome);
}

/** Back into quarantine, the same bytes, for a new round of tries. Only a scan of them can release it. */
async function requeue(doc: LockedDocument): Promise<void> {
  await getDb()
    .prepare(
      `UPDATE approval_documents SET scan_status = 'pending', scan_failure = NULL, scan_attempts = 0, scan_next_at = now(), scan_claimed_until = NULL,
         scanned_at = NULL, scan_error = NULL, scan_rounds = scan_rounds + 1
        WHERE id = ? AND scan_status = 'failed'`
    )
    .run(doc.id);
  await addSystemEvent(doc.request_id, "scan_requeued", null);
}

/** Bytes gone or no longer matching their hash: nothing can be scanned again, so the document fails for good. */
async function markUnscannable(doc: LockedDocument): Promise<void> {
  await getDb()
    .prepare(
      `UPDATE approval_documents SET scan_failure = 'unscannable', scanned_at = now(), scan_error = ?
        WHERE id = ? AND scan_status = 'failed' AND scan_failure = 'scanner_unavailable'`
    )
    .run(doc.bytes === 0 ? "integrity: content is gone" : "integrity: content does not match its hash", doc.id);
}

export type RetryRefusal = { ok: false; code: string; error: string; status: number };
const refuse = (code: string, error: string, status: number): RetryRefusal => ({ ok: false, code, error, status });

/** The words of each refusal, in English (staff read them in their own language: lib/staff-i18n/refusals-2.ts). */
export const RETRY_REFUSALS = {
  SCAN_RETRY_OWNER: "Only the platform owner can have a document scanned again.",
  SCAN_RETRY_REASON: "Say why the document should be scanned again.",
  SCAN_RETRY_GONE: "That document is no longer kept: the applicant needs to send it again.",
  SCAN_RETRY_NOT_FAILED: "Only a document that could not be scanned can be scanned again.",
  SCAN_RETRY_NEW_UPLOAD: "That document's content is gone or no longer matches what was checked, so it cannot be scanned again: the applicant needs to send it again.",
  SCAN_RETRY_LIMIT: `That document has been scanned again ${MAX_MANUAL_RETRIES} times already: the applicant needs to send it again.`,
} as const;

/**
 * The platform owner has a failed document scanned again, saying why. Its
 * bytes must still be there and match the hash recorded when they were
 * checked, and it may be retried at most MAX_MANUAL_RETRIES times;
 * otherwise a new upload is needed. The same bytes go back into quarantine
 * (never changed, never released by this) and are scanned at once where a
 * scanner answers, else on the usual schedule. Asking again while it waits
 * changes nothing. Every request is recorded, refused or not, with who, when,
 * why and, once the scan settles, its outcome.
 */
export async function retryDocumentScan(
  admin: Admin,
  input: { documentId: unknown; reason: unknown }
): Promise<{ ok: true; status: ScanStatus | null; alreadyQueued: boolean } | RetryRefusal> {
  if (!isOwner(admin)) return refuse("SCAN_RETRY_OWNER", RETRY_REFUSALS.SCAN_RETRY_OWNER, 403);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 5 || reason.length > 500) return refuse("SCAN_RETRY_REASON", RETRY_REFUSALS.SCAN_RETRY_REASON, 400);
  const id = Number(input.documentId);
  if (!Number.isInteger(id) || id <= 0) return refuse("SCAN_RETRY_GONE", RETRY_REFUSALS.SCAN_RETRY_GONE, 404);
  const db = getDb();
  const by = { adminId: admin.id, name: admin.name };
  const done = await db.transaction(async (): Promise<{ outcome: RetryOutcome | "already" | "gone"; venueId?: number }> => {
    const doc = await lockDocument(id);
    if (!doc) return { outcome: "gone" };
    if (doc.scan_status === "pending") return { outcome: "already", venueId: doc.venue_id };
    let outcome: RetryOutcome;
    if (doc.scan_status !== "failed") outcome = "refused_not_failed";
    else if (doc.bytes === 0) outcome = "refused_bytes_gone";
    else if (!doc.intact) outcome = "refused_integrity";
    else {
      const used = (await db
        .prepare("SELECT COUNT(*)::int AS n FROM approval_document_scan_retries WHERE document_id = ? AND kind = 'manual' AND outcome NOT LIKE 'refused%'")
        .get(id)) as { n: number };
      outcome = used.n >= MAX_MANUAL_RETRIES ? "refused_limit" : "queued";
    }
    if (outcome === "refused_bytes_gone" || outcome === "refused_integrity") await markUnscannable(doc);
    if (outcome === "queued") await requeue(doc);
    await recordRetry(id, "manual", by, reason, outcome);
    return { outcome, venueId: doc.venue_id };
  })();
  if (done.outcome === "gone") return refuse("SCAN_RETRY_GONE", RETRY_REFUSALS.SCAN_RETRY_GONE, 404);
  const said = {
    queued: "put back in quarantine",
    already: "already waiting for a scan",
    refused_not_failed: "refused: it had not failed",
    refused_bytes_gone: "refused: its content is gone",
    refused_integrity: "refused: its content no longer matches its hash",
    refused_limit: "refused: retried too often",
  }[done.outcome];
  await logAction(admin, { venueId: done.venueId ?? null, action: "approval.scan_retry", detail: `Asked for supporting document ${id} to be scanned again (${said}): ${reason}` });
  if (done.outcome === "refused_not_failed") return refuse("SCAN_RETRY_NOT_FAILED", RETRY_REFUSALS.SCAN_RETRY_NOT_FAILED, 409);
  if (done.outcome === "refused_bytes_gone" || done.outcome === "refused_integrity")
    return refuse("SCAN_RETRY_NEW_UPLOAD", RETRY_REFUSALS.SCAN_RETRY_NEW_UPLOAD, 409);
  if (done.outcome === "refused_limit") return refuse("SCAN_RETRY_LIMIT", RETRY_REFUSALS.SCAN_RETRY_LIMIT, 409);
  if (done.outcome === "queued") await scanDocuments([id], 10_000);
  return { ok: true, status: await currentStatus(id), alreadyQueued: done.outcome === "already" };
}

/**
 * Every minute from the scheduler: once a scanner answers again, documents
 * that failed only because none did go back into quarantine by themselves,
 * to be scanned (bytes checked against their hash first: a document whose
 * bytes are gone or changed fails for good instead). Recorded as retries by
 * the app itself; they do not count against the owner's.
 */
export async function requeueWaitingDocuments(limit = 50): Promise<{ requeued: number }> {
  const db = getDb();
  const waiting = (await db
    .prepare("SELECT id FROM approval_documents WHERE scan_status = 'failed' AND scan_failure = 'scanner_unavailable' ORDER BY id LIMIT ?")
    .all(limit)) as { id: number }[];
  if (waiting.length === 0) return { requeued: 0 };
  const scanner = documentScanner();
  if (!scanner) return { requeued: 0 };
  const state = await scanner.status().catch(() => ({ reachable: false }));
  if (!state.reachable) return { requeued: 0 };
  let requeued = 0;
  for (const { id } of waiting) {
    const outcome = await db.transaction(async (): Promise<RetryOutcome | null> => {
      const doc = await lockDocument(id);
      if (!doc || doc.scan_status !== "failed" || doc.scan_failure !== "scanner_unavailable") return null;
      if (!doc.intact) {
        await markUnscannable(doc);
        await recordRetry(id, "recovery", { adminId: null, name: "MySenam" }, "The malware scanner answers again", doc.bytes === 0 ? "refused_bytes_gone" : "refused_integrity");
        return "refused_integrity";
      }
      await requeue(doc);
      await recordRetry(id, "recovery", { adminId: null, name: "MySenam" }, "The malware scanner answers again", "queued");
      return "queued";
    })();
    if (outcome === "queued") requeued++;
  }
  if (requeued > 0) console.info(`[mysenam] the malware scanner answers again: ${requeued} supporting document(s) put back in quarantine to be scanned.`);
  return { requeued };
}

// ------------------------------------------------------------ the owner's view

export interface ScanRetryRecord {
  at: string;
  kind: "manual" | "recovery";
  by: string;
  reason: string;
  outcome: ScanRetryOutcome;
  settledAt: string | null;
}

export interface FailedDocument {
  id: number;
  requestId: number;
  venueId: number;
  venueName: string;
  sport: string;
  contentType: string;
  size: number;
  failure: ScanFailure;
  error: string | null;
  failedAt: string | null;
  storedAt: string;
  legacyReason: "before_scanning" | "scanning_off" | null;
  /** Its bytes are there and match the hash recorded when they were checked: it can be scanned again. */
  intact: boolean;
  manualRetries: number;
  retries: ScanRetryRecord[];
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

/**
 * Documents that failed, newest first, for the platform owner's panel: what
 * they are (number, venue, activity, kind and size; never contents, file
 * name or applicant), why they failed, whether they can be scanned again, and
 * their retries.
 */
export async function failedDocuments(limit = 50): Promise<FailedDocument[]> {
  const db = getDb();
  const rows = (await db
    .prepare(
      `SELECT d.id, d.request_id, r.venue_id, v.name AS venue_name, r.sport, d.content_type, d.size, d.scan_failure, d.scan_error, d.scanned_at, d.created_at,
              d.legacy_reason, (d.sha256 IS NOT NULL AND octet_length(d.content) > 0 AND d.sha256 = encode(sha256(d.content), 'hex')) AS intact
         FROM approval_documents d JOIN approval_requests r ON r.id = d.request_id JOIN venues v ON v.id = r.venue_id
        WHERE d.scan_status = 'failed' ORDER BY d.scanned_at DESC NULLS LAST, d.id DESC LIMIT ?`
    )
    .all(limit)) as {
    id: number;
    request_id: number;
    venue_id: number;
    venue_name: string;
    sport: string;
    content_type: string;
    size: number;
    scan_failure: ScanFailure;
    scan_error: string | null;
    scanned_at: unknown;
    created_at: unknown;
    legacy_reason: FailedDocument["legacyReason"];
    intact: boolean;
  }[];
  const history = rows.length
    ? ((await db
        .prepare(
          `SELECT document_id, kind, by_name, reason, outcome, requested_at, settled_at FROM approval_document_scan_retries
            WHERE document_id IN (${rows.map(() => "?").join(",")}) ORDER BY id DESC`
        )
        .all(...rows.map((r) => r.id))) as { document_id: number; kind: "manual" | "recovery"; by_name: string; reason: string; outcome: ScanRetryOutcome; requested_at: unknown; settled_at: unknown }[])
    : [];
  return rows.map((r) => {
    const mine = history.filter((h) => h.document_id === r.id);
    return {
      id: r.id,
      requestId: r.request_id,
      venueId: r.venue_id,
      venueName: r.venue_name,
      sport: r.sport,
      contentType: r.content_type,
      size: r.size,
      failure: r.scan_failure,
      error: r.scan_error,
      failedAt: iso(r.scanned_at),
      storedAt: iso(r.created_at) ?? "",
      legacyReason: r.legacy_reason,
      intact: Boolean(r.intact),
      manualRetries: mine.filter((h) => h.kind === "manual" && !h.outcome.startsWith("refused")).length,
      retries: mine.slice(0, 10).map((h) => ({
        at: iso(h.requested_at) ?? "",
        kind: h.kind,
        by: h.by_name,
        reason: h.reason,
        outcome: h.outcome,
        settledAt: iso(h.settled_at),
      })),
    };
  });
}

// ------------------------------------------------------------ health

export type ScannerProblem = "unconfigured" | "unreachable" | "signatures_old" | "signatures_unknown" | "backlog" | "failures" | "waiting";

export interface ScannerHealth {
  mode: ScanMode;
  reachable: boolean | null;
  engine: string | null;
  signaturesAt: string | null;
  signatureAgeHours: number | null;
  /** Waiting for a scan; of those, waiting longer than BACKLOG_MINUTES. */
  pending: number;
  overdue: number;
  /** Failed only because no scanner answered: kept, waiting for one. */
  waiting: number;
  /** Settled in the last seven days. */
  rejected: number;
  failed: number;
  /** Stored before scanning existed, or taken unscanned under the withdrawn opt-out: where they stand now. */
  legacy: { total: number; waiting: number; clean: number; rejected: number; unscannable: number };
  problems: ScannerProblem[];
}

const PROBLEM_TEXT: Record<ScannerProblem, string> = {
  unconfigured: "No malware scanner is configured (MYSENAM_CLAMD): supporting documents wait in quarantine, and nobody can open them, until one is.",
  unreachable: "The malware scanner does not answer: documents wait in quarantine and are tried again.",
  signatures_old: `The malware scanner's signatures are more than ${SIGNATURES_MAX_AGE_HOURS} hours old: check freshclam.`,
  signatures_unknown: "The malware scanner does not say how old its signatures are: check freshclam.",
  backlog: `Supporting documents have waited more than ${BACKLOG_MINUTES} minutes for a scan.`,
  failures: "Supporting documents could not be scanned by a working scanner, and cannot be opened.",
  waiting:
    "Supporting documents could not be scanned because no scanner answered: they are kept in quarantine, unopened, and scanned by themselves once a scanner answers.",
};

/** The scanner, and documents by state: for the owner's dashboard and the hourly check. */
export async function scannerHealth(now = Date.now()): Promise<ScannerHealth> {
  const mode = scanMode();
  const counts = (await getDb()
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE scan_status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE scan_status = 'pending' AND created_at < now() - make_interval(mins => ${BACKLOG_MINUTES}))::int AS overdue,
         COUNT(*) FILTER (WHERE scan_status = 'failed' AND scan_failure = 'scanner_unavailable')::int AS waiting,
         COUNT(*) FILTER (WHERE scan_status = 'rejected' AND scanned_at > now() - interval '7 days')::int AS rejected,
         COUNT(*) FILTER (WHERE scan_status = 'failed' AND scan_failure = 'unscannable' AND scanned_at > now() - interval '7 days')::int AS failed,
         COUNT(*) FILTER (WHERE legacy_reason IS NOT NULL)::int AS legacy_total,
         COUNT(*) FILTER (WHERE legacy_reason IS NOT NULL AND (scan_status = 'pending' OR scan_failure = 'scanner_unavailable'))::int AS legacy_waiting,
         COUNT(*) FILTER (WHERE legacy_reason IS NOT NULL AND scan_status = 'clean')::int AS legacy_clean,
         COUNT(*) FILTER (WHERE legacy_reason IS NOT NULL AND scan_status = 'rejected')::int AS legacy_rejected,
         COUNT(*) FILTER (WHERE legacy_reason IS NOT NULL AND scan_failure = 'unscannable')::int AS legacy_unscannable
       FROM approval_documents`
    )
    .get()) as Record<
    "pending" | "overdue" | "waiting" | "rejected" | "failed" | "legacy_total" | "legacy_waiting" | "legacy_clean" | "legacy_rejected" | "legacy_unscannable",
    number
  >;
  const problems: ScannerProblem[] = [];
  let reachable: boolean | null = null;
  let engine: string | null = null;
  let signaturesAt: string | null = null;
  let signatureAgeHours: number | null = null;
  const scanner = documentScanner();
  if (mode === "unconfigured") problems.push("unconfigured");
  if (scanner) {
    const s = await scanner.status();
    reachable = s.reachable;
    engine = s.engine;
    signaturesAt = s.signaturesAt;
    if (!s.reachable) problems.push("unreachable");
    else if (signaturesAt === null) problems.push("signatures_unknown");
    else {
      signatureAgeHours = Math.max(0, (now - Date.parse(signaturesAt)) / 3_600_000);
      if (signatureAgeHours > SIGNATURES_MAX_AGE_HOURS) problems.push("signatures_old");
    }
  }
  if (counts.overdue > 0) problems.push("backlog");
  if (counts.failed > 0) problems.push("failures");
  if (counts.waiting > 0) problems.push("waiting");
  return {
    mode,
    reachable,
    engine,
    signaturesAt,
    signatureAgeHours,
    pending: counts.pending,
    overdue: counts.overdue,
    waiting: counts.waiting,
    rejected: counts.rejected,
    failed: counts.failed,
    legacy: {
      total: counts.legacy_total,
      waiting: counts.legacy_waiting,
      clean: counts.legacy_clean,
      rejected: counts.legacy_rejected,
      unscannable: counts.legacy_unscannable,
    },
    problems,
  };
}

/** The problems, in English, for the owners' alert. */
export function problemText(problems: ScannerProblem[]): string {
  return problems.map((p) => PROBLEM_TEXT[p]).join("\n");
}

/**
 * Hourly from the scheduler: tell the owners when the scanner is down, its
 * signatures are stale or unknown, documents are waiting for it or have
 * failed, or no scanner is configured. An install that never takes
 * documents and has no scanner is told only once there is a document waiting.
 */
export async function checkScanner(now = Date.now()): Promise<ScannerHealth> {
  const health = await scannerHealth(now);
  const worth = health.problems.filter((p) => (p === "unconfigured" ? health.pending + health.waiting > 0 : true));
  if (worth.length > 0) await raiseAlert("document-scanner", "Supporting documents: malware scanning needs attention", problemText(worth));
  return health;
}
