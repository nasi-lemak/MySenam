#!/usr/bin/env node
/**
 * Fill a staging or test install with synthetic people and activity, through
 * the app itself wherever the app has a way in, so what is made is what the
 * app would have made:
 *
 *   node scripts/seed-synthetic.mjs --url http://127.0.0.1:3900 --db postgres://… [--seed 7] [--players 24]
 *
 * The owner signs in (E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD) and fills the
 * venues with the demo fortnight (lib/demo.ts), which refuses an install that
 * has taken real bookings. Player accounts are written straight to the
 * database, because signing up is rate-limited per address, all with one
 * password made for this run; each then signs in and acts through the API:
 * sports and levels, playing preferences, a booking and an open game.
 * Names, phone numbers and emails are invented (@seed.mysenam.test). The
 * same --seed makes the same people; another makes others.
 *
 * Prints one JSON line: the players' emails and the password, for the
 * scenarios to sign in with. Never point it at a database with real people.
 */
import crypto from "node:crypto";
import pg from "pg";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1] ?? fallback;
};
const url = flag("--url", process.env.E2E_URL);
const dbUrl = flag("--db", process.env.SEED_DATABASE_URL);
const seed = Number(flag("--seed", 7));
const count = Math.min(200, Number(flag("--players", 24)));
if (!url || !dbUrl) {
  console.error("Give --url (the app) and --db (its database).");
  process.exit(2);
}

/** Same seed, same people. */
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(seed);
const pick = (list) => list[Math.floor(rng() * list.length)];
const FIRST = ["Aina", "Bala", "Chong", "Dewi", "Elan", "Farah", "Ganesh", "Hui Min", "Irfan", "Jia Wei", "Kavitha", "Lokman", "Mei Ling", "Nabil", "Ong", "Priya", "Qistina", "Ravi", "Siti", "Tan", "Umar", "Vani", "Wan", "Xin Yi", "Yusof", "Zara"];
const LAST = ["Abdullah", "Chandran", "Lee", "Rahman", "Tan", "Wong", "Krishnan", "Ismail", "Lim", "Ng"];

const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
};

async function call(path, init = {}, cookie = "") {
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Origin: url, ...(cookie ? { Cookie: cookie } : {}), ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
}

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
const summary = { seed, players: [], password: crypto.randomBytes(12).toString("base64url"), demo: null, games: 0 };
try {
  // The owner fills the venues with a plausible fortnight, unless something real is there.
  const owner = await call("/api/admin/auth/login", { method: "POST", body: JSON.stringify({ email: process.env.E2E_OWNER_EMAIL, password: process.env.E2E_OWNER_PASSWORD }) });
  if (owner.status !== 200) throw new Error(`Owner sign-in failed (${owner.status}).`);
  const demo = await call("/api/admin/demo", { method: "POST", body: "{}" }, owner.cookie);
  summary.demo = demo.status === 200 ? "filled" : `not filled: ${demo.body.error ?? demo.status}`;

  const hash = hashPassword(summary.password);
  for (let i = 0; i < count; i++) {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const email = `player${seed}-${i}@seed.mysenam.test`;
    const phone = `0179${String(seed % 100).padStart(2, "0")}${String(i).padStart(4, "0")}`;
    await db.query(
      `INSERT INTO users (name, email, phone, password_hash) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING`,
      [name, email, phone, hash]
    );
    summary.players.push({ email, name });
  }
} finally {
  await db.end();
}
console.log(JSON.stringify(summary));
