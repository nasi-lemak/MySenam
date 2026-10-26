import net from "net";

/**
 * The malware scanner supporting documents go through before anybody can
 * open them (lib/document-scanning.ts; ADR 0024): one small interface, and
 * one implementation of it, clamd (ClamAV's daemon) over its TCP `INSTREAM`
 * protocol, which needs nothing but a socket.
 *
 * A scan says what the engine found with the signatures it has: a clean
 * result means no known signature matched, never that a file is harmless.
 * It supplements the structural checks (lib/approval-documents.ts) and
 * replaces none of them.
 *
 * The bytes are streamed from memory; nothing is written to disk on this
 * side. The scanner's answer is read from the socket the server opened to
 * the scanner it was configured with, so nothing a browser sends can stand
 * in for it.
 */

export type ScanErrorKind = "unavailable" | "timeout" | "inconclusive" | "too_large";

export type ScanVerdict =
  | { kind: "clean"; engine: string }
  | { kind: "found"; finding: string; engine: string }
  | { kind: "error"; error: ScanErrorKind; detail: string };

export interface ScannerStatus {
  reachable: boolean;
  /** The engine and signature version, as it reports them (`ClamAV 1.5.4/27800/Sun Oct 26 07:23:01 2026`). */
  engine: string | null;
  /** When its signature database was built, where it says (ISO); null when it does not. */
  signaturesAt: string | null;
  error: string | null;
}

export interface DocumentScanner {
  readonly name: string;
  scan(content: Buffer): Promise<ScanVerdict>;
  status(): Promise<ScannerStatus>;
}

/** How long a whole scan may take, connecting included. */
export const SCAN_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 5_000;
const CHUNK = 64 * 1024;
const MAX_REPLY = 4096;

class ScannerError extends Error {
  constructor(
    readonly kind: ScanErrorKind,
    message: string
  ) {
    super(message);
  }
}

/** Where clamd listens: `host:port` (or `tcp://host:port`); the port is 3310 when not given. */
export function parseClamdAddress(value: string): { host: string; port: number } | null {
  const m = /^(?:tcp:\/\/)?(\[[^\]]+\]|[^:/\s]+)(?::(\d{1,5}))?\/?$/.exec(value.trim());
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : 3310;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1].replace(/^\[|\]$/g, ""), port };
}

/** The date a clamd `VERSION` reply gives for its signatures, read as UTC; null when there is none. */
export function signaturesDate(version: string): string | null {
  const parts = version.split("/");
  if (parts.length < 3) return null;
  const at = Date.parse(`${parts.slice(2).join("/").trim()} UTC`);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** clamd, over TCP. */
export class ClamdScanner implements DocumentScanner {
  readonly name = "clamd";

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = SCAN_TIMEOUT_MS
  ) {}

  /** One command on its own connection (`z` form: NUL-terminated), and its one reply. */
  private command(command: string, body?: Buffer): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];
      let size = 0;
      let connected = false;
      let settled = false;
      const finish = (err: ScannerError | null, reply?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(total);
        socket.destroy();
        if (err) reject(err);
        else resolve(reply!);
      };
      const total = setTimeout(() => finish(new ScannerError("timeout", `no answer within ${this.timeoutMs} ms`)), this.timeoutMs);
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => {
        if (!connected) finish(new ScannerError("unavailable", "could not connect in time"));
      });
      socket.on("connect", () => {
        connected = true;
        socket.setTimeout(0);
        socket.write(`z${command}\0`);
        if (body) {
          for (let i = 0; i < body.length; i += CHUNK) {
            const part = body.subarray(i, i + CHUNK);
            const length = Buffer.alloc(4);
            length.writeUInt32BE(part.length);
            socket.write(length);
            socket.write(part);
          }
          socket.write(Buffer.alloc(4));
        }
      });
      socket.on("data", (data: Buffer) => {
        chunks.push(data);
        size += data.length;
        if (size > MAX_REPLY) return finish(new ScannerError("inconclusive", "the reply was too long"));
        const reply = Buffer.concat(chunks);
        const end = reply.indexOf(0);
        if (end >= 0) finish(null, reply.subarray(0, end).toString("utf8").trim());
      });
      socket.on("end", () => finish(null, Buffer.concat(chunks).toString("utf8").replace(/\0+$/, "").trim()));
      socket.on("error", (err: NodeJS.ErrnoException) => {
        // A connection reset while streaming is clamd closing on a size limit; anything before connecting is it being away.
        finish(new ScannerError(connected ? "inconclusive" : "unavailable", err.code ?? "connection error"));
      });
    });
  }

  async status(): Promise<ScannerStatus> {
    try {
      const pong = await this.command("PING");
      if (pong !== "PONG") return { reachable: false, engine: null, signaturesAt: null, error: "unexpected answer to PING" };
      const engine = await this.command("VERSION");
      return { reachable: true, engine, signaturesAt: signaturesDate(engine), error: null };
    } catch (err) {
      return { reachable: false, engine: null, signaturesAt: null, error: err instanceof ScannerError ? `${err.kind}: ${err.message}` : "error" };
    }
  }

  async scan(content: Buffer): Promise<ScanVerdict> {
    try {
      const engine = await this.command("VERSION");
      if (!engine) return { kind: "error", error: "inconclusive", detail: "no version" };
      const reply = await this.command("INSTREAM", content);
      return readReply(reply, engine);
    } catch (err) {
      if (err instanceof ScannerError) return { kind: "error", error: err.kind, detail: err.message };
      return { kind: "error", error: "unavailable", detail: "error" };
    }
  }
}

/**
 * clamd's answer to `INSTREAM`: `stream: OK`, `stream: <signature> FOUND`, or
 * an `ERROR` (a size limit, or anything it could not finish). Anything else is
 * inconclusive, never clean.
 */
export function readReply(reply: string, engine: string): ScanVerdict {
  const text = reply.replace(/\0/g, "").trim();
  if (text === "stream: OK") return { kind: "clean", engine };
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found) return { kind: "found", finding: found[1].slice(0, 200), engine };
  if (/size limit exceeded/i.test(text)) return { kind: "error", error: "too_large", detail: "size limit exceeded" };
  return { kind: "error", error: "inconclusive", detail: text.slice(0, 120) || "empty reply" };
}

// ------------------------------------------------------------ configuration

/**
 * - `scanner`: a scanner is configured (`MYSENAM_CLAMD`); documents wait in
 *   quarantine until it has passed them.
 * - `off`: the operator turned scanning off on purpose
 *   (`MYSENAM_DOCUMENT_SCAN=off`); documents are taken, marked *not scanned*
 *   for everybody who sees them.
 * - `unconfigured`: neither; documents are refused, never taken unscanned.
 */
export type ScanMode = "scanner" | "off" | "unconfigured";

const testing = globalThis as { __mysenamDocumentScanner?: DocumentScanner | "off" | "unconfigured" | null };

/** Tests only: put a scanner (or a mode) in place of the configured one; null goes back to the environment. */
export function setDocumentScanner(scanner: DocumentScanner | "off" | "unconfigured" | null): void {
  testing.__mysenamDocumentScanner = scanner;
}

/** The scanner in use, or null when there is none. A configured scanner wins over the opt-out. */
export function documentScanner(): DocumentScanner | null {
  const t = testing.__mysenamDocumentScanner;
  if (t !== undefined && t !== null) return typeof t === "string" ? null : t;
  const address = process.env.MYSENAM_CLAMD?.trim();
  const parsed = address ? parseClamdAddress(address) : null;
  return parsed ? new ClamdScanner(parsed.host, parsed.port) : null;
}

export function scanMode(): ScanMode {
  const t = testing.__mysenamDocumentScanner;
  if (t !== undefined && t !== null) return typeof t === "string" ? t : "scanner";
  if (documentScanner()) return "scanner";
  return process.env.MYSENAM_DOCUMENT_SCAN?.trim().toLowerCase() === "off" ? "off" : "unconfigured";
}
