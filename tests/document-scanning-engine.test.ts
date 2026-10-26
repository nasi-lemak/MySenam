import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { uploaded } from "../src/lib/approval-documents";
import { apply, openDocument, requestById, saveRequirement } from "../src/lib/approvals";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { ClamdScanner, parseClamdAddress, setDocumentScanner } from "../src/lib/document-scanner";
import { scanDocument } from "../src/lib/document-scanning";
import { createResources } from "../src/lib/resources";
import { createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * The real engine: ClamAV's clamd, over its TCP `INSTREAM` protocol, with the
 * EICAR test file (a recognised, harmless test string; never real malware).
 *
 * Where clamd runs. `MYSENAM_TEST_CLAMD=host:port` names one already running
 * (with whatever signatures it has: the official ones detect EICAR as
 * `Eicar-Signature` or `Win.Test.EICAR_HDB-1`). Otherwise, where the `clamd`
 * binary is installed (`apt-get install clamav-daemon`), the test starts its
 * own on a free local port with a **locally generated test signature
 * database** holding one signature, for the EICAR string, so it needs no
 * download: this proves the engine, the protocol and the lifecycle, not the
 * official signatures or their updates (freshclam), which only a deployment
 * can. Where neither is available the tests are skipped, and say why.
 */

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const PDF = Buffer.from(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "latin1"
);
const EICAR_PDF = Buffer.concat([PDF.subarray(0, 9), Buffer.from(`% ${EICAR}\n`, "latin1"), PDF.subarray(9)]);
/** The stream limit given to a clamd this test starts: anything larger is refused by clamd itself. */
const STREAM_MAX = 1024 * 1024;

function onPath(binary: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).concat(["/usr/sbin", "/usr/local/sbin"])) {
    const full = path.join(dir, binary);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      // not here
    }
  }
  return null;
}

const given = process.env.MYSENAM_TEST_CLAMD?.trim() ? parseClamdAddress(process.env.MYSENAM_TEST_CLAMD) : null;
const binary = given ? null : onPath("clamd");
const why = given ? null : binary ? null : "no clamd reachable: set MYSENAM_TEST_CLAMD=host:port, or install clamav-daemon so the test can start one";
if (why) console.info(`[document-scanning-engine] skipped: ${why}`);

let host = "127.0.0.1";
let port = 0;
let child: ChildProcess | null = null;
let work: string | null = null;
/** Started here, with the local test signature: what it reports and detects is known. */
const own = !given;

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const p = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return p;
}

async function waitForPong(scanner: ClamdScanner, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await scanner.status()).reachable) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

let n = 0;
async function customer() {
  const made = await registerUser({ name: `Engine ${++n}`, email: `engine${n}@clamd.test`, phone: `0177${String(n).padStart(6, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now') WHERE id = ?").run(made.user.id);
  return made.user;
}
let venueId: number;

describe.skipIf(why !== null)("clamd, the real engine", () => {
  beforeAll(async () => {
    if (given) {
      host = given.host;
      port = given.port;
    } else {
      work = fs.mkdtempSync(path.join(os.tmpdir(), "mysenam-clamd-"));
      fs.mkdirSync(path.join(work, "db"));
      // One signature, made here: the EICAR string, anywhere in what is scanned. No download.
      fs.writeFileSync(path.join(work, "db", "mysenam-test.ndb"), `MySenam.Test.EICAR:0:*:${Buffer.from(EICAR).toString("hex")}\n`);
      port = await freePort();
      fs.writeFileSync(
        path.join(work, "clamd.conf"),
        [
          `DatabaseDirectory ${path.join(work, "db")}`,
          `TCPSocket ${port}`,
          "TCPAddr 127.0.0.1",
          "Foreground yes",
          `LogFile ${path.join(work, "clamd.log")}`,
          `StreamMaxLength ${STREAM_MAX}`,
          "",
        ].join("\n")
      );
      child = spawn(binary!, ["--config-file", path.join(work, "clamd.conf")], { stdio: "ignore" });
    }
    const ready = await waitForPong(new ClamdScanner(host, port), 60_000);
    if (!ready) throw new Error(`clamd did not answer on ${host}:${port}`);
    setDocumentScanner(new ClamdScanner(host, port));

    const v = await createVenue({ name: "Engine Pool", area: "Puchong", address: "x", phone: "0312349501", openMin: 7 * 60, closeMin: 23 * 60 });
    if (!v.ok) throw new Error("venue");
    venueId = v.venue.id;
    const r = await createResources({ venueId, sport: "kayak", name: "Dive pool", offPeakRate: 30, peakRate: 30, capacity: 10 });
    if (!r.ok) throw new Error(r.error);
    const saved = await saveRequirement(venueId, {
      sport: "kayak",
      kind: "certification",
      documentLabel: "Your diving certification card",
      documentPurpose: "Diving here needs proof of an open-water certification.",
      declaration: "The certification I send is my own and in force.",
      validDays: 365,
    });
    if (!saved.ok) throw new Error(saved.error);
  }, 90_000);

  afterAll(async () => {
    setDocumentScanner(null);
    if (child) {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
    }
    if (work) fs.rmSync(work, { recursive: true, force: true });
  });

  const applyWith = async (bytes: Buffer) => {
    const me = await customer();
    const made = await apply(
      me,
      { venueId, sport: "kayak", declaration: true, adult: true, certReference: "PADI 12345, PADI", certExpiresOn: addDays(todayISO(), 300) },
      [uploaded(Buffer.from(bytes), "card.pdf", "application/pdf")]
    );
    if (!made.ok) throw new Error(`${made.code}: ${made.error}`);
    return { me, request: made.request };
  };

  it("answers, and says which engine and signatures it runs", async () => {
    const status = await new ClamdScanner(host, port).status();
    expect(status.reachable).toBe(true);
    expect(status.engine).toMatch(/^ClamAV \d+\.\d+/);
    // A database made here has no build date; the official one does.
    if (own) expect(status.signaturesAt).toBeNull();
  });

  it("passes a plain PDF through the whole lifecycle: stored in quarantine, scanned, released", async () => {
    const { me, request } = await applyWith(PDF);
    expect(request.documents[0].scan).toBe("clean");
    const opened = await openDocument(request.documents[0].id, { kind: "customer", userId: me.id, name: me.name });
    expect(opened && "content" in opened && opened.content.equals(PDF)).toBe(true);
    const row = (await getDb().prepare("SELECT scan_engine FROM approval_documents WHERE id = ?").get(request.documents[0].id)) as { scan_engine: string };
    expect(row.scan_engine).toMatch(/^ClamAV /);
  });

  it("finds the EICAR test string, on its own and inside a PDF that passed every structural check, and refuses it", async () => {
    const plain = await new ClamdScanner(host, port).scan(Buffer.from(EICAR));
    expect(plain.kind).toBe("found");
    if (plain.kind === "found") expect(plain.finding).toMatch(own ? /^MySenam\.Test\.EICAR/ : /eicar/i);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { me, request } = await applyWith(EICAR_PDF);
    const id = request.documents[0].id;
    expect((await requestById(request.id))!.documents[0].scan).toBe("rejected");
    const row = (await getDb().prepare("SELECT octet_length(content) AS bytes, scan_finding FROM approval_documents WHERE id = ?").get(id)) as { bytes: number; scan_finding: string };
    expect(row.bytes).toBe(0);
    expect(row.scan_finding).toMatch(/eicar/i);
    expect(await openDocument(id, { kind: "customer", userId: me.id, name: me.name })).toEqual({ withheld: "rejected" });
  });

  it.skipIf(!own)("refuses a stream over its own limit, which fails the document at once rather than passing it", async () => {
    const big = Buffer.alloc(STREAM_MAX + 64 * 1024, 0x20);
    const verdict = await new ClamdScanner(host, port).scan(big);
    expect(verdict.kind).toBe("error");
    if (verdict.kind === "error") expect(["too_large", "inconclusive"]).toContain(verdict.error);
  });

  it.skipIf(!own)("when clamd stops, a document waits in quarantine to be tried again, never clean", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    child!.kill("SIGTERM");
    await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    child = null;
    const { request } = await applyWith(PDF);
    const id = request.documents[0].id;
    const row = (await getDb().prepare("SELECT scan_status, scan_attempts, scan_error FROM approval_documents WHERE id = ?").get(id)) as {
      scan_status: string;
      scan_attempts: number;
      scan_error: string;
    };
    expect(row).toMatchObject({ scan_status: "pending", scan_attempts: 1 });
    expect(row.scan_error).toMatch(/^unavailable/);
    expect(await scanDocument(id)).toBe("pending");
  });
});
