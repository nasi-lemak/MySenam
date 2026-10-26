import crypto from "crypto";
import { raiseAlert } from "./alerts";
import { getDb } from "./db";
import { documentScanner, scanMode, type ScanErrorKind, type ScanMode } from "./document-scanner";

/**
 * Supporting documents, scanned before anybody can open them
 * (docs/architecture/security.md#supporting-documents; ADR 0024).
 *
 * received → size and count limits → its format checked from its bytes
 * (lib/approval-documents.ts, every ADR 0021 check) → stored in quarantine,
 * in the database, `pending` → scanned by the server's own call to the
 * scanner → the result recorded → released (`clean`) only when the scan
 * passed; `rejected` (the scanner found something: its bytes wiped at once,
 * the fact kept) or `failed` (no answer after a bounded number of tries:
 * never released). The quarantine period (lib/retention-policy.ts) then
 * removes what is left of a rejected or failed document.
 *
 * - **Only the server sets a result.** No route takes a status; the only
 *   write that releases a document is `settle` below, after the configured
 *   scanner answered for exactly the stored bytes (their SHA-256 is checked
 *   and recorded), and the database refuses a clean status without that
 *   record, and any change to a settled one (migration 0142).
 * - **Idempotent.** A scan claims the document for a short while first; a
 *   second scan of the same document at the same time, a repeated or late
 *   result, or a retry after it settled changes nothing.
 * - **Bounded retries.** An unavailable, timed-out or inconclusive scan is
 *   tried again on a schedule (`RETRY_MINUTES`), at most `MAX_SCAN_ATTEMPTS`
 *   times over about a day, then the document is `failed`.
 * - **Never clean by default.** Without a scanner, documents are refused
 *   (`unconfigured`), unless the operator turned scanning off on purpose,
 *   when each is stored `not_scanned` and shown so (lib/document-scanner.ts).
 *
 * Logs name a document by its number and the signature found, never its
 * contents or the applicant.
 */

export type ScanStatus = "pending" | "clean" | "rejected" | "failed" | "not_scanned";

/** What may be opened, and counts towards a document an approval needs. */
export const RELEASED: ScanStatus[] = ["clean", "not_scanned"];

/** Minutes to wait after each failed try before the next; after the last, the document has failed. */
export const RETRY_MINUTES = [1, 5, 30, 120, 360, 720];
export const MAX_SCAN_ATTEMPTS = RETRY_MINUTES.length + 1;
/** A claimed scan is somebody else's for this long (longer than a scan may take). */
const CLAIM_SECONDS = 120;
/** Signatures older than this are reported to the owners: freshclam has stopped. */
export const SIGNATURES_MAX_AGE_HOURS = 48;
/** A document still pending after this is reported: the scanner is behind or down. */
export const BACKLOG_MINUTES = 60;

/** The status a newly stored document starts in, or null when documents cannot be taken now. */
export function initialScanStatus(mode: ScanMode = scanMode()): ScanStatus | null {
  return mode === "scanner" ? "pending" : mode === "off" ? "not_scanned" : null;
}

const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

async function addSystemEvent(requestId: number, action: string, reason: string | null): Promise<void> {
  await getDb()
    .prepare("INSERT INTO approval_events (request_id, actor, actor_name, action, reason) VALUES (?, 'system', 'MySenam', ?, ?)")
    .run(requestId, action, reason);
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
  const mode = scanMode();
  if (mode === "off") return settle(claimed, hash, { status: "not_scanned" });
  // The bytes must be the ones stored when the document was checked.
  if (claimed.sha256 !== null && claimed.sha256 !== hash) return failTry(claimed, "inconclusive", "content does not match its hash", true);
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
  return failTry(claimed, verdict.error, verdict.detail, verdict.error === "too_large");
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
  result: { status: "clean"; engine: string } | { status: "rejected"; engine: string; finding: string } | { status: "not_scanned" }
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
              `UPDATE approval_documents SET scan_status = ?, scanned_at = now(), scan_engine = ?, scan_sha256 = ?,
                 scan_attempts = scan_attempts + ?, scan_next_at = NULL, scan_claimed_until = NULL, scan_error = NULL
                WHERE id = ? AND scan_status = 'pending'`
            )
            .run(result.status, result.status === "clean" ? result.engine.slice(0, 200) : null, hash, result.status === "clean" ? 1 : 0, doc.id);
    if (changed.changes === 0) return false;
    if (result.status === "rejected") await addSystemEvent(doc.request_id, "scan_rejected", null);
    return true;
  })();
  if (done && result.status === "rejected")
    // The document's number and the signature's name: never its contents or whose it is.
    console.warn(`[mysenam] supporting document ${doc.id} was refused by the malware scan (${result.finding}); its content was removed.`);
  return currentStatus(doc.id);
}

/** A try that gave no answer: tried again later, or failed for good once the tries are used up (or `final`). */
async function failTry(doc: Claimed, error: ScanErrorKind, detail: string, final = false): Promise<ScanStatus | null> {
  const db = getDb();
  const attempts = doc.scan_attempts + 1;
  const failed = final || attempts >= MAX_SCAN_ATTEMPTS;
  const wait = RETRY_MINUTES[Math.min(attempts, RETRY_MINUTES.length) - 1];
  const done = await db.transaction(async () => {
    const changed = await db
      .prepare(
        failed
          ? `UPDATE approval_documents SET scan_status = 'failed', scanned_at = now(), scan_attempts = ?, scan_error = ?, scan_next_at = NULL, scan_claimed_until = NULL
              WHERE id = ? AND scan_status = 'pending'`
          : `UPDATE approval_documents SET scan_attempts = ?, scan_error = ?, scan_next_at = now() + make_interval(mins => ${wait}), scan_claimed_until = NULL
              WHERE id = ? AND scan_status = 'pending'`
      )
      .run(attempts, `${error}: ${detail}`.slice(0, 200), doc.id);
    if (changed.changes > 0 && failed) await addSystemEvent(doc.request_id, "scan_failed", null);
    return changed.changes > 0;
  })();
  if (done) console.error(`[mysenam] scanning supporting document ${doc.id} ${failed ? "failed for good" : "failed, to be tried again"} (try ${attempts}): ${error}`);
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

// ------------------------------------------------------------ health

export type ScannerProblem = "unconfigured" | "off" | "unreachable" | "signatures_old" | "signatures_unknown" | "backlog" | "failures";

export interface ScannerHealth {
  mode: ScanMode;
  reachable: boolean | null;
  engine: string | null;
  signaturesAt: string | null;
  signatureAgeHours: number | null;
  /** Waiting for a scan; of those, waiting longer than BACKLOG_MINUTES. */
  pending: number;
  overdue: number;
  /** Settled in the last seven days. */
  rejected: number;
  failed: number;
  notScanned: number;
  problems: ScannerProblem[];
}

const PROBLEM_TEXT: Record<ScannerProblem, string> = {
  unconfigured: "No malware scanner is configured (MYSENAM_CLAMD), so supporting documents are refused.",
  off: "Malware scanning of supporting documents is turned off (MYSENAM_DOCUMENT_SCAN=off): documents are taken and marked not scanned.",
  unreachable: "The malware scanner does not answer: documents wait in quarantine and are retried.",
  signatures_old: `The malware scanner's signatures are more than ${SIGNATURES_MAX_AGE_HOURS} hours old: check freshclam.`,
  signatures_unknown: "The malware scanner does not say how old its signatures are: check freshclam.",
  backlog: `Supporting documents have waited more than ${BACKLOG_MINUTES} minutes for a scan.`,
  failures: "Supporting documents could not be scanned after every try, and cannot be opened.",
};

/** The scanner, and documents by state: for the owner's dashboard and the hourly check. */
export async function scannerHealth(now = Date.now()): Promise<ScannerHealth> {
  const mode = scanMode();
  const counts = (await getDb()
    .prepare(
      `SELECT
         COUNT(*) FILTER (WHERE scan_status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE scan_status = 'pending' AND created_at < now() - make_interval(mins => ${BACKLOG_MINUTES}))::int AS overdue,
         COUNT(*) FILTER (WHERE scan_status = 'rejected' AND scanned_at > now() - interval '7 days')::int AS rejected,
         COUNT(*) FILTER (WHERE scan_status = 'failed' AND scanned_at > now() - interval '7 days')::int AS failed,
         COUNT(*) FILTER (WHERE scan_status = 'not_scanned')::int AS not_scanned
       FROM approval_documents`
    )
    .get()) as { pending: number; overdue: number; rejected: number; failed: number; not_scanned: number };
  const problems: ScannerProblem[] = [];
  let reachable: boolean | null = null;
  let engine: string | null = null;
  let signaturesAt: string | null = null;
  let signatureAgeHours: number | null = null;
  const scanner = documentScanner();
  if (mode === "unconfigured") problems.push("unconfigured");
  if (mode === "off") problems.push("off");
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
  return {
    mode,
    reachable,
    engine,
    signaturesAt,
    signatureAgeHours,
    pending: counts.pending,
    overdue: counts.overdue,
    rejected: counts.rejected,
    failed: counts.failed,
    notScanned: counts.not_scanned,
    problems,
  };
}

/** The problems, in English, for the owners' alert. */
export function problemText(problems: ScannerProblem[]): string {
  return problems.map((p) => PROBLEM_TEXT[p]).join("\n");
}

/**
 * Hourly from the scheduler: tell the owners when the scanner is down, its
 * signatures are stale or unknown, documents are waiting or have failed, or
 * scanning is not running at all. An install that never takes documents and
 * has no scanner is told only once there is a document to scan.
 */
export async function checkScanner(now = Date.now()): Promise<ScannerHealth> {
  const health = await scannerHealth(now);
  const worth = health.problems.filter((p) => (p === "unconfigured" || p === "off" ? health.pending + health.notScanned > 0 : true));
  if (worth.length > 0) await raiseAlert("document-scanner", "Supporting documents: malware scanning needs attention", problemText(worth));
  return health;
}
