import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { hasTradingHistory, seedDemoData } from "../src/lib/demo";
import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

let adminId: number;

beforeAll(() => {
  ensureBootstrapAdmin();
  adminId = listAdmins()[0].id;
});

const count = (sql: string, ...args: unknown[]) =>
  (getDb().prepare(sql).get(...args) as { n: number }).n;

describe("filling an empty install", () => {
  it("writes a fortnight either side of today", () => {
    expect(hasTradingHistory()).toBe(false);

    const result = seedDemoData({ adminId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.bookings).toBeGreaterThan(40);
    expect(result.cancelled).toBeGreaterThan(0);
    expect(result.noShows).toBeGreaterThan(0);
    expect(result.classes).toBeGreaterThan(0);
    expect(result.extras.length).toBeGreaterThan(3);

    const today = todayISO();
    // Both directions, so the reports tab and the day list both have something.
    expect(count("SELECT COUNT(*) AS n FROM bookings WHERE date < ?", today)).toBeGreaterThan(10);
    expect(count("SELECT COUNT(*) AS n FROM bookings WHERE date > ?", today)).toBeGreaterThan(10);
    expect(count("SELECT COUNT(*) AS n FROM bookings WHERE date > ?", addDays(today, 20))).toBe(0);
  });

  it("fills every screen a newcomer would open", () => {
    expect(count("SELECT COUNT(*) AS n FROM check_ins")).toBeGreaterThan(0);
    expect(count("SELECT COUNT(*) AS n FROM classes")).toBeGreaterThan(0);
    expect(count("SELECT COUNT(*) AS n FROM bookings WHERE class_id IS NOT NULL")).toBeGreaterThan(0);
    expect(count("SELECT COUNT(*) AS n FROM passes")).toBeGreaterThan(0);
    expect(count("SELECT COUNT(*) AS n FROM memberships")).toBeGreaterThan(0);
    expect(count("SELECT COUNT(*) AS n FROM promo_codes")).toBeGreaterThan(0);
    expect(count("SELECT COUNT(*) AS n FROM wallet_entries")).toBeGreaterThan(0);
    expect(count("SELECT COUNT(*) AS n FROM slot_blocks")).toBeGreaterThan(0);
    expect(count("SELECT COUNT(*) AS n FROM venue_closures")).toBeGreaterThan(0);
    expect(count("SELECT COUNT(*) AS n FROM inductions")).toBeGreaterThan(0);
    expect(count("SELECT COUNT(*) AS n FROM users")).toBeGreaterThan(0);
  });

  it("never sells the same hour twice, however it was written", () => {
    const clashes = count(`
      SELECT COUNT(*) AS n FROM (
        SELECT court_id, date, hour, seat, COUNT(*) AS c
        FROM booking_slots GROUP BY court_id, date, hour, seat HAVING c > 1
      )
    `);
    expect(clashes).toBe(0);
    // And nothing was sold above a resource's capacity.
    const over = count(`
      SELECT COUNT(*) AS n FROM (
        SELECT s.court_id, s.date, s.hour, COUNT(*) AS taken, c.capacity
        FROM booking_slots s JOIN courts c ON c.id = s.court_id
        GROUP BY s.court_id, s.date, s.hour HAVING taken > c.capacity
      )
    `);
    expect(over).toBe(0);
  });

  it("prices every booking the way the venue would have", () => {
    const wrong = count("SELECT COUNT(*) AS n FROM bookings WHERE total_price <= 0");
    expect(wrong).toBe(0);
    // Evenings cost more than mornings on the same court.
    const court = listVenues()[0].courts[0].id;
    const evening = getDb()
      .prepare("SELECT total_price AS p FROM bookings WHERE court_id = ? AND start_hour >= 19 LIMIT 1")
      .get(court) as { p: number } | undefined;
    const morning = getDb()
      .prepare("SELECT total_price AS p FROM bookings WHERE court_id = ? AND start_hour <= 10 LIMIT 1")
      .get(court) as { p: number } | undefined;
    if (evening && morning) expect(evening.p).toBeGreaterThanOrEqual(morning.p);
  });

  it("leaves no cancelled booking holding a court", () => {
    const held = count(`
      SELECT COUNT(*) AS n FROM booking_slots s
      JOIN bookings b ON b.id = s.booking_id
      WHERE b.status = 'cancelled'
    `);
    expect(held).toBe(0);
  });

  it("refuses to run a second time, because that install now trades", () => {
    expect(hasTradingHistory()).toBe(true);
    const again = seedDemoData({ adminId });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain("already taken bookings");
  });
});
