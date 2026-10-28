import { beforeAll, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { NextRequest } from "next/server";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { runStep } from "../src/lib/db-steps";
import { FEED_DAYS, feedStatus } from "../src/lib/staff-calendar";
import { createVenue } from "../src/lib/store";
import * as adminFeed from "../src/app/api/admin/calendar-feed/route";
import { GET as feedGet } from "../src/app/api/calendar/[token]/route";

/**
 * A venue's staff calendar feed is a bearer link to its customers' names and
 * numbers, so it is kept as coaches' links are (S16): only its hash is
 * stored, the address is shown once when a manager makes it, and it lapses
 * after `FEED_DAYS`, when a manager makes a new one. Each change is in the
 * activity log. Migration 0240 keeps addresses already given working, by
 * their hash, for a year.
 */

let venueId: number;
let cookie: string;

const asStaff = (url: string, method = "GET", body?: unknown) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const fetchFeed = async (token: string) =>
  (await feedGet(new NextRequest(`http://localhost/api/calendar/${token}.ics`), { params: Promise.resolve({ token: `${token}.ics` }) })).status;
const stored = async () =>
  (await getDb()
    .prepare("SELECT calendar_token, calendar_feed_hash FROM venues WHERE id = ?")
    .get(venueId)) as { calendar_token: string | null; calendar_feed_hash: string | null };

beforeAll(async () => {
  const v = await createVenue({ name: "Hash Hall", area: "PJ", address: "x", phone: "0377771234" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const a = await createAdmin({ name: "Feed Manager", email: "feed-manager@x.my", password: "a long enough password", venueId });
  if (!a.ok) throw new Error(a.error);
  cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(a.admin.id)).token}`;
});

describe("the staff calendar feed's address", () => {
  let token: string;

  it("is shown once, when made, and kept only as its hash", async () => {
    const res = await adminFeed.POST(asStaff("http://localhost/api/admin/calendar-feed", "POST", { venueId, on: true }));
    expect(res.status).toBe(200);
    const made = (await res.json()) as { url: string; on: boolean; expiresAt: string; lapsed: boolean };
    expect(made).toMatchObject({ on: true, lapsed: false });
    token = /\/api\/calendar\/([A-Za-z0-9_-]+)\.ics/.exec(made.url)![1];
    const days = (Date.parse(made.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(FEED_DAYS - 1);
    expect(days).toBeLessThanOrEqual(FEED_DAYS);

    const row = await stored();
    expect(row.calendar_token).toBeNull();
    expect(row.calendar_feed_hash).toBe(crypto.createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(await getDb().prepare("SELECT * FROM venues WHERE id = ?").get(venueId))).not.toContain(token);

    const again = (await (await adminFeed.GET(asStaff(`http://localhost/api/admin/calendar-feed?venueId=${venueId}`))).json()) as Record<string, unknown>;
    expect(again).toMatchObject({ url: null, on: true, lapsed: false, expiresAt: made.expiresAt });
    expect(JSON.stringify(again)).not.toContain(token);
    expect(await fetchFeed(token)).toBe(200);
  });

  it("lapses at its expiry: the feed answers nothing and staff are told to make a new one", async () => {
    await getDb().prepare("UPDATE venues SET calendar_feed_expires_at = now() - interval '1 minute' WHERE id = ?").run(venueId);
    expect(await fetchFeed(token)).toBe(404);
    expect(await feedStatus(venueId)).toMatchObject({ on: true, lapsed: true });

    const res = await adminFeed.POST(asStaff("http://localhost/api/admin/calendar-feed", "POST", { venueId, on: true }));
    const fresh = (await res.json()) as { url: string };
    const next = /\/api\/calendar\/([A-Za-z0-9_-]+)\.ics/.exec(fresh.url)![1];
    expect(next).not.toBe(token);
    expect(await fetchFeed(next)).toBe(200);
    expect(await fetchFeed(token)).toBe(404);
    expect(await feedStatus(venueId)).toMatchObject({ on: true, lapsed: false });
  });

  it("is turned off, and every change is in the activity log", async () => {
    const res = await adminFeed.POST(asStaff("http://localhost/api/admin/calendar-feed", "POST", { venueId, on: false }));
    expect(await res.json()).toMatchObject({ url: null, on: false });
    expect(await stored()).toMatchObject({ calendar_token: null, calendar_feed_hash: null });
    const log = (await listActivity([venueId])).filter((a) => a.detail?.startsWith("Calendar feed"));
    expect(log.map((a) => a.detail)).toEqual(["Calendar feed: off", "Calendar feed: new address", "Calendar feed: new address"]);
    expect(log.every((a) => a.adminName === "Feed Manager")).toBe(true);
  });

  it("refuses a body that is not an object", async () => {
    const res = await adminFeed.POST(new NextRequest("http://localhost/api/admin/calendar-feed", { method: "POST", headers: { "content-type": "application/json", cookie }, body: "null" }));
    expect(res.status).toBe(400);
  });
});

const DIR = path.join(__dirname, "..", "db", "migrations");
const FILES = fs.readdirSync(DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

async function run(db: PGlite, files: string[]): Promise<void> {
  for (const f of files) {
    const version = f.replace(/\.sql$/, "");
    await db.transaction(async (tx) => {
      await tx.exec(fs.readFileSync(path.join(DIR, f), "utf8"));
      await runStep(version, { query: async (sql, params) => ({ rows: (await tx.query(sql, params)).rows as Record<string, unknown>[] }) });
    });
  }
}

describe("migration 0240 on venues with a feed already given", () => {
  it("keeps each address working by its hash for a year, and removes the plain token", async () => {
    const db = new PGlite({ extensions: { citext } });
    await run(db, FILES.filter((f) => f < "0240"));
    const token = crypto.randomBytes(24).toString("base64url");
    await db.query("INSERT INTO venues (name, area, address, phone, calendar_token) VALUES ('Old Hall', 'PJ', 'x', '031', $1)", [token]);
    await db.query("INSERT INTO venues (name, area, address, phone) VALUES ('No Feed', 'PJ', 'x', '032')");

    await run(db, FILES.filter((f) => f >= "0240"));

    const rows = (await db.query<{ name: string; calendar_token: string | null; calendar_feed_hash: string | null; days: number | null }>(
      "SELECT name, calendar_token, calendar_feed_hash, EXTRACT(EPOCH FROM calendar_feed_expires_at - now()) / 86400 AS days FROM venues WHERE name IN ('Old Hall', 'No Feed') ORDER BY name DESC"
    )).rows;
    expect(rows[0].name).toBe("Old Hall");
    expect(rows[0].calendar_token).toBeNull();
    expect(rows[0].calendar_feed_hash).toBe(crypto.createHash("sha256").update(token).digest("hex"));
    expect(Number(rows[0].days)).toBeGreaterThan(364);
    expect(rows[1]).toMatchObject({ calendar_token: null, calendar_feed_hash: null, days: null });
    await db.close();
  }, 120_000);
});
