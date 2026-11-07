import { spawn } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";
import { OWNER } from "../e2e/server";
import { withoutProviderEnv } from "../hermetic-env";
import type { Actor } from "./harness";

/**
 * A second acceptance server, for the tournament-day scenario, whose clock can be moved. A tournament has to start after
 * today, so the day it is run on (announcing the next match, calling a fixture, the wait for players, the live page) can
 * never be today on the main acceptance server, and a deployed app's clock cannot be moved from a browser. This is the
 * same production build, a fresh in-memory database and MYSENAM_SEND=log as the main server, with tests/uat/day-clock.mjs
 * loaded into it: the scenario makes and draws the tournament for a later day with the clock as it is, then sets the clock
 * to a few minutes before that day's first match, and everything after runs on the real speed from there. Only this
 * process is stopped afterwards. Its output is kept beside the scenario's evidence, and is where the emails it sent are read.
 */
export interface ClockedServer {
  base: string;
  output: () => string;
  /** The server's clock set to this instant (it runs at the real speed from there). */
  setNow: (instant: Date) => void;
  stop: () => Promise<void>;
}

export async function clockedServer(dir: string): Promise<ClockedServer> {
  const port = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, () => {
      const { port: p } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(p));
    });
    probe.on("error", reject);
  });
  const base = `http://127.0.0.1:${port}`;
  const root = path.join(import.meta.dirname, "..", "..");
  const clockFile = path.join(dir, "server-clock-offset.txt");
  fs.writeFileSync(clockFile, "0");
  const preload = path.join(import.meta.dirname, "day-clock.mjs");
  const child = spawn(path.join(root, "node_modules", ".bin", "next"), ["start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: root,
    env: {
      // As the main acceptance server (tests/e2e/server.ts): no provider credentials, so it behaves as an install without them.
      ...withoutProviderEnv(process.env),
      NODE_ENV: "production",
      MYSENAM_DB: ":memory:",
      DATABASE_URL: "",
      MYSENAM_COUNTRY: "MY",
      MYSENAM_SCHEDULER: "off",
      MYSENAM_SEND: "log",
      MYSENAM_GEOCODER: "off",
      MYSENAM_URL: base,
      ADMIN_EMAIL: OWNER.email,
      ADMIN_PASSWORD: OWNER.password,
      // Synthetic data only: the one way staff two-factor sign-in is left off on a production marketplace (tests/e2e/server.ts, ADR 0064).
      MYSENAM_STAFF_2FA: "off",
      MYSENAM_SYNTHETIC_DATA: "on",
      UAT_CLOCK_FILE: clockFile,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${preload}`.trim(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const file = path.join(dir, "server-day.log");
  const record = (d: Buffer) => {
    log += d;
    fs.appendFileSync(file, d);
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`The tournament-day server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    base,
    output: () => log,
    setNow: (instant) => fs.writeFileSync(clockFile, String(instant.getTime() - Date.now())),
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

/** This actor's requests go to another server from now on (their own cookies, that server as the origin), its emails read from that server's output. */
export function rebase(a: Actor, server: ClockedServer): Actor {
  a.serverOutput = server.output;
  a.api = async (method, p, body) => {
    const res = await a.context.request.fetch(`${server.base}${p}`, {
      method,
      headers: { "content-type": "application/json", origin: server.base },
      data: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status(), body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  return a;
}

/** The instant of a minute of a day in Malaysia (UTC+8). */
export const instantOfDay = (date: string, minute: number): Date => new Date(Date.parse(`${date}T00:00:00Z`) - 8 * 3_600_000 + minute * 60_000);
