#!/usr/bin/env node
/**
 * Fill a staging or test install with synthetic people and activity, through
 * the app itself wherever the app has a way in, so what is made is what the
 * app would have made:
 *
 *   node scripts/seed-synthetic.mjs --url http://127.0.0.1:3900 --db postgres://… [--seed 7] [--players 24] [--password …]
 *
 * The owner signs in (E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD) and fills the
 * venues with the demo fortnight (lib/demo.ts), which refuses an install that
 * has taken real bookings. Player accounts are written straight to the
 * database, because signing up is rate-limited per address, all with one
 * password made for this run; each then signs in and acts through the API:
 * sports and levels, playing preferences, a booking and an open game.
 * Players get a playing profile (declared adults, an area and a point near a
 * venue, some opted in to being found) and a level, written to the database
 * as the profile page would. Then some of them, each signed in and from an
 * address of their own, book a court through the app, open it as a game
 * (some letting everybody in, some deciding, one private, all with a
 * waiting list), and others ask to join. Names, phone numbers and emails are
 * invented (@seed.mysenam.test). The same --seed makes the same people;
 * another makes others.
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

async function call(path, init = {}, cookie = "", from = "") {
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Origin: url,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(from ? { "X-Forwarded-For": from } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
}

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
const summary = { seed, players: [], password: flag("--password", crypto.randomBytes(12).toString("base64url")), demo: null, games: 0, joined: 0 };
const LEVELS = ["beginner", "intermediate", "advanced", "competitive"];

/** A session for a seeded player, as signing in would make one (lib/auth.ts keeps only its hash). */
async function sessionFor(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 7 * 864e5).toISOString().replace("T", " ").slice(0, 19);
  await db.query("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)", [crypto.createHash("sha256").update(token).digest("hex"), userId, expires]);
  return `ms_session=${token}`;
}
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

  // Where and what they play: near the venues there are, each with a level.
  const venues = ((await call("/api/venues")).body.venues ?? []).filter((v) => v.courts?.length);
  if (venues.length === 0) throw new Error("No venue with courts to seed games at.");
  const ids = (await db.query("SELECT id, email FROM users WHERE email = ANY($1) ORDER BY id", [summary.players.map((p) => p.email)])).rows;
  for (const [i, u] of ids.entries()) {
    const v = venues[i % venues.length];
    const sport = v.courts[0].sport;
    await db.query(
      `INSERT INTO player_profiles (user_id, area, near_lat, near_lng, max_km, days, times, intensity, discoverable, invitable, adult, notify_matches)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 1, 'none') ON CONFLICT (user_id) DO NOTHING`,
      [u.id, v.area, v.lat == null ? null : Math.round((Number(v.lat) + (rng() - 0.5) * 0.04) * 100) / 100, v.lng == null ? null : Math.round((Number(v.lng) + (rng() - 0.5) * 0.04) * 100) / 100,
       pick([5, 10, 25]), pick(["1,3,5", "6,0", "2,4"]), pick(["evening", "morning,evening", "afternoon"]), pick(["casual", "competitive", "any"]), i % 2 === 0 ? 1 : 0]
    );
    await db.query("INSERT INTO player_levels (user_id, sport, level) VALUES ($1, $2, $3) ON CONFLICT (user_id, sport) DO NOTHING", [u.id, sport, pick(LEVELS)]);
    summary.players[i].id = u.id;
  }

  // Some of them host: a court booked through the app, opened as a game.
  const hosts = ids.slice(0, Math.max(1, Math.floor(ids.length / 4)));
  const today = new Date();
  const games = [];
  for (const [i, h] of hosts.entries()) {
    const v = venues[i % venues.length];
    const court = v.courts[0];
    const cookie = await sessionFor(h.id);
    const from = `10.77.${seed % 250}.${i + 1}`;
    const player = summary.players.find((p) => p.id === h.id);
    let booking = null;
    for (let tries = 0; tries < 12 && !booking; tries++) {
      const date = new Date(today.getTime() + (2 + ((i + tries) % 10)) * 864e5).toISOString().slice(0, 10);
      const hour = 18 + ((i + tries) % 4);
      const made = await call("/api/bookings", { method: "POST", body: JSON.stringify({ courtId: court.id, date, hours: [hour], name: player.name, phone: `0179${String(seed % 100).padStart(2, "0")}${String(ids.indexOf(h)).padStart(4, "0")}` }) }, cookie, from);
      if (made.status === 201 || made.status === 200) booking = made.body.booking ?? made.body.bookings?.[0];
    }
    if (!booking) continue;
    const opened = await call(
      "/api/games",
      {
        method: "POST",
        body: JSON.stringify({
          bookingCode: booking.code,
          spots: 1 + (i % 3),
          level: i % 2 ? null : pick(LEVELS),
          share: Math.round((booking.totalPrice ?? 20) / (2 + (i % 3))),
          autoAccept: i % 2 === 0,
          waitlist: true,
          intensity: pick(["casual", "competitive", "any"]),
          visibility: i === 1 ? "private" : "public",
          note: "Synthetic game for testing",
        }),
      },
      cookie,
      from
    );
    if (opened.status === 201) {
      games.push({ id: opened.body.game.id, host: player.email, visibility: opened.body.game.visibility });
      summary.games++;
    }
  }

  // And others ask to join the public ones.
  const others = ids.slice(hosts.length);
  for (const [i, g] of games.filter((x) => x.visibility === "public").entries()) {
    const p = others[i % Math.max(1, others.length)];
    if (!p) break;
    const joined = await call(`/api/games/${g.id}`, { method: "POST", body: JSON.stringify({ action: "join" }) }, await sessionFor(p.id), `10.78.${seed % 250}.${i + 1}`);
    if (joined.status === 200) summary.joined++;
  }
  summary.gameList = games;
} finally {
  await db.end();
}
console.log(JSON.stringify(summary));
