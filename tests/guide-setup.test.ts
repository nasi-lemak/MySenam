import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_MARKETPLACE = "on";
process.env.MYSENAM_GEOCODER = "off";
// No mail or WhatsApp service is reached from a test, whatever this machine has set.
for (const name of ["SMTP_URL", "MAIL_FROM", "SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_REGION", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]) delete process.env[name];

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdmin, createAdminSession, ensureBootstrapAdmin, type Admin } from "../src/lib/admin-auth";
import { submitApplication } from "../src/lib/applications";
import { cancelPolicy } from "../src/lib/cancel-policy";
import { getDb } from "../src/lib/db";
import { savePaymentSettings } from "../src/lib/payments";
import { ratesOn } from "../src/lib/pricing";
import { adminCancelBooking, cancelBooking, createBooking, createCourt, getVenue, quoteFor, setPaymentStatus } from "../src/lib/store";
import { venueSetup } from "../src/lib/setup";
import { clearTestBookings } from "../src/lib/test-bookings";
import { STAFF_DICTIONARIES } from "../src/lib/staff-i18n";
import { addDays, dayOfWeek, todayISO } from "../src/lib/time";
import { emptyAnswers, validatePatch, type GuideAnswers } from "../src/lib/guide/answer-schema";
import { readGuide, saveAnswers } from "../src/lib/guide/answers";
import { BUSINESS_TYPES } from "../src/lib/guide/business-types";
import { capability } from "../src/lib/guide/capabilities";
import { buildSetupPlan, focusIds, SETUP_ACTIONS } from "../src/lib/guide/plan";
import { readVenueProfile } from "../src/lib/guide/profile";
import { launchReadiness } from "../src/lib/guide/readiness";
import { journeyView, nextSaturday } from "../src/lib/guide/setup-journey";
import { QUESTIONS, questionFlow, unanswered } from "../src/lib/guide/setup-questions";
import { SETUP_STEPS } from "../src/lib/guide/steps";
import { GET as journeyGet } from "../src/app/api/admin/guide/setup/journey/route";
import { GET as setupGet, POST as setupPost } from "../src/app/api/admin/guide/setup/route";
import { POST as courtsPost } from "../src/app/api/admin/courts/route";
import { PATCH as courtPatch } from "../src/app/api/admin/courts/[id]/route";
import { PATCH as venuePatch } from "../src/app/api/admin/venues/[id]/route";
import { POST as cancelPolicyPost } from "../src/app/api/admin/cancel-policy/route";
import { POST as peakPost } from "../src/app/api/admin/peak-rules/route";
import { POST as policiesPost } from "../src/app/api/admin/booking-policies/route";
import { GET as adminsGet, POST as adminsPost } from "../src/app/api/admin/admins/route";
import { POST as checklistPost } from "../src/app/api/admin/setup/route";

/**
 * The adaptive setup journey (docs/features/venue-guide.md#the-setup-journey):
 * what it shows each kind of venue, that every action it runs is the existing
 * route's own (so it changes real behaviour and is refused where the
 * application refuses it), that answers save and resume across two sessions
 * and refuse a stale save, that an established venue is never changed by
 * rerunning it, and that the journey and the checklist agree.
 */

const ZONE = "Asia/Kuala_Lumpur";
const today = todayISO(ZONE);
const pin = { lat: 3.15, lng: 101.6 };
const PASSWORD = "a long enough password";

const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

async function signUp(name: string, email: string): Promise<{ venueId: number; manager: Admin }> {
  const applied = await submitApplication({ businessName: name, area: "Ampang", address: "1 Jalan Satu, Ampang", venuePhone: "0342220000", contactName: `Owner of ${name}`, email, password: PASSWORD, ...pin });
  if (!applied.ok) throw new Error(applied.error);
  return { venueId: applied.application.venueId!, manager: (await authenticateAdmin(email, PASSWORD))! };
}

const cookieOf = async (admin: Admin) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(admin.id)).token}`;
const req = (method: string, path: string, cookie: string, body?: unknown) =>
  new NextRequest(`http://localhost${path}`, { method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const journey = (venueId: number, cookie: string, focus?: string) => journeyGet(req("GET", `/api/admin/guide/setup/journey?venueId=${venueId}${focus ? `&focus=${focus}` : ""}`, cookie));

const withAnswers = (patch: Partial<Omit<GuideAnswers, "v">>): GuideAnswers => {
  const checked = validatePatch(patch);
  if (!checked.ok) throw new Error(checked.error);
  return { ...emptyAnswers(), ...patch };
};
const stepIds = async (venueId: number, answers: GuideAnswers, focus?: string) => {
  const profile = await readVenueProfile(venueId);
  return buildSetupPlan({ profile, answers, acknowledged: {}, role: "manager", ...(focus ? { focus } : {}) }).items.map((i) => i.id);
};

let fresh: number;
let small: number;
let trading: number;
let theirs: number;
let smallManager: Admin;
let asFresh: string;
let asSmall: string;
let asSmallSecond: string;
let asDesk: string;
let asTrading: string;
let asTheirs: string;
let asOwner: string;
let tradingCourt: number;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  asOwner = await cookieOf((await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!);

  const f = await signUp("Fresh Courts", "fresh@setup.my");
  fresh = f.venueId;
  asFresh = await cookieOf(f.manager);

  const s = await signUp("Small Badminton", "small@setup.my");
  small = s.venueId;
  smallManager = s.manager;
  asSmall = await cookieOf(s.manager);
  // The same manager signed in a second time, as on a phone and a computer.
  asSmallSecond = await cookieOf(s.manager);
  const desk = ok(await createAdmin({ name: "Dina Desk", email: "dina@setup.my", password: "desk-password-1", venueId: small, role: "desk" }));
  asDesk = await cookieOf(desk.admin);

  const t = await signUp("Trading Courts", "trade@setup.my");
  trading = t.venueId;
  asTrading = await cookieOf(t.manager);
  await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(trading);
  const tc = ok(await createCourt({ venueId: trading, name: "Court A", sport: "badminton", offPeakRate: 20, peakRate: 30 }));
  tradingCourt = tc.court.id;
  const b = ok(await createBooking({ courtId: tradingCourt, date: addDays(today, 2), hours: [10], name: "Cust Omer", phone: "0128880000" }));
  ok(await setPaymentStatus(b.booking.code, true, "cash"));

  const other = await signUp("ZZB Courts", "zzb@setup.my");
  theirs = other.venueId;
  asTheirs = await cookieOf(other.manager);
  ok(await createCourt({ venueId: theirs, name: "ZZB Court", sport: "badminton", offPeakRate: 11, peakRate: 99 }));
});

describe("what a venue is shown, by what it says", () => {
  it("leads a small badminton centre through a short, ordered plan with no coach, branch, class, tournament or discount steps", async () => {
    const answers = withAnswers({ types: ["badminton-and-pickleball"], activities: ["badminton"], customersDo: ["reserve"], resources: "few", branches: "one", staffing: "staffed", channels: ["online", "counter"], coaching: false, children: false, competitions: false, discounts: false, audience: "public" });
    const steps = await stepIds(fresh, answers);
    expect(steps).toEqual(
      expect.arrayContaining(["details", "activities", "courts", "prices", "peak-hours", "booking-rules", "cancellation-terms", "communications", "staff", "counter-payments", "online-payment", "test-booking", "launch"])
    );
    for (const absent of ["coaches", "coach-hours", "classes", "memberships", "branches", "tournaments", "discounts", "equipment", "participant-requirements", "unattended", "guardians", "einvoicing", "shared-resources", "price-dates"])
      expect(steps, absent).not.toContain(absent);
  });

  it("leads a coaching academy through coaches, their hours, classes, passes and children, and never through equipment hire or counter operations it did not choose", async () => {
    const answers = withAnswers({ types: ["coaching-academy"], activities: ["tennis"], customersDo: ["classes", "memberships"], coaching: true, children: true, memberships: ["passes"], channels: ["online"], staffing: "staffed" });
    const steps = await stepIds(fresh, answers);
    expect(steps).toEqual(expect.arrayContaining(["activities", "coaches", "coach-hours", "classes", "memberships", "guardians", "participant-requirements", "online-payment", "staff"]));
    for (const absent of ["equipment", "branches", "tournaments", "counter-payments", "shared-resources", "discounts"]) expect(steps, absent).not.toContain(absent);
    // Its hours step waits for its coaches, and says so.
    const profile = await readVenueProfile(fresh);
    const hours = buildSetupPlan({ profile, answers, acknowledged: {}, role: "manager" }).items.find((i) => i.id === "coach-hours")!;
    expect(hours.state).toMatchObject({ status: "blocked", blockedBy: ["coaches"] });
  });

  it("leads a multi-sport business with branches through branches, shared facilities, tournaments and discounts, and not through coaching", async () => {
    const answers = withAnswers({ types: ["multi-sport"], activities: ["badminton", "futsal"], customersDo: ["reserve", "memberships"], resources: "many", branches: "several", memberships: ["memberships"], competitions: true, discounts: true, coaching: false });
    const steps = await stepIds(fresh, answers);
    expect(steps).toEqual(expect.arrayContaining(["branches", "shared-resources", "tournaments", "discounts", "memberships", "activities", "prices", "booking-rules"]));
    for (const absent of ["coaches", "coach-hours", "classes", "guardians"]) expect(steps, absent).not.toContain(absent);
  });

  it("waits for the first court before pricing, peak hours and booking rules, and says what it waits for", async () => {
    const profile = await readVenueProfile(fresh);
    const plan = buildSetupPlan({ profile, answers: emptyAnswers(), acknowledged: {}, role: "manager" });
    for (const id of ["prices", "peak-hours", "booking-rules"]) expect(plan.items.find((i) => i.id === id)!.state, id).toMatchObject({ status: "blocked", blockedBy: ["courts"] });
  });

  it("proposes a recommendation only from the catalogue and the install, says it is not saved, and never saves one", async () => {
    const before = await readVenueProfile(small);
    const answers = withAnswers({ activities: ["badminton"], resources: "few" });
    const plan = buildSetupPlan({ profile: before, answers, acknowledged: {}, role: "manager" });
    const rec = plan.items.filter((i) => i.recommend !== null);
    expect(rec.map((i) => i.id)).toEqual(expect.arrayContaining(["courts", "peak-hours", "online-payment"]));
    for (const item of rec) expect(item.nature === "recommendation" || item.state.status === "done", item.id).toBe(true);
    // A recommendation is not a setting: reading the plan changed none.
    const after = await readVenueProfile(small);
    expect(after).toEqual(before);
    // The booking rule's recommendation is the catalogue's own number.
    const rules = buildSetupPlan({ profile: await readVenueProfile(small), answers: withAnswers({ activities: ["swimming"] }), acknowledged: {}, role: "manager" }).items.find((i) => i.id === "booking-rules");
    if (rules?.recommend) expect(Number(rules.recommend.vars?.minutes)).toBeGreaterThan(0);
  });

  it("says, for every step, why it is shown, and names only real capabilities", () => {
    for (const step of SETUP_STEPS) {
      expect(step.capabilities.length, step.id).toBeGreaterThan(0);
      for (const id of step.capabilities) expect(capability(id), `${step.id}: ${id}`).toBeDefined();
      if (step.action) expect(SETUP_ACTIONS as readonly string[], step.id).toContain(step.action);
      for (const before of step.after ?? []) expect(SETUP_STEPS.some((s) => s.id === before), `${step.id} after ${before}`).toBe(true);
    }
    expect(new Set(SETUP_STEPS.map((s) => s.id)).size).toBe(SETUP_STEPS.length);
  });
});

describe("the questions", () => {
  it("skip what the saved settings already show, and what earlier answers make irrelevant", async () => {
    const empty = await readVenueProfile(fresh);
    expect(questionFlow(empty, emptyAnswers()).map((e) => e.question.id)).toEqual(QUESTIONS.map((q) => q.id));
    // A venue that already has courts, a branch of a business, coaches and plans is not asked about them.
    const tradingProfile = await readVenueProfile(trading);
    const flow = questionFlow(tradingProfile, emptyAnswers());
    expect(flow.find((e) => e.question.id === "resources")!.fact).toMatchObject({ key: "gs.fact.resources", vars: { n: 1 } });
    expect(flow.find((e) => e.question.id === "activities")!.fact).toMatchObject({ key: "gs.fact.activities" });
    expect(unanswered(tradingProfile, emptyAnswers()).map((q) => q.id)).not.toContain("resources");
    // A one-facility venue is not asked about tournaments; a venue with no coaching in its kinds of business is not asked about coaching.
    const one = questionFlow(empty, withAnswers({ resources: "one", types: ["equipment-rental"], customersDo: ["hire"] })).map((e) => e.question.id);
    expect(one).not.toContain("competitions");
    expect(one).not.toContain("coaching");
    expect(one).not.toContain("memberships");
    // Taking an answer back brings the question back.
    expect(questionFlow(empty, withAnswers({ resources: "few", types: ["coaching-academy"] })).map((e) => e.question.id)).toContain("coaching");
  });

  it("only ask what the answers can hold", () => {
    for (const q of QUESTIONS) {
      expect(STAFF_DICTIONARIES.en[q.title], q.id).toBeTruthy();
      expect(STAFF_DICTIONARIES.en[q.help], q.id).toBeTruthy();
      for (const o of q.options ?? []) for (const locale of ["en", "ms", "zh"] as const) expect(STAFF_DICTIONARIES[locale][o.label], `${q.id}.${o.value} in ${locale}`).toBeTruthy();
      if (q.id !== "types" && q.id !== "activities") expect(validatePatch({ [q.id]: q.kind === "yesno" ? true : q.kind === "multi" ? (q.options ?? []).map((o) => o.value) : q.options![0].value }).ok, q.id).toBe(true);
    }
    expect(new Set(BUSINESS_TYPES.map((b) => b.id)).size).toBeGreaterThan(10);
  });
});

describe("the journey route", () => {
  it("answers a manager with the plan, the venue's hours and courts, a price example and what Try it can tick, and leaves nothing cached", async () => {
    const res = await journey(trading, asTrading);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(Object.keys(body.extras).sort()).toEqual(["courts", "focus", "prices", "tryIt", "venue"]);
    expect(body.extras.venue).toMatchObject({ openMin: 480, closeMin: 1380, cancelCutoffHours: expect.any(Number) });
    expect(body.extras.courts.map((c: { name: string }) => c.name)).toEqual(["Court A"]);
    expect(body.plan.items.find((i: { id: string }) => i.id === "courts").state.status).toBe("done");
  });

  it("refuses the front desk, another venue's manager and a focus that does not exist", async () => {
    const desk = await journey(small, asDesk);
    expect(desk.status).toBe(403);
    expect((await desk.json()).code).toBe("MANAGER_ONLY");
    const theirsAsking = await journey(trading, asTheirs);
    expect(theirsAsking.status).toBe(403);
    expect(JSON.stringify(await theirsAsking.json())).not.toContain("Court A");
    expect((await journey(small, asSmall, "nonsense")).status).toBe(400);
    // The owner may read any venue's.
    expect((await journey(trading, asOwner)).status).toBe(200);
  });

  it("shows a venue only its own courts, rates and counts", async () => {
    const mine = JSON.stringify(await (await journey(theirs, asTheirs)).json());
    expect(mine).toContain("ZZB Court");
    for (const marker of ["Court A", "Cust Omer", "0128880000", "small@setup.my"]) expect(mine, marker).not.toContain(marker);
    const others = JSON.stringify(await (await journey(trading, asTrading)).json());
    expect(others).not.toContain("ZZB");
  });

  it("holds no door code, key, credential or person's details, in the plan, the courts or the examples", async () => {
    await getDb().prepare("UPDATE courts SET access_code = '4321', unmanned = 1 WHERE id = ?").run(tradingCourt);
    await getDb().prepare("UPDATE venues SET emergency_phone = '0129990000', alert_email = 'boss@setup.my', tax_registered = 1, tax_reg_no = 'W10-SECRET-123' WHERE id = ?").run(trading);
    ok(await savePaymentSettings(trading, { apiKey: "api-key-secret-1", collectionId: "colsecret", xSignatureKey: "S-key-secret", sandbox: true, enabled: true }));
    const text = JSON.stringify(await (await journey(trading, asTrading)).json());
    for (const secret of ["4321", "api-key-secret-1", "colsecret", "S-key-secret", "W10-SECRET-123", "0129990000", "boss@setup.my", "Cust Omer", "0128880000", "trade@setup.my"]) expect(text, secret).not.toContain(secret);
  });

  it("narrows to a targeted journey: the capability's steps shown whether or not it was asked for, and the steps they wait for", async () => {
    const plain = await stepIds(trading, emptyAnswers());
    expect(plain).not.toContain("staff-invitations");
    const staff = await stepIds(trading, emptyAnswers(), "staff-invitations");
    expect(staff).toEqual(["staff"]);
    // A policy review: the policy group and nothing of the rest.
    const policies = await stepIds(trading, emptyAnswers(), "policies");
    expect(policies).toEqual(expect.arrayContaining(["booking-rules", "cancellation-terms", "communications", "courts"]));
    for (const id of policies) expect(["booking-rules", "cancellation-terms", "guardians", "participant-requirements", "unattended", "communications", "courts"], id).toContain(id);
    // A venue with no coaching asking to add it is shown the coaching steps, with a reason that says so.
    const profile = await readVenueProfile(trading);
    const coaching = buildSetupPlan({ profile, answers: emptyAnswers(), acknowledged: {}, role: "manager", focus: "coaching" });
    expect(coaching.items.map((i) => i.id)).toEqual(["coaches", "coach-hours"]);
    expect(coaching.items.every((i) => i.because.key === "gs.because.focus")).toBe(true);
    // Every focus the route accepts names a group or a capability a step concerns.
    expect(focusIds()).toEqual(expect.arrayContaining(["policies", "programmes", "branches", "staff-invitations", "activity-catalogue"]));
    const viaRoute = await (await journey(trading, asTrading, "staff-invitations")).json();
    expect(viaRoute.plan.items.map((i: { id: string }) => i.id)).toEqual(["staff"]);
    expect(viaRoute.extras.focus).toBe("staff-invitations");
  });
});

describe("what it shows beside the plan", () => {
  it("prices one hour at 8 pm on the next Saturday with the real quote, from the venue's saved rates", async () => {
    const view = await journeyView(trading, "manager", null);
    const saturday = nextSaturday(today);
    expect(dayOfWeek(saturday)).toBe(6);
    expect(saturday > today).toBe(true);
    expect(view.extras.prices).toHaveLength(1);
    const [example] = view.extras.prices;
    expect(example).toMatchObject({ court: "Court A", date: saturday, startMin: 20 * 60, minutes: 60, peak: true });
    const quote = await quoteFor({ courtId: tradingCourt, date: saturday, start: 20 * 60, minutes: 60 });
    if (!quote.ok) throw new Error("quote");
    expect(example.total).toBe(quote.quote.total);
    // A Saturday evening is peak: the peak rate, not the off-peak one.
    expect(example.total).toBe(30);
  });

  it("follows a change of the venue's rates and peak hours made through the existing routes", async () => {
    const court = ok(await createCourt({ venueId: small, name: "Rate Court", sport: "badminton", offPeakRate: 18, peakRate: 28 }));
    const before = (await journeyView(small, "manager", null)).extras.prices.find((p) => p.courtId === court.court.id)!;
    expect(before.total).toBe(28);
    // The rates step's own request.
    const patched = await courtPatch(req("PATCH", `/api/admin/courts/${court.court.id}`, asSmall, { offPeakRate: 20, peakRate: 35 }), ctx(court.court.id));
    expect(patched.status).toBe(200);
    expect((await journeyView(small, "manager", null)).extras.prices.find((p) => p.courtId === court.court.id)!.total).toBe(35);
    expect(ratesOn((await getVenue(small))!.courts.find((c) => c.id === court.court.id)!, today).peakRate).toBe(35);
    // The peak hours step's own request: no peak on Saturdays any more.
    const peak = await peakPost(req("POST", "/api/admin/peak-rules", asSmall, { venueId: small, weekdayFrom: 18 * 60, weekdayUntil: 24 * 60, weekendDays: [0], weekendFrom: 0, weekendUntil: 24 * 60 }));
    expect(peak.status).toBe(200);
    const after = (await journeyView(small, "manager", null)).extras.prices.find((p) => p.courtId === court.court.id)!;
    expect(after.total).toBe(35);
    const peakFromSix = await peakPost(req("POST", "/api/admin/peak-rules", asSmall, { venueId: small, weekdayFrom: 18 * 60, weekdayUntil: 24 * 60, weekendDays: [], weekendFrom: 0, weekendUntil: 24 * 60 }));
    expect(peakFromSix.status).toBe(200);
    // Saturday is now a working day, with peak from 6 pm: 8 pm is still peak, so ask for a window that ends before it.
    await peakPost(req("POST", "/api/admin/peak-rules", asSmall, { venueId: small, weekdayFrom: 9 * 60, weekdayUntil: 12 * 60, weekendDays: [], weekendFrom: 0, weekendUntil: 24 * 60 }));
    const offPeak = (await journeyView(small, "manager", null)).extras.prices.find((p) => p.courtId === court.court.id)!;
    expect(offPeak).toMatchObject({ total: 20, peak: false });
  });

  it("ticks Try it from saved state only: a test booking, a counter payment, a cancellation by staff (not the banner's clearing)", async () => {
    const court = ok(await createCourt({ venueId: fresh, name: "Try Court", sport: "badminton", offPeakRate: 10, peakRate: 10 }));
    const first = async () => (await journeyView(fresh, "manager", null)).extras.tryIt;
    expect(await first()).toMatchObject({ live: false, made: 0, standing: 0, cancelled: 0, counterPaid: 0, publicPath: `/venue/${fresh}` });
    // A booking made while the venue is a draft is a test.
    const a = ok(await createBooking({ courtId: court.court.id, date: addDays(today, 4), hours: [9], name: "Tester", phone: "0123450001" }));
    expect(await first()).toMatchObject({ made: 1, standing: 1, cancelled: 0, counterPaid: 0 });
    ok(await setPaymentStatus(a.booking.code, true, "cash"));
    expect(await first()).toMatchObject({ made: 1, standing: 1, counterPaid: 1 });
    // Cancelled by staff: ticked. Cleared in bulk by the banner is not "cancel it and read the terms".
    ok(await adminCancelBooking(a.booking.code));
    expect(await first()).toMatchObject({ made: 1, standing: 0, cancelled: 1 });
    const b = ok(await createBooking({ courtId: court.court.id, date: addDays(today, 4), hours: [11], name: "Tester", phone: "0123450001" }));
    const cleared = await clearTestBookings({ id: smallManager.id, name: smallManager.name }, fresh, [b.booking.code]);
    expect(cleared.done).toEqual([b.booking.code]);
    expect(await first()).toMatchObject({ made: 2, standing: 0, cancelled: 1 });
  });
});

describe("every action is the existing route's, with its own validation and its own refusals", () => {
  it("hours: widening them through the venue route changes what can be booked and ticks the checklist; narrowing them under a booking is refused in the application's words", async () => {
    const court = ok(await createCourt({ venueId: small, name: "Hours Court", sport: "badminton", offPeakRate: 15, peakRate: 25 }));
    const date = addDays(today, 3);
    const held = ok(await createBooking({ courtId: court.court.id, date, hours: [20], name: "Late Lee", phone: "0123450002" }));
    expect((await readVenueProfile(small)).setup.detailsChecked).toBe(false);
    // Narrowed under the booking: refused, naming it; nothing changed and nothing ticked.
    const refused = await venuePatch(req("PATCH", `/api/admin/venues/${small}`, asSmall, { openMin: 8 * 60, closeMin: 19 * 60 }), ctx(small));
    expect(refused.status).toBe(400);
    const why = await refused.json();
    expect(why.error).toMatch(/booking/i);
    expect(JSON.stringify(why.stranded)).toContain(held.booking.code);
    expect((await getVenue(small))!.closeMin).toBe(23 * 60);
    expect((await readVenueProfile(small)).setup.detailsChecked).toBe(false);
    // Widened: saved, in the profile at once, the checklist's step ticked, and a booking an hour earlier is now possible.
    const widened = await venuePatch(req("PATCH", `/api/admin/venues/${small}`, asSmall, { openMin: 6 * 60, closeMin: 23 * 60 }), ctx(small));
    expect(widened.status).toBe(200);
    const profile = await readVenueProfile(small);
    expect(profile.hours).toMatchObject({ openMin: 6 * 60, closeMin: 23 * 60 });
    expect(profile.setup.detailsChecked).toBe(true);
    expect(ok(await createBooking({ courtId: court.court.id, date, hours: [6], name: "Early Eve", phone: "0123450003" })).booking.startHour).toBe(6);
    const plan = (await (await journey(small, asSmall)).json()).plan;
    expect(plan.items.find((i: { id: string }) => i.id === "details").state.status).toBe("done");
  });

  it("hours: saying they are right as they are is the checklist's own request", async () => {
    expect((await readVenueProfile(fresh)).setup.detailsChecked).toBe(false);
    const done = await checklistPost(req("POST", "/api/admin/setup", asFresh, { venueId: fresh, action: "detailsChecked" }));
    expect(done.status).toBe(200);
    expect((await readVenueProfile(fresh)).setup.detailsChecked).toBe(true);
  });

  it("resources: courts added from an activity's template appear on the venue and are counted by the plan; a bad request is refused", async () => {
    const before = (await readVenueProfile(fresh)).setup.courts;
    const made = await courtsPost(req("POST", "/api/admin/courts", asFresh, { venueId: fresh, sport: "badminton", count: 4, noun: "court", offPeakRate: 12, peakRate: 20, capacity: 1, deposit: 0, perPlayer: false, maxPlayers: null, setting: null }));
    expect(made.status).toBe(201);
    const names = ((await made.json()).courts as { name: string }[]).map((c) => c.name);
    expect(names).toHaveLength(4);
    const venue = (await getVenue(fresh))!;
    for (const n of names) expect(venue.courts.map((c) => c.name)).toContain(n);
    expect((await readVenueProfile(fresh)).setup.courts).toBe(before + 4);
    const plan = (await (await journey(fresh, asFresh)).json()).plan;
    expect(plan.items.find((i: { id: string }) => i.id === "courts").state.status).toBe("done");
    // The application's own refusals.
    const noRate = await courtsPost(req("POST", "/api/admin/courts", asFresh, { venueId: fresh, sport: "badminton", count: 2, offPeakRate: -1, peakRate: 20 }));
    expect(noRate.status).toBe(400);
    const tooMany = await courtsPost(req("POST", "/api/admin/courts", asFresh, { venueId: fresh, sport: "badminton", count: 500, offPeakRate: 1, peakRate: 1 }));
    expect(tooMany.status).toBe(400);
    const elsewhere = await courtsPost(req("POST", "/api/admin/courts", asFresh, { venueId: theirs, sport: "badminton", count: 1, offPeakRate: 1, peakRate: 1 }));
    expect(elsewhere.status).toBe(403);
  });

  it("cancellation: the terms saved through the existing routes change what a cancellation then does", async () => {
    const court = ok(await createCourt({ venueId: small, name: "Terms Court", sport: "badminton", offPeakRate: 40, peakRate: 40 }));
    await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 48 WHERE id = ?").run(small);
    const soon = addDays(today, 1);
    const first = ok(await createBooking({ courtId: court.court.id, date: soon, hours: [9], name: "Aisyah", phone: "0197770001" }));
    // As set up: inside the cutoff, a customer cannot cancel online.
    const refused = await cancelBooking(first.booking.code, "0197770001");
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.error).toContain("48 hours");
    // The journey's own requests: the cutoff, then the late-cancellation terms.
    const cutoff = await venuePatch(req("PATCH", `/api/admin/venues/${small}`, asSmall, { cancelCutoffHours: 48 }), ctx(small));
    expect(cutoff.status).toBe(200);
    const saved = await cancelPolicyPost(req("POST", "/api/admin/cancel-policy", asSmall, { venueId: small, lateKeep: 50 }));
    expect(saved.status).toBe(200);
    expect((await cancelPolicy(small)).lateKeep).toBe(50);
    expect((await readVenueProfile(small)).policies.cancellation.lateKeepPercent).toBe(50);
    const second = ok(await createBooking({ courtId: court.court.id, date: soon, hours: [10], name: "Aisyah", phone: "0197770001" }));
    await setPaymentStatus(second.booking.code, true, "cash");
    const late = await cancelBooking(second.booking.code, "0197770001");
    expect(late).toMatchObject({ ok: true, kept: 20 });
    // A cutoff the application refuses is refused here too.
    const tooLong = await venuePatch(req("PATCH", `/api/admin/venues/${small}`, asSmall, { cancelCutoffHours: 500 }), ctx(small));
    expect(tooLong.status).toBe(400);
    const badKeep = await cancelPolicyPost(req("POST", "/api/admin/cancel-policy", asSmall, { venueId: small, lateKeep: 101 }));
    expect(badKeep.status).toBe(400);
  });

  it("booking rules: a gap saved through the existing route keeps the next booking away", async () => {
    const court = ok(await createCourt({ venueId: small, name: "Gap Court", sport: "badminton", offPeakRate: 15, peakRate: 15 }));
    const date = addDays(today, 6);
    const saved = await policiesPost(req("POST", "/api/admin/booking-policies", asSmall, { venueId: small, level: "court", courtId: court.court.id, settings: { bufferAfter: 15 } }));
    expect(saved.status).toBe(200);
    expect((await readVenueProfile(small)).resources.withBuffers).toBeGreaterThan(0);
    ok(await createBooking({ courtId: court.court.id, date, hours: [18], name: "First", phone: "0123450010" }));
    const next = await createBooking({ courtId: court.court.id, date, hours: [19], name: "Second", phone: "0123450011" });
    expect(next.ok).toBe(false);
    const rules = (await (await journey(small, asSmall)).json()).plan.items.find((i: { id: string }) => i.id === "booking-rules");
    expect(rules.state.status).toBe("done");
    // A setting the application refuses is refused.
    const bad = await policiesPost(req("POST", "/api/admin/booking-policies", asSmall, { venueId: small, level: "court", courtId: court.court.id, settings: { bufferAfter: 9999 } }));
    expect(bad.status).toBe(400);
  });

  it("staff: an invitation sent through the staff route exists, counts in the profile and ticks the step; the application's refusals stand", async () => {
    const before = (await readVenueProfile(fresh)).staff.pendingInvitations;
    const step = async () => (await (await journey(fresh, asFresh)).json()).plan.items.find((i: { id: string }) => i.id === "staff").state.status;
    expect(await step()).toBe("optional");
    const bad = await adminsPost(req("POST", "/api/admin/admins", asFresh, { name: "X", email: "not-an-address", venueId: fresh, role: "desk" }));
    expect(bad.status).toBe(400);
    const wrongVenue = await adminsPost(req("POST", "/api/admin/admins", asFresh, { name: "Nina Desk", email: "nina@setup.my", venueId: theirs, role: "desk" }));
    expect(wrongVenue.status).toBe(403);
    expect((await readVenueProfile(fresh)).staff.pendingInvitations).toBe(before);
    // As the staff step asks: what this install can do (an emailed invitation, or an account with a typed password), then the request.
    const options = await (await adminsGet(req("GET", "/api/admin/admins", asFresh))).json();
    const invite = { name: "Nina Desk", email: "nina@setup.my", venueId: fresh, role: "desk", locale: "ms" };
    const sent = await adminsPost(req("POST", "/api/admin/admins", asFresh, options.typedPassword ? { ...invite, password: "a long enough password" } : invite));
    expect(sent.status).toBe(201);
    const after = await readVenueProfile(fresh);
    expect(options.invitationsPossible ? after.staff.pendingInvitations : after.staff.desk).toBeGreaterThan(options.invitationsPossible ? before : 0);
    expect(await step()).toBe("done");
    // Without a typed password where this install cannot email, the route refuses in its own words.
    if (options.typedPassword) {
      const refused = await adminsPost(req("POST", "/api/admin/admins", asFresh, { ...invite, email: "nina2@setup.my" }));
      expect(refused.status).toBe(400);
    }
  });

  it("the front desk is refused every one of these routes, as it always was", async () => {
    const paths: [typeof venuePatch, string, string, unknown][] = [[venuePatch, `/api/admin/venues/${small}`, "PATCH", { openMin: 480 }]];
    for (const [handler, path, method, body] of paths) expect((await handler(req(method, path, asDesk, body), ctx(small))).status).toBe(403);
    expect((await courtsPost(req("POST", "/api/admin/courts", asDesk, { venueId: small, sport: "badminton", count: 1, offPeakRate: 1, peakRate: 1 }))).status).toBe(403);
    expect((await cancelPolicyPost(req("POST", "/api/admin/cancel-policy", asDesk, { venueId: small, lateKeep: 10 }))).status).toBe(403);
    expect((await adminsPost(req("POST", "/api/admin/admins", asDesk, { name: "Nobody", email: "nobody@setup.my", venueId: small, role: "desk" }))).status).toBe(403);
  });
});

describe("save and resume", () => {
  it("holds the answers on the server: what one session saves, another session reads, and every save moves the revision", async () => {
    const start = (await (await setupGet(req("GET", `/api/admin/guide/setup?venueId=${small}`, asSmall))).json()) as { rev: number };
    const save = (cookie: string, rev: number, answers: unknown) => setupPost(req("POST", "/api/admin/guide/setup", cookie, { venueId: small, action: "answers", answers, rev }));
    const one = await save(asSmall, start.rev, { types: ["badminton-and-pickleball"], resources: "few" });
    expect(one.status).toBe(200);
    // The phone and the computer agree.
    const computer = await (await journey(small, asSmallSecond)).json();
    expect(computer.answers).toMatchObject({ types: ["badminton-and-pickleball"], resources: "few" });
    expect(computer.rev).toBe(start.rev + 1);
    const two = await save(asSmallSecond, computer.rev, { channels: ["online", "counter"] });
    expect(two.status).toBe(200);
    const phone = await (await journey(small, asSmall)).json();
    expect(phone.answers).toMatchObject({ types: ["badminton-and-pickleball"], resources: "few", channels: ["online", "counter"] });
    // Taking an answer back with null keeps the others.
    const back = await save(asSmall, phone.rev, { resources: null });
    expect(back.status).toBe(200);
    expect((await readGuide(small)).answers).toMatchObject({ types: ["badminton-and-pickleball"], channels: ["online", "counter"] });
    expect((await readGuide(small)).answers.resources).toBeUndefined();
  });

  it("refuses a save made on a stale revision, shows the answers now saved, and loses neither", async () => {
    const now = await readGuide(small);
    const winner = await setupPost(req("POST", "/api/admin/guide/setup", asSmall, { venueId: small, action: "answers", answers: { coaching: true }, rev: now.rev }));
    expect(winner.status).toBe(200);
    const loser = await setupPost(req("POST", "/api/admin/guide/setup", asSmallSecond, { venueId: small, action: "answers", answers: { children: true }, rev: now.rev }));
    expect(loser.status).toBe(409);
    const body = await loser.json();
    expect(body.stale).toBe(true);
    expect(body.answers).toMatchObject({ coaching: true });
    expect(body.answers.children).toBeUndefined();
    // Saved again on top of what it lost to: both are there.
    const again = await setupPost(req("POST", "/api/admin/guide/setup", asSmallSecond, { venueId: small, action: "answers", answers: { children: true }, rev: body.rev }));
    expect(again.status).toBe(200);
    expect((await readGuide(small)).answers).toMatchObject({ coaching: true, children: true });
  });

  it("saves, in a steady revision, many answers saved at once: one wins each round and none is lost", async () => {
    const venue = (await signUp("Racing Courts", "racing@setup.my")).venueId;
    const keys = ["coaching", "children", "competitions", "discounts"] as const;
    const pending = new Set<string>(keys);
    for (let round = 0; round < 8 && pending.size > 0; round++) {
      const rev = (await readGuide(venue)).rev;
      const results = await Promise.all([...pending].map((k) => saveAnswers(venue, { [k]: true }, rev)));
      [...pending].forEach((k, i) => results[i].ok && pending.delete(k));
    }
    expect(pending.size).toBe(0);
    expect((await readGuide(venue)).answers).toMatchObject({ coaching: true, children: true, competitions: true, discounts: true });
  });
});

describe("a venue with bookings", () => {
  it("is recognised: what it has reads done, and nothing offered writes starting values over its own", async () => {
    const profile = await readVenueProfile(trading);
    const plan = buildSetupPlan({ profile, answers: emptyAnswers(), acknowledged: {}, role: "manager" });
    expect(plan.items.find((i) => i.id === "courts")!.state.status).toBe("done");
    expect(plan.items.every((i) => ["open", "add", "review"].includes(i.effect))).toBe(true);
    // Rates are shown to read, with the dated change offered: its price step exists, and a price from a date applies to later bookings only.
    expect(plan.items.map((i) => i.id)).toEqual(expect.arrayContaining(["price-dates", "prices"]));
  });

  it("is changed by nothing the journey itself does: reading it, saving answers and saying a review was done leave every setting as it was", async () => {
    const snapshot = async () => {
      const db = getDb();
      return JSON.stringify({
        venue: await db.prepare("SELECT * FROM venues WHERE id = ?").get(trading),
        courts: await db.prepare("SELECT * FROM courts WHERE venue_id = ? ORDER BY id").all(trading),
        policies: await db.prepare("SELECT * FROM booking_policies WHERE venue_id = ? OR court_id IN (SELECT id FROM courts WHERE venue_id = ?)").all(trading, trading),
        changes: await db.prepare("SELECT * FROM court_changes WHERE court_id IN (SELECT id FROM courts WHERE venue_id = ?)").all(trading),
        bookings: await db.prepare("SELECT code, status, total_price, payment_status FROM bookings b JOIN courts c ON c.id = b.court_id WHERE c.venue_id = ? ORDER BY code").all(trading),
        settings: await db.prepare("SELECT key, value FROM settings WHERE key LIKE ? ORDER BY key").all(`setup.%.${trading}`),
      });
    };
    const before = await snapshot();
    for (let i = 0; i < 3; i++) {
      expect((await journey(trading, asTrading)).status).toBe(200);
      expect((await journey(trading, asTrading, "policies")).status).toBe(200);
    }
    const rev = (await readGuide(trading)).rev;
    expect((await setupPost(req("POST", "/api/admin/guide/setup", asTrading, { venueId: trading, action: "answers", answers: { types: ["badminton-and-pickleball"], coaching: false }, rev }))).status).toBe(200);
    expect((await setupPost(req("POST", "/api/admin/guide/setup", asTrading, { venueId: trading, action: "acknowledge", step: "cancellation-terms" }))).status).toBe(200);
    expect(await snapshot()).toBe(before);
    // The review is recorded, as the manager's own act.
    const plan = (await (await journey(trading, asTrading)).json()).plan;
    expect(plan.items.find((i: { id: string }) => i.id === "cancellation-terms").state.status).toBe("done");
  });
});

describe("the checklist and the journey agree", () => {
  it("about whether the venue is set up, at each stage of setting one up", async () => {
    const venue = (await signUp("Stages Courts", "stages@setup.my")).venueId;
    const manager = await cookieOf((await authenticateAdmin("stages@setup.my", PASSWORD))!);
    const agree = async () => {
      const checklist = await venueSetup(venue);
      const plan = (await (await journey(venue, manager)).json()).plan as { items: { id: string; required: boolean; state: { status: string } }[] };
      const required = plan.items.filter((i) => i.required);
      // The journey's first three steps ARE the checklist's three.
      expect(required.map((i) => i.id)).toEqual(["details", "courts", "test-booking"]);
      const set = required.every((i) => i.state.status === "done");
      expect(set, JSON.stringify(checklist)).toBe(checklist.complete);
      const state = (id: string) => plan.items.find((i) => i.id === id)!.state.status === "done";
      expect(state("courts")).toBe(checklist.courts > 0);
      expect(state("details")).toBe(checklist.detailsChecked);
      expect(state("test-booking")).toBe(checklist.testBooking);
      return checklist.complete;
    };
    expect(await agree()).toBe(false);
    const court = ok(await createCourt({ venueId: venue, name: "Stage Court", sport: "badminton", offPeakRate: 10, peakRate: 10 }));
    expect(await agree()).toBe(false);
    await checklistPost(req("POST", "/api/admin/setup", manager, { venueId: venue, action: "detailsChecked" }));
    expect(await agree()).toBe(false);
    ok(await createBooking({ courtId: court.court.id, date: addDays(today, 2), hours: [10], name: "Test", phone: "0123450099" }));
    expect(await agree()).toBe(true);
  });
});

describe("launch readiness, as the journey shows it", () => {
  it("asks a counter-only venue nothing of online payment, and shows the checks once online payment is switched on", async () => {
    const profile = await readVenueProfile(fresh);
    const counter = launchReadiness(profile);
    const all = (r: ReturnType<typeof launchReadiness>) => [...r.requiredMissing, ...r.unverifiedExternal, ...r.optionalEnhancements, ...r.featureSpecific, ...r.legalPrerequisite].map((i) => i.id);
    expect(all(counter)).not.toContain("online-account");
    expect(all(counter)).not.toContain("online-unverified");
    // Every item says why, and where to fix it where there is a screen.
    for (const item of [...counter.requiredMissing, ...counter.unverifiedExternal, ...counter.legalPrerequisite, ...counter.optionalEnhancements]) expect(item.why, item.id).toBeDefined();
    // The launch step is the summary itself, not an item of it.
    expect(all(counter)).not.toContain("launch");
    ok(await savePaymentSettings(fresh, { apiKey: "api-key-9999", collectionId: "col999", xSignatureKey: "S-key-9", sandbox: true, enabled: true }));
    const online = launchReadiness(await readVenueProfile(fresh));
    expect(online.unverifiedExternal.map((i) => i.id)).toContain("online-unverified");
    expect(JSON.stringify(online)).not.toContain("api-key-9999");
  });

  it("shows no e-invoicing check to a venue that does not use it, and keeps the compliance notice", async () => {
    const r = launchReadiness(await readVenueProfile(small));
    expect(r.unverifiedExternal.map((i) => i.id)).not.toContain("einvoice");
    expect(r.legalPrerequisite.map((i) => i.id)).toContain("einvoice-notice");
    const steps = await stepIds(small, emptyAnswers());
    expect(steps).not.toContain("einvoicing");
  });
});

describe("what it says of the catalogue", () => {
  it("says an activity's limitation as the catalogue says it, and never claims what is not built", async () => {
    const { activityFacts } = await import("../src/lib/guide/business-types");
    // Kayak hire (a gym's entry without a session is built since: lib/entries.ts; so are an archery range's rostered range officers: lib/rosters.ts).
    const kayak = activityFacts("kayak")!;
    expect(kayak.support).toBe("basic");
    expect(kayak.supportNote).toContain("Not built");
    // The picker reads the same note from the catalogue (components/admin/guide/SetupDiscovery.tsx); the dictionaries carry its Malay and Chinese.
    for (const locale of ["ms", "zh"] as const) expect(STAFF_DICTIONARIES[locale]["srv.support.kayak" as keyof (typeof STAFF_DICTIONARIES)["en"]]).toBeTruthy();
    // An archery range is fully supported, and is told its range officer can be rostered: the capability rests on the roster's feature row.
    expect(activityFacts("archery")!.support).toBe("full");
    expect(capability("range-officer")).toMatchObject({ status: "available", featureRow: "Supervisor rosters and supervision rules" });
    expect(capability("gym-walk-in")!.status).toBe("available");
  });
});

describe("the words", () => {
  it("every phrase the journey can say is in all three staff languages, and every step has its longer explanation", async () => {
    const keys = new Set<string>();
    const profiles = [await readVenueProfile(fresh), await readVenueProfile(small), await readVenueProfile(trading)];
    const answers = [
      emptyAnswers(),
      withAnswers({ types: ["multi-sport"], activities: ["badminton"], customersDo: ["reserve", "classes", "hire", "memberships"], resources: "many", branches: "several", staffing: "partial", channels: ["online", "counter"], memberships: ["passes"], coaching: true, children: true, audience: "both", competitions: true, discounts: true }),
    ];
    for (const profile of profiles)
      for (const a of answers)
        for (const focus of [undefined, ...focusIds()])
          for (const item of buildSetupPlan({ profile, answers: a, acknowledged: {}, role: "manager", ...(focus ? { focus } : {}) }).items) {
            keys.add(item.titleKey).add(item.whyKey).add(item.because.key);
            for (const say of [item.recommend, item.consequence, item.platformRule, item.state.note]) if (say) keys.add(say.key);
            keys.add(`gs.more.${item.id}`);
          }
    for (const step of SETUP_STEPS) keys.add(`gs.more.${step.id}`);
    for (const q of QUESTIONS) for (const k of [q.title, q.help]) keys.add(k);
    for (const key of keys) for (const locale of ["en", "ms", "zh"] as const) expect(STAFF_DICTIONARIES[locale][key as keyof (typeof STAFF_DICTIONARIES)["en"]], `${key} in ${locale}`).toBeTruthy();
    // Readiness items say why, in the dictionaries too.
    for (const profile of profiles) {
      const r = launchReadiness(profile);
      for (const item of [...r.requiredMissing, ...r.unverifiedExternal, ...r.legalPrerequisite, ...r.featureSpecific, ...r.optionalEnhancements])
        if (item.why) for (const locale of ["en", "ms", "zh"] as const) expect(STAFF_DICTIONARIES[locale][item.why.key], `${item.why.key} in ${locale}`).toBeTruthy();
    }
  });
});
