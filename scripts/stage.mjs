#!/usr/bin/env node
/**
 * Staging on this machine, with Docker: the app as the immutable image built
 * from this source, its own Postgres, synthetic data, the tests, the evidence,
 * and everything it made removed again.
 *
 *   node scripts/stage.mjs image                 # find or build mysenam:src-<digest> for this source
 *   node scripts/stage.mjs up [--ttl 4h] [--port 3900]
 *   node scripts/stage.mjs test <id> [e2e|uat|smoke]
 *   node scripts/stage.mjs evidence <id>
 *   node scripts/stage.mjs down <id>
 *   node scripts/stage.mjs run [--keep] [--suite smoke,e2e,uat]   # all of the above, one go
 *   node scripts/stage.mjs status
 *   node scripts/stage.mjs gc [--dry-run] [--images 3]   # remove what has outlived its --ttl; keep the newest 3 images
 *
 * Each deployment has an id (stg-<time>-<random>) carried as a label on
 * every container, network and volume it makes; down and gc remove only what
 * carries their id or the staging label, never anything else on the machine.
 * Images are kept: one image per source digest, built once and reused by
 * every deployment of that source until the source changes. The record of
 * each deployment (image, digest, commit, address, timings) is in
 * artifacts/staging/<id>/. No credential goes into the image or the record
 * beyond the synthetic owner password made for that deployment.
 */
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { ROOT, sourceState } from "./lib/source.mjs";

const args = process.argv.slice(2);
const command = args[0];
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1] ?? fallback;
};
const has = (name) => args.includes(name);
const ARTIFACTS = path.join(ROOT, "artifacts", "staging");
const LABEL = "mysenam.purpose=staging";

function docker(dockerArgs, opts = {}) {
  return execFileSync("docker", dockerArgs, { encoding: "utf8", stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"], ...opts }).toString().trim();
}
function dockerOk(dockerArgs) {
  return spawnSync("docker", dockerArgs, { stdio: "ignore" }).status === 0;
}
const say = (line) => console.log(line);
const seconds = (since) => Math.round((Date.now() - since) / 100) / 10;

/** "4h", "90m", "2d" in seconds. */
function ttlSeconds(text) {
  const m = /^(\d+)([mhd])$/.exec(text ?? "");
  if (!m) throw new Error("--ttl is a number of m, h or d, like 4h.");
  return Number(m[1]) * { m: 60, h: 3600, d: 86400 }[m[2]];
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

// ------------------------------------------------------------ the image

/**
 * The image for this source: reused when one built from the same content is
 * there, built otherwise. The tag is the content digest, so a changed file,
 * lock file or Dockerfile makes a new image and never reuses a stale one.
 */
export function resolveImage() {
  const source = sourceState();
  const tag = `mysenam:src-${source.digest.slice(0, 16)}`;
  const started = Date.now();
  let built = false;
  if (!dockerOk(["image", "inspect", tag])) {
    say(`Building ${tag} (${source.short}${source.dirty ? ", with uncommitted changes" : ""})…`);
    const buildArgs = ["build", "--network", "host", "-t", tag, "--build-arg", `SOURCE_COMMIT=${source.commit}`, "--build-arg", `SOURCE_DIGEST=${source.digest}`];
    // The machine's proxy and its certificate, where it has them: proxy arguments stay out of the image history, the certificate is a build secret.
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) if (process.env[name]) buildArgs.push("--build-arg", `${name}=${process.env[name]}`);
    const ca = process.env.NODE_EXTRA_CA_CERTS ?? (fs.existsSync("/root/.ccr/ca-bundle.crt") ? "/root/.ccr/ca-bundle.crt" : null);
    if (ca) buildArgs.push("--secret", `id=proxy_ca,src=${ca}`);
    buildArgs.push(ROOT);
    const result = spawnSync("docker", buildArgs, { stdio: "inherit", env: { ...process.env, DOCKER_BUILDKIT: "1" } });
    if (result.status !== 0) throw new Error("The image build failed.");
    built = true;
  }
  const id = docker(["image", "inspect", tag, "--format", "{{.Id}}"]);
  const labelled = docker(["image", "inspect", tag, "--format", '{{index .Config.Labels "dev.mysenam.source-digest"}}']);
  if (labelled !== source.digest) throw new Error(`${tag} carries source digest ${labelled}, not ${source.digest}: refusing a stale image.`);
  return { tag, imageId: id, built, seconds: seconds(started), ...source };
}

// ------------------------------------------------------------ a deployment

function record(id) {
  const file = path.join(ARTIFACTS, id, "deployment.json");
  if (!fs.existsSync(file)) throw new Error(`No deployment ${id} recorded here (artifacts/staging/${id}).`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function save(dep) {
  const dir = path.join(ARTIFACTS, dep.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "deployment.json"), JSON.stringify(dep, null, 2), { mode: 0o600 });
}

async function waitHealthy(url, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function up() {
  const ttl = ttlSeconds(flag("--ttl", "4h"));
  if (ttl > 3 * 86400) throw new Error("A staging deployment lives at most 3 days: give a shorter --ttl.");
  const image = resolveImage();
  const id = `stg-${new Date().toISOString().replace(/\D/g, "").slice(2, 12)}-${crypto.randomBytes(3).toString("hex")}`;
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const labels = ["--label", LABEL, "--label", `mysenam.deployment=${id}`, "--label", `mysenam.expires=${expires}`];
  const port = Number(flag("--port", 0)) || (await freePort());
  const dbPort = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const dbPassword = crypto.randomBytes(16).toString("hex");
  const owner = { email: `owner+${id}@staging.mysenam.test`, password: crypto.randomBytes(18).toString("base64url") };
  const dep = { id, createdAt: new Date().toISOString(), expiresAt: new Date(expires * 1000).toISOString(), url, image, owner, timings: { image: image.seconds } };
  save(dep);
  const started = Date.now();
  try {
    docker(["network", "create", ...labels, `${id}-net`]);
    docker(["volume", "create", ...labels, `${id}-db`]);
    docker(["run", "-d", "--name", `${id}-db`, ...labels, "--network", `${id}-net`, "--network-alias", "db", "-v", `${id}-db:/var/lib/postgresql/data`, "-p", `127.0.0.1:${dbPort}:5432`,
      "-e", `POSTGRES_PASSWORD=${dbPassword}`, "-e", "POSTGRES_DB=mysenam", "postgres:16-alpine"]);
    const dbUrl = `postgres://postgres:${dbPassword}@db:5432/mysenam`;
    for (let i = 0; i < 120 && !dockerOk(["exec", `${id}-db`, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"]); i++) await new Promise((r) => setTimeout(r, 500));
    docker(["run", "-d", "--name", `${id}-app`, ...labels, "--network", `${id}-net`, "-p", `127.0.0.1:${port}:3000`,
      "-e", `DATABASE_URL=${dbUrl}`, "-e", `MYSENAM_URL=${url}`, "-e", "MYSENAM_COUNTRY=MY", "-e", "MYSENAM_SEND=log", "-e", "MYSENAM_GEOCODER=off",
      "-e", "MYSENAM_SCHEDULER=on", "-e", `ADMIN_EMAIL=${owner.email}`, "-e", `ADMIN_PASSWORD=${owner.password}`,
      "-e", `MYSENAM_SECRET=${crypto.randomBytes(32).toString("hex")}`, image.tag]);
    if (!(await waitHealthy(url, 120_000))) throw new Error(`The app did not become healthy:\n${docker(["logs", "--tail", "60", `${id}-app`])}`);
    dep.timings.start = seconds(started);
    // Synthetic data only: the seed refuses a database that has taken real bookings.
    const seeded = Date.now();
    const seedOut = execFileSync(process.execPath, [path.join(ROOT, "scripts", "seed-synthetic.mjs"), "--url", url, "--db", `postgres://postgres:${dbPassword}@127.0.0.1:${dbPort}/mysenam`], {
      encoding: "utf8",
      env: { ...process.env, E2E_OWNER_EMAIL: owner.email, E2E_OWNER_PASSWORD: owner.password },
    });
    dep.timings.seed = seconds(seeded);
    dep.seed = JSON.parse(seedOut.split("\n").filter((l) => l.startsWith("{")).at(-1) ?? "{}");
    save(dep);
    say(`Up: ${id} at ${url} (image ${image.built ? "built" : "reused"} ${image.tag}; start ${dep.timings.start}s, seed ${dep.timings.seed}s; expires ${dep.expiresAt}).`);
    say(`Owner sign-in and synthetic players are in artifacts/staging/${id}/deployment.json.`);
    return dep;
  } catch (err) {
    say(`Bringing ${id} up failed; removing what it made.`);
    down(id);
    throw err;
  }
}

/** Remove one deployment: only what carries its id. Returns what is left (nothing, if it worked). */
export function down(id) {
  const filter = ["--filter", `label=mysenam.deployment=${id}`];
  const containers = docker(["ps", "-aq", ...filter]).split("\n").filter(Boolean);
  if (containers.length) docker(["rm", "-f", ...containers]);
  const networks = docker(["network", "ls", "-q", ...filter]).split("\n").filter(Boolean);
  if (networks.length) docker(["network", "rm", ...networks]);
  const volumes = docker(["volume", "ls", "-q", ...filter]).split("\n").filter(Boolean);
  if (volumes.length) docker(["volume", "rm", "-f", ...volumes]);
  const left = [...docker(["ps", "-aq", ...filter]).split("\n"), ...docker(["network", "ls", "-q", ...filter]).split("\n"), ...docker(["volume", "ls", "-q", ...filter]).split("\n")].filter(Boolean);
  say(left.length === 0 ? `Down: ${id}, nothing of it left.` : `Down: ${id}, but ${left.length} resource(s) remain: ${left.join(", ")}`);
  return left;
}

/** Health, a restart with the data kept, and the migrations all applied. */
async function smoke(dep) {
  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok, detail });
    say(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const health = await fetch(`${dep.url}/api/health`).then((r) => r.json()).catch(() => null);
  check("health", !!health, JSON.stringify(health ?? {}).slice(0, 200));
  const venues = await fetch(`${dep.url}/api/venues`).then((r) => r.json()).catch(() => null);
  const before = Array.isArray(venues?.venues) ? venues.venues.length : -1;
  check("venues listed", before > 0, `${before}`);
  const migrations = docker(["exec", `${dep.id}-db`, "psql", "-U", "postgres", "-d", "mysenam", "-tAc", "SELECT COUNT(*) FROM schema_migrations"]);
  const files = fs.readdirSync(path.join(ROOT, "db", "migrations")).filter((f) => f.endsWith(".sql")).length;
  check("every migration applied", Number(migrations) === files, `${migrations} of ${files}`);
  const restarted = Date.now();
  docker(["restart", `${dep.id}-app`]);
  const back = await waitHealthy(dep.url, 120_000);
  check("restart", back, `${seconds(restarted)}s`);
  const after = await fetch(`${dep.url}/api/venues`).then((r) => r.json()).catch(() => null);
  check("data kept across the restart", Array.isArray(after?.venues) && after.venues.length === before);
  return checks;
}

async function test(id, suite) {
  const dep = record(id);
  const results = dep.tests ?? {};
  if (suite === "smoke") results.smoke = await smoke(dep);
  else {
    const config = suite === "uat" ? "vitest.uat.config.mts" : "vitest.e2e.config.mts";
    const started = Date.now();
    const run = spawnSync(path.join(ROOT, "node_modules", ".bin", "vitest"), ["run", "--config", config], {
      cwd: ROOT,
      stdio: "inherit",
      // The tests drive this deployment instead of starting a server of their own.
      env: { ...process.env, E2E_URL: dep.url, E2E_OWNER_EMAIL: dep.owner.email, E2E_OWNER_PASSWORD: dep.owner.password, UAT_ARTIFACTS: path.join(ARTIFACTS, id, "uat") },
    });
    results[suite] = { ok: run.status === 0, seconds: seconds(started) };
  }
  dep.tests = results;
  save(dep);
  const failed = suite === "smoke" ? results.smoke.some((c) => !c.ok) : !results[suite].ok;
  return !failed;
}

function evidence(id) {
  const dir = path.join(ARTIFACTS, id, "logs");
  fs.mkdirSync(dir, { recursive: true });
  for (const part of ["app", "db"]) {
    const out = spawnSync("docker", ["logs", `${id}-${part}`], { encoding: "utf8" });
    fs.writeFileSync(path.join(dir, `${part}.log`), `${out.stdout ?? ""}${out.stderr ?? ""}`);
  }
  say(`Logs in artifacts/staging/${id}/logs.`);
}

/** Every staging resource, by deployment, with when it expires. */
function inventory() {
  const rows = [];
  for (const [kind, list, name] of [
    ["container", ["ps", "-a"], "{{.Names}}"],
    ["network", ["network", "ls"], "{{.Name}}"],
    ["volume", ["volume", "ls"], "{{.Name}}"],
  ]) {
    const out = docker([...list, "--filter", `label=${LABEL}`, "--format", `${name}\t{{.Label "mysenam.deployment"}}\t{{.Label "mysenam.expires"}}`]);
    for (const line of out.split("\n").filter(Boolean)) {
      const [name, deployment, expires] = line.split("\t");
      rows.push({ kind, name, deployment, expires: Number(expires) });
    }
  }
  return rows;
}

function gc(dryRun) {
  const now = Date.now() / 1000;
  const expired = [...new Set(inventory().filter((r) => !(r.expires > now)).map((r) => r.deployment))];
  if (expired.length === 0) say("No deployment has outlived its time.");
  for (const id of expired) {
    if (dryRun) say(`Would remove ${id}.`);
    else down(id);
  }
  // Images are kept for reuse, but not without end: the newest few, and any a container still runs.
  const keep = Number(flag("--images", 0));
  if (keep > 0) {
    const inUse = new Set(docker(["ps", "-a", "--format", "{{.Image}}"]).split("\n").filter(Boolean));
    const images = docker(["images", "mysenam", "--format", "{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}"])
      .split("\n")
      .filter((l) => l.startsWith("mysenam:src-"))
      .map((l) => l.split("\t"))
      .sort((a, b) => b[1].localeCompare(a[1]));
    for (const [tag] of images.slice(keep)) {
      if (inUse.has(tag)) continue;
      if (dryRun) say(`Would remove image ${tag}.`);
      else {
        docker(["rmi", tag]);
        say(`Removed image ${tag}.`);
      }
    }
  }
}

// ------------------------------------------------------------ the commands

try {
  if (command === "image") {
    const image = resolveImage();
    say(`${image.built ? "Built" : "Reused"} ${image.tag} (${image.imageId}) for ${image.short}${image.dirty ? " with uncommitted changes" : ""} in ${image.seconds}s.`);
  } else if (command === "up") {
    await up();
  } else if (command === "test") {
    if (!args[1]) throw new Error("Which deployment? node scripts/stage.mjs test <id> [smoke|e2e|uat]");
    process.exitCode = (await test(args[1], args[2] ?? "smoke")) ? 0 : 1;
  } else if (command === "evidence") {
    evidence(args[1]);
  } else if (command === "down") {
    if (!args[1]) throw new Error("Which deployment? node scripts/stage.mjs down <id>");
    process.exitCode = down(args[1]).length === 0 ? 0 : 1;
  } else if (command === "status") {
    const rows = inventory();
    if (rows.length === 0) say("No staging resources on this machine.");
    for (const r of rows) say(`${r.deployment}\t${r.kind}\t${r.name}\texpires ${new Date(r.expires * 1000).toISOString()}`);
  } else if (command === "gc") {
    gc(has("--dry-run"));
  } else if (command === "run") {
    const suites = (flag("--suite", "smoke,e2e") ?? "").split(",").filter(Boolean);
    const dep = await up();
    let ok = true;
    try {
      for (const suite of suites) ok = (await test(dep.id, suite)) && ok;
    } finally {
      evidence(dep.id);
      if (!has("--keep")) {
        const left = down(dep.id);
        const final = record(dep.id);
        final.removed = left.length === 0;
        final.remaining = left;
        save(final);
        if (left.length) ok = false;
      } else say(`Kept: ${dep.id} until ${dep.expiresAt}; node scripts/stage.mjs down ${dep.id} when done.`);
    }
    say(ok ? "Staging run passed." : "Staging run FAILED.");
    process.exitCode = ok ? 0 : 1;
  } else {
    say("Commands: image, up, test, evidence, down, run, status, gc (see the top of this file).");
    process.exitCode = 2;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
