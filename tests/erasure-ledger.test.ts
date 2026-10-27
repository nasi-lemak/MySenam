import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "mysenam-ledger-"));
process.env.MYSENAM_BACKUP_DIR = path.join(work, "backups");

import { registerUser } from "../src/lib/auth";
import { signBytes, signatureValid } from "../src/lib/backup-crypto";
import { getDb } from "../src/lib/db";
import { GENESIS, assembleChain, entryHash, nextEntry, type ChainEntry } from "../src/lib/erasure-chain";
import {
  acknowledgeRecovery,
  ledgerEntries,
  ledgerHead,
  readLedgerFile,
  reapplyErasures,
  reapplyIfRestored,
  restoreGate,
} from "../src/lib/erasure-ledger";
import { checkLedgerShipping, fetchOffsiteLedger, ledgerOffsiteConfig, ledgerOffsiteReadConfig, ledgerOffsiteStatus, makeSegment, segmentProblem, shipLedger } from "../src/lib/erasure-ledger-offsite";
import { addManaged } from "../src/lib/managed-people";
import { eraseCustomer } from "../src/lib/privacy";
import { createAdmin, type Admin } from "../src/lib/admin-auth";
import { retentionPolicy, setRetentionPolicy } from "../src/lib/retention-policy";
import { startStandin, type Standin } from "./helpers/s3-standin";

/**
 * The erasure ledger as a numbered, hash-chained record, copied off-site in
 * signed segments (lib/erasure-chain.ts, lib/erasure-ledger.ts,
 * lib/erasure-ledger-offsite.ts; docs/operations/backups.md#after-a-restore;
 * ADR 0024). The chain and segment checks are pure; recording, replay and
 * the start-up gate run against the database; copying and reading back run
 * against a stand-in bucket with an upload-only key and a separate read key.
 * The whole restore, with the real scripts, is tests/erasure-ledger-restore.test.ts.
 */

afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

const entry = (prev: { seq: number; hash: string }, n: number): ChainEntry =>
  nextEntry(prev, { id: `e${n}`, kind: "customer", subjectId: 100 + n, subjectCreatedAt: `2026-10-0${(n % 9) + 1} 10:00:00`, erasedAt: new Date(Date.UTC(2026, 9, 20, n)).toISOString(), detail: null });

function chainOf(n: number, from = { seq: 0, hash: GENESIS }): ChainEntry[] {
  const out: ChainEntry[] = [];
  let prev = from;
  for (let i = 1; i <= n; i++) {
    const e = entry(prev, prev.seq + 1);
    out.push(e);
    prev = { seq: e.seq, hash: e.hash };
  }
  return out;
}

const from = (source: string) => (e: ChainEntry) => ({ entry: e, source });

describe("the chain", () => {
  const five = chainOf(5);
  const anchor = { seq: 2, hash: five[1].hash };

  it("runs from the restored copy's newest entry to the newest entry any source has, and reads the same entry from two sources once", () => {
    const report = assembleChain(anchor, [...five.map(from("a segment")), ...five.slice(3).map(from("the file"))], [{ seq: 5, hash: five[4].hash, source: "a manifest" }]);
    expect(report).toMatchObject({ complete: true, verified: { seq: 5, hash: five[4].hash }, stranded: [], problems: [] });
    expect(report.entries.map((e) => e.seq)).toEqual([3, 4, 5]);
    // Replayed again from the same sources: the same answer.
    expect(assembleChain(anchor, [...five, ...five].map(from("again")), [])).toMatchObject({ complete: true, verified: { seq: 5 } });
  });

  it("refuses an entry changed after it was made, and stops there", () => {
    const changed = { ...five[3], subjectId: 999 };
    const report = assembleChain(anchor, [five[2], changed, five[4]].map(from("segment X")), []);
    expect(report.complete).toBe(false);
    expect(report.verified.seq).toBe(3);
    expect(report.problems.join("\n")).toMatch(/Entry 4 from segment X does not match its own hash/);
    expect(report.stranded).toEqual([5]);
  });

  it("finds a missing entry (a gap) and an entry slipped in with its own hash but not following the one before", () => {
    const gap = assembleChain(anchor, [five[2], five[4]].map(from("s")), []);
    expect(gap).toMatchObject({ complete: false, verified: { seq: 3 }, stranded: [5] });
    expect(gap.problems.join("\n")).toContain("entry 4 is missing");
    // Forged: a well-formed entry 4 that does not follow entry 3.
    const forged = nextEntry({ seq: 3, hash: "f".repeat(64) }, { id: "x", kind: "customer", subjectId: 1, subjectCreatedAt: "x", erasedAt: new Date().toISOString(), detail: null });
    const broken = assembleChain(anchor, [five[2], forged].map(from("s")), []);
    expect(broken.problems.join("\n")).toMatch(/Entry 4 \(s\) does not follow entry 3: the chain is broken/);
    expect(broken.verified.seq).toBe(3);
  });

  it("calls two different entries under one number a conflict, and a newer number named elsewhere incomplete", () => {
    const other = chainOf(5).map((e, i) => (i === 3 ? nextEntry({ seq: 3, hash: five[2].hash }, { ...e, id: "other", subjectId: 7 }) : e));
    const conflict = assembleChain(anchor, [...five.map(from("file")), from("segment")(other[3])], []);
    expect(conflict.problems.join("\n")).toMatch(/Two different entries are numbered 4/);
    expect(conflict.verified.seq).toBe(3);
    const behind = assembleChain(anchor, five.slice(0, 4).map(from("s")), [{ seq: 5, source: "The newest backup set in the bucket (x)" }]);
    expect(behind).toMatchObject({ complete: false, verified: { seq: 4 }, knownSeq: 5 });
    expect(behind.problems.join("\n")).toContain("The newest backup set in the bucket (x) says the ledger had reached entry 5; the verified ledger reaches 4.");
    const otherHash = assembleChain(anchor, five.map(from("s")), [{ seq: 4, hash: "a".repeat(64), source: "A manifest" }]);
    expect(otherHash.problems.join("\n")).toContain("A manifest names a different entry 4");
  });

  it("crosses numbers an acknowledged recovery recorded as lost, and no further", () => {
    const three = chainOf(3);
    const recovery = nextEntry({ seq: 3, hash: three[2].hash }, { id: "r", kind: "recovery", subjectId: null, subjectCreatedAt: null, erasedAt: new Date().toISOString(), detail: JSON.stringify({ lostFrom: 4, lostTo: 6 }) }, 7);
    const after = entry({ seq: 7, hash: recovery.hash }, 8);
    const report = assembleChain({ seq: 1, hash: three[0].hash }, [...three, recovery, after].map(from("s")), [{ seq: 5, source: "An old manifest" }]);
    expect(report).toMatchObject({ complete: true, verified: { seq: 8 }, lost: [[4, 6]] });
    // A recovery entry claiming a range that does not start after the last entry kept is not a way across.
    const bad = nextEntry({ seq: 3, hash: three[2].hash }, { id: "r2", kind: "recovery", subjectId: null, subjectCreatedAt: null, erasedAt: new Date().toISOString(), detail: JSON.stringify({ lostFrom: 5, lostTo: 6 }) }, 7);
    expect(assembleChain({ seq: 3, hash: three[2].hash }, [bad].map(from("s")), []).verified.seq).toBe(3);
  });

  it("hashes over the previous hash and every field, so no field can change unseen", () => {
    const e = five[0];
    for (const change of [{ seq: 9 }, { id: "y" }, { kind: "participant" as const }, { subjectId: 1 }, { subjectCreatedAt: "z" }, { erasedAt: "2020-01-01T00:00:00.000Z" }, { detail: "{}" }])
      expect(entryHash(e.prevHash, { ...e, ...change }), JSON.stringify(change)).not.toBe(e.hash);
    expect(entryHash("1".repeat(64), e)).not.toBe(e.hash);
  });
});

describe("segments", () => {
  it("hold together, and are refused when an entry in them is changed, reordered or does not follow", () => {
    const chain = chainOf(4);
    const segment = makeSegment(chain.slice(1));
    expect(segment).toMatchObject({ firstSeq: 2, lastSeq: 4, prevHash: chain[0].hash, headHash: chain[3].hash });
    expect(segmentProblem(segment)).toBeNull();
    expect(segmentProblem({ ...segment, entries: [segment.entries[0], { ...segment.entries[1], subjectId: 5 }, segment.entries[2]] })).toMatch(/does not match its own hash/);
    expect(segmentProblem({ ...segment, entries: [segment.entries[1], segment.entries[0], segment.entries[2]] })).toMatch(/not the numbers it names/);
    expect(segmentProblem({ ...segment, headHash: "0".repeat(64) })).toMatch(/not the hashes it names/);
    expect(segmentProblem({ format: "other" })).toMatch(/not an erasure-ledger segment/);
  });

  it("are signed with the backup-signing key: another key's signature, or a changed byte, does not verify", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const priv = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const pub = publicKey.export({ type: "spki", format: "pem" }) as string;
    const bytes = Buffer.from(JSON.stringify(makeSegment(chainOf(2))));
    const sig = signBytes(bytes, priv);
    expect(signatureValid(bytes, sig, pub)).toBe(true);
    const changed = Buffer.from(bytes);
    changed[10] ^= 1;
    expect(signatureValid(changed, sig, pub)).toBe(false);
    const other = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    expect(signatureValid(bytes, signBytes(bytes, other), pub)).toBe(false);
  });
});

async function customer(tag: string) {
  const made = await registerUser({ name: `Ledger ${tag}`, email: `${tag}@ledger.test`, phone: `0177${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

/** What a restore of an earlier copy brings back: the rows exactly as they were, to the microsecond (kept in a table aside). */
let snapshots = 0;
async function snapshotRows(table: string, where: string, ...args: unknown[]) {
  const aside = `ledger_snapshot_${++snapshots}`;
  await getDb().prepare(`CREATE TABLE ${aside} AS SELECT * FROM ${table} WHERE ${where}`).run(...args);
  return { table, aside, rows: (await getDb().prepare(`SELECT * FROM ${aside}`).all()) as Record<string, unknown>[] };
}
async function putBack(snapshot: { table: string; aside: string }) {
  await getDb().prepare(`INSERT INTO ${snapshot.table} SELECT * FROM ${snapshot.aside}`).run();
}

describe("recording, and applying again", () => {
  let owner: Admin;
  beforeAll(async () => {
    const made = await createAdmin({ name: "Ledger Owner", email: "owner@ledger.test", password: "a long enough password", venueId: null });
    if (!made.ok) throw new Error(made.error);
    owner = made.admin;
  });

  it("numbers and chains every erasure, with the participant erased with an account, copies them beside the backups, and refuses to change one", async () => {
    const before = await ledgerHead();
    const parent = await customer("parent");
    const added = await addManaged(parent.id, { displayName: "Kid Ledger", relationship: "parent", authority: true });
    if (!added.ok) throw new Error(added.error);
    expect((await eraseCustomer(parent.id)).ok).toBe(true);
    const entries = await ledgerEntries(before.seq);
    expect(entries.map((e) => e.kind)).toEqual(["participant", "customer"]);
    expect(entries.map((e) => e.seq)).toEqual([before.seq + 1, before.seq + 2]);
    expect(entries[0].prevHash).toBe(before.hash);
    expect(entries[1].prevHash).toBe(entries[0].hash);
    expect(await ledgerHead()).toMatchObject({ seq: before.seq + 2, hash: entries[1].hash });
    // Numbers and moments only.
    expect(JSON.stringify(entries)).not.toMatch(/Ledger parent|Kid Ledger|@ledger\.test/);
    // Both beside the backups, as the database has them.
    const file = readLedgerFile();
    expect(file.filter((e) => entries.some((x) => x.id === e.id))).toEqual(entries);
    // Recorded is recorded.
    await expect(getDb().prepare("UPDATE erasure_ledger SET subject_id = subject_id + 1000 WHERE id = ?").run(entries[1].id)).rejects.toThrow(/cannot be changed/);
  });

  it("applies every erasure again to what came back with the same creation moment, puts back the newest periods, and does it once", async () => {
    const leaving = await customer("leaving");
    const added = await addManaged(leaving.id, { displayName: "Leaving Kid", relationship: "parent", authority: true });
    if (!added.ok) throw new Error(added.error);
    // What a backup taken now holds.
    const user = await snapshotRows("users", "id = ?", leaving.id);
    const participant = await snapshotRows("participants", "id = ?", added.person.id);
    const guardian = await snapshotRows("participant_guardians", "participant_id = ?", added.person.id);
    const periods = await snapshotRows("retention_policy", "id = 1");
    // After it: the account closed, the periods shortened.
    expect((await eraseCustomer(leaving.id)).ok).toBe(true);
    expect((await setRetentionPolicy(owner, { documentDays: 60, reviewDays: 20 })).ok).toBe(true);
    expect((await ledgerEntries()).at(-1)).toMatchObject({ kind: "retention_policy", detail: JSON.stringify({ documentDays: 60, reviewDays: 20, recordDays: 365, quarantineDays: 7 }) });
    // The restore: the account, its participant and the older periods are back.
    await putBack(user);
    await putBack(participant);
    await putBack(guardian);
    await getDb().prepare("UPDATE retention_policy SET approval_document_days = ?, approval_review_days = ? WHERE id = 1").run(periods.rows[0].approval_document_days, periods.rows[0].approval_review_days);
    expect((await retentionPolicy()).documentDays).toBe(90);
    const first = await reapplyErasures();
    expect(first).toMatchObject({ erasedAgain: 2, refused: [], policyRestored: true });
    expect(await getDb().prepare("SELECT 1 FROM users WHERE id = ?").get(leaving.id)).toBeUndefined();
    expect(await getDb().prepare("SELECT 1 FROM participants WHERE id = ?").get(added.person.id)).toBeUndefined();
    expect(await retentionPolicy()).toMatchObject({ documentDays: 60, reviewDays: 20, provisional: true });
    // Idempotent: nothing more to do, and no second entry for the same erasure.
    const count = (await ledgerEntries()).length;
    expect(await reapplyErasures()).toMatchObject({ erasedAgain: 0, refused: [], policyRestored: false });
    expect((await ledgerEntries()).length).toBe(count);
    // A later account that happens to take the same number is never touched.
    await getDb().prepare("INSERT INTO users (id, name, email, phone, password_hash, created_at) VALUES (?, 'Someone Else', 'else@ledger.test', '0179990000', 'x', '2031-01-01 00:00:00')").run(leaving.id);
    expect(await reapplyErasures()).toMatchObject({ erasedAgain: 0 });
    expect(await getDb().prepare("SELECT 1 FROM users WHERE id = ?").get(leaving.id)).toBeTruthy();
  });

  it("keeps the app from serving until a restore's erasures are applied again, and while a restore that lost entries is not acknowledged", async () => {
    const db = getDb();
    expect(await restoreGate()).toBeNull();
    await db.prepare("INSERT INTO settings (key, value) VALUES ('restore_reapply_due', 'x.tar.gz') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run();
    expect(await restoreGate()).toMatch(/have not been applied again yet/);
    // Start-up: when applying them again fails, the mark stays and the app exits rather than serve (src/instrumentation-node.ts).
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const { startNode } = await import("../src/instrumentation-node");
    try {
      await db.prepare("ALTER TABLE retention_policy RENAME TO retention_policy_gone").run();
      expect(await reapplyIfRestored()).toBeNull();
      expect(await restoreGate()).toMatch(/have not been applied again yet/);
      await expect(startNode()).rejects.toThrow("exit 78");
      await db.prepare("ALTER TABLE retention_policy_gone RENAME TO retention_policy").run();
      // Applied: the mark goes, and with it the gate.
      expect(await reapplyIfRestored()).not.toBeNull();
      expect(await restoreGate()).toBeNull();

      // A restore that could not show the ledger complete, and knew it had reached further.
      const head = await ledgerHead();
      await db
        .prepare("INSERT INTO erasure_ledger_recoveries (backup, state, anchor_seq, verified_seq, known_seq, detail) VALUES ('old.tar.gz', 'blocked', ?, ?, ?, 'test')")
        .run(head.seq, head.seq, head.seq + 2);
      expect(await restoreGate()).toMatch(/could not show the erasure ledger complete[\s\S]*--acknowledge-ledger/);
      await expect(startNode()).rejects.toThrow("exit 78");
      expect(await acknowledgeRecovery("ok", "ops")).toMatchObject({ error: expect.stringContaining("at least 10") });
      expect(await acknowledgeRecovery("Checked the alerts and the closure requests: none since.", "ops")).toEqual({ recoveries: 1, lost: [head.seq + 1, head.seq + 2] });
      expect(await restoreGate()).toBeNull();
      // The lost numbers are not taken again: a recovery entry after them, and the next erasure after that.
      const recovery = (await ledgerEntries(head.seq))[0];
      expect(recovery).toMatchObject({ kind: "recovery", seq: head.seq + 3, prevHash: head.hash });
      expect(JSON.parse(recovery.detail!)).toMatchObject({ lostFrom: head.seq + 1, lostTo: head.seq + 2 });
      const next = await customer("after");
      expect((await eraseCustomer(next.id)).ok).toBe(true);
      expect((await ledgerHead()).seq).toBe(head.seq + 4);
      expect(assembleChain({ seq: head.seq, hash: head.hash }, (await ledgerEntries(head.seq)).map(from("db")), []).verified.seq).toBe(head.seq + 4);
      expect(await acknowledgeRecovery("Nothing waiting to be acknowledged now.", "ops")).toMatchObject({ error: expect.stringContaining("No restore") });
    } finally {
      exit.mockRestore();
    }
  });
});

describe("off-site, through a stand-in bucket", () => {
  let bucket: Standin;
  let keys: { signPriv: string; signPub: string; encPub: string; encPriv: string };
  beforeAll(async () => {
    bucket = await startStandin({
      upload: { secret: "u", capabilities: ["writeFiles"], bucket: "backups", prefix: "venue/" },
      read: { secret: "r", capabilities: ["listFiles", "readFiles"], bucket: "backups", prefix: "venue/" },
      ledgerUpload: { secret: "lu", capabilities: ["writeFiles"], bucket: "ledger", prefix: "venue/" },
      ledgerRead: { secret: "lr", capabilities: ["listFiles", "readFiles"], bucket: "ledger", prefix: "venue/" },
    });
    const sign = crypto.generateKeyPairSync("ed25519");
    const enc = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const write = (name: string, pem: string) => {
      fs.writeFileSync(path.join(work, name), pem);
      return path.join(work, name);
    };
    keys = {
      signPriv: write("sign.pem", sign.privateKey.export({ type: "pkcs8", format: "pem" }) as string),
      signPub: write("sign-pub.pem", sign.publicKey.export({ type: "spki", format: "pem" }) as string),
      encPub: write("enc-pub.pem", enc.publicKey.export({ type: "spki", format: "pem" }) as string),
      encPriv: write("enc.pem", enc.privateKey.export({ type: "pkcs8", format: "pem" }) as string),
    };
  });
  afterAll(() => bucket.close());
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("OFFSITE_")) delete process.env[k];
  });

  function asServer(more: Record<string, string> = {}) {
    Object.assign(process.env, {
      OFFSITE_S3_ENDPOINT: bucket.endpoint,
      OFFSITE_S3_BUCKET: "backups",
      OFFSITE_S3_REGION: bucket.region,
      OFFSITE_S3_PREFIX: "venue/",
      OFFSITE_S3_ACCESS_KEY_ID: "upload",
      OFFSITE_S3_SECRET_ACCESS_KEY: "u",
      OFFSITE_DATA_LOCATION: "US",
      OFFSITE_TRANSFER_APPROVED: "US",
      OFFSITE_ENCRYPTION_PUBLIC_KEY_FILE: keys.encPub,
      OFFSITE_SIGNING_KEY_FILE: keys.signPriv,
      ...more,
    });
  }
  function asRestoreMachine(more: Record<string, string> = {}) {
    for (const k of Object.keys(process.env)) if (k.startsWith("OFFSITE_")) delete process.env[k];
    Object.assign(process.env, {
      OFFSITE_S3_ENDPOINT: bucket.endpoint,
      OFFSITE_S3_BUCKET: "backups",
      OFFSITE_S3_REGION: bucket.region,
      OFFSITE_S3_PREFIX: "venue/",
      OFFSITE_S3_READ_ACCESS_KEY_ID: "read",
      OFFSITE_S3_READ_SECRET_ACCESS_KEY: "r",
      OFFSITE_ENCRYPTION_PRIVATE_KEY_FILE: keys.encPriv,
      OFFSITE_SIGNING_PUBLIC_KEY_FILE: keys.signPub,
      ...more,
    });
  }

  it("copies the entries not yet off-site as one signed, encrypted segment with the upload key alone, and nothing twice", async () => {
    asServer();
    expect(ledgerOffsiteConfig()).toMatchObject({ bucket: "backups", prefix: "venue/erasure-ledger/" });
    const head = await ledgerHead();
    expect(head.seq).toBeGreaterThan(head.shippedSeq);
    const waiting = (await ledgerEntries(head.shippedSeq)).length;
    const sent = await shipLedger();
    expect(sent).toMatchObject({ ok: true, shipped: waiting });
    expect(bucket.log.every((r) => r.key === "upload" && r.method === "PUT")).toBe(true);
    const names = [...bucket.versions.keys()];
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^backups\/venue\/erasure-ledger\/ledger-\d{12}-\d{12}-\d{8}T\d{6}Z\.json\.sig$/);
    expect(names[1]).toMatch(/\.json\.enc$/);
    // Ciphertext: no account number or JSON visible to the provider.
    expect(bucket.versions.get(names[1])![0].toString("latin1")).not.toContain("subjectId");
    expect(await ledgerOffsiteStatus()).toMatchObject({ configured: true, headSeq: head.seq, shippedSeq: head.seq, lastError: null, lastShipped: { encrypted: true, signed: true } });
    expect(await shipLedger()).toEqual({ ok: true, shipped: 0 });
    expect(bucket.versions.size).toBe(2);
    // The next erasure is its own segment, following on.
    const next = await customer("shipped");
    expect((await eraseCustomer(next.id)).ok).toBe(true);
    await vi.waitFor(async () => expect((await ledgerHead()).shippedSeq).toBe((await ledgerHead()).seq), { timeout: 5000 });
    expect(bucket.versions.size).toBe(4);
  });

  it("is read back with the read key, the signing public key and the private key alone, every segment checked", async () => {
    asRestoreMachine();
    const fetched = await fetchOffsiteLedger(ledgerOffsiteReadConfig()!, path.join(work, "read-1"));
    expect(fetched).toMatchObject({ segments: 2, problems: [], signature: "verified", head: (await ledgerHead()).seq });
    const report = assembleChain({ seq: 0, hash: GENESIS }, fetched.candidates, []);
    expect(report).toMatchObject({ complete: true, verified: { seq: (await ledgerHead()).seq } });
    expect(bucket.log.filter((r) => r.key === "read").every((r) => r.method === "GET")).toBe(true);
  });

  it("refuses a segment written over (first upload used), changed, unsigned or signed by another key, and finds one removed", async () => {
    const segName = [...bucket.versions.keys()].filter((k) => k.includes("erasure-ledger/") && k.endsWith(".enc")).sort()[0];
    const sigName = segName.replace(/\.enc$/, ".sig");
    const original = bucket.versions.get(segName)!;
    // Written over with the upload key: the first upload is still what is read, and the rewrite is reported.
    bucket.versions.set(segName, [...original, Buffer.from("forged")]);
    asRestoreMachine();
    let fetched = await fetchOffsiteLedger(ledgerOffsiteReadConfig()!, path.join(work, "read-2"));
    expect(fetched.problems).toEqual([]);
    expect(fetched.warnings.join("\n")).toMatch(/written again after upload: its first upload was used/);
    // Its only copy changed: refused.
    const changed = Buffer.from(original[0]);
    changed[changed.length - 20] ^= 1;
    bucket.versions.set(segName, [changed]);
    fetched = await fetchOffsiteLedger(ledgerOffsiteReadConfig()!, path.join(work, "read-3"));
    expect(fetched.problems.join("\n")).toMatch(/was refused: The encrypted backup does not check out/);
    bucket.versions.set(segName, original);
    // Its signature gone, or another key's.
    const sig = bucket.versions.get(sigName)!;
    bucket.versions.delete(sigName);
    fetched = await fetchOffsiteLedger(ledgerOffsiteReadConfig()!, path.join(work, "read-4"));
    expect(fetched.problems.join("\n")).toMatch(/has no signature/);
    const other = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    bucket.versions.set(sigName, [Buffer.from(JSON.stringify(signBytes(Buffer.from("something else"), other)))]);
    fetched = await fetchOffsiteLedger(ledgerOffsiteReadConfig()!, path.join(work, "read-5"));
    expect(fetched.problems.join("\n")).toMatch(/not signed by the server's key/);
    bucket.versions.set(sigName, sig);
    // Without the public key: read, but said to be unchecked.
    asRestoreMachine({ OFFSITE_SIGNING_PUBLIC_KEY_FILE: "" });
    fetched = await fetchOffsiteLedger(ledgerOffsiteReadConfig()!, path.join(work, "read-6"));
    expect(fetched).toMatchObject({ signature: "unchecked", problems: [] });
    // The first segment removed: what is left starts after a gap.
    asRestoreMachine();
    bucket.versions.delete(segName);
    fetched = await fetchOffsiteLedger(ledgerOffsiteReadConfig()!, path.join(work, "read-7"));
    const report = assembleChain({ seq: 0, hash: GENESIS }, fetched.candidates, []);
    expect(report.complete).toBe(false);
    expect(report.verified.seq).toBe(0);
    expect(report.problems.join("\n")).toContain("entry 1 is missing");
    bucket.versions.set(segName, original);
  });

  it("goes to a bucket of its own with a key of its own where set, and is paused, noted and told to the owners where the transfer is not allowed", async () => {
    asServer({ OFFSITE_LEDGER_S3_BUCKET: "ledger", OFFSITE_LEDGER_S3_ACCESS_KEY_ID: "ledgerUpload", OFFSITE_LEDGER_S3_SECRET_ACCESS_KEY: "lu" });
    const next = await customer("own-bucket");
    const before = bucket.versions.size;
    expect((await eraseCustomer(next.id)).ok).toBe(true);
    await vi.waitFor(async () => expect((await ledgerHead()).shippedSeq).toBe((await ledgerHead()).seq), { timeout: 5000 });
    const added = [...bucket.versions.keys()].slice(before);
    expect(added.every((k) => k.startsWith("ledger/venue/erasure-ledger/"))).toBe(true);
    asRestoreMachine({ OFFSITE_LEDGER_S3_BUCKET: "ledger", OFFSITE_LEDGER_S3_READ_ACCESS_KEY_ID: "ledgerRead", OFFSITE_LEDGER_S3_READ_SECRET_ACCESS_KEY: "lr" });
    expect((await fetchOffsiteLedger(ledgerOffsiteReadConfig()!, path.join(work, "read-8"))).segments).toBe(1);

    asServer({ OFFSITE_TRANSFER_APPROVED: "" });
    const paused = await customer("paused");
    expect((await eraseCustomer(paused.id)).ok).toBe(true);
    const result = await shipLedger();
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("US") });
    const status = await ledgerOffsiteStatus();
    expect(status.shippedSeq).toBeLessThan(status.headSeq);
    expect(status.lastError?.error).toContain("US");
    const alert = (await getDb().prepare("SELECT subject, last_detail FROM system_alerts WHERE key = 'erasure-ledger-offsite'").get()) as { subject: string; last_detail: string };
    expect(alert.subject).toBe("The erasure ledger could not be copied off-site");
    expect(alert.last_detail).toContain(`The newest erasure-ledger entry is number ${status.headSeq}; the off-site copy reaches number ${status.shippedSeq}.`);
    // The hourly check: not yet an hour old, nothing said; past it, the owners are told, with the numbers.
    expect(await checkLedgerShipping()).toBe(false);
    expect(await checkLedgerShipping(Date.now() + 2 * 3_600_000)).toBe(true);
    const behind = (await getDb().prepare("SELECT subject, last_detail FROM system_alerts WHERE key = 'erasure-ledger-offsite'").get()) as { subject: string; last_detail: string };
    expect(behind.subject).toBe("The erasure ledger is behind off-site");
    expect(behind.last_detail).toContain(`entry ${status.shippedSeq + 1} has waited more than 60 minutes`);
  });
});
