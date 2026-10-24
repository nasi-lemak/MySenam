#!/usr/bin/env node
/**
 * On-demand staging on DigitalOcean, for what this machine cannot do: a
 * public HTTPS address for payment webhooks and callbacks, and tests from
 * outside. One droplet per deployment, running the image already built for
 * this source (scripts/stage.mjs) from a registry, with its own Postgres,
 * Caddy for HTTPS on <ip>.sslip.io, and synthetic data; deleted afterwards.
 *
 *   node scripts/stage-remote.mjs plan [--ttl 2h] [--size s-1vcpu-2gb]
 *   node scripts/stage-remote.mjs up --approve-usd 0.10 [--ttl 2h] [--size s-1vcpu-2gb] [--region sgp1]
 *   node scripts/stage-remote.mjs test <id> [smoke|e2e|uat]
 *   node scripts/stage-remote.mjs down <id>
 *   node scripts/stage-remote.mjs status
 *   node scripts/stage-remote.mjs gc [--dry-run]
 *
 * Needs, from the environment (never the command line, never printed):
 * - DIGITALOCEAN_TOKEN: a custom-scoped token of a team used only for
 *   staging (droplet:create/read/delete, tag:create/read, registry:read).
 * - STAGING_IMAGE: the image reference to run, pushed already
 *   (registry.digitalocean.com/<registry>/mysenam:src-<digest>, or another
 *   registry), and STAGING_REGISTRY_AUTH (base64 user:token) when it is
 *   private and not on DigitalOcean's registry.
 * - STAGING_MAX_USD: the most one deployment may cost over its lifetime
 *   (default 1.00). `up` also needs --approve-usd at least the estimate.
 *
 * Ownership: every droplet made here carries the tags mysenam-staging,
 * mysenam-stg-<id> and expires-<unix time>. down deletes by its own
 * deployment tag only; gc deletes only droplets tagged mysenam-staging whose
 * expiry has passed. Nothing untagged is ever touched. DigitalOcean has no
 * expiry of its own, and a powered-off droplet is still billed, so run gc on
 * a schedule while anything is up.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, sourceState } from "./lib/source.mjs";

const args = process.argv.slice(2);
const command = args[0];
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1] ?? fallback;
};
const API = (process.env.DO_API_URL ?? "https://api.digitalocean.com").replace(/\/$/, "");
const DIR = path.join(ROOT, "artifacts", "staging-remote");
const TAG = "mysenam-staging";
/** List prices (USD an hour, billed per second with a monthly cap), October 2026. Only these sizes may be used. */
export const SIZES = { "s-1vcpu-1gb": 0.00893, "s-1vcpu-2gb": 0.01786, "s-2vcpu-4gb": 0.03571 };
const say = (line) => console.log(line);

function ttlHours(text) {
  const m = /^(\d+)([mh])$/.exec(text ?? "");
  if (!m) throw new Error("--ttl is minutes or hours, like 90m or 2h.");
  const hours = m[2] === "h" ? Number(m[1]) : Number(m[1]) / 60;
  if (hours <= 0 || hours > 24) throw new Error("A remote staging deployment lives 1 minute to 24 hours.");
  return hours;
}

/** What a deployment would cost at most: its size for its whole time, rounded up to the cent. */
export function estimate(size, hours) {
  if (!(size in SIZES)) throw new Error(`Size ${size} is not one of ${Object.keys(SIZES).join(", ")}.`);
  return Math.ceil(SIZES[size] * hours * 100) / 100;
}

async function api(method, route, body) {
  const token = process.env.DIGITALOCEAN_TOKEN;
  if (!token) throw new Error("DIGITALOCEAN_TOKEN is not set (a custom-scoped token of the staging team).");
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`DigitalOcean ${method} ${route}: ${res.status} ${data.message ?? ""}`.trim());
  return data;
}

async function stagingDroplets() {
  const data = await api("GET", `/v2/droplets?tag_name=${TAG}&per_page=200`);
  return (data.droplets ?? []).map((d) => {
    const expires = Number((d.tags ?? []).find((t) => t.startsWith("expires-"))?.slice(8));
    const id = (d.tags ?? []).find((t) => t.startsWith("mysenam-stg-"))?.slice("mysenam-".length) ?? null;
    const ip = d.networks?.v4?.find((n) => n.type === "public")?.ip_address ?? null;
    const hourly = SIZES[d.size_slug] ?? null;
    const hoursUp = (Date.now() - Date.parse(d.created_at)) / 3_600_000;
    return { dropletId: d.id, name: d.name, id, ip, status: d.status, size: d.size_slug, expires, createdAt: d.created_at, accruedUsd: hourly ? Math.round(hourly * hoursUp * 100) / 100 : null };
  });
}

/** The machine's first boot: Postgres, the app, Caddy with a certificate for <ip>.sslip.io, synthetic data. */
function cloudInit({ image, registryAuth, owner, playerPassword, dbPassword, secret }) {
  const dockerConfig = registryAuth ? JSON.stringify({ auths: { [image.split("/")[0]]: { auth: registryAuth } } }) : null;
  return `#!/bin/bash
set -euo pipefail
${dockerConfig ? `mkdir -p /root/.docker && umask 077 && cat > /root/.docker/config.json <<'JSON'\n${dockerConfig}\nJSON` : ""}
IP=$(curl -s http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address)
HOST="$(echo "$IP" | tr . -).sslip.io"
docker network create mysenam
docker run -d --name db --network mysenam --restart unless-stopped -e POSTGRES_PASSWORD='${dbPassword}' -e POSTGRES_DB=mysenam postgres:16-alpine
until docker exec db pg_isready -U postgres; do sleep 2; done
docker run -d --name app --network mysenam --restart unless-stopped \\
  -e DATABASE_URL='postgres://postgres:${dbPassword}@db:5432/mysenam' -e MYSENAM_URL="https://$HOST" \\
  -e MYSENAM_COUNTRY=MY -e MYSENAM_SEND=log -e MYSENAM_GEOCODER=off -e MYSENAM_SCHEDULER=on \\
  -e ADMIN_EMAIL='${owner.email}' -e ADMIN_PASSWORD='${owner.password}' -e MYSENAM_SECRET='${secret}' '${image}'
docker run -d --name caddy --network mysenam --restart unless-stopped -p 80:80 -p 443:443 caddy:2 caddy reverse-proxy --from "$HOST" --to app:3000
until docker exec app curl -fsS http://127.0.0.1:3000/api/health; do sleep 5; done
docker exec -e E2E_OWNER_EMAIL='${owner.email}' -e E2E_OWNER_PASSWORD='${owner.password}' app \\
  node scripts/seed-synthetic.mjs --url http://127.0.0.1:3000 --db 'postgres://postgres:${dbPassword}@db:5432/mysenam' --password '${playerPassword}' > /root/seed.json
`;
}

function save(dep) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `${dep.id}.json`), JSON.stringify(dep, null, 2), { mode: 0o600 });
}
function load(id) {
  const file = path.join(DIR, `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`No record of ${id} in artifacts/staging-remote.`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const addressOf = (ip) => (process.env.STAGING_URL_TEMPLATE ?? "https://{host}").replace("{host}", `${ip.replace(/\./g, "-")}.sslip.io`).replace("{ip}", ip);

async function up() {
  const size = flag("--size", "s-1vcpu-2gb");
  const hours = ttlHours(flag("--ttl", "2h"));
  const cost = estimate(size, hours);
  const cap = Number(process.env.STAGING_MAX_USD ?? 1);
  const approved = Number(flag("--approve-usd", NaN));
  if (cost > cap) throw new Error(`This would cost up to $${cost.toFixed(2)}, over STAGING_MAX_USD ($${cap.toFixed(2)}).`);
  if (!(approved >= cost)) throw new Error(`This would cost up to $${cost.toFixed(2)}: run again with --approve-usd ${cost.toFixed(2)} to agree to it.`);
  const image = process.env.STAGING_IMAGE;
  if (!image) throw new Error("STAGING_IMAGE is not set: push the image for this source first (docs/development/testing.md#staging).");
  const source = sourceState();
  const id = `stg-${new Date().toISOString().replace(/\D/g, "").slice(2, 12)}-${crypto.randomBytes(3).toString("hex")}`;
  const expires = Math.floor(Date.now() / 1000 + hours * 3600);
  let registryAuth = process.env.STAGING_REGISTRY_AUTH ?? null;
  // DigitalOcean's own registry: a read-only credential that lasts as long as the droplet.
  if (!registryAuth && image.startsWith("registry.digitalocean.com/")) {
    const creds = await api("GET", `/v2/registry/docker-credentials?read_write=false&expiry_seconds=${Math.ceil(hours * 3600)}`);
    registryAuth = Object.values(creds.auths ?? {})[0]?.auth ?? null;
  }
  const owner = { email: `owner+${id}@staging.mysenam.test`, password: crypto.randomBytes(18).toString("base64url") };
  const dep = { id, size, region: flag("--region", "sgp1"), hours, estimateUsd: cost, image, commit: source.commit, sourceDigest: source.digest, createdAt: new Date().toISOString(), expiresAt: new Date(expires * 1000).toISOString(), owner, playerPassword: crypto.randomBytes(12).toString("base64url") };
  for (const tag of [TAG, `mysenam-${id}`, `expires-${expires}`]) await api("POST", "/v2/tags", { name: tag }).catch(() => null);
  const made = await api("POST", "/v2/droplets", {
    name: `mysenam-${id}`,
    region: dep.region,
    size,
    image: "docker-20-04",
    tags: [TAG, `mysenam-${id}`, `expires-${expires}`],
    user_data: cloudInit({ image, registryAuth, owner, playerPassword: dep.playerPassword, dbPassword: crypto.randomBytes(16).toString("hex"), secret: crypto.randomBytes(32).toString("hex") }),
    monitoring: false,
    ipv6: false,
  });
  dep.dropletId = made.droplet.id;
  save(dep);
  say(`Creating ${id} (droplet ${dep.dropletId}, ${size}, up to $${cost.toFixed(2)}, expires ${dep.expiresAt})…`);
  // Its address, then its health over HTTPS: a failure here deletes it again.
  try {
    const deadline = Date.now() + Number(process.env.STAGING_WAIT_MS ?? 15 * 60_000);
    for (;;) {
      const d = (await api("GET", `/v2/droplets/${dep.dropletId}`)).droplet;
      const ip = d.networks?.v4?.find((n) => n.type === "public")?.ip_address;
      if (d.status === "active" && ip) {
        dep.ip = ip;
        dep.url = addressOf(ip);
        break;
      }
      if (Date.now() > deadline) throw new Error("The droplet did not become active.");
      await new Promise((r) => setTimeout(r, 3000));
    }
    save(dep);
    for (;;) {
      const ok = await fetch(`${dep.url}/api/health`).then((r) => r.ok).catch(() => false);
      if (ok) break;
      if (Date.now() > deadline) throw new Error(`${dep.url} did not answer healthily in time.`);
      await new Promise((r) => setTimeout(r, 5000));
    }
    dep.readyAt = new Date().toISOString();
    save(dep);
    say(`Up: ${id} at ${dep.url}. The record (owner and synthetic players' sign-in) is in artifacts/staging-remote/${id}.json.`);
    return dep;
  } catch (err) {
    say(`${id} did not come up; deleting it.`);
    await down(id);
    throw err;
  }
}

/** Delete one deployment by its own tag, and say whether anything of it is left. */
async function down(id) {
  await api("DELETE", `/v2/droplets?tag_name=mysenam-${id}`);
  for (let i = 0; i < 20; i++) {
    const left = (await api("GET", `/v2/droplets?tag_name=mysenam-${id}`)).droplets ?? [];
    if (left.length === 0) {
      await api("DELETE", `/v2/tags/mysenam-${id}`).catch(() => null);
      say(`Down: ${id}, no droplet of it left.`);
      try {
        const dep = load(id);
        dep.removedAt = new Date().toISOString();
        save(dep);
      } catch {
        // no local record: removed by tag alone
      }
      return [];
    }
    await new Promise((r) => setTimeout(r, Number(process.env.STAGING_POLL_MS ?? 3000)));
  }
  say(`Down: ${id}, but a droplet is still listed: check the DigitalOcean console.`);
  return ["droplet"];
}

async function gc(dryRun) {
  const now = Date.now() / 1000;
  const all = await stagingDroplets();
  const expired = all.filter((d) => !(d.expires > now));
  if (expired.length === 0) say("No staging droplet has outlived its time.");
  for (const d of expired) {
    if (!d.id) {
      say(`Droplet ${d.dropletId} (${d.name}) is tagged ${TAG} but carries no deployment tag: left alone, check it by hand.`);
      continue;
    }
    if (dryRun) say(`Would delete ${d.id} (droplet ${d.dropletId}, expired ${new Date(d.expires * 1000).toISOString()}).`);
    else await down(d.id);
  }
  return stagingDroplets();
}

async function test(id, suite) {
  const dep = load(id);
  if (!dep.url) throw new Error(`${id} has no address yet.`);
  if (suite === "smoke") {
    const health = await fetch(`${dep.url}/api/health`).then((r) => r.ok).catch(() => false);
    const https = dep.url.startsWith("https://");
    say(`${health ? "PASS" : "FAIL"} health over ${https ? "HTTPS" : "HTTP"} at ${dep.url}`);
    return health;
  }
  const config = suite === "uat" ? "vitest.uat.config.mts" : "vitest.e2e.config.mts";
  const run = spawnSync(path.join(ROOT, "node_modules", ".bin", "vitest"), ["run", "--config", config], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, E2E_URL: dep.url, E2E_OWNER_EMAIL: dep.owner.email, E2E_OWNER_PASSWORD: dep.owner.password, UAT_ARTIFACTS: path.join(DIR, `${id}-uat`) },
  });
  return run.status === 0;
}

try {
  if (command === "plan") {
    const size = flag("--size", "s-1vcpu-2gb");
    const hours = ttlHours(flag("--ttl", "2h"));
    say(`${size} for ${hours}h: up to $${estimate(size, hours).toFixed(2)} (list price $${SIZES[size]}/h, billed per second).`);
    say("Also billed while it exists: nothing else is made (no volume, snapshot, load balancer or reserved IP).");
    say(`Cap: STAGING_MAX_USD=${process.env.STAGING_MAX_USD ?? "1.00"}.`);
  } else if (command === "up") {
    await up();
  } else if (command === "down") {
    if (!args[1]) throw new Error("Which deployment? down <id>");
    process.exitCode = (await down(args[1])).length === 0 ? 0 : 1;
  } else if (command === "status") {
    const all = await stagingDroplets();
    if (all.length === 0) say("No staging droplets: nothing is being billed for staging.");
    for (const d of all)
      say(`${d.id ?? "(untagged deployment)"}\tdroplet ${d.dropletId}\t${d.status}\t${d.size}\texpires ${d.expires ? new Date(d.expires * 1000).toISOString() : "never"}\tabout $${d.accruedUsd ?? "?"} so far`);
  } else if (command === "gc") {
    const left = await gc(args.includes("--dry-run"));
    if (left.length) say(`Still billable: ${left.map((d) => `${d.id ?? d.dropletId} (until ${d.expires ? new Date(d.expires * 1000).toISOString() : "?"})`).join(", ")}`);
  } else if (command === "test") {
    process.exitCode = (await test(args[1], args[2] ?? "smoke")) ? 0 : 1;
  } else {
    say("Commands: plan, up, test, down, status, gc (see the top of this file).");
    process.exitCode = 2;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
