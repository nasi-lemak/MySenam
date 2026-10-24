import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import http from "http";
import path from "path";

/**
 * On-demand remote staging (scripts/stage-remote.mjs) against a stand-in for
 * DigitalOcean's API: the cost is refused until it is agreed and under the
 * cap; a droplet is made with its ownership and expiry tags and no
 * DigitalOcean credential in what it boots with; down deletes by the
 * deployment's own tag; gc deletes only expired staging droplets and never
 * one that is not staging's. It is not DigitalOcean: no droplet is created.
 */

interface Droplet {
  id: number;
  name: string;
  status: string;
  size_slug: string;
  tags: string[];
  created_at: string;
  networks: { v4: { type: string; ip_address: string }[] };
  user_data?: string;
}

let droplets: Droplet[] = [];
const calls: { method: string; url: string; auth: string }[] = [];
let api: http.Server;
let health: http.Server;
let apiUrl = "";
let healthPort = 0;
let nextId = 100;
const RECORDS = path.join(process.cwd(), "artifacts", "staging-remote");

beforeAll(async () => {
  api = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method!, url: req.url!, auth: String(req.headers.authorization ?? "") });
      const url = new URL(req.url!, "http://do");
      const json = (status: number, data: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
      if (req.headers.authorization !== "Bearer test-token") return json(401, { message: "Unable to authenticate you" });
      if (url.pathname === "/v2/tags") return json(201, { tag: { name: JSON.parse(body).name } });
      if (url.pathname.startsWith("/v2/tags/")) return res.writeHead(204).end();
      if (url.pathname === "/v2/droplets" && req.method === "POST") {
        const input = JSON.parse(body);
        const d: Droplet = { id: nextId++, name: input.name, status: "active", size_slug: input.size, tags: input.tags, created_at: new Date().toISOString(), networks: { v4: [{ type: "public", ip_address: "127.0.0.1" }] }, user_data: input.user_data };
        droplets.push(d);
        return json(202, { droplet: d });
      }
      if (url.pathname === "/v2/droplets" && req.method === "GET") {
        const tag = url.searchParams.get("tag_name");
        return json(200, { droplets: droplets.filter((d) => !tag || d.tags.includes(tag)) });
      }
      if (url.pathname === "/v2/droplets" && req.method === "DELETE") {
        const tag = url.searchParams.get("tag_name")!;
        droplets = droplets.filter((d) => !d.tags.includes(tag));
        return res.writeHead(204).end();
      }
      const one = /^\/v2\/droplets\/(\d+)$/.exec(url.pathname);
      if (one) return json(200, { droplet: droplets.find((d) => d.id === Number(one[1])) });
      json(404, { message: "not found" });
    });
  });
  health = http.createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'));
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  await new Promise<void>((r) => health.listen(0, "127.0.0.1", () => r()));
  apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  healthPort = (health.address() as { port: number }).port;
});
afterAll(() => {
  api.close();
  health.close();
});
beforeEach(() => {
  droplets = [];
  calls.length = 0;
});

function run(...args: string[]): Promise<{ code: number | null; out: string }> {
  const extra: Record<string, string> = {};
  while (args[0]?.includes("=")) {
    const [k, v] = args.shift()!.split("=");
    extra[k] = v;
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/stage-remote.mjs", ...args], {
      env: {
        ...extra,
        PATH: process.env.PATH,
        NODE_ENV: "test",
        DO_API_URL: apiUrl,
        DIGITALOCEAN_TOKEN: "test-token",
        STAGING_IMAGE: "ghcr.io/example/mysenam:src-0123456789abcdef",
        STAGING_URL_TEMPLATE: `http://{ip}:${healthPort}`,
        STAGING_POLL_MS: "10",
      },
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
}

describe("remote staging", () => {
  it("says what a deployment would cost, and makes none until that is agreed and under the cap", async () => {
    expect((await run("plan", "--ttl", "2h")).out).toMatch(/s-1vcpu-2gb for 2h: up to \$0\.04/);
    expect(await run("up", "--ttl", "2h")).toMatchObject({ code: 1, out: expect.stringMatching(/--approve-usd 0\.04/) });
    expect(await run("STAGING_MAX_USD=0.50", "up", "--ttl", "24h", "--size", "s-2vcpu-4gb", "--approve-usd", "5")).toMatchObject({ code: 1, out: expect.stringMatching(/over STAGING_MAX_USD/) });
    expect(await run("up", "--size", "c-32", "--approve-usd", "5")).toMatchObject({ code: 1, out: expect.stringMatching(/not one of/) });
    expect(droplets).toHaveLength(0);
  });

  it("makes one droplet with its ownership and expiry tags, no DigitalOcean credential in its first boot, then deletes it by its own tag", async () => {
    const made = await run("up", "--ttl", "1h", "--approve-usd", "0.02");
    expect(made.code, made.out).toBe(0);
    expect(made.out).not.toMatch(/test-token/);
    expect(droplets).toHaveLength(1);
    const d = droplets[0];
    const id = /Up: (stg-[\w-]+)/.exec(made.out)![1];
    expect(d.tags).toEqual(["mysenam-staging", `mysenam-${id}`, expect.stringMatching(/^expires-\d+$/)]);
    expect(Number(d.tags[2].slice(8)) - Date.now() / 1000).toBeGreaterThan(3500);
    expect(d.user_data).not.toMatch(/test-token|DIGITALOCEAN/);
    expect(d.user_data).toMatch(/caddy reverse-proxy/);
    expect(d.user_data).toMatch(/seed-synthetic\.mjs/);
    const record = JSON.parse(fs.readFileSync(path.join(RECORDS, `${id}.json`), "utf8"));
    expect(record).toMatchObject({ id, size: "s-1vcpu-2gb", estimateUsd: 0.02, url: `http://127.0.0.1:${healthPort}` });
    expect((await run("test", id, "smoke")).out).toMatch(/PASS health/);

    // Somebody else's droplet in the same team, without staging's tags, is never touched.
    droplets.push({ id: 999, name: "production-db", status: "active", size_slug: "s-2vcpu-4gb", tags: ["prod"], created_at: new Date().toISOString(), networks: { v4: [] } });
    expect(await run("down", id)).toMatchObject({ code: 0, out: expect.stringMatching(/no droplet of it left/) });
    expect(droplets.map((x) => x.name)).toEqual(["production-db"]);
    expect(calls.filter((c) => c.method === "DELETE" && c.url.startsWith("/v2/droplets")).map((c) => c.url)).toEqual([`/v2/droplets?tag_name=mysenam-${id}`]);
    fs.rmSync(path.join(RECORDS, `${id}.json`), { force: true });
  });

  it("collects only expired staging droplets, leaves current ones and anything not staging's, and says what is still billable", async () => {
    const at = new Date().toISOString();
    const v4 = { v4: [{ type: "public", ip_address: "127.0.0.1" }] };
    droplets.push(
      { id: 1, name: "old", status: "active", size_slug: "s-1vcpu-2gb", tags: ["mysenam-staging", "mysenam-stg-old", "expires-1"], created_at: at, networks: v4 },
      { id: 2, name: "current", status: "active", size_slug: "s-1vcpu-2gb", tags: ["mysenam-staging", "mysenam-stg-now", `expires-${Math.floor(Date.now() / 1000) + 3600}`], created_at: at, networks: v4 },
      { id: 3, name: "prod", status: "active", size_slug: "s-2vcpu-4gb", tags: ["prod", "expires-1"], created_at: at, networks: v4 },
      { id: 4, name: "half-tagged", status: "active", size_slug: "s-1vcpu-2gb", tags: ["mysenam-staging", "expires-1"], created_at: at, networks: v4 }
    );
    expect((await run("gc", "--dry-run")).out).toMatch(/Would delete stg-old/);
    expect(droplets).toHaveLength(4);
    const collected = await run("gc");
    expect(collected.out).toMatch(/Down: stg-old/);
    expect(collected.out).toMatch(/carries no deployment tag: left alone/);
    expect(collected.out).toMatch(/Still billable: stg-now/);
    expect(droplets.map((d) => d.name).sort()).toEqual(["current", "half-tagged", "prod"]);
    expect((await run("status")).out).toMatch(/stg-now\tdroplet 2\tactive/);
  });

  it("refuses to run without its token, and says so without printing any", async () => {
    const child = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, ["scripts/stage-remote.mjs", "status"], { env: { PATH: process.env.PATH, NODE_ENV: "test", DO_API_URL: apiUrl } });
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.stderr.on("data", (c) => (out += c));
      p.on("close", (code) => resolve({ code, out }));
    });
    expect(child).toMatchObject({ code: 1, out: expect.stringMatching(/DIGITALOCEAN_TOKEN is not set/) });
  });
});
