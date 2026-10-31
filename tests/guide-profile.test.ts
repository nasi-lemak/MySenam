import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_MARKETPLACE = "on";
process.env.MYSENAM_GEOCODER = "off";
// No mail or WhatsApp service is reached from a test, whatever this machine has set: sign-ups then open at once, unconfirmed.
for (const name of ["SMTP_URL", "MAIL_FROM", "SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_REGION", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]) delete process.env[name];

import { NextRequest } from "next/server";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdmin, createAdminSession, ensureBootstrapAdmin, type Admin } from "../src/lib/admin-auth";
import { submitApplication } from "../src/lib/applications";
import { createAddon } from "../src/lib/addons";
import { updatePolicy } from "../src/lib/booking-policy";
import { saveCoach } from "../src/lib/coaching";
import { saveConcession } from "../src/lib/concessions";
import { setCourtParts } from "../src/lib/court-links";
import { setCourtRates, setHoursChange } from "../src/lib/dated-changes";
import { getDb } from "../src/lib/db";
import { createPlan } from "../src/lib/membership-plans";
import { createPassProduct } from "../src/lib/pass-products";
import { savePaymentSettings } from "../src/lib/payments";
import { createBooking, createClassSessions, createCourt, createPromoCode, getCourt, setPaymentStatus } from "../src/lib/store";
import { STAFF_DICTIONARIES } from "../src/lib/staff-i18n";
import { ACTION_LABELS } from "../src/lib/activity-labels";
import { addDays, todayISO } from "../src/lib/time";
import { acknowledge, dismiss, readGuide, saveAnswers, seedFromFit } from "../src/lib/guide/answers";
import { buildSetupPlan } from "../src/lib/guide/plan";
import { hasHistory, isEmptyVenue, readVenueProfile, usesOnlinePayments } from "../src/lib/guide/profile";
import { launchReadiness } from "../src/lib/guide/readiness";
import { setupView } from "../src/lib/guide/http";
import { GET as setupGet, POST as setupPost } from "../src/app/api/admin/guide/setup/route";
import { GET as playbookGet } from "../src/app/api/admin/guide/playbook/route";
import { POST as branchesPost } from "../src/app/api/admin/branches/route";
import { POST as applyPost } from "../src/app/api/venue-applications/route";

/**
 * The venue profile reads the real saved configuration and nothing else, for
 * one venue only; the guide's answers save, resume and refuse a stale save; a
 * visitor's choice in the public guide becomes a new venue's starting intent;
 * and the routes keep the guide a manager's (the desk is refused the setup and
 * is given its own playbook), tenant by tenant. See
 * docs/features/venue-guide.md.
 */

const ZONE = "Asia/Kuala_Lumpur";
const today = todayISO(ZONE);
const later = addDays(today, 20);
const pin = { lat: 3.15, lng: 101.6 };
const PASSWORD = "a long enough password";

const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

async function signUp(name: string, email: string, extra: Record<string, unknown> = {}): Promise<{ venueId: number; manager: Admin }> {
  const applied = await submitApplication({
    businessName: name,
    area: "Ampang",
    address: "1 Jalan Satu, Ampang",
    venuePhone: "0342220000",
    contactName: `Owner of ${name}`,
    email,
    password: PASSWORD,
    ...pin,
    ...extra,
  });
  if (!applied.ok) throw new Error(applied.error);
  const manager = (await authenticateAdmin(email, PASSWORD))!;
  return { venueId: applied.application.venueId!, manager };
}

const cookieOf = async (admin: Admin) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(admin.id)).token}`;

const get = (handler: typeof setupGet, path: string, cookie: string) => handler(new NextRequest(`http://localhost${path}`, { headers: { cookie } }));
const post = (cookie: string, body: unknown) =>
  setupPost(new NextRequest("http://localhost/api/admin/guide/setup", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));

let fresh: number;
let configured: number;
let trading: number;
let theirs: number;
let configuredManager: Admin;
let owner: Admin;
let asConfiguredManager: string;
let asBranchManager: string;
let asDesk: string;
let asOwner: string;
let asTheirManager: string;
let asTradingManager: string;
let hourlyCourt: number;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  owner = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!;
  asOwner = await cookieOf(owner);

  // A fresh draft: just signed up.
  fresh = (await signUp("Fresh Courts", "fresh@guide.my")).venueId;

  // A configured draft: courts, rates, hours, a dated change, a pass, a coach, a class, a payment account, staff.
  const c = await signUp("Configured Courts", "conf@guide.my");
  configured = c.venueId;
  configuredManager = c.manager;
  const court1 = ok(await createCourt({ venueId: configured, name: "Court 1", sport: "badminton", offPeakRate: 18, peakRate: 28 }));
  const court2 = ok(await createCourt({ venueId: configured, name: "Court 2", sport: "badminton", offPeakRate: 18, peakRate: 28 }));
  const pitch = ok(await createCourt({ venueId: configured, name: "Pitch", sport: "futsal", offPeakRate: 80, peakRate: 120 }));
  const studio = ok(await createCourt({ venueId: configured, name: "Studio", sport: "yoga", offPeakRate: 0, peakRate: 0, capacity: 20 }));
  hourlyCourt = court1.court.id;
  ok(await setCourtParts(pitch.court.id, [court1.court.id, court2.court.id]));
  await getDb().prepare("UPDATE courts SET classes_only = true WHERE id = ?").run(studio.court.id);
  await getDb().prepare("UPDATE courts SET member_off_peak_rate = 14, member_peak_rate = 22, deposit = 5, access_code = '4321', unmanned = 1 WHERE id = ?").run(court1.court.id);
  ok(await updatePolicy({ court: court1.court.id }, { bufferAfter: 15 }));
  ok(await setHoursChange(configured, { from: later, openMin: 7 * 60, closeMin: 22 * 60 }));
  ok(await setCourtRates((await getCourt(court1.court.id))!, { from: later, offPeakRate: 25, peakRate: 40 }));
  ok(await createPassProduct(configured, { name: "Ten hours", entries: 10, price: 150, validDays: 90 }, c.manager.id));
  ok(await createPlan(configured, { name: "Annual", months: 12, price: 300 }));
  ok(await saveConcession(configured, { name: "Student", percent: 20, proof: "a student card" }));
  ok(
    await createPromoCode({ venueId: configured, code: "OPENING", description: "Opening week", kind: "percent", value: 10, validFrom: today, validTo: addDays(today, 30), adminId: c.manager.id })
  );
  ok(await createAddon(configured, { name: "Racket", kind: "rental", price: 5, stock: 10 }));
  ok(await saveCoach(configured, { name: "Coach Karim", sports: ["badminton"], rate: 60, hours: [{ weekday: 1, from: 9 * 60, until: 17 * 60 }] }));
  ok(await saveCoach(configured, { name: "Coach Hana", sports: ["badminton"], rate: 70, hours: [] }));
  ok(await createClassSessions({ courtId: studio.court.id, name: "Morning yoga", instructor: "Ina", date: addDays(today, 3), start: 9 * 60, end: 10 * 60, capacity: 15, price: 20 }));
  ok(await savePaymentSettings(configured, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true }));
  await getDb()
    .prepare("UPDATE venues SET alert_email = 'boss@guide.my', alert_phone = '0123334444', tax_registered = 1, tax_reg_no = 'W10-SECRET-123', emergency_phone = '0129990000', staffed_from = 540, staffed_to = 1080 WHERE id = ?")
    .run(configured);
  const desk = ok(await createAdmin({ name: "Dina Desk", email: "dina@guide.my", password: "desk-password-1", venueId: configured, role: "desk" }));
  const branch = ok(await createAdmin({ name: "Bala Branch", email: "bala@guide.my", password: "branch-password-1", venueId: configured }));
  asDesk = await cookieOf(desk.admin);
  asBranchManager = await cookieOf(branch.admin);
  asConfiguredManager = await cookieOf(c.manager);

  // A venue that trades: live, a booking paid at the counter, and what that leaves.
  const t = await signUp("Trading Courts", "trade@guide.my");
  trading = t.venueId;
  asTradingManager = await cookieOf(t.manager);
  await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(trading);
  const tc = ok(await createCourt({ venueId: trading, name: "Court A", sport: "badminton", offPeakRate: 20, peakRate: 30 }));
  const b = ok(await createBooking({ courtId: tc.court.id, date: addDays(today, 2), hours: [10], name: "Cust Omer", phone: "0128880000" }));
  ok(await setPaymentStatus(b.booking.code, true, "cash"));

  // Somebody else's venue, every name carrying the marker.
  const other = await signUp("ZZB Courts", "zzb@guide.my");
  theirs = other.venueId;
  asTheirManager = await cookieOf(other.manager);
  await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(theirs);
  const zc = ok(await createCourt({ venueId: theirs, name: "ZZB Court", sport: "badminton", offPeakRate: 11, peakRate: 99 }));
  ok(await saveCoach(theirs, { name: "ZZB Coach", sports: ["badminton"], rate: 61, hours: [{ weekday: 2, from: 540, until: 900 }] }));
  ok(await createPlan(theirs, { name: "ZZB Plan", months: 6, price: 111 }));
  ok(await createAddon(theirs, { name: "ZZB Racket", kind: "rental", price: 6, stock: 3 }));
  ok(await saveConcession(theirs, { name: "ZZB Student", percent: 15, proof: "ZZB card" }));
  const zb = ok(await createBooking({ courtId: zc.court.id, date: addDays(today, 3), hours: [11], name: "ZZB Customer", phone: "0127770000" }));
  ok(await setPaymentStatus(zb.booking.code, true, "cash"));
});

const NOTHING_SECRET = ["api-key-1234", "col123", "S-key", "W10-SECRET-123", "boss@guide.my", "0123334444", "0129990000", "conf@guide.my", "Cust Omer", "0128880000", "Coach Karim", "Coach Hana", "4321", "Owner of"];

function keysOf(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => keysOf(v, path));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => [`${path}${k}`, ...keysOf(v, `${path}${k}.`)]);
  return [];
}

describe("readVenueProfile", () => {
  it("reads a fresh draft as empty: nothing set up, nothing happened", async () => {
    const p = await readVenueProfile(fresh);
    expect(p.venueId).toBe(fresh);
    expect(p.illustrative).toBe(false);
    expect(p.identity).toMatchObject({ draft: true, live: false, suspended: false, visibility: "public", hasPin: true, country: "MY", currency: "MYR", marketplace: true });
    expect(p.identity.customerLanguages).toEqual(["en", "ms", "zh", "ta"]);
    expect(p.identity.staffLanguages).toEqual(["en", "ms", "zh"]);
    expect(p.resources.total).toBe(0);
    expect(p.activities).toEqual([]);
    expect(p.history).toEqual({ bookings: 0, paidBookings: 0, onlinePayments: 0, receipts: 0, testBookings: 0, paidTestBookings: 0 });
    expect(p.setup).toMatchObject({ courts: 0, detailsChecked: false, testBooking: false, onlinePayment: false, complete: false });
    expect(p.goLive.missing.length).toBeGreaterThan(0);
    expect(isEmptyVenue(p)).toBe(true);
    expect(hasHistory(p)).toBe(false);
    expect(usesOnlinePayments(p)).toBe(false);
    expect(p.branches).toEqual({ venues: 1, copiedFromBranch: false });
  });

  it("reports each fact of a configured venue", async () => {
    const p = await readVenueProfile(configured);
    expect(p.identity.draft).toBe(true);
    expect(p.activities.map((a) => a.key)).toEqual(["badminton", "futsal", "yoga"]);
    // Support levels are the catalogue's, never copied.
    expect(p.activities.every((a) => a.support === "full" && !a.own)).toBe(true);
    expect(p.resources).toMatchObject({ total: 4, shared: 1, linked: 3, withBuffers: 1, priced: 3, unmanned: 1 });
    expect(p.resources.byModel).toEqual({ exclusive: 3, lanes: 0, shared: 0, class: 1, hire: 0 });
    expect(p.rates).toMatchObject({ lowest: 18, highest: 120, peakPricing: true, memberRates: true });
    // Dated changes are scheduled, not in force: today's prices and hours are today's.
    expect(p.rates.scheduled).toEqual([{ from: later, resources: 1 }]);
    expect(p.hours.scheduled).toEqual([{ from: later, openMin: 420, closeMin: 1320 }]);
    expect(p.commerce).toMatchObject({ membershipPlans: 1, passProducts: 1, concessions: 1, promoCodes: 1, extras: 1, hireDeposits: true });
    expect(p.people).toMatchObject({ coaches: 2, coachesWithHours: 1, classes: 1, upcomingClasses: 1 });
    expect(p.payments.online).toEqual({ accountExists: true, accountEnabled: true, sandbox: true, provider: "billplz", firstPaymentTaken: false });
    expect(p.setup.onlinePayment).toBe(true);
    expect(p.staff).toMatchObject({ desk: 1 });
    expect(p.staff.managers).toBeGreaterThanOrEqual(2);
    expect(p.compliance.bookingAlerts).toBe(true);
    expect(p.identity.taxRegistered).toBe(true);
    expect(p.access).toMatchObject({ unstaffedHours: true, unmannedResources: 1, emergencyDetails: true });
    expect(p.policies.cancellation).toMatchObject({ onlineRefunds: "staff", refundWithinDays: 7 });
    expect(p.history.bookings).toBe(0);
    expect(isEmptyVenue(p)).toBe(false);
    expect(hasHistory(p)).toBe(false);
  });

  it("tells a change that has come into force from one still scheduled, on the day asked", async () => {
    const after = await readVenueProfile(configured, { today: addDays(later, 1) });
    expect(after.today).toBe(addDays(later, 1));
    expect(after.rates.scheduled).toEqual([]);
    expect(after.hours.scheduled).toEqual([]);
    expect(after.hours).toMatchObject({ openMin: 420, closeMin: 1320 });
    // Court 1's new rates are the ones in force; the dearest is still the pitch's.
    expect(after.rates).toMatchObject({ lowest: 18, highest: 120 });
    const before = await readVenueProfile(configured, { today: today });
    expect(before.hours).toMatchObject({ openMin: 480, closeMin: 1380 });
    expect((await getCourt(hourlyCourt))!.rateChanges).toHaveLength(1);
  });

  it("reads a venue with bookings and payments as one with history, and counts none of the people", async () => {
    const p = await readVenueProfile(trading);
    expect(p.identity.live).toBe(true);
    expect(p.history).toMatchObject({ bookings: 1, paidBookings: 1, testBookings: 0 });
    expect(p.payments.counterMethods).toEqual(["cash"]);
    expect(p.channels).toMatchObject({ onlinePage: true, counter: true });
    expect(hasHistory(p)).toBe(true);
    expect(isEmptyVenue(p)).toBe(false);
  });

  it("holds only counts and settings: no key, credential, tax identifier or private detail of a person", async () => {
    for (const id of [fresh, configured, trading]) {
      const p = await readVenueProfile(id);
      const text = JSON.stringify(p);
      for (const secret of NOTHING_SECRET) expect(text, `${secret} in venue ${id}'s profile`).not.toContain(secret);
      for (const key of keysOf(p)) expect(key, key).not.toMatch(/(^|\.)(email|phone|address|password|secret|credentials?|token|tin|name|holder\w*|customer(Name|Phone|Email)|reg_?no)$/i);
    }
    // The whole setup view, plan and readiness too.
    const view = JSON.stringify(await setupView(configured, "manager"));
    for (const secret of NOTHING_SECRET) expect(view, secret).not.toContain(secret);
  });

  it("is each venue's own: another venue's data is never in a profile, plan, readiness or discovery", async () => {
    for (const id of [fresh, configured, trading]) {
      const view = JSON.stringify(await setupView(id, "manager"));
      expect(view, `venue ${id}`).not.toContain("ZZB");
    }
    const mine = await readVenueProfile(configured);
    const theirsP = await readVenueProfile(theirs);
    expect(theirsP.resources.total).toBe(1);
    expect(theirsP.people.coaches).toBe(1);
    expect(mine.resources.total).toBe(4);
    expect(mine.people.coaches).toBe(2);
    expect(mine.commerce.membershipPlans).toBe(1);
    expect(theirsP.history.bookings).toBe(1);
    expect(mine.history.bookings).toBe(0);
    // A venue that is not there reads empty, rather than throwing.
    expect((await readVenueProfile(999999)).venueId).toBe(0);
  });
});

describe("the plan and readiness over real venues", () => {
  it("leads a fresh draft through the checklist's three steps, in order, with the steps every venue has and nothing it did not choose", async () => {
    const view = await setupView(fresh, "manager");
    // The three of the checklist among the steps every venue is shown (the setup journey's own list): no coach, class, branch or tournament step.
    expect(view.plan.items.map((i) => i.id)).toEqual([
      "details",
      "courts",
      "prices",
      "peak-hours",
      "booking-rules",
      "cancellation-terms",
      "communications",
      "staff",
      "counter-payments",
      "online-payment",
      "test-booking",
      "launch",
    ]);
    expect(view.plan.items.filter((i) => i.required).map((i) => i.id)).toEqual(["details", "courts", "test-booking"]);
    expect(view.readiness.requiredMissing.map((i) => i.id)).toEqual(expect.arrayContaining(["details", "courts", "test-booking", "go-live-0"]));
  });

  it("recognises what a configured venue has done, and leaves coach steps to a venue with coaches", async () => {
    const view = await setupView(configured, "manager");
    const state = (id: string) => view.plan.items.find((i) => i.id === id)?.state.status;
    expect(state("courts")).toBe("done");
    expect(state("details")).toBe("todo");
    // It has coaches, so coach steps are shown, with the hours one open because one coach has none.
    expect(state("coaches")).toBe("done");
    expect(state("coach-hours")).toBe("todo");
    expect(state("classes")).toBe("done");
    expect(state("memberships")).toBe("done");
    expect(state("online-payment")).toBe("done");
    expect(view.plan.items.find((i) => i.id === "online-payment")!.state).toMatchObject({ verified: false });
    expect(view.readiness.featureSpecific.map((i) => i.id)).toEqual(expect.arrayContaining(["coach-hours"]));
    expect(view.readiness.unverifiedExternal.map((i) => i.id)).toContain("online-unverified");
    expect(view.readiness.unverifiedExternal.find((i) => i.id === "online-unverified")!.label.key).toBe("gd.ready.onlineSandbox");
    expect(view.readiness.legalPrerequisite.map((i) => i.id)).toEqual(expect.arrayContaining(["einvoice-notice", "tax-treatment"]));
  });

  it("recognises an existing venue's completed set-up as done, and offers it nothing that rewrites it", async () => {
    await getDb().prepare("UPDATE venues SET staffed_from = NULL, staffed_to = NULL WHERE id = ?").run(trading);
    const view = await setupView(trading, "manager");
    expect(view.profile.history.bookings).toBe(1);
    const state = (id: string) => view.plan.items.find((i) => i.id === id)?.state.status;
    expect(state("courts")).toBe("done");
    // The booking made counts for the checklist's own third step, as it always has.
    expect(state("test-booking")).toBe("done");
    expect(view.plan.items.every((i) => ["open", "add", "review"].includes(i.effect))).toBe(true);
  });

  it("asks nothing of online payments of a counter venue, and shows it once online payments are on", async () => {
    const before = await readVenueProfile(trading);
    const said = { v: 1 as const, channels: ["counter" as const] };
    const quiet = launchReadiness(before, buildSetupPlan({ profile: before, answers: said, acknowledged: {}, role: "manager" }));
    const everything = Object.values(quiet).flat() as { id: string }[];
    expect(everything.filter((i) => /online/.test(i.id))).toEqual([]);
    ok(await savePaymentSettings(trading, { apiKey: "api-key-9999", collectionId: "col999", xSignatureKey: "S-key-9", sandbox: false, enabled: true }));
    const on = await readVenueProfile(trading);
    expect(usesOnlinePayments(on)).toBe(true);
    const loud = launchReadiness(on);
    expect(loud.unverifiedExternal.map((i) => i.id)).toContain("online-unverified");
    expect(loud.unverifiedExternal.find((i) => i.id === "online-unverified")!.integration).toBe("billplz");
    // A payment really taken lifts it.
    await getDb()
      .prepare("INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, status, payer_name, payer_phone) VALUES ('billplz', 'bill-guide-1', 'x', ?, 20, 'paid', 'A Payer', '0120000000')")
      .run(trading);
    const proven = await readVenueProfile(trading);
    expect(proven.payments.online.firstPaymentTaken).toBe(true);
    expect(launchReadiness(proven).unverifiedExternal.map((i) => i.id)).not.toContain("online-unverified");
  });
});

describe("answers", () => {
  it("save and resume, and every write moves the revision", async () => {
    expect(await readGuide(fresh)).toMatchObject({ rev: 0, answers: { v: 1 }, acknowledged: {}, dismissed: {}, updatedAt: null });
    const saved = await saveAnswers(fresh, { coaching: true, branches: "one" }, 0, { id: owner.id, name: owner.name });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.state.rev).toBe(1);
    expect(saved.state.answers).toEqual({ v: 1, coaching: true, branches: "one" });
    // Resuming reads the same.
    expect((await readGuide(fresh)).answers).toEqual({ v: 1, coaching: true, branches: "one" });
    // Taking an answer back, on top of the revision it was looking at.
    const next = await saveAnswers(fresh, { coaching: null, children: true }, 1);
    expect(next.ok && next.state.answers).toEqual({ v: 1, branches: "one", children: true });
    expect(next.ok && next.state.rev).toBe(2);
    // The plan follows the answers: no coaching, no coach steps.
    expect((await setupView(fresh, "manager")).plan.items.map((i) => i.id)).not.toContain("coaches");
    expect((await setupView(fresh, "manager")).plan.items.map((i) => i.id)).toContain("guardians");
  });

  it("refuse a stale save with the state as it now is, and change nothing", async () => {
    const stale = await saveAnswers(fresh, { audience: "members" }, 0);
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.stale).toBe(true);
    expect(stale.state.rev).toBe(2);
    expect(stale.state.answers.audience).toBeUndefined();
    expect((await readGuide(fresh)).answers.audience).toBeUndefined();
    // A revision from the future is as stale as one from the past.
    expect((await saveAnswers(fresh, { audience: "members" }, 99)).ok).toBe(false);
  });

  it("lose neither answer when several people save at once", async () => {
    const venue = (await signUp("Concurrent Courts", "race@guide.my")).venueId;
    // Two saving on the same revision: exactly one wins, and the other is told the state it lost to.
    const [a, b] = await Promise.all([saveAnswers(venue, { coaching: true }, 0), saveAnswers(venue, { children: true }, 0)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    expect(loser.ok).toBe(false);
    if (loser.ok) return;
    expect(loser.state.rev).toBe(1);
    // It saves again on top of the winner's, and now both are there.
    const patch = a.ok ? { children: true } : { coaching: true };
    const again = await saveAnswers(venue, patch, loser.state.rev);
    expect(again.ok).toBe(true);
    expect((await readGuide(venue)).answers).toEqual({ v: 1, coaching: true, children: true });

    // Many at once, each retrying on a stale answer from the state it was given: every one lands.
    const patches = [{ resources: "few" as const }, { branches: "several" as const }, { staffing: "partial" as const }, { audience: "both" as const }, { memberships: ["passes" as const] }, { types: ["swimming" as const] }];
    const save = async (patch: Parameters<typeof saveAnswers>[1]) => {
      let rev = (await readGuide(venue)).rev;
      for (let tries = 0; tries < 30; tries++) {
        const r = await saveAnswers(venue, patch, rev);
        if (r.ok) return;
        rev = r.state.rev;
      }
      throw new Error("never saved");
    };
    await Promise.all(patches.map(save));
    const final = await readGuide(venue);
    expect(final.answers).toEqual({ v: 1, coaching: true, children: true, resources: "few", branches: "several", staffing: "partial", audience: "both", memberships: ["passes"], types: ["swimming"] });
    expect(final.rev).toBe(2 + patches.length);
  });

  it("record a review as the manager's own act, and a dismissal, each moving the revision and neither touching answers", async () => {
    const venue = (await signUp("Reviewed Courts", "review@guide.my")).venueId;
    const before = await readGuide(venue);
    const reviewed = await acknowledge(venue, "cancellation-terms", { id: owner.id, name: "Musa Manager" });
    expect(reviewed.acknowledged["cancellation-terms"]).toMatchObject({ byAdminId: owner.id, byName: "Musa Manager" });
    expect(reviewed.acknowledged["cancellation-terms"].at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(reviewed.rev).toBe(before.rev + 1);
    const gone = await dismiss(venue, "coaching");
    expect(gone.dismissed.coaching.at).toBeTruthy();
    expect(gone.rev).toBe(before.rev + 2);
    expect(gone.answers).toEqual(before.answers);
    // The plan reads it as done, with who and when; the discoveries stop offering what was dismissed.
    const item = (await setupView(venue, "manager")).plan.items.find((i) => i.id === "cancellation-terms")!;
    expect(item.state).toMatchObject({ status: "done", reviewedBy: "Musa Manager" });
  });

  it("go with the venue when it is removed, and hold no personal data beyond the name of whoever reviewed", async () => {
    const venue = (await signUp("Short Lived", "gone@guide.my")).venueId;
    await saveAnswers(venue, { coaching: true }, 0);
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM venue_guide WHERE venue_id = ?").get(venue) as { n: number }).n).toBe(1);
    await getDb().prepare("DELETE FROM venue_applications WHERE venue_id = ?").run(venue);
    await getDb().prepare("DELETE FROM admins WHERE business_id = (SELECT business_id FROM venues WHERE id = ?)").run(venue);
    await getDb().prepare("DELETE FROM venues WHERE id = ?").run(venue);
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM venue_guide WHERE venue_id = ?").get(venue) as { n: number }).n).toBe(0);
  });
});

describe("what a visitor chose in the public guide", () => {
  it("becomes the new venue's starting intent when its application opens the venue, and is kept with the application", async () => {
    const fit = { types: ["swimming", "coaching-academy"], activities: ["swimming"], children: true };
    const { venueId } = await signUp("Fit Courts", "fit@guide.my", { fit });
    const state = await readGuide(venueId);
    expect(state.answers).toEqual({ v: 1, types: ["swimming", "coaching-academy"], activities: ["swimming"], children: true });
    expect(state.rev).toBe(1);
    const row = (await getDb().prepare("SELECT fit FROM venue_applications WHERE venue_id = ?").get(venueId)) as { fit: string };
    expect(JSON.parse(row.fit)).toEqual({ v: 1, ...fit });
    // The journey starts from it: the children's step is there without anyone asking again.
    expect((await setupView(venueId, "manager")).plan.items.map((i) => i.id)).toContain("guardians");
  });

  it("refuses a choice that names a business type or activity that does not exist, and starts nothing when there is none", async () => {
    for (const fit of [{ types: ["spaceport"] }, { activities: ["curling"] }, "swimming", { bogus: 1 }]) {
      const refused = await submitApplication({ businessName: "Nope Courts", area: "Ampang", address: "1 Jalan Satu, Ampang", venuePhone: "0342220000", contactName: "Nobody", email: "nope@guide.my", password: PASSWORD, ...pin, fit });
      expect(refused.ok, JSON.stringify(fit)).toBe(false);
    }
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM venue_applications WHERE email = 'nope@guide.my'").get() as { n: number }).n).toBe(0);
    const none = await signUp("No Fit Courts", "nofit@guide.my");
    expect(await readGuide(none.venueId)).toMatchObject({ rev: 0, answers: { v: 1 } });
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM venue_guide WHERE venue_id = ?").get(none.venueId) as { n: number }).n).toBe(0);
  });

  it("is read from the apply route's body, and a seed never replaces answers a manager has saved", async () => {
    const res = await applyPost(
      new NextRequest("http://localhost/api/venue-applications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessName: "Route Courts",
          area: "Ampang",
          address: "1 Jalan Satu, Ampang",
          venuePhone: "0342220000",
          contactName: "Rina",
          email: "route@guide.my",
          password: PASSWORD,
          ...pin,
          fit: { types: ["climbing-and-bouldering"] },
        }),
      })
    );
    expect(res.status).toBe(201);
    const row = (await getDb().prepare("SELECT venue_id FROM venue_applications WHERE email = 'route@guide.my'").get()) as { venue_id: number };
    expect((await readGuide(row.venue_id)).answers.types).toEqual(["climbing-and-bouldering"]);
    const bad = await applyPost(
      new NextRequest("http://localhost/api/venue-applications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ businessName: "Route Two", area: "Ampang", address: "1 Jalan Satu, Ampang", venuePhone: "0342220000", contactName: "Rina", email: "route2@guide.my", password: PASSWORD, ...pin, fit: { types: ["nope"] } }),
      })
    );
    expect(bad.status).toBe(400);
    // Saved answers stand against a later seed.
    await seedFromFit(row.venue_id, { v: 1, types: ["swimming"] });
    expect((await readGuide(row.venue_id)).answers.types).toEqual(["climbing-and-bouldering"]);
  });
});

describe("a branch started from another's set-up", () => {
  it("is read for itself: its own plan and readiness, no intent copied, no secret or money copied", async () => {
    const res = await branchesPost(
      new NextRequest("http://localhost/api/admin/branches", {
        method: "POST",
        headers: { cookie: asConfiguredManager, "content-type": "application/json" },
        body: JSON.stringify({ name: "Configured Courts Two", area: "Cheras", address: "9 Jalan Salinan, Cheras", phone: "0391110000", ...pin, copyFrom: configured }),
      })
    );
    expect(res.status).toBe(201);
    const copy = (await res.json()).venueId as number;
    const p = await readVenueProfile(copy);
    expect(p.branches).toEqual({ venues: 2, copiedFromBranch: true });
    expect(p.resources.total).toBeGreaterThan(0);
    expect(p.rates.scheduled).toHaveLength(1);
    // Nothing of a person or of money, no account of its own.
    expect(p.history.bookings).toBe(0);
    expect(p.payments.online.accountExists).toBe(false);
    expect(p.commerce.passProducts).toBe(1);
    expect(p.people.coaches).toBe(0);
    expect(p.staff.desk).toBe(0);
    expect(p.compliance.bookingAlerts).toBe(false);
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM venue_guide WHERE venue_id = ?").get(copy) as { n: number }).n).toBe(0);
    const view = await setupView(copy, "manager");
    const ids = view.plan.items.map((i) => i.id);
    expect(ids).toContain("copied-branch");
    expect(ids).toContain("branches");
    expect(view.plan.items.find((i) => i.id === "courts")!.state.status).toBe("done");
    expect(view.plan.items.find((i) => i.id === "test-booking")!.state.status).toBe("todo");
    expect(view.readiness.requiredMissing.map((i) => i.id)).toContain("test-booking");
    // The first branch's view of itself now knows it has a sibling, and that it was not copied.
    const first = await readVenueProfile(configured);
    expect(first.branches).toEqual({ venues: 2, copiedFromBranch: false });
    expect(JSON.stringify(view)).not.toContain("api-key-1234");
  });
});

describe("the routes", () => {
  it("answer a manager with the venue's profile, answers, plan, readiness and discoveries, and leave nothing cached", async () => {
    const res = await get(setupGet, `/api/admin/guide/setup?venueId=${configured}`, asConfiguredManager);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["acknowledged", "answers", "discoveries", "dismissed", "plan", "profile", "readiness", "rev", "role", "venueId"]);
    expect(body).toMatchObject({ venueId: configured, role: "manager", rev: 0 });
    expect(body.profile.venueId).toBe(configured);
    // Its own venue by default, for a manager of one.
    const own = await get(setupGet, "/api/admin/guide/setup", asBranchManager);
    expect((await own.json()).venueId).toBe(configured);
  });

  it("refuse the front desk the setup, read or write, and give it its own playbook", async () => {
    const read = await get(setupGet, `/api/admin/guide/setup?venueId=${configured}`, asDesk);
    expect(read.status).toBe(403);
    expect((await read.json()).code).toBe("MANAGER_ONLY");
    const write = await post(asDesk, { venueId: configured, action: "answers", answers: { coaching: true }, rev: 0 });
    expect(write.status).toBe(403);
    expect((await write.json()).code).toBe("MANAGER_ONLY");
    expect((await readGuide(configured)).rev).toBe(0);
    const playbook = await get(playbookGet, `/api/admin/guide/playbook?venueId=${configured}`, asDesk);
    expect(playbook.status).toBe(200);
    const body = await playbook.json();
    expect(body).toMatchObject({ venueId: configured, role: "desk", ownRole: "desk", roles: ["desk", "coach"] });
    // The playbook is the desk's own: no manager's section, and no module of a manager's (tests/guide-playbook*.test.ts holds the rest).
    expect(body.playbook).toMatchObject({ role: "desk", venue: { id: configured } });
    expect(body.playbook.sections.map((s: { id: string }) => s.id)).not.toContain("manager");
    expect(body.playbook.modules).not.toContain("manager.staff");
    expect(body.playbook.modules).not.toContain("manager.finance");
  });

  it("take the role from the session and refuse a role above it", async () => {
    const above = await get(playbookGet, `/api/admin/guide/playbook?venueId=${configured}&as=manager`, asDesk);
    expect(above.status).toBe(403);
    const same = await get(playbookGet, `/api/admin/guide/playbook?venueId=${configured}&as=desk`, asDesk);
    expect(same.status).toBe(200);
    const below = await get(playbookGet, `/api/admin/guide/playbook?venueId=${configured}&as=coach`, asDesk);
    expect(below.status).toBe(200);
    expect((await below.json()).role).toBe("coach");
    expect((await get(playbookGet, `/api/admin/guide/playbook?venueId=${configured}&as=owner`, asDesk)).status).toBe(400);
    // A manager may prepare the desk's training: the desk's guide, not their own.
    const manager = await get(playbookGet, `/api/admin/guide/playbook?venueId=${configured}`, asConfiguredManager);
    const asManager = await manager.json();
    expect(asManager).toMatchObject({ role: "manager", roles: ["manager", "desk", "coach"] });
    expect(asManager.playbook.modules).toContain("manager.staff");
    const preview = await (await get(playbookGet, `/api/admin/guide/playbook?venueId=${configured}&as=desk`, asConfiguredManager)).json();
    expect(preview).toMatchObject({ role: "desk", ownRole: "manager" });
    expect(preview.playbook.modules).not.toContain("manager.staff");
    // And asking for a venue not yours is refused in the playbook as everywhere.
    expect((await get(playbookGet, `/api/admin/guide/playbook?venueId=${theirs}`, asDesk)).status).toBe(403);
  });

  it("keep each tenant to its own venues: a branch manager, a business manager and the desk are refused another's", async () => {
    for (const cookie of [asBranchManager, asConfiguredManager, asDesk]) {
      for (const id of [theirs, trading, fresh]) {
        expect((await get(playbookGet, `/api/admin/guide/playbook?venueId=${id}`, cookie)).status, `playbook ${id}`).toBe(403);
        if (cookie !== asDesk) {
          expect((await get(setupGet, `/api/admin/guide/setup?venueId=${id}`, cookie)).status, `setup ${id}`).toBe(403);
          expect((await post(cookie, { venueId: id, action: "answers", answers: { coaching: true }, rev: 0 })).status, `write ${id}`).toBe(403);
        }
      }
    }
    // Nothing was written to any of them.
    for (const id of [theirs, trading]) expect((await readGuide(id)).rev, `venue ${id}`).toBe(0);
    // Their own manager, and the platform owner, may.
    expect((await get(setupGet, `/api/admin/guide/setup?venueId=${theirs}`, asTheirManager)).status).toBe(200);
    expect((await get(setupGet, `/api/admin/guide/setup?venueId=${theirs}`, asOwner)).status).toBe(200);
    // Not signed in, or no venue named for the owner.
    expect((await setupGet(new NextRequest("http://localhost/api/admin/guide/setup?venueId=1"))).status).toBe(401);
    expect((await get(setupGet, "/api/admin/guide/setup", asOwner)).status).toBe(400);
    expect((await get(setupGet, "/api/admin/guide/setup?venueId=abc", asOwner)).status).toBe(400);
  });

  it("save answers, log it, and refuse a stale save with the current view", async () => {
    const saved = await post(asConfiguredManager, { venueId: configured, action: "answers", answers: { coaching: true, children: true }, rev: 0 });
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body).toMatchObject({ rev: 1, answers: { v: 1, coaching: true, children: true } });
    expect(body.plan.items.map((i: { id: string }) => i.id)).toContain("guardians");
    const logged = (await listActivity([configured])).filter((a) => a.action === "guide.answers");
    expect(logged).toHaveLength(1);
    expect(logged[0].detail).toBe("Answers: coaching, children");
    expect(logged[0].adminName).toBe(configuredManager.name);
    // A stale rev is a 409 carrying what is there now, and nothing is written or logged.
    const stale = await post(asConfiguredManager, { venueId: configured, action: "answers", answers: { audience: "members" }, rev: 0 });
    expect(stale.status).toBe(409);
    const current = await stale.json();
    expect(current).toMatchObject({ stale: true, rev: 1, answers: { coaching: true, children: true } });
    expect(current.error).toContain("Somebody saved");
    expect((await listActivity([configured])).filter((a) => a.action === "guide.answers")).toHaveLength(1);
    // Bad bodies are refused, not guessed at.
    expect((await post(asConfiguredManager, { venueId: configured, action: "answers", answers: { coaching: "maybe" }, rev: 1 })).status).toBe(400);
    expect((await post(asConfiguredManager, { venueId: configured, action: "answers", answers: { ghost: 1 }, rev: 1 })).status).toBe(400);
    expect((await post(asConfiguredManager, { venueId: configured, action: "answers", answers: { coaching: false } })).status).toBe(400);
    expect((await post(asConfiguredManager, { venueId: configured, action: "nonsense" })).status).toBe(400);
    const notJson = await setupPost(new NextRequest("http://localhost/api/admin/guide/setup", { method: "POST", headers: { cookie: asConfiguredManager }, body: "not json" }));
    expect(notJson.status).toBe(400);
    expect((await readGuide(configured)).answers).toEqual({ v: 1, coaching: true, children: true });
  });

  it("record a review and a dismissal, each logged and each moving the plan and the discoveries", async () => {
    const reviewed = await post(asConfiguredManager, { venueId: configured, action: "acknowledge", step: "cancellation-terms" });
    expect(reviewed.status).toBe(200);
    const view = await reviewed.json();
    expect(view.plan.items.find((i: { id: string }) => i.id === "cancellation-terms").state).toMatchObject({ status: "done", reviewedBy: configuredManager.name });
    expect((await listActivity([configured])).some((a) => a.action === "guide.acknowledged" && a.detail === "Step cancellation-terms")).toBe(true);
    // Only a review step may be reviewed: a step that is done by saved state may not be ticked.
    expect((await post(asConfiguredManager, { venueId: configured, action: "acknowledge", step: "courts" })).status).toBe(400);
    expect((await post(asConfiguredManager, { venueId: configured, action: "acknowledge", step: "../x" })).status).toBe(400);
    expect((await readGuide(configured)).acknowledged.courts).toBeUndefined();

    // A live venue with bookings and nothing set to tell it of them is suggested something, with its reason.
    const live = await (await get(setupGet, `/api/admin/guide/setup?venueId=${trading}`, asTradingManager)).json();
    const offered = live.discoveries.map((d: { id: string }) => d.id);
    expect(offered).toContain("booking-alerts");
    expect(live.discoveries.find((d: { id: string }) => d.id === "booking-alerts").reason.key).toBe("gd.disc.alerts");
    const dismissed = await post(asTradingManager, { venueId: trading, action: "dismiss", id: "booking-alerts" });
    expect(dismissed.status).toBe(200);
    expect((await dismissed.json()).discoveries.map((d: { id: string }) => d.id)).not.toContain("booking-alerts");
    expect((await listActivity([trading])).some((a) => a.action === "guide.dismissed" && a.detail === "Suggestion booking-alerts")).toBe(true);
    // Only a suggestion MySenam makes can be dismissed.
    expect((await post(asConfiguredManager, { venueId: configured, action: "dismiss", id: "web-push" })).status).toBe(400);
  });

  it("log labels in all three staff languages, and show them in the activity panel", async () => {
    for (const action of ["guide.answers", "guide.acknowledged", "guide.dismissed"]) expect(ACTION_LABELS[action], action).toBeTruthy();
    for (const key of ["gd.act.answers", "gd.act.acknowledged", "gd.act.dismissed"] as const)
      for (const locale of ["en", "ms", "zh"] as const) expect(STAFF_DICTIONARIES[locale][key], `${key} in ${locale}`).toBeTruthy();
    const fs = await import("fs");
    const panel = fs.readFileSync(`${__dirname}/../src/components/admin/ActivityPanel.tsx`, "utf8");
    for (const [action, key] of [["guide.answers", "gd.act.answers"], ["guide.acknowledged", "gd.act.acknowledged"], ["guide.dismissed", "gd.act.dismissed"]]) expect(panel).toContain(`"${action}": "${key}"`);
  });
});
