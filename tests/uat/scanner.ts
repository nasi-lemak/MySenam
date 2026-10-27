import net from "net";
import type { TestProject } from "vitest/node";

/**
 * A stand-in for clamd, for the acceptance scenarios only. **It is not the
 * real engine and proves nothing about ClamAV**: it speaks clamd's TCP
 * protocol (`PING`, `VERSION`, `INSTREAM`), so the app reaches it through its
 * real scanner (lib/document-scanner.ts) exactly as it reaches clamd, and the
 * scenarios can drive a document from quarantine to released, or to refused,
 * deterministically. The real engine is tested in
 * tests/document-scanning-engine.test.ts.
 *
 * Runs before the app starts (tests/e2e/server.ts), on the loopback, and
 * points the app at itself with MYSENAM_CLAMD, an environment variable the
 * app already reads; nothing in the app knows it is a stand-in, and no
 * production configuration can reach it. Not started against a deployment
 * (E2E_URL), or where MYSENAM_CLAMD is already set (a real clamd).
 *
 * What it answers for the bytes streamed:
 * - the EICAR test string: `stream: Eicar-Test-Signature FOUND`;
 * - `UAT-HOLD-SCAN`: nothing yet; the answer (`stream: OK`) waits until a
 *   scenario sends the stand-in's own command `UAT-RELEASE` (see
 *   `releaseHeldScans`), as a slow scanner would;
 * - anything else: `stream: OK`.
 *
 * And how it behaves, set by its own command `UAT-MODE <mode>` (see
 * tests/uat/round4.uat.ts), for a scenario to drive a document through a
 * scanner that is away or cannot scan it; every scenario that changes it puts
 * it back to `up`:
 * - `up` (the default): as above;
 * - `down`: every clamd command's connection is closed unanswered, so the app
 *   finds no scanner (its PING fails), as when clamd is stopped;
 * - `error`: PING and VERSION answer, but every scan answers clamd's own
 *   `INSTREAM size limit exceeded. ERROR`: a working scanner that cannot scan
 *   the document.
 */

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const HOLD = "UAT-HOLD-SCAN";

/** Signatures "built" now, as clamd writes the date in its VERSION reply. */
function version(): string {
  const d = new Date();
  const day = d.toUTCString().slice(0, 3);
  const month = d.toUTCString().slice(8, 11);
  const time = d.toISOString().slice(11, 19);
  return `UAT stand-in, not ClamAV/1/${day} ${month} ${String(d.getUTCDate()).padStart(2, " ")} ${time} ${d.getUTCFullYear()}`;
}

let server: net.Server | undefined;
type Mode = "up" | "down" | "error";

export default async function setup(project: TestProject) {
  if (process.env.E2E_URL || process.env.MYSENAM_CLAMD) {
    project.provide("uatScanner", null);
    return;
  }
  const held: net.Socket[] = [];
  const open = new Set<net.Socket>();
  let mode: Mode = "up";
  server = net.createServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("error", () => undefined);
    socket.on("data", (data) => {
      buffer = Buffer.concat([buffer, data]);
      const nul = buffer.indexOf(0);
      if (nul < 0) return;
      const command = buffer.subarray(buffer[0] === 0x7a ? 1 : 0, nul).toString();
      const asked = /^UAT-MODE (up|down|error)$/.exec(command);
      if (asked) {
        mode = asked[1] as Mode;
        return void socket.end(`MODE ${mode}\0`);
      }
      if (mode === "down" && !command.startsWith("UAT-")) return void socket.destroy();
      if (command === "PING") return void socket.end("PONG\0");
      if (command === "VERSION") return void socket.end(`${version()}\0`);
      if (command === "UAT-RELEASE") {
        const n = held.length;
        for (const s of held.splice(0)) s.end("stream: OK\0");
        return void socket.end(`RELEASED ${n}\0`);
      }
      if (command !== "INSTREAM") return void socket.end("UNKNOWN COMMAND\0");
      // Length-prefixed chunks until a zero length.
      const chunks: Buffer[] = [];
      let at = nul + 1;
      for (;;) {
        if (buffer.length < at + 4) return;
        const length = buffer.readUInt32BE(at);
        if (length === 0) break;
        if (buffer.length < at + 4 + length) return;
        chunks.push(buffer.subarray(at + 4, at + 4 + length));
        at += 4 + length;
      }
      socket.removeAllListeners("data");
      const content = Buffer.concat(chunks).toString("latin1");
      if (mode === "error") return void socket.end("INSTREAM size limit exceeded. ERROR\0");
      if (content.includes(EICAR)) return void socket.end("stream: Eicar-Test-Signature FOUND\0");
      if (content.includes(HOLD)) return void held.push(socket);
      socket.end("stream: OK\0");
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  process.env.MYSENAM_CLAMD = `127.0.0.1:${port}`;
  project.provide("uatScanner", `127.0.0.1:${port}`);
  return async () => {
    for (const s of open) s.destroy();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    uatScanner: string | null;
  }
}
