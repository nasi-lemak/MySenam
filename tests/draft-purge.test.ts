import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_MARKETPLACE = "on";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { submitApplication } from "../src/lib/applications";
import { getDb } from "../src/lib/db";
import { deleteStaleDrafts, draftDeletionPlan, foreignKeysByParent, staleDrafts } from "../src/lib/drafts";
import * as privacy from "../src/lib/privacy";
import { createLadder } from "../src/lib/ladders";
import { createCourt } from "../src/lib/store";
import { createTournament } from "../src/lib/tournaments";
import { addDays, todayISO } from "../src/lib/time";

/**
 * The stale-draft purge (lib/drafts.ts), which runs inside the daily retention run: a draft that set up more than
 * a court (a ladder, a tournament match on its court, ...) is still removed; what stops one business from being
 * removed is left and reported and never stops the retention run or a dashboard load.
 */

let n = 0;
async function signUp() {
  n++;
  const applied = await submitApplication({
    businessName: `Stale Hall ${n}`,
    area: "Seremban",
    address: `${n} Jalan Draf`,
    venuePhone: "0600000000",
    contactName: "Dee",
    email: `stale${n}@draft.my`,
    password: "a long enough password",
    lat: 2.7 + n * 0.01,
    lng: 101.94,
  });
  if (!applied.ok) throw new Error(applied.error);
  const venueId = applied.application.venueId!;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 12, peakRate: 18 });
  if (!court.ok) throw new Error("court");
  const manager = (await authenticateAdmin(`stale${n}@draft.my`, "a long enough password"))!;
  await getDb()
    .prepare(
      `UPDATE admins SET last_seen_at = datetime('now', '-200 days'), created_at = datetime('now', '-200 days')
        WHERE business_id = (SELECT business_id FROM venues WHERE id = ?)`
    )
    .run(venueId);
  return { venueId, courtId: court.court.id, manager };
}

const purge = () => getDb().transaction(async () => deleteStaleDrafts([]))();
const venueGone = async (id: number) => (await getDb().prepare("SELECT 1 FROM venues WHERE id = ?").get(id)) === undefined;

beforeAll(async () => {
  await ensureBootstrapAdmin();
});

describe("a stale draft that set up more than a court", () => {
  it("with a ladder is still deleted (does not wedge the retention run)", async () => {
    const { venueId, manager } = await signUp();
    const l = await createLadder(
      { venueId, name: "Draft Ladder", sport: "badminton", teamSize: 1, level: null, settings: {} },
      manager.id
    );
    expect(l.ok, JSON.stringify(l)).toBe(true);
    expect((await staleDrafts()).flatMap((d) => d.venueIds)).toContain(venueId);
    await expect(purge()).resolves.toBeGreaterThanOrEqual(1);
    expect(await venueGone(venueId)).toBe(true);
  });

  it("does not stop the rest of the daily retention run (pruneOldData)", async () => {
    await expect(privacy.pruneOldData()).resolves.toBeTruthy();
  });

  it("does not break every staff member's dashboard load (/api/admin/auth/me runs pruneIfDue)", async () => {
    await getDb().prepare("DELETE FROM settings WHERE key = 'retention_last_run'").run();
    const owner = (await listAdmins()).find((a) => a.venueId === null && a.businessId === null)!;
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
    const { GET } = await import("../src/app/api/admin/auth/me/route");
    const res = await GET(new NextRequest("http://localhost/api/admin/auth/me", { headers: { cookie } }));
    expect(res.status).toBe(200);
  });

  it("with a tournament match put on its court is still deleted", async () => {
    const { venueId, courtId, manager } = await signUp();
    const t = await createTournament(
      {
        venueId, name: "Draft Cup", sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 0,
        maxEntries: 8, startsOn: addDays(todayISO(), 7), endsOn: addDays(todayISO(), 7), startHour: 9, endHour: 18, courtIds: [courtId],
      } as never,
      manager.id
    );
    expect(t.ok, JSON.stringify(t)).toBe(true);
    await expect(purge()).resolves.toBeGreaterThanOrEqual(1);
    expect(await venueGone(venueId)).toBe(true);
  });

  it("with an urgent notice, a WhatsApp pack bought and spent from, and a register is still deleted, with nothing left pointing at it", async () => {
    const { venueId } = await signUp();
    const db = getDb();
    await db
      .prepare("INSERT INTO urgent_notices (venue_id, kind, name, phone, date, start_min, summary, ack_token) VALUES (?, 'cancelled', 'X', '0100000000', '2030-01-01', 540, 's', ?)")
      .run(venueId, `tok-${venueId}`);
    const pack = (await db.prepare("INSERT INTO whatsapp_packs (venue_id, messages, amount) VALUES (?, 100, 10) RETURNING id").get(venueId)) as { id: number };
    await db.prepare("INSERT INTO whatsapp_credit (venue_id, delta, reason, pack_id) VALUES (?, 100, 'bought', ?)").run(venueId, pack.id);
    await db.prepare("INSERT INTO attendance_sessions (kind, session_id, venue_id, session_date) VALUES ('class', 1, ?, '2030-01-01')").run(venueId);
    expect((await staleDrafts()).flatMap((d) => d.venueIds)).toContain(venueId);
    await expect(purge()).resolves.toBeGreaterThanOrEqual(1);
    expect(await venueGone(venueId)).toBe(true);
    for (const t of ["urgent_notices", "whatsapp_packs", "whatsapp_credit", "attendance_sessions"])
      expect(await db.prepare(`SELECT 1 FROM ${t} WHERE venue_id = ?`).get(venueId), t).toBeUndefined();
  });

  it("leaves a draft somebody signed in to lately and a draft holding a record of money alone", async () => {
    const stale = await signUp();
    const fresh = await signUp();
    await getDb().prepare("UPDATE admins SET last_seen_at = datetime('now') WHERE business_id = (SELECT business_id FROM venues WHERE id = ?)").run(fresh.venueId);
    const withMoney = await signUp();
    await getDb()
      .prepare("INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, status, purpose) VALUES ('billplz', ?, 'https://x', ?, 5, 'paid', 'booking')")
      .run(`bp-keep-${withMoney.venueId}`, withMoney.venueId);
    await purge();
    expect(await venueGone(stale.venueId)).toBe(true);
    expect(await venueGone(fresh.venueId)).toBe(false);
    expect(await venueGone(withMoney.venueId)).toBe(false);
  });

  it("one draft that cannot be deleted is left and reported, the others still go, and the retention run completes", async () => {
    const bad = await signUp();
    const good = await signUp();
    const db = getDb();
    // A trigger refusing one venue's delete stands in for any future blocker the foreign keys do not show.
    await db
      .prepare(
        `CREATE OR REPLACE FUNCTION draft_purge_refuses() RETURNS trigger AS $$ BEGIN
           IF OLD.id = ${bad.venueId} THEN RAISE EXCEPTION 'blocked on purpose'; END IF; RETURN OLD; END $$ LANGUAGE plpgsql`
      )
      .run();
    await db.prepare("CREATE TRIGGER draft_purge_refuses BEFORE DELETE ON venues FOR EACH ROW EXECUTE FUNCTION draft_purge_refuses()").run();
    try {
      await db.prepare("DELETE FROM system_alerts WHERE key = 'retention:stale-draft-not-deleted'").run();
      await expect(purge()).resolves.toBeGreaterThanOrEqual(1);
      expect(await venueGone(bad.venueId)).toBe(false);
      expect(await venueGone(good.venueId)).toBe(true);
      // The business that failed is whole again (its savepoint rolled back) and the owners are told.
      expect(await db.prepare("SELECT 1 FROM courts WHERE id = ?").get(bad.courtId)).toBeDefined();
      const alert = (await db.prepare("SELECT last_detail FROM system_alerts WHERE key = 'retention:stale-draft-not-deleted'").get()) as { last_detail: string } | undefined;
      expect(alert?.last_detail).toContain("blocked on purpose");
      await db.prepare("DELETE FROM settings WHERE key = 'retention_last_run'").run();
      await expect(privacy.pruneOldData()).resolves.toBeTruthy();
      expect(await privacy.retentionLastRun()).not.toBeNull();
    } finally {
      await db.prepare("DROP TRIGGER draft_purge_refuses ON venues").run();
      await db.prepare("DROP FUNCTION draft_purge_refuses()").run();
    }
  });

  it("the dashboard opens when the housekeeping throws, and the owners are told", async () => {
    vi.spyOn(privacy, "pruneIfDue").mockRejectedValueOnce(new Error("housekeeping exploded"));
    const owner = (await listAdmins()).find((a) => a.venueId === null && a.businessId === null)!;
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
    const { GET } = await import("../src/app/api/admin/auth/me/route");
    const res = await GET(new NextRequest("http://localhost/api/admin/auth/me", { headers: { cookie } }));
    vi.restoreAllMocks();
    expect(res.status).toBe(200);
    const alert = (await getDb().prepare("SELECT last_detail FROM system_alerts WHERE key = 'scheduler:retention-failed'").get()) as { last_detail: string } | undefined;
    expect(alert?.last_detail).toContain("housekeeping exploded");
  });
});

describe("the purge finds what points at a draft from the foreign keys", () => {
  it("covers every table that points at businesses, venues and courts with NO ACTION, without a hand-kept list", async () => {
    const plan = draftDeletionPlan(await foreignKeysByParent(), "businesses", "id = 1").join("\n");
    for (const t of ["ladders", "attendance_sessions", "attendance_marks", "lesson_moves", "urgent_notices", "whatsapp_credit", "whatsapp_packs", "invoice_lines", "tournament_matches", "waitlist", "bookings", "classes", "courts", "admins", "venue_applications", "messages"])
      expect(plan, t).toContain(`DELETE FROM ${t} WHERE`);
  });

  it("no foreign key that blocks a delete is over more than one column (the walk follows single-column keys)", async () => {
    const rows = (await getDb()
      .prepare("SELECT conrelid::regclass::text AS t FROM pg_constraint WHERE contype = 'f' AND cardinality(conkey) > 1 AND confdeltype IN ('a', 'r')")
      .all()) as { t: string }[];
    expect(rows.map((r) => r.t)).toEqual([]);
  });

  it("a table added later that references venues with NO ACTION is purged without anyone editing a list", async () => {
    const db = getDb();
    await db.prepare("CREATE TABLE zz_later_table (id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, venue_id INTEGER NOT NULL REFERENCES venues(id))").run();
    try {
      const { venueId } = await signUp();
      await db.prepare("INSERT INTO zz_later_table (venue_id) VALUES (?)").run(venueId);
      await expect(purge()).resolves.toBeGreaterThanOrEqual(1);
      expect(await venueGone(venueId)).toBe(true);
      expect(await db.prepare("SELECT 1 FROM zz_later_table").get()).toBeUndefined();
    } finally {
      await db.prepare("DROP TABLE zz_later_table").run();
    }
  });
});
