import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_MARKETPLACE = "on";
process.env.MYSENAM_GEOCODER = "off";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdmin, createAdminSession, type Admin } from "../src/lib/admin-auth";
import { listActivity } from "../src/lib/activity";
import { addBranch, submitApplication } from "../src/lib/applications";
import { createAddon } from "../src/lib/addons";
import { updatePolicy } from "../src/lib/booking-policy";
import { COPIED_TABLES, VENUE_SETTINGS } from "../src/lib/branch-copy";
import { saveConcession } from "../src/lib/concessions";
import { setCourtParts } from "../src/lib/court-links";
import { setCourtRates, setHoursChange } from "../src/lib/dated-changes";
import { getDb } from "../src/lib/db";
import { setHouseRules } from "../src/lib/house-rules";
import { createPlan } from "../src/lib/membership-plans";
import { createPassProduct } from "../src/lib/pass-products";
import { addHoliday, setPeakRules } from "../src/lib/peak";
import { setSportRules } from "../src/lib/sport-rules";
import { createBooking, createCourt, getAvailability, getCourt, issuePass, quoteFor, setPaymentStatus } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { setWaiver } from "../src/lib/waivers";
import { POST as branchesPost } from "../src/app/api/admin/branches/route";

/**
 * X1-15: a business manager starts a new branch from another's set-up. The
 * copy prices and opens as its source does, today and on a later date the
 * source has hours and rates set from; and nothing of a person or of money,
 * nor any account or secret, comes with it.
 */

const ZONE = "Asia/Kuala_Lumpur";
const today = todayISO(ZONE);
const later = addDays(today, 20);
let manager: Admin;
let source: number;
const courts: number[] = [];
let asManager: string;
let asDesk: string;
let copy: number;

const pin = { lat: 3.15, lng: 101.6 };
const branch = (name: string, extra: Record<string, unknown> = {}) => ({ name, area: "Cheras", address: "9 Jalan Salinan, Cheras", phone: "0391110000", ...pin, ...extra });

const call = (cookie: string, body: unknown) =>
  branchesPost(
    new NextRequest("http://localhost/api/admin/branches", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );

async function court(name: string, sport = "badminton", rates = [20, 30]) {
  const c = await createCourt({ venueId: source, name, sport: sport as "badminton", offPeakRate: rates[0], peakRate: rates[1] });
  if (!c.ok) throw new Error(c.error);
  courts.push(c.court.id);
  return c.court.id;
}

const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r;
};

beforeAll(async () => {
  const applied = await submitApplication({
    businessName: "Copy Courts",
    area: "Ampang",
    address: "1 Jalan Asal, Ampang",
    venuePhone: "0342220000",
    contactName: "Ong",
    email: "ong@copy.my",
    password: "a long enough password",
    ...pin,
  });
  if (!applied.ok) throw new Error(applied.error);
  source = applied.application.venueId!;
  await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(source);
  manager = (await authenticateAdmin("ong@copy.my", "a long enough password"))!;
  asManager = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.id)).token}`;
  const desk = await createAdmin({ name: "Dan Desk", email: "dan@copy.my", password: "desk-password-1", venueId: source, role: "desk" });
  if (!desk.ok) throw new Error("desk");
  asDesk = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;

  // The set-up: courts with member rates, a second activity at its own rates, a pitch over two courts.
  const c1 = await court("Court 1");
  const c2 = await court("Court 2", "badminton", [18, 28]);
  const pitch = await court("Pitch", "futsal", [80, 120]);
  ok(await setCourtParts(pitch, [c1, c2]));
  await getDb().prepare("UPDATE courts SET member_off_peak_rate = 15, member_peak_rate = 22, deposit = 5, access_code = '4321', unmanned = 1 WHERE id = ?").run(c1);
  await getDb().prepare("INSERT INTO court_activities (court_id, sport, off_peak_rate, peak_rate, position) VALUES (?, 'pickleball', 16, 26, 2)").run(c2);
  // Rules, peak hours, house rules, sport rules, a holiday to come.
  ok(await updatePolicy({ venue: source }, { minLength: 60, maxLength: 180 }));
  ok(await updatePolicy({ court: c1 }, { bufferAfter: 15 }));
  ok(await setPeakRules(source, { weekdayFrom: 17 * 60, weekdayUntil: 23 * 60, weekendDays: [0, 6], weekendFrom: 8 * 60, weekendUntil: 23 * 60 }));
  ok(await setHouseRules(source, { upcoming: 3, aheadDays: 30 }));
  ok(await setSportRules(source, "badminton", { cutoffHours: 6 }));
  ok(await addHoliday(source, { date: addDays(today, 10), name: "Hari Raya" }));
  await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 12, hold_minutes = 20, deposit_percent = 30, last_minute_hours = 2, last_minute_percent = 20 WHERE id = ?").run(source);
  // Hours and rates from a later date (ADR 0027).
  ok(await setHoursChange(source, { from: later, openMin: 7 * 60, closeMin: 22 * 60 }));
  ok(await setCourtRates((await getCourt(c1))!, { from: later, offPeakRate: 25, peakRate: 40 }));
  // What is on sale, the waiver.
  ok(await saveConcession(source, { name: "Student", percent: 20, proof: "a student card" }));
  ok(await createAddon(source, { name: "Racket", kind: "rental", price: 5, stock: 10 }));
  ok(await createPlan(source, { name: "Annual", months: 12, price: 300 }));
  ok(await createPassProduct(source, { name: "Ten hours", entries: 10, price: 150, validDays: 90 }, manager.id));
  ok(await setWaiver(source, "I play at my own risk and follow the venue's rules at all times."));

  // What is never copied: a customer's booking and payment, a pass sold, a closed day, accounts and secrets.
  const b = await createBooking({ courtId: c1, date: addDays(today, 2), hours: [10], name: "Cust Omer", phone: "0128880000" });
  if (!b.ok) throw new Error(b.error);
  ok(await setPaymentStatus(b.booking.code, true, "cash"));
  ok(await issuePass({ venueId: source, name: "5 hours", entries: 5, price: 80, holderName: "Pia", holderPhone: "0128880001", expiresOn: addDays(today, 60), adminId: manager.id }));
  await getDb().prepare("INSERT INTO venue_closures (venue_id, date, reason) VALUES (?, ?, 'Floor works')").run(source, addDays(today, 5));
  await getDb()
    .prepare("UPDATE venues SET alert_email = 'boss@copy.my', alert_phone = '0123334444', tax_registered = 1, tax_reg_no = 'W10-1234-56789012', calendar_token = 'secret-token', amenities = '{parking}' WHERE id = ?")
    .run(source);
  await getDb().prepare("INSERT INTO venue_blocked_phones (venue_id, phone_key, phone, reason) VALUES (?, '60120000000', '0120000000', 'abuse')").run(source);
});

describe("starting a branch from another's set-up", () => {
  it("is a business manager's: the desk is refused, and only their own business's branch may be copied", async () => {
    const desk = await call(asDesk, { ...branch("Desk Branch"), copyFrom: source });
    expect(desk.status).toBe(403);
    expect((await desk.json()).code).toBe("MANAGER_ONLY");
    const other = await submitApplication({
      businessName: "Someone Else",
      area: "Klang",
      address: "2 Jalan Lain, Klang",
      venuePhone: "0333330000",
      contactName: "Lee",
      email: "lee@else.my",
      password: "a long enough password",
      lat: 3.04,
      lng: 101.45,
    });
    if (!other.ok) throw new Error(other.error);
    expect(await addBranch(manager, { ...branch("Theirs"), copyFrom: other.application.venueId! })).toMatchObject({
      ok: false,
      error: "Start it from one of your own branches.",
    });
  });

  it("adds the branch as a draft in one go, and logs it", async () => {
    const res = await call(asManager, { ...branch("Copy Cheras"), copyFrom: source });
    expect(res.status).toBe(201);
    const body = await res.json();
    copy = body.venueId;
    expect(body.copied).toMatchObject({ fromVenueId: source, courts: 3, skippedCourts: [] });
    const v = (await getDb().prepare("SELECT published_at, business_id, name FROM venues WHERE id = ?").get(copy)) as Record<string, unknown>;
    expect(v).toMatchObject({ published_at: null, business_id: manager.businessId, name: "Copy Cheras" });
    expect((await listActivity([copy])).map((a) => a.action)).toContain("venue.branch_added");
  });

  it("copies the venue's settings", async () => {
    const cols = VENUE_SETTINGS.join(", ");
    const [a, b] = await Promise.all(
      [source, copy].map((id) => getDb().prepare(`SELECT ${cols} FROM venues WHERE id = ?`).get(id))
    );
    expect(b).toEqual(a);
  });

  it("prices and opens as the source does, today and from the later date, member and holiday prices included", async () => {
    const theirs = (await getDb().prepare("SELECT id FROM courts WHERE venue_id = ? ORDER BY id").all(copy)) as { id: number }[];
    expect(theirs).toHaveLength(courts.length);
    for (const date of [addDays(today, 1), addDays(today, 10), later, addDays(later, 3)]) {
      // The board: each court's columns, rates and starts.
      const board = async (venueId: number) =>
        (await getAvailability(venueId, date)).map((c) => ({ name: c.court.name, starts: c.starts.map((s) => s.minute), slots: c.slots.map((s) => [s.minute, s.rate]) }));
      expect(await board(copy)).toEqual(await board(source));
      for (const [i, from] of courts.entries())
        for (const start of [9 * 60, 19 * 60])
          for (const sport of [undefined, "pickleball"] as const) {
            const q = async (courtId: number) => {
              const r = await quoteFor({ courtId, date, start, minutes: 60, ...(sport ? { sport } : {}) });
              return r.ok ? { allowed: r.allowed, court: r.quote.court, total: r.quote.total } : { refused: r.code ?? r.error };
            };
            expect(await q(theirs[i].id), `court ${i} ${date} ${start} ${sport ?? ""}`).toEqual(await q(from));
          }
    }
    // Linked courts: booking the pitch takes both courts at the copy too.
    const links = (await getDb()
      .prepare("SELECT COUNT(*)::int AS n FROM court_links l JOIN courts c ON c.id = l.whole_id WHERE c.venue_id = ?")
      .get(copy)) as { n: number };
    expect(links.n).toBe(2);
    const pitch = theirs[2].id;
    const date = addDays(today, 2);
    const b = await createBooking({ courtId: pitch, date, hours: [12], name: "Futsal Team", phone: "0128880002" });
    expect(b.ok).toBe(true);
    expect((await createBooking({ courtId: theirs[0].id, date, hours: [12], name: "Clash", phone: "0128880003" })).ok).toBe(false);
  });

  it("copies what is on sale, the rules, the holiday and the waiver; keeps no door code", async () => {
    const count = async (table: string, id: number) =>
      ((await getDb().prepare(`SELECT COUNT(*)::int AS n FROM ${table} WHERE venue_id = ?`).get(id)) as { n: number }).n;
    for (const table of ["concessions", "venue_addons", "membership_plans", "pass_products", "venue_holidays", "venue_waivers", "sport_rules", "venue_hours_changes"])
      expect(await count(table, copy), table).toBe(await count(table, source));
    const doors = (await getDb().prepare("SELECT access_code, unmanned FROM courts WHERE venue_id = ?").all(copy)) as { access_code: string | null; unmanned: number }[];
    expect(doors.every((d) => d.access_code === null && !d.unmanned)).toBe(true);
    const changes = (await getDb()
      .prepare("SELECT COUNT(*)::int AS n FROM court_changes x JOIN courts c ON c.id = x.court_id WHERE c.venue_id = ?")
      .get(copy)) as { n: number };
    expect(changes.n).toBe(1);
  });

  it("copies nothing of a person or of money, no account, secret, alert contact or place of its own", async () => {
    const tables = (await getDb()
      .prepare(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND column_name IN ('venue_id', 'court_id') ORDER BY 1`
      )
      .all()) as { table_name: string; column_name: string }[];
    const allowed = new Set<string>([...COPIED_TABLES, "venue_applications", "staff_actions"]);
    const copied: string[] = [];
    for (const { table_name, column_name } of tables) {
      if (allowed.has(table_name)) continue;
      const where = column_name === "venue_id" ? "venue_id = ?" : "court_id IN (SELECT id FROM courts WHERE venue_id = ?)";
      const { n } = (await getDb().prepare(`SELECT COUNT(*)::int AS n FROM ${table_name} WHERE ${where}`).get(copy)) as { n: number };
      // The futsal booking made in the test above is the copy's own (`claims_all` is `claims` and the archive together).
      if (n > 0 && !["bookings", "claims", "claims_all", "facility_gaps"].includes(table_name)) copied.push(table_name);
    }
    expect(copied).toEqual([]);
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings b JOIN courts c ON c.id = b.court_id WHERE c.venue_id = ? AND b.name <> 'Futsal Team'").get(copy)) as { n: number }).n).toBe(0);
    const v = (await getDb()
      .prepare("SELECT alert_email, alert_phone, tax_registered, tax_reg_no, calendar_token, cardinality(amenities) AS amenities, lat, lng FROM venues WHERE id = ?")
      .get(copy)) as Record<string, unknown>;
    expect(v).toMatchObject({ alert_email: null, alert_phone: null, tax_reg_no: null, calendar_token: null, lat: pin.lat, lng: pin.lng });
    expect(Number(v.tax_registered ?? 0)).toBe(0);
    expect(v.amenities ?? 0).toBe(0);
  });

  it("leaves out a court whose activity is the source venue's own, and says so", async () => {
    await getDb()
      .prepare(
        `INSERT INTO activities (key, venue_id, category, icon, names, template, support)
         VALUES ('copy_test_wall', ?, 'specialist', 'x', '{"en":"Wall"}', '{"model":"exclusive","noun":"wall","capacity":1,"count":1,"perPlayer":false,"maxPlayers":null,"setting":null,"signOff":false}', 'basic')`
      )
      .run(source);
    await getDb().prepare("INSERT INTO courts (venue_id, name, sport, off_peak_rate, peak_rate) VALUES (?, 'Climbing wall', 'copy_test_wall', 10, 10)").run(source);
    const added = await addBranch(manager, { ...branch("Copy Two"), copyFrom: source });
    if (!added.ok) throw new Error(added.error);
    expect(added.copied).toMatchObject({ courts: 3, skippedCourts: ["Climbing wall"] });
  });
});
