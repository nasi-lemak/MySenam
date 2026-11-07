import { spawn, type ChildProcess } from "child_process";
import { withoutProviderEnv } from "../hermetic-env";
import fs from "fs";
import net from "net";
import path from "path";
import type { TestProject } from "vitest/node";

/**
 * Starts the built app once for every end-to-end file, as production runs it
 * (NODE_ENV=production, so the security headers, the same-origin check and
 * the refusal of the default owner password are all in force), on a fresh
 * in-memory database with the starter venues. Its address goes to the tests
 * as E2E_URL.
 */

export const OWNER = {
  email: process.env.E2E_OWNER_EMAIL ?? "owner@e2e.my",
  password: process.env.E2E_OWNER_PASSWORD ?? "an end-to-end owner password",
};

const ROOT = path.join(import.meta.dirname, "..", "..");
let server: ChildProcess | undefined;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

export default async function setup(project: TestProject) {
  // A deployment already running (scripts/stage.mjs): drive it instead of starting one.
  if (process.env.E2E_URL) {
    project.provide("e2eUrl", process.env.E2E_URL.replace(/\/$/, ""));
    return;
  }
  if (!fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"))) throw new Error("Build the app first: npm run build");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  server = spawn(path.join(ROOT, "node_modules", ".bin", "next"), ["start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: ROOT,
    env: {
      ...withoutProviderEnv(process.env),
      NODE_ENV: "production",
      MYSENAM_DB: ":memory:",
      DATABASE_URL: "",
      MYSENAM_COUNTRY: "MY",
      MYSENAM_SCHEDULER: "off",
      MYSENAM_SEND: "log",
      MYSENAM_GEOCODER: "off",
      MYSENAM_URL: url,
      ADMIN_EMAIL: OWNER.email,
      ADMIN_PASSWORD: OWNER.password,
      // The acceptance server runs as a production marketplace holding synthetic data only, where its scenarios sign managers in with a
      // password: the one way staff two-factor sign-in is left off there (lib/two-factor.ts `staffTwoFactor`, ADR 0064). Said in its log.
      MYSENAM_STAFF_2FA: "off",
      MYSENAM_SYNTHETIC_DATA: "on",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  // Where E2E_SERVER_LOG names a file (the acceptance runs: tests/uat/setup.ts), the app's own output goes there too.
  const keep = process.env.E2E_SERVER_LOG;
  const record = (d: Buffer) => {
    log += d;
    if (keep) fs.appendFileSync(keep, d);
  };
  server.stdout?.on("data", record);
  server.stderr?.on("data", record);
  // Ready when it answers; the first answer also creates the database.
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline || server.exitCode !== null) throw new Error(`The app did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  project.provide("e2eUrl", url);
  return async () => {
    server?.kill("SIGTERM");
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    e2eUrl: string;
  }
}
