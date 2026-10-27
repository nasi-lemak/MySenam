import crypto from "crypto";

/**
 * The erasure ledger's chain, as pure functions: no database, no files, no
 * network (lib/erasure-ledger.ts records entries; lib/erasure-ledger-offsite.ts
 * copies them off-site and reads them back; ADR 0024).
 *
 * Every entry has a number (`seq`, one more than the entry before it) and
 * the SHA-256 of the entry before it (`prevHash`; the first entry's is
 * `GENESIS`), and its own `hash` covers its number, what it says and that
 * previous hash. So an entry changed, removed or slipped in breaks the chain
 * wherever it is checked, and a number missing is a gap. A chain is not a
 * signature: anybody can compute SHA-256. What says the server made a
 * segment of it is the segment's Ed25519 signature; what the chain adds is
 * order and completeness from a trusted starting point (the restored
 * database's own newest entry).
 *
 * An entry holds an account's or participant's number and the moment it was
 * created, a change of the install's retention periods, or an acknowledged
 * recovery that lost entries: never a name, email or phone.
 */

export const GENESIS = "0".repeat(64);

export type LedgerKind = "customer" | "participant" | "retention_policy" | "recovery";
const KINDS: readonly LedgerKind[] = ["customer", "participant", "retention_policy", "recovery"];

export interface ChainEntry {
  seq: number;
  id: string;
  kind: LedgerKind;
  subjectId: number | null;
  subjectCreatedAt: string | null;
  erasedAt: string;
  /** A retention_policy entry's periods, or a recovery entry's lost range, as JSON. */
  detail: string | null;
  prevHash: string;
  hash: string;
}

export type EntryFields = Omit<ChainEntry, "prevHash" | "hash">;

/** The entry's hash: SHA-256 over the previous hash and the entry's fields, in a fixed order. */
export function entryHash(prevHash: string, e: EntryFields): string {
  const fields = JSON.stringify([e.seq, e.id, e.kind, e.subjectId, e.subjectCreatedAt, e.erasedAt, e.detail]);
  return crypto.createHash("sha256").update(`${prevHash}\n${fields}`).digest("hex");
}

/** The next entry after `prev` (the chain's newest entry, or `{ seq: 0, hash: GENESIS }`). */
export function nextEntry(prev: { seq: number; hash: string }, fields: Omit<EntryFields, "seq">, seq = prev.seq + 1): ChainEntry {
  const e: EntryFields = { ...fields, seq };
  return { ...e, prevHash: prev.hash, hash: entryHash(prev.hash, e) };
}

const HEX = /^[0-9a-f]{64}$/;

/** Is this, read from a file or a segment, shaped as a chained entry? (Not whether it fits the chain.) */
export function isChainEntry(x: unknown): x is ChainEntry {
  const e = x as Partial<ChainEntry> | null;
  return (
    !!e &&
    Number.isSafeInteger(e.seq) &&
    (e.seq as number) > 0 &&
    typeof e.id === "string" &&
    KINDS.includes(e.kind as LedgerKind) &&
    (e.subjectId === null || Number.isSafeInteger(e.subjectId)) &&
    (e.subjectCreatedAt === null || typeof e.subjectCreatedAt === "string") &&
    typeof e.erasedAt === "string" &&
    (e.detail === null || typeof e.detail === "string") &&
    typeof e.prevHash === "string" &&
    HEX.test(e.prevHash) &&
    typeof e.hash === "string" &&
    HEX.test(e.hash)
  );
}

/** Does the entry's hash cover what it says? */
export function selfConsistent(e: ChainEntry): boolean {
  return entryHash(e.prevHash, e) === e.hash;
}

/** The numbers an acknowledged recovery entry says were lost: `[from, to]`, or null. */
export function lostRange(e: ChainEntry): [number, number] | null {
  if (e.kind !== "recovery" || !e.detail) return null;
  try {
    const d = JSON.parse(e.detail) as { lostFrom?: unknown; lostTo?: unknown };
    const from = Number(d.lostFrom);
    const to = Number(d.lostTo);
    return Number.isSafeInteger(from) && Number.isSafeInteger(to) && from >= 1 && to >= from && to === e.seq - 1 ? [from, to] : null;
  } catch {
    return null;
  }
}

export interface KnownHead {
  seq: number;
  /** The entry's hash at that number, where the source says it. */
  hash?: string | null;
  /** Where this number comes from (a manifest, the file beside the backups, the operator). */
  source: string;
}

export interface Candidate {
  entry: ChainEntry;
  /** Where it was read: the restored database, the file beside the backups, an off-site segment. */
  source: string;
}

export interface ChainReport {
  /** Where the trusted part ends: the restored database's newest entry. */
  anchor: { seq: number; hash: string };
  /** How far an unbroken chain reaches from the anchor, and its newest hash. */
  verified: { seq: number; hash: string };
  /** The entries after the anchor, in order, up to `verified`. */
  entries: ChainEntry[];
  /** Ranges of numbers an acknowledged recovery said were lost, crossed on the way. */
  lost: [number, number][];
  /** Entries found beyond a gap or a broken link: not applied. */
  stranded: number[];
  /** The newest number known from anywhere. */
  knownSeq: number;
  /** Everything that keeps the chain from being shown whole: numbers only. */
  problems: string[];
  complete: boolean;
}

/**
 * Put a chain together from what every source holds, starting from the
 * anchor, and say whether it is whole. An entry whose hash does not cover
 * what it says is refused; two different entries under one number are a
 * conflict; the chain runs while each entry follows the one before it (or an
 * acknowledged recovery entry says which numbers were lost); and it must
 * reach every number another source says the ledger had reached.
 */
export function assembleChain(anchor: { seq: number; hash: string }, candidates: Candidate[], knownHeads: KnownHead[]): ChainReport {
  const problems: string[] = [];
  const bySeq = new Map<number, Candidate>();
  const conflicted = new Set<number>();
  for (const c of candidates) {
    if (!selfConsistent(c.entry)) {
      problems.push(`Entry ${c.entry.seq} from ${c.source} does not match its own hash: it was changed after it was made.`);
      continue;
    }
    const there = bySeq.get(c.entry.seq);
    if (!there) bySeq.set(c.entry.seq, c);
    else if (there.entry.hash !== c.entry.hash) {
      conflicted.add(c.entry.seq);
      problems.push(`Two different entries are numbered ${c.entry.seq} (${there.source}; ${c.source}).`);
    }
  }
  const entries: ChainEntry[] = [];
  const lost: [number, number][] = [];
  let cur = { ...anchor };
  const fromAnchor = bySeq.get(anchor.seq);
  if (anchor.seq > 0 && fromAnchor && fromAnchor.entry.hash !== anchor.hash && !conflicted.has(anchor.seq)) {
    conflicted.add(anchor.seq);
    problems.push(`Entry ${anchor.seq} from ${fromAnchor.source} differs from the restored database's.`);
  }
  for (;;) {
    const next = bySeq.get(cur.seq + 1);
    if (next && !conflicted.has(next.entry.seq)) {
      if (next.entry.prevHash !== cur.hash) {
        problems.push(`Entry ${next.entry.seq} (${next.source}) does not follow entry ${cur.seq}: the chain is broken there.`);
        break;
      }
      entries.push(next.entry);
      cur = { seq: next.entry.seq, hash: next.entry.hash };
      continue;
    }
    // A recovery acknowledged before: it says which numbers were lost, and follows the last entry kept.
    const jump = [...bySeq.values()].find(
      (c) => c.entry.seq > cur.seq + 1 && !conflicted.has(c.entry.seq) && c.entry.prevHash === cur.hash && lostRange(c.entry)?.[0] === cur.seq + 1
    );
    if (!jump) break;
    lost.push(lostRange(jump.entry)!);
    entries.push(jump.entry);
    cur = { seq: jump.entry.seq, hash: jump.entry.hash };
  }
  const stranded = [...bySeq.keys()].filter((s) => s > cur.seq).sort((a, b) => a - b);
  if (stranded.length > 0)
    problems.push(
      `Entries ${stranded[0]}${stranded.length > 1 ? `–${stranded.at(-1)}` : ""} were found, but the chain stops at ${cur.seq}: ${
        bySeq.has(cur.seq + 1) ? "the next entry does not follow" : `entry ${cur.seq + 1} is missing`
      }.`
    );
  const inLost = (seq: number) => lost.some(([a, b]) => seq >= a && seq <= b);
  const hashAt = (seq: number) => (seq === anchor.seq ? anchor.hash : seq === cur.seq ? cur.hash : entries.find((e) => e.seq === seq)?.hash ?? bySeq.get(seq)?.entry.hash);
  let knownSeq = Math.max(cur.seq, ...stranded);
  for (const k of knownHeads) {
    knownSeq = Math.max(knownSeq, k.seq);
    if (k.seq > cur.seq && !inLost(k.seq)) problems.push(`${k.source} says the ledger had reached entry ${k.seq}; the verified ledger reaches ${cur.seq}.`);
    else if (k.hash && k.seq > 0 && !inLost(k.seq)) {
      const ours = hashAt(k.seq);
      if (ours && ours !== k.hash) problems.push(`${k.source} names a different entry ${k.seq} from the ledger's.`);
    }
  }
  return { anchor, verified: cur, entries, lost, stranded, knownSeq, problems, complete: problems.length === 0 };
}
