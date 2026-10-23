/// <reference types="vite/client" />
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { saveAccount } from "../src/lib/accounts";
import { registerUser } from "../src/lib/auth";
import { createAddon } from "../src/lib/addons";
import { getDb } from "../src/lib/db";
import { createLeague } from "../src/lib/leagues";
import { createNotice } from "../src/lib/notices";
import {
  createBooking,
  createClassSessions,
  createCourt,
  createPromoCode,
  createVenue,
  issuePass,
  listVenues,
  sellMembership,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { createTournament } from "../src/lib/tournaments";

/**
 * The venue boundary, swept across every admin route rather than a chosen
 * dozen.
 *
 * Another venue ("ZZB") is filled with a booking, a class, a promo, a pass, a
 * membership, an extra, a notice, a tournament, a league and staff, every
 * name carrying the marker ZZB. Then every method of every admin route is
 * called by a manager of the first venue, with every identifier it might read
 * (path, query and body) set to the other venue's. Whatever each answers:
 * - nothing it says contains the marker (nothing of the other venue leaks);
 * - none of the other venue's rows changed (nothing was written to it).
 *
 * What it does not prove: a route that refuses the request's shape before it
 * looks at who is asking is not exercised past that point. The counts of
 * answers by status are reported, so that number is visible.
 */

type Handler = (req: NextRequest, ctx?: unknown) => Response | Promise<Response>;
type Routish = Record<string, unknown>;

const MARKER = "ZZB";
let manager: string;
let theirs: {
  venue: number;
  courts: number[];
  booking: number;
  code: string;
  ids: number[];
  account: number;
  payment: number;
  user: number;
};

const routes = import.meta.glob("../src/app/api/admin/**/route.ts");

/** Every row of the other venue, as text: tables with a venue_id, and those reached through its courts. */
async function snapshot(venueId: number): Promise<string> {
  const db = getDb();
  const tables = (await db
    .prepare(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name = 'venue_id' ORDER BY table_name`
    )
    .all()) as { table_name: string }[];
  const parts: string[] = [];
  for (const { table_name } of tables) {
    const row = (await db
      .prepare(`SELECT COALESCE(string_agg(t::text, '|' ORDER BY t::text), '') AS v FROM ${table_name} t WHERE t.venue_id = ?`)
      .get(venueId)) as { v: string };
    parts.push(`${table_name}:${row.v}`);
  }
  for (const table of ["bookings", "classes", "court_outages"]) {
    const row = (await db
      .prepare(
        `SELECT COALESCE(string_agg(t::text, '|' ORDER BY t::text), '') AS v FROM ${table} t
          WHERE t.court_id IN (SELECT id FROM courts WHERE venue_id = ?)`
      )
      .get(venueId)) as { v: string };
    parts.push(`${table}:${row.v}`);
  }
  return parts.join("\n");
}

beforeAll(async () => {
  const ours = (await listVenues())[0].id;
  const mine = await createAdmin({ name: "Our Manager", email: "ours@sweep.my", password: "a long enough password", venueId: ours });
  if (!mine.ok) throw new Error(mine.error);
  manager = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(mine.admin.id)).token}`;

  const made = await createVenue({ name: `${MARKER} Arena`, area: "Ipoh", address: `${MARKER} Road`, phone: "0599990000" });
  if (!made.ok) throw new Error("venue");
  const venue = made.venue.id;
  const staff = await createAdmin({ name: `${MARKER} Manager`, email: "zzb@sweep.my", password: "a long enough password", venueId: venue });
  if (!staff.ok) throw new Error(staff.error);
  const adminId = staff.admin.id;
  const courts: number[] = [];
  for (const name of [`${MARKER} Court 1`, `${MARKER} Court 2`]) {
    const c = await createCourt({ venueId: venue, name, sport: "badminton", offPeakRate: 20, peakRate: 20 });
    if (!c.ok) throw new Error(c.error);
    courts.push(c.court.id);
  }
  const day = addDays(todayISO(), 3);
  const booking = await createBooking({ courtId: courts[0], date: day, hours: [10], name: `${MARKER} Booker`, phone: "0199990001" });
  if (!booking.ok) throw new Error(booking.error);
  const ids: number[] = [venue, ...courts, booking.booking.id, adminId];
  /** The id of whatever a successful result made, wherever the result keeps it. */
  const keep = (r: unknown, _hint?: unknown) => {
    if (!r || typeof r !== "object" || !(r as { ok?: boolean }).ok) throw new Error(`Seeding failed: ${JSON.stringify(r)}`);
    for (const [key, v] of Object.entries(r as Record<string, unknown>)) {
      if (key === "ok") continue;
      const first = Array.isArray(v) ? v[0] : v;
      if (first && typeof first === "object" && typeof (first as { id?: unknown }).id === "number") {
        ids.push((first as { id: number }).id);
        return;
      }
    }
    throw new Error(`No id in ${JSON.stringify(r).slice(0, 200)}`);
  };
  keep(
    await createClassSessions({ courtId: courts[1], name: `${MARKER} Class`, instructor: MARKER, date: day, startHour: 18, endHour: 19, capacity: 1, price: 10 }),
    (r: { classes: { id: number }[] }) => r.classes[0].id
  );
  keep(
    await createPromoCode({
      venueId: venue, code: `${MARKER}20`, description: `${MARKER} promo`, kind: "percent", value: 20,
      validFrom: todayISO(), validTo: addDays(day, 30), maxUses: 10, adminId,
    }),
    (r: { promo: { id: number } }) => r.promo.id
  );
  keep(
    await issuePass({ venueId: venue, name: `${MARKER} Pass`, entries: 5, price: 50, holderName: `${MARKER} Holder`, holderPhone: "0199990002", expiresOn: addDays(day, 60), adminId }),
    (r: { pass: { id: number } }) => r.pass.id
  );
  keep(
    await sellMembership({ venueId: venue, holderName: `${MARKER} Member`, holderPhone: "0199990003", startsOn: todayISO(), expiresOn: addDays(day, 90), price: 100, adminId }),
    (r: { membership: { id: number } }) => r.membership.id
  );
  keep(await createAddon(venue, { name: `${MARKER} Shuttles`, kind: "sale", price: 5 } as never), (r: { addon: { id: number } }) => r.addon.id);
  keep(
    await createNotice({ venueId: venue, text: `${MARKER} notice for players`, startsOn: todayISO(), endsOn: day }, adminId),
    (r: { notice: { id: number } }) => r.notice.id
  );
  keep(
    await createTournament(
      { venueId: venue, name: `${MARKER} Cup`, sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 0, maxEntries: 8, startsOn: addDays(day, 7), endsOn: addDays(day, 7), startHour: 9, endHour: 12, courtIds: [courts[1]] } as never,
      adminId
    ),
    (r: { value: { id: number } }) => r.value.id
  );
  keep(
    await createLeague({ venueId: venue, name: `${MARKER} League`, sport: "badminton", teamSize: 1, level: null, fee: 0, startsOn: addDays(day, 7) }, adminId),
    (r: { value: { id: number } }) => r.value.id
  );
  const account = await saveAccount(venue, { name: `${MARKER} School`, email: "bursar@zzb.my" });
  if (!account.ok) throw new Error(account.error);
  // An online payment owed back at the other venue, for the refund route.
  const payment = (await getDb()
    .prepare(
      `INSERT INTO online_payments (venue_id, provider, bill_id, url, amount, status, refund_due, payer_name)
       VALUES (?, 'billplz', 'zzb-bill', 'https://example.invalid', 20, 'paid', 20, ?) RETURNING id`
    )
    .get(venue, `${MARKER} Payer`)) as { id: number };
  const user = await registerUser({ name: "Credit Holder", email: "holder@sweep.my", phone: "0199990009", password: "a long enough password" });
  if (!user.ok) throw new Error(user.error);
  theirs = {
    venue, courts, booking: booking.booking.id, code: booking.booking.code, ids: [...new Set(ids)],
    account: account.account.id, payment: payment.id, user: user.user.id,
  };
});

function request(file: string, method: string, id: number): { req: NextRequest; params: Record<string, string> } {
  const path = file.replace("../src/app/api", "/api").replace("/route.ts", "");
  const params: Record<string, string> = {};
  for (const [, name] of path.matchAll(/\[([^\]]+)\]/g)) params[name] = String(id);
  const query = new URLSearchParams({
    venueId: String(theirs.venue),
    courtId: String(theirs.courts[0]),
    bookingId: String(theirs.booking),
    id: String(id),
    code: theirs.code,
    date: addDays(todayISO(), 3),
    from: todayISO(),
    to: addDays(todayISO(), 30),
    start: todayISO(),
    q: "someone",
    phone: "0199990001",
  });
  const url = `http://localhost${path.replace(/\[([^\]]+)\]/g, String(id))}?${query}`;
  const body = {
    venueId: theirs.venue,
    courtId: theirs.courts[0],
    courtIds: theirs.courts,
    bookingId: theirs.booking,
    bookingIds: [theirs.booking],
    code: theirs.code,
    codes: [theirs.code],
    id,
    ids: [id],
  };
  const init: { method: string; headers: Record<string, string>; body?: string } = {
    method,
    headers: { "content-type": "application/json", cookie: manager },
  };
  if (method !== "GET") init.body = JSON.stringify(body);
  return { req: new NextRequest(url, init), params };
}

describe("every admin route, called by another venue's manager with this venue's identifiers", () => {
  const statuses = new Map<number, number>();
  /** Routes that answered 400 every time: refused the request's shape before anything else. */
  const shapeOnly = new Map<string, Set<number>>();

  for (const [file, load] of Object.entries(routes)) {
    // Signing in, out and the like act on the caller's own account only.
    if (file.includes("/auth/")) continue;
    it(`${file.replace("../src/app/api", "")} neither shows nor changes it`, async () => {
      const mod = (await load()) as Routish;
      const before = await snapshot(theirs.venue);
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        if (typeof mod[method] !== "function") continue;
        // A route with an id in its path is tried with each of the other venue's ids.
        for (const id of file.includes("[") ? theirs.ids : [theirs.booking]) {
          const { req, params } = request(file, method, id);
          const res = await (mod[method] as Handler)(req, { params: Promise.resolve(params) });
          statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
          const seen = shapeOnly.get(`${method} ${file}`) ?? new Set<number>();
          shapeOnly.set(`${method} ${file}`, seen.add(res.status));
          const text = await res.text();
          expect(text.includes(MARKER), `${method} ${file} (id ${id}) answered ${res.status} with the other venue's data`).toBe(false);
        }
      }
      expect(await snapshot(theirs.venue), `${file} changed the other venue's rows`).toBe(before);
    });
  }

  it("reports how the routes answered", () => {
    // Visible in the test output: how many calls were refused (403/404), how
    // many rejected the request's shape (400), and how many answered for the
    // caller's own venue instead (2xx).
    console.log("tenant sweep statuses:", Object.fromEntries([...statuses].sort((a, b) => a[0] - b[0])));
    const unproven = [...shapeOnly].filter(([, s]) => s.size === 1 && s.has(400)).map(([route]) => route.replace("../src/app/api", ""));
    console.log("answered only 400 (not exercised past validation):", unproven);
    expect(statuses.size).toBeGreaterThan(0);
  });
});

/**
 * The routes the sweep above only reached as far as their input checks, asked
 * properly: each a write that matters (money, the court sheet), aimed at the
 * other venue. Each must refuse, and change nothing there.
 */
describe("the writes the sweep could not reach, asked in the right shape", () => {
  const day = () => addDays(todayISO(), 3);
  const cases: [string, string, () => Promise<Routish>, () => Record<string, unknown>][] = [
    ["issue an account invoice", "POST", () => import("../src/app/api/admin/accounts/invoices/route"), () => ({ accountId: theirs.account, period: todayISO().slice(0, 7) })],
    ["block a court", "POST", () => import("../src/app/api/admin/blocks/route"), () => ({ courtId: theirs.courts[1], date: day(), hours: [14], reason: "x" })],
    ["unblock a court", "DELETE", () => import("../src/app/api/admin/blocks/route"), () => ({ courtId: theirs.courts[1], date: day(), hours: [14] })],
    ["reschedule a booking", "POST", () => import("../src/app/api/admin/bookings/reschedule/route"), () => ({ code: theirs.code, date: day(), startHour: 15 })],
    ["hand out kit on a booking", "POST", () => import("../src/app/api/admin/hire/route"), () => ({ venueId: theirs.venue, code: theirs.code, action: "take", deposit: 0 })],
    ["mark a no-show", "POST", () => import("../src/app/api/admin/no-show/route"), () => ({ code: theirs.code, noShow: true })],
    ["mark a refund made", "POST", () => import("../src/app/api/admin/online-payments/route"), () => ({ venueId: theirs.venue, paymentId: theirs.payment })],
    ["mark a booking paid", "POST", () => import("../src/app/api/admin/payments/route"), () => ({ code: theirs.code, paid: true, via: "cash" })],
    // Credit is per venue only where MYSENAM_CREDIT_SCOPE=venue; with the
    // default (platform) it belongs to the install, and any staff may sell it.
    ["top up credit there", "POST", () => import("../src/app/api/admin/wallet/route"), () => ({ venueId: theirs.venue, userId: theirs.user, amount: 50 })],
  ];
  for (const [what, method, load, body] of cases)
    it(`cannot ${what} at another venue`, async () => {
      if (what.startsWith("top up")) vi.stubEnv("MYSENAM_CREDIT_SCOPE", "venue");
      const before = await snapshot(theirs.venue);
      const mod = (await load()) as Routish;
      const req = new NextRequest(`http://localhost/api/admin/x?venueId=${theirs.venue}`, {
        method,
        headers: { "content-type": "application/json", cookie: manager },
        body: JSON.stringify(body()),
      });
      const res = await (mod[method] as Handler)(req, { params: Promise.resolve({}) });
      expect([403, 404], `${what} answered ${res.status}`).toContain(res.status);
      expect((await res.text()).includes(MARKER)).toBe(false);
      expect(await snapshot(theirs.venue)).toBe(before);
      vi.unstubAllEnvs();
    });
});

/**
 * The same between customers: every route under /api/my, called by one
 * customer with another's identifiers, shows nothing of theirs and changes
 * nothing of theirs.
 */
describe("every my/ route, called by another customer with this customer's identifiers", () => {
  const mine = import.meta.glob("../src/app/api/my/**/route.ts");
  let caller: string;
  let target: { user: number; ids: number[]; code: string };

  /** Everything filed against the other customer: rows with their user_id, and bookings in their name. */
  async function theirRows(userId: number): Promise<string> {
    const db = getDb();
    const tables = (await db
      .prepare(
        `SELECT table_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND column_name = 'user_id' ORDER BY table_name`
      )
      .all()) as { table_name: string }[];
    const parts: string[] = [];
    for (const { table_name } of tables) {
      // Their sessions come and go with nothing they did; the sweep is about their data.
      if (table_name === "sessions") continue;
      const row = (await db
        .prepare(`SELECT COALESCE(string_agg(t::text, '|' ORDER BY t::text), '') AS v FROM ${table_name} t WHERE t.user_id = ?`)
        .get(userId)) as { v: string };
      parts.push(`${table_name}:${row.v}`);
    }
    parts.push((await db.prepare("SELECT row_to_json(u)::text AS v FROM users u WHERE id = ?").get(userId) as { v: string }).v);
    return parts.join("\n");
  }

  beforeAll(async () => {
    const me = await registerUser({ name: "Caller", email: "caller@sweep.my", phone: "0128880001", password: "a long enough password" });
    if (!me.ok) throw new Error(me.error);
    const { createSession, SESSION_COOKIE } = await import("../src/lib/auth");
    caller = `${SESSION_COOKIE}=${(await createSession(me.user.id)).token}`;

    const them = await registerUser({ name: `${MARKER} Customer`, email: "zzb-customer@sweep.my", phone: "0128880002", password: "a long enough password" });
    if (!them.ok) throw new Error(them.error);
    const venue = (await listVenues())[0];
    const court = venue.courts.find((c) => c.sport === "badminton")!;
    const day = addDays(todayISO(), 4);
    const booking = await createBooking({ courtId: court.id, date: day, hours: [16], name: `${MARKER} Customer`, phone: "0128880002", userId: them.user.id });
    if (!booking.ok) throw new Error(booking.error);
    const pass = await issuePass({ venueId: venue.id, name: `${MARKER} Pass`, entries: 5, price: 50, holderName: `${MARKER} Customer`, holderPhone: "0128880002", expiresOn: addDays(day, 60), adminId: null, userId: them.user.id });
    if (!pass.ok) throw new Error(pass.error);
    const membership = await sellMembership({ venueId: venue.id, holderName: `${MARKER} Customer`, holderPhone: "0128880002", startsOn: todayISO(), expiresOn: addDays(day, 90), price: 100, userId: them.user.id });
    if (!membership.ok) throw new Error(membership.error);
    target = {
      user: them.user.id,
      ids: [them.user.id, booking.booking.id, pass.pass.id, membership.membership.id],
      code: booking.booking.code,
    };
  });

  for (const [file, load] of Object.entries(mine)) {
    it(`${file.replace("../src/app/api", "")} neither shows nor changes it`, async () => {
      const mod = (await load()) as Routish;
      const before = await theirRows(target.user);
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        if (typeof mod[method] !== "function") continue;
        // Erasing or exporting acts on the caller only; erasing the caller would end the sweep.
        if (file.includes("/erase/") && method !== "GET") continue;
        for (const id of target.ids) {
          const path = file.replace("../src/app/api", "/api").replace("/route.ts", "").replace(/\[[^\]]+\]/g, String(id));
          const params = Object.fromEntries([...file.matchAll(/\[([^\]]+)\]/g)].map(([, n]) => [n, String(id)]));
          const query = new URLSearchParams({ id: String(id), code: target.code, userId: String(target.user), bookingId: String(id) });
          const init: { method: string; headers: Record<string, string>; body?: string } = {
            method,
            headers: { "content-type": "application/json", cookie: caller },
          };
          if (method !== "GET")
            init.body = JSON.stringify({ id, ids: [id], code: target.code, userId: target.user, bookingId: id, passId: id, membershipId: id });
          const res = await (mod[method] as Handler)(new NextRequest(`http://localhost${path}?${query}`, init), {
            params: Promise.resolve(params),
          });
          expect((await res.text()).includes(MARKER), `${method} ${file} (id ${id}) showed another customer's data`).toBe(false);
        }
      }
      expect(await theirRows(target.user), `${file} changed another customer's rows`).toBe(before);
    });
  }
});
