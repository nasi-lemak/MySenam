// A stand-in for clamd, started the way the app starts clamd on demand
// (`<binary> -F --config-file=<path>`): it listens where the config says and
// speaks enough of clamd's protocol (PING, VERSION, INSTREAM) for the app.
// It is not ClamAV: it "finds" only the EICAR test string. Its behaviour for
// a test is set by `#fake <what> <value>` lines in the config file, which real
// clamd would read as comments:
//
//   #fake starts <file>          append this process's pid to <file>
//   #fake delay <ms>             wait this long before listening (loading signatures)
//   #fake never-listen 1         never listen (a start that hangs)
//   #fake exit-at-start <code>   say something and exit at once
//   #fake crash-on-scan <marker> exit in the middle of the first scan (while <marker> does not exist; it is then made)
//   #fake ignore-term 1          ignore SIGTERM (only SIGKILL stops it)
//   #fake ballast <MiB>          hold this much memory (so its peak resident memory shows)
import fs from "fs";
import net from "net";

const arg = process.argv.find((a) => a.startsWith("--config-file="));
if (!arg) {
  console.error("ERROR: no --config-file");
  process.exit(2);
}
const text = fs.readFileSync(arg.slice("--config-file=".length), "utf8");
const conf = new Map();
const fake = new Map();
for (const raw of text.split("\n")) {
  const line = raw.trim();
  const f = /^#fake\s+(\S+)\s+(.+)$/.exec(line);
  if (f) fake.set(f[1], f[2].trim());
  else if (line && !line.startsWith("#")) {
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (m) conf.set(m[1], m[2].trim());
  }
}

if (fake.has("starts")) fs.appendFileSync(fake.get("starts"), `${process.pid}\n`);
if (fake.has("ignore-term")) process.on("SIGTERM", () => console.log("SIGTERM ignored"));
else process.on("SIGTERM", () => process.exit(0));
const ballast = fake.has("ballast") ? Buffer.alloc(Number(fake.get("ballast")) * 1024 * 1024, 1) : null;
console.log(`fake clamd ${process.pid} reading ${conf.get("DatabaseDirectory") ?? "(no database)"}`);
if (fake.has("exit-at-start")) {
  console.log("ERROR: Can't open database: this is a stand-in told to fail");
  process.exit(Number(fake.get("exit-at-start")));
}

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const VERSION = "ClamAV 1.5.4/28165/Mon Oct 26 06:27:07 2026";

function serve() {
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let command = null;
    const stream = [];
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (command === null) {
        const end = buf.indexOf(0);
        if (end < 0) return;
        command = buf.subarray(1, end).toString("utf8");
        buf = buf.subarray(end + 1);
        if (command === "PING") return socket.end("PONG\0");
        if (command === "VERSION") return socket.end(`${VERSION}\0`);
        if (command !== "INSTREAM") return socket.end("UNKNOWN COMMAND\0");
        const marker = fake.get("crash-on-scan");
        if (marker && !fs.existsSync(marker)) {
          fs.writeFileSync(marker, "crashed once\n");
          console.log("LibClamAV Error: a stand-in told to crash mid-scan");
          process.exit(70);
        }
      }
      // INSTREAM: <length><bytes>... then a zero length.
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          const all = Buffer.concat(stream).toString("latin1");
          return socket.end(all.includes(EICAR) ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
        }
        if (buf.length < 4 + len) return;
        stream.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
    socket.on("error", () => undefined);
  });
  server.listen(Number(conf.get("TCPSocket")), conf.get("TCPAddr") ?? "127.0.0.1");
}

if (ballast) console.log(`holding ${ballast.length} bytes`);
if (fake.has("never-listen")) setInterval(() => undefined, 60_000);
else setTimeout(serve, Number(fake.get("delay") ?? 0));
