import fs from "fs";
import os from "os";
import path from "path";
import { decryptFile, encryptFile, readKeyFile, signBytes, signatureValid } from "./backup-crypto.ts";
import { getDb } from "./db.ts";
import { assembleChain, isChainEntry, selfConsistent, type Candidate, type ChainEntry, type KnownHead } from "./erasure-chain.ts";
import { bringIn, ledgerEntries, ledgerFile, ledgerHead, readLedgerFile } from "./erasure-ledger.ts";
import {
  downloadObject,
  firstVersions,
  listOffsite,
  listOffsiteVersions,
  offsiteConfig,
  offsiteReadConfig,
  offsiteTransferCheck,
  uploadBackup,
  type OffsiteConfig,
} from "./offsite.ts";

/**
 * The erasure ledger, off-site (docs/operations/backups.md#the-erasure-ledger-off-site; ADR 0024).
 *
 * The ledger beside the backups survives a restore, not the loss of the
 * server. So its entries are also copied to object storage, in **segments**:
 * each one JSON holding the entries not copied yet (numbered and
 * hash-chained, lib/erasure-chain.ts), its first and last number, the hash
 * it follows from and the hash it ends on. A segment is uploaded once, under
 * a name of its own (`ledger-<first>-<last>-<time>.json`), never replaced:
 *
 * - **when:** at once after each erasure, again on each scheduler tick
 *   (every minute) until the bucket accepts it, and before every backup set
 *   goes off-site, whose manifest names the ledger's newest entry
 *   (lib/backup.ts);
 * - **where:** the backup bucket under its own prefix (`erasure-ledger/`
 *   inside `OFFSITE_S3_PREFIX`) by default, or a bucket of its own with a
 *   key of its own (`OFFSITE_LEDGER_S3_*`), on the same endpoint, so the
 *   same data-location and transfer checks apply;
 * - **protected:** the upload key only writes; the bucket's Object Lock
 *   keeps each segment's first upload; each segment is signed with the
 *   backup-signing key (`OFFSITE_SIGNING_KEY_FILE`, a detached `.sig` sent
 *   first) and encrypted like a backup set where a public key is set
 *   (required for a bucket abroad);
 * - **read back:** on the restore machine, with the read key, the signing
 *   public key and the encryption private key alone (`recoverLedger`, run by
 *   scripts/restore.mjs). Each name's first upload is used; a segment that
 *   does not hold together, is unsigned or signed by another key is refused;
 *   the chain is put together from the restored database's own newest entry,
 *   and a gap, a broken link or a newer number named anywhere else (a newer
 *   backup's manifest in the bucket, the ledger beside the backups, the
 *   operator) is reported, and the app does not serve until somebody
 *   acknowledges it.
 *
 * Segments overlap where a copy was accepted but not noted (the server
 * stopped between the two): the same entry under the same number is read
 * once, and two different entries under one number are a conflict.
 */

export const SEGMENT_FORMAT = "mysenam-erasure-ledger/1";
const SEGMENT = /^ledger-(\d{12})-(\d{12})-(\d{8}T\d{6}Z)\.json(\.enc)?$/;
const STATUS_KEY = "erasure_ledger_offsite";
/** An entry not off-site after this long is told to the owners. */
export const UNSHIPPED_ALERT_MINUTES = 60;

export interface Segment {
  format: typeof SEGMENT_FORMAT;
  firstSeq: number;
  lastSeq: number;
  /** The hash the first entry follows from. */
  prevHash: string;
  /** The last entry's hash. */
  headHash: string;
  createdAt: string;
  entries: ChainEntry[];
}

const pad = (n: number) => String(n).padStart(12, "0");
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** A segment's name in the bucket, before any `.enc`. */
export function segmentName(s: Pick<Segment, "firstSeq" | "lastSeq" | "createdAt">): string {
  return `ledger-${pad(s.firstSeq)}-${pad(s.lastSeq)}-${stamp(new Date(s.createdAt))}.json`;
}

/** Make a segment of these entries, in order. */
export function makeSegment(entries: ChainEntry[], now = new Date()): Segment {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  return {
    format: SEGMENT_FORMAT,
    firstSeq: sorted[0].seq,
    lastSeq: sorted.at(-1)!.seq,
    prevHash: sorted[0].prevHash,
    headHash: sorted.at(-1)!.hash,
    createdAt: now.toISOString(),
    entries: sorted,
  };
}

/** Does this segment hold together: its entries numbered one after another, each following the one before, each covered by its hash? Null when it does, or what is wrong. */
export function segmentProblem(s: unknown): string | null {
  const seg = s as Partial<Segment> | null;
  if (!seg || seg.format !== SEGMENT_FORMAT || !Array.isArray(seg.entries) || seg.entries.length === 0) return "it is not an erasure-ledger segment";
  if (!seg.entries.every(isChainEntry)) return "an entry in it is malformed";
  const es = seg.entries;
  if (es[0].seq !== seg.firstSeq || es.at(-1)!.seq !== seg.lastSeq) return "its entries are not the numbers it names";
  if (es[0].prevHash !== seg.prevHash || es.at(-1)!.hash !== seg.headHash) return "its entries are not the hashes it names";
  for (let i = 0; i < es.length; i++) {
    if (!selfConsistent(es[i])) return `entry ${es[i].seq} does not match its own hash`;
    if (i > 0 && (es[i].seq !== es[i - 1].seq + 1 || es[i].prevHash !== es[i - 1].hash)) {
      // Only an acknowledged recovery may skip numbers, and it still follows the entry before it.
      const skips = es[i].kind === "recovery" && es[i].seq > es[i - 1].seq + 1 && es[i].prevHash === es[i - 1].hash;
      if (!skips) return `entry ${es[i].seq} does not follow entry ${es[i - 1].seq}`;
    }
  }
  return null;
}

// ------------------------------------------------------------- where

/**
 * Where the server sends ledger segments, with the upload key: the backup
 * bucket's endpoint; `OFFSITE_LEDGER_S3_BUCKET` or the backup bucket;
 * `OFFSITE_LEDGER_S3_PREFIX` or `erasure-ledger/` inside the backups' prefix;
 * `OFFSITE_LEDGER_S3_ACCESS_KEY_ID` and `OFFSITE_LEDGER_S3_SECRET_ACCESS_KEY`
 * or the backups' upload key. Null when off-site copies are not set up.
 */
export function ledgerOffsiteConfig(): OffsiteConfig | null {
  const base = offsiteConfig();
  if (!base) return null;
  const id = process.env.OFFSITE_LEDGER_S3_ACCESS_KEY_ID;
  const secret = process.env.OFFSITE_LEDGER_S3_SECRET_ACCESS_KEY;
  return {
    ...base,
    bucket: process.env.OFFSITE_LEDGER_S3_BUCKET || base.bucket,
    prefix: process.env.OFFSITE_LEDGER_S3_PREFIX || `${base.prefix}erasure-ledger/`,
    ...(id && secret ? { accessKeyId: id, secretAccessKey: secret } : {}),
  };
}

/** Where the restore machine reads them, with the read key (`OFFSITE_LEDGER_S3_READ_*`, or the backups' read key). */
export function ledgerOffsiteReadConfig(): OffsiteConfig | null {
  const base = offsiteReadConfig();
  if (!base) return null;
  const id = process.env.OFFSITE_LEDGER_S3_READ_ACCESS_KEY_ID;
  const secret = process.env.OFFSITE_LEDGER_S3_READ_SECRET_ACCESS_KEY;
  return {
    ...base,
    bucket: process.env.OFFSITE_LEDGER_S3_BUCKET || base.bucket,
    prefix: process.env.OFFSITE_LEDGER_S3_PREFIX || `${base.prefix}erasure-ledger/`,
    ...(id && secret ? { accessKeyId: id, secretAccessKey: secret } : {}),
  };
}

// ------------------------------------------------------------- sending

export interface LedgerOffsiteStatus {
  lastShipped: { name: string; firstSeq: number; lastSeq: number; at: string; encrypted: boolean; signed: boolean } | null;
  lastError: { at: string; error: string } | null;
}

async function storedStatus(): Promise<LedgerOffsiteStatus> {
  const row = (await getDb().prepare("SELECT value FROM settings WHERE key = ?").get(STATUS_KEY)) as { value: string } | undefined;
  try {
    return row ? (JSON.parse(row.value) as LedgerOffsiteStatus) : { lastShipped: null, lastError: null };
  } catch {
    return { lastShipped: null, lastError: null };
  }
}

async function rememberStatus(next: LedgerOffsiteStatus): Promise<void> {
  await getDb()
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(STATUS_KEY, JSON.stringify(next));
}

/** The off-site copy's state: where it reaches against the newest entry, and the last copy or failure. */
export async function ledgerOffsiteStatus(): Promise<LedgerOffsiteStatus & { configured: boolean; headSeq: number; shippedSeq: number }> {
  const head = await ledgerHead();
  return { configured: ledgerOffsiteConfig() !== null, headSeq: head.seq, shippedSeq: head.shippedSeq, ...(await storedStatus()) };
}

export type ShipResult = { ok: true; shipped: number; name?: string } | { ok: false; error: string };

async function failed(error: string): Promise<ShipResult> {
  const previous = await storedStatus();
  await rememberStatus({ lastShipped: previous.lastShipped, lastError: { at: new Date().toISOString(), error } });
  const head = await ledgerHead();
  const { raiseAlert } = await import("./alerts");
  await raiseAlert(
    "erasure-ledger-offsite",
    "The erasure ledger could not be copied off-site",
    `The newest erasure-ledger entry is number ${head.seq}; the off-site copy reaches number ${head.shippedSeq}. ${error}\n` +
      "Until it is copied, losing this server would lose the erasures after that number: a restore elsewhere would not apply them again. Keep this message: its numbers tell a restore how far the ledger had reached."
  );
  return { ok: false, error };
}

/**
 * Copy every entry not yet off-site, as one segment: its signature first,
 * then the segment, encrypted where a public key is set. Only one copy at a
 * time (a claim on the head row, which runs out after five minutes if this
 * process stops); a failure is noted, told to the owners, and tried again
 * on the next tick. Null when off-site copies are not set up.
 */
export async function shipLedger(now = new Date()): Promise<ShipResult | null> {
  const config = ledgerOffsiteConfig();
  if (!config) return null;
  const head = await ledgerHead();
  if (head.seq <= head.shippedSeq) return { ok: true, shipped: 0 };
  const paused = offsiteTransferCheck();
  if (paused) return failed(paused);
  const db = getDb();
  const claimed = await db
    .prepare(
      "UPDATE erasure_ledger_head SET shipping_until = now() + interval '5 minutes' WHERE id = 1 AND (shipping_until IS NULL OR shipping_until < now()) RETURNING shipped_seq"
    )
    .get();
  if (!claimed) return { ok: true, shipped: 0 };
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mysenam-ledger-"));
  try {
    const entries = await ledgerEntries(Number((claimed as { shipped_seq: number }).shipped_seq));
    if (entries.length === 0) return { ok: true, shipped: 0 };
    const segment = makeSegment(entries, now);
    const name = segmentName(segment);
    const plain = path.join(scratch, name);
    fs.writeFileSync(plain, JSON.stringify(segment));
    const signingKey = readKeyFile(process.env.OFFSITE_SIGNING_KEY_FILE);
    const publicKey = readKeyFile(process.env.OFFSITE_ENCRYPTION_PUBLIC_KEY_FILE);
    if (signingKey) {
      const sig = path.join(scratch, `${name}.sig`);
      fs.writeFileSync(sig, JSON.stringify(signBytes(fs.readFileSync(plain), signingKey)));
      const sent = await uploadBackup({ name: `${name}.sig`, path: sig }, config);
      if (!sent.ok) return failed(`signature: ${sent.error}`);
    }
    let body = { name, path: plain };
    if (publicKey) {
      body = { name: `${name}.enc`, path: `${plain}.enc` };
      await encryptFile(plain, body.path, publicKey);
    }
    const sent = await uploadBackup(body, config);
    if (!sent.ok) return failed(sent.error);
    await db
      .prepare("UPDATE erasure_ledger_head SET shipped_seq = GREATEST(shipped_seq, ?), shipped_at = now() WHERE id = 1")
      .run(segment.lastSeq);
    await rememberStatus({
      lastShipped: { name: body.name, firstSeq: segment.firstSeq, lastSeq: segment.lastSeq, at: new Date().toISOString(), encrypted: Boolean(publicKey), signed: Boolean(signingKey) },
      lastError: null,
    });
    return { ok: true, shipped: entries.length, name: body.name };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    await db.prepare("UPDATE erasure_ledger_head SET shipping_until = NULL WHERE id = 1").run();
  }
}

/**
 * Hourly: an entry still not off-site an hour after it was made is told to
 * the owners, with the numbers (the alert is then a record, off the server,
 * of how far the ledger had reached).
 */
export async function checkLedgerShipping(now = Date.now()): Promise<boolean> {
  if (!ledgerOffsiteConfig()) return false;
  const head = await ledgerHead();
  if (head.seq <= head.shippedSeq) return false;
  const oldest = (await getDb().prepare("SELECT erased_at FROM erasure_ledger WHERE seq > ? ORDER BY seq LIMIT 1").get(head.shippedSeq)) as
    | { erased_at: Date | string }
    | undefined;
  if (!oldest || now - new Date(oldest.erased_at).getTime() < UNSHIPPED_ALERT_MINUTES * 60_000) return false;
  const status = await storedStatus();
  const { raiseAlert } = await import("./alerts");
  await raiseAlert(
    "erasure-ledger-offsite",
    "The erasure ledger is behind off-site",
    `The newest erasure-ledger entry is number ${head.seq}; the off-site copy reaches number ${head.shippedSeq}, and entry ${head.shippedSeq + 1} has waited more than ${UNSHIPPED_ALERT_MINUTES} minutes.` +
      (status.lastError ? ` Last failure: ${status.lastError.error}` : "") +
      "\nKeep this message: its numbers tell a restore how far the ledger had reached."
  );
  return true;
}

// ------------------------------------------------------------- reading back

export interface OffsiteLedger {
  candidates: Candidate[];
  /** Segments read and accepted. */
  segments: number;
  /** Segments refused: why, by name. */
  problems: string[];
  warnings: string[];
  /** "verified": every accepted segment carried the server's signature; "unchecked": no public key to check with. */
  signature: "verified" | "unchecked";
  /** The newest number in an accepted segment. */
  head: number;
}

/**
 * Every segment in the bucket, each as first uploaded where versions can be
 * listed, decrypted, its signature checked where the signing public key is
 * set (`OFFSITE_SIGNING_PUBLIC_KEY_FILE`), and checked to hold together. A
 * refused segment's entries are left out, and why is said.
 */
export async function fetchOffsiteLedger(config: OffsiteConfig, dir: string): Promise<OffsiteLedger> {
  fs.mkdirSync(dir, { recursive: true });
  const out: OffsiteLedger = { candidates: [], segments: 0, problems: [], warnings: [], signature: "unchecked", head: 0 };
  const versions = await listOffsiteVersions(config).catch(() => null);
  const firsts = versions ? firstVersions(versions) : null;
  const names = firsts ? [...firsts].filter(([, v]) => v.first).map(([n]) => n) : (await listOffsite(config)).map((o) => o.name);
  if (!firsts) out.warnings.push("The bucket's versions could not be listed: the ledger's segments read are the current copies, which the upload key could have replaced.");
  const fetchOne = async (name: string, dest: string) => {
    const v = firsts?.get(name);
    if (firsts && !v?.first) throw new Error(`${name} is not in the bucket`);
    if (v?.rewritten) out.warnings.push(`${name} was written again after upload: its first upload was used. Treat the upload key as stolen.`);
    await downloadObject(config, name, dest, v?.first?.versionId);
  };
  const signingPublic = readKeyFile(process.env.OFFSITE_SIGNING_PUBLIC_KEY_FILE);
  const privateKey = readKeyFile(process.env.OFFSITE_ENCRYPTION_PRIVATE_KEY_FILE);
  out.signature = signingPublic ? "verified" : "unchecked";
  const segments = names.filter((n) => SEGMENT.test(n)).sort();
  for (const name of segments) {
    const plainName = name.replace(/\.enc$/, "");
    const local = path.join(dir, path.basename(plainName));
    try {
      if (name.endsWith(".enc")) {
        if (!privateKey) throw new Error("it is encrypted, and OFFSITE_ENCRYPTION_PRIVATE_KEY_FILE is not set");
        await fetchOne(name, `${local}.enc`);
        await decryptFile(`${local}.enc`, local, privateKey);
      } else await fetchOne(name, local);
      const bytes = fs.readFileSync(local);
      if (signingPublic) {
        const sigFile = `${local}.sig`;
        try {
          await fetchOne(`${plainName}.sig`, sigFile);
        } catch {
          throw new Error("it has no signature, and OFFSITE_SIGNING_PUBLIC_KEY_FILE asks for one");
        }
        if (!signatureValid(bytes, JSON.parse(fs.readFileSync(sigFile, "utf8")) as unknown, signingPublic))
          throw new Error("it is not signed by the server's key (OFFSITE_SIGNING_PUBLIC_KEY_FILE)");
      }
      const segment = JSON.parse(bytes.toString("utf8")) as Segment;
      const wrong = segmentProblem(segment);
      if (wrong) throw new Error(wrong);
      const [, first, last] = SEGMENT.exec(name)!;
      if (Number(first) !== segment.firstSeq || Number(last) !== segment.lastSeq) throw new Error("its name does not match the numbers inside it");
      for (const entry of segment.entries) out.candidates.push({ entry, source: `off-site segment ${plainName}` });
      out.segments++;
      out.head = Math.max(out.head, segment.lastSeq);
    } catch (err) {
      out.problems.push(`Off-site segment ${plainName} was refused: ${err instanceof Error ? err.message : String(err)}.`);
    }
  }
  if (!signingPublic && out.segments > 0) out.warnings.push("The off-site ledger's signatures were not checked: OFFSITE_SIGNING_PUBLIC_KEY_FILE is not set on this machine.");
  return out;
}

/**
 * The ledger's newest entry as the newest backup set in the bucket names it
 * (its manifest's `erasureLedger`), signature checked where the public key
 * is set. A record of how far the ledger had reached that does not depend
 * on the ledger's own segments.
 */
export async function newestManifestHead(config: OffsiteConfig, dir: string): Promise<{ head: KnownHead | null; warning: string | null }> {
  fs.mkdirSync(dir, { recursive: true });
  const versions = await listOffsiteVersions(config).catch(() => null);
  const firsts = versions ? firstVersions(versions) : null;
  const names = firsts ? [...firsts].filter(([, v]) => v.first).map(([n]) => n) : (await listOffsite(config)).map((o) => o.name);
  // Newest last, as backup names sort: by the time in the name, then the -2, -3 of a second set in the same second.
  const MANIFEST = /^mysenam-(\d{4}-\d{2}-\d{2}-\d{6})(?:-(\d+))?\.manifest\.json$/;
  const order = (n: string) => {
    const m = MANIFEST.exec(n)!;
    return `${m[1]}-${(m[2] ?? "1").padStart(4, "0")}`;
  };
  const manifests = names.filter((n) => MANIFEST.test(n)).sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  for (const name of manifests.reverse()) {
    const dest = path.join(dir, name);
    await downloadObject(config, name, dest, firsts?.get(name)?.first?.versionId);
    const signingPublic = readKeyFile(process.env.OFFSITE_SIGNING_PUBLIC_KEY_FILE);
    if (signingPublic) {
      try {
        await downloadObject(config, `${name}.sig`, `${dest}.sig`, firsts?.get(`${name}.sig`)?.first?.versionId);
        if (!signatureValid(fs.readFileSync(dest), JSON.parse(fs.readFileSync(`${dest}.sig`, "utf8")) as unknown, signingPublic)) throw new Error("bad");
      } catch {
        continue;
      }
    }
    const m = JSON.parse(fs.readFileSync(dest, "utf8")) as { erasureLedger?: { seq?: unknown; hash?: unknown } };
    const seq = Number(m.erasureLedger?.seq);
    if (!Number.isSafeInteger(seq)) return { head: null, warning: `The newest backup set in the bucket (${name}) is from before the ledger's number was recorded in manifests.` };
    return { head: { seq, hash: typeof m.erasureLedger?.hash === "string" ? m.erasureLedger.hash : null, source: `The newest backup set in the bucket (${name})` }, warning: null };
  }
  return { head: null, warning: null };
}

export interface Recovery {
  state: "complete" | "blocked";
  anchor: number;
  verified: number;
  knownSeq: number;
  broughtIn: number;
  /** Customer and participant entries after the restored copy's own, to be applied again at start. */
  toApply: number;
  problems: string[];
  warnings: string[];
  sources: string[];
}

/**
 * After a restore, before the app starts: read the ledger from every source
 * there is, put the chain together from the restored database's own newest
 * entry, bring in what is verified, and record whether it is shown complete
 * (`erasure_ledger_recoveries`). Complete means: the ledger beside the
 * backups is here (this server survived), and nothing (a gap, a broken
 * link, a refused segment, a conflict, a newer number named by the set's
 * manifest, the newest manifest in the bucket, the file, or the operator)
 * says otherwise. After losing the server, nothing can prove the newest
 * erasures left it, so such a restore is never complete by itself: it waits
 * for somebody to acknowledge it.
 */
export async function recoverLedger(input: {
  backup: string;
  /** What this set's manifest says the ledger had reached, if it says. */
  manifestHead?: { seq: number; hash?: string | null } | null;
  /** What the operator knows it had reached (`--expect-ledger-head`). */
  expectSeq?: number | null;
  /**
   * Whether the ledger beside the backups was there before the restore began (the restore script looks
   * first: keeping what is there takes a backup, which makes an empty file).
   */
  localLedger?: boolean;
  scratch?: string;
}): Promise<Recovery> {
  const db = getDb();
  const scratch = input.scratch ?? fs.mkdtempSync(path.join(os.tmpdir(), "mysenam-ledger-restore-"));
  const anchorHead = await ledgerHead();
  const anchor = { seq: anchorHead.seq, hash: anchorHead.hash };
  const candidates: Candidate[] = (await ledgerEntries()).map((entry) => ({ entry, source: "the restored database" }));
  const known: KnownHead[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  const sources = ["the restored database"];

  const file = ledgerFile();
  const local = file !== null && fs.existsSync(file) && input.localLedger !== false;
  if (local) {
    sources.push("the ledger beside the backups");
    const chained = readLedgerFile(file).filter(isChainEntry);
    for (const entry of chained) candidates.push({ entry, source: "the ledger beside the backups" });
    const newest = chained.reduce<ChainEntry | null>((n, e) => (!n || e.seq > n.seq ? e : n), null);
    if (newest) known.push({ seq: newest.seq, hash: newest.hash, source: "The ledger beside the backups" });
  }

  let offsiteHead = 0;
  const config = ledgerOffsiteReadConfig();
  if (config) {
    try {
      const fetched = await fetchOffsiteLedger(config, path.join(scratch, "ledger"));
      sources.push(`${fetched.segments} off-site segment(s) (signatures ${fetched.signature})`);
      candidates.push(...fetched.candidates);
      problems.push(...fetched.problems);
      warnings.push(...fetched.warnings);
      offsiteHead = fetched.head;
      if (!local && fetched.signature === "unchecked" && fetched.head > anchor.seq)
        problems.push("The off-site entries after this backup could not be checked against the server's signing key (OFFSITE_SIGNING_PUBLIC_KEY_FILE is not set).");
    } catch (err) {
      problems.push(`The off-site ledger could not be read: ${err instanceof Error ? err.message : String(err)}.`);
    }
    const backups = offsiteReadConfig();
    if (backups)
      try {
        const newest = await newestManifestHead(backups, path.join(scratch, "manifests"));
        if (newest.head) known.push(newest.head);
        if (newest.warning) warnings.push(newest.warning);
      } catch (err) {
        warnings.push(`The newest backup set in the bucket could not be read for the ledger's number: ${err instanceof Error ? err.message : String(err)}.`);
      }
  }
  if (input.manifestHead) known.push({ seq: input.manifestHead.seq, hash: input.manifestHead.hash ?? null, source: "This backup's manifest" });
  if (input.expectSeq) known.push({ seq: input.expectSeq, source: "The operator (--expect-ledger-head)" });

  const chain = assembleChain(anchor, candidates, known);
  problems.push(...chain.problems);
  if (!local)
    problems.push(
      config
        ? `The ledger beside the backups is not here (the server was lost?): entries made after the last off-site copy (entry ${offsiteHead || chain.verified.seq} here) cannot be seen.`
        : "Neither the ledger beside the backups nor an off-site copy of it (OFFSITE_S3_* with the read key) is available here: erasures made after this backup cannot be known."
    );
  const after = chain.entries;
  const shippedThrough = Math.min(offsiteHead, chain.verified.seq);
  const brought = await bringIn(after, shippedThrough);
  if (brought.clashed.length > 0) problems.push(`Entries ${brought.clashed.join(", ")} clash with the restored database's under the same number.`);
  const toApply = after.filter((e) => e.kind === "customer" || e.kind === "participant").length;
  const state: Recovery["state"] = problems.length === 0 ? "complete" : "blocked";
  const detail = [
    `Restored copy's ledger ends at entry ${anchor.seq}; verified to entry ${chain.verified.seq}; newest known ${chain.knownSeq}.`,
    ...(chain.lost.length > 0 ? [`Recorded as lost by an earlier acknowledged recovery: ${chain.lost.map(([a, b]) => `${a}–${b}`).join(", ")}.`] : []),
    ...problems,
  ].join("\n");
  await db
    .prepare(
      "INSERT INTO erasure_ledger_recoveries (backup, state, anchor_seq, verified_seq, known_seq, brought_in, detail) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(path.basename(input.backup), state, anchor.seq, chain.verified.seq, chain.knownSeq, brought.added, detail.slice(0, 4000));
  if (!input.scratch) fs.rmSync(scratch, { recursive: true, force: true });
  return { state, anchor: anchor.seq, verified: chain.verified.seq, knownSeq: chain.knownSeq, broughtIn: brought.added, toApply, problems, warnings, sources };
}

