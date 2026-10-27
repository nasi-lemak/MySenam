import crypto from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { uploaded } from "../src/lib/approval-documents";
import { apply, saveRequirement } from "../src/lib/approvals";
import { registerUser } from "../src/lib/auth";
import { OnDemandClamd, processAlive, signaturesOnDisk } from "../src/lib/clamd-on-demand";
import { getDb } from "../src/lib/db";
import { ClamdScanner, setDocumentScanner } from "../src/lib/document-scanner";
import { onDemandHooks, scanDocument, scannerHealth, setOnDemandScanner, tickOnDemandScanner } from "../src/lib/document-scanning";
import { createResources } from "../src/lib/resources";
import { createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * The real engine, started on demand: ClamAV's clamd, launched by the app
 * (lib/clamd-on-demand.ts) with ClamAV's **official signatures** when a
 * document waits and no scanner answers, then stopped when idle. It needs the
 * `clamd` binary (`apt-get install clamav-daemon`) and the official
 * signatures in /var/lib/clamav (fetched by freshclam); without either it is
 * skipped and says why. It measures, in this machine, how long clamd takes to
 * answer, how long a document sent while clamd was stopped waits for its clean
 * result, and clamd's peak resident memory: one container's figures, not a
 * Droplet's. The EICAR test file is a recognised, harmless test string.
 */

const DATABASE = "/var/lib/clamav";
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const PDF = Buffer.from(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "latin1"
);

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

const binary = onPath("clamd");
const official = signaturesOnDisk(DATABASE) !== null && ["main.cvd", "main.cld"].some((f) => fs.existsSync(path.join(DATABASE, f)));
const why = !binary ? "clamd is not installed (apt-get install clamav-daemon)" : !official ? `no official signatures in ${DATABASE} (run freshclam)` : null;
if (why) console.info(`[clamd-on-demand-engine] skipped: ${why}`);

let work: string;
let m: OnDemandClamd;
let clock = Date.now();
let venueId: number;

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const p = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return p;
}

describe.skipIf(why !== null)("clamd started on demand, with the official signatures", () => {
  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "mysenam-ondemand-engine-"));
    const port = await freePort();
    // The kit's settings (deploy/digitalocean/setup.sh), on a free port.
    const configFile = path.join(work, "clamd-ondemand.conf");
    fs.writeFileSync(
      configFile,
      [`DatabaseDirectory ${DATABASE}`, `TCPSocket ${port}`, "TCPAddr 127.0.0.1", "ConcurrentDatabaseReload no", "StreamMaxLength 12M", "MaxThreads 2", ""].join("\n")
    );
    m = new OnDemandClamd({
      binary: binary!,
      configFile,
      host: "127.0.0.1",
      port,
      lockDir: path.join(work, "scanner"),
      idleMs: 5 * 60_000,
      startTimeoutMs: 180_000,
      // The real memory guard; freshclam is left out, as another process here may be running it.
      freshclamRunning: () => null,
      now: () => clock,
      ...onDemandHooks(),
      log: () => undefined,
    });
    setDocumentScanner(new ClamdScanner("127.0.0.1", port));
    setOnDemandScanner(m);

    const v = await createVenue({ name: "Engine On Demand", area: "Puchong", address: "x", phone: "0312349503", openMin: 7 * 60, closeMin: 23 * 60 });
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
  });

  afterAll(async () => {
    await m.whenReady();
    await m.stop();
    m.stopNow();
    setOnDemandScanner(null);
    setDocumentScanner(null);
    fs.rmSync(work, { recursive: true, force: true });
  });

  it("starts clamd only when a document waits, scans it clean, refuses the EICAR file, and stops it when idle", { timeout: 240_000 }, async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Nothing waiting: nothing started.
    expect(await tickOnDemandScanner()).toBe("nothing_waiting");

    const made = await registerUser({ name: "Engine On Demand", email: "ondemand-engine@clamd.test", phone: "0179900001", password: "a long enough password" });
    if (!made.ok) throw new Error(made.error);
    await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now') WHERE id = ?").run(made.user.id);
    const arrived = Date.now();
    const applied = await apply(
      made.user,
      { venueId, sport: "kayak", declaration: true, adult: true, certReference: "PADI 12345, PADI", certExpiresOn: addDays(todayISO(), 300) },
      [uploaded(Buffer.from(PDF), "card.pdf", "application/pdf")]
    );
    if (!applied.ok) throw new Error(`${applied.code}: ${applied.error}`);
    const id = applied.request.documents[0].id;
    // clamd is stopped: the upload's own try found no scanner, and the document waits in quarantine.
    expect(applied.request.documents[0].scan).toBe("pending");

    // The scheduler's tick (here at once; in production within a minute).
    expect(await tickOnDemandScanner()).toBe("started");
    expect(await m.whenReady()).toBe(true);
    const row = (await getDb().prepare("SELECT scan_status, scan_engine FROM approval_documents WHERE id = ?").get(id)) as { scan_status: string; scan_engine: string };
    const toClean = Date.now() - arrived;
    expect(row.scan_status).toBe("clean");
    expect(row.scan_engine).toMatch(/^ClamAV \d+\.\d+\.\d+\/\d+\//);

    // The EICAR test file as its standard defines it, stored in quarantine and scanned by this clamd: refused.
    const stored = (await getDb()
      .prepare(
        `INSERT INTO approval_documents (request_id, content_type, size, content, sha256, scan_status, scan_next_at)
         VALUES (?, 'image/webp', ?, ?, ?, 'pending', now()) RETURNING id`
      )
      .get(applied.request.id, EICAR.length, Buffer.from(EICAR), crypto.createHash("sha256").update(EICAR).digest("hex"))) as { id: number };
    expect(await scanDocument(stored.id)).toBe("rejected");
    const refused = (await getDb().prepare("SELECT scan_finding, octet_length(content) AS bytes FROM approval_documents WHERE id = ?").get(stored.id)) as {
      scan_finding: string;
      bytes: number;
    };
    expect(refused).toEqual({ scan_finding: "Eicar-Test-Signature", bytes: 0 });

    // Running, so the health check asks it; signatures dated.
    const health = await scannerHealth();
    expect(health.reachable).toBe(true);
    expect(health.signaturesAt).not.toBeNull();

    const state = m.state();
    const pid = state.pid!;
    expect(state.lastLoadMs).toBeGreaterThan(0);

    // Idle: stopped, and gone.
    clock += 5 * 60_000 + 1;
    expect(await tickOnDemandScanner()).toBe("stopped_idle");
    await m.whenStopped();
    expect(processAlive(pid)).toBe(false);
    expect(fs.existsSync(`/proc/${pid}`)).toBe(false);
    const after = m.state();
    expect(after).toMatchObject({ phase: "stopped", lastStopReason: "idle" });
    expect(after.peakRssMiB).toBeGreaterThan(100);

    // Measured here (one container, not a Droplet): printed for the record.
    console.info(
      `[clamd-on-demand-engine] ${row.scan_engine}: start to PONG ${after.lastLoadMs} ms; document sent with clamd stopped to clean ${toClean} ms (the scheduler's tick at once); clamd peak resident memory (VmHWM) ${after.peakRssMiB} MiB`
    );
  });
});
