import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { BUILTIN_ACTIVITIES } from "../src/lib/activity-catalogue";
import { DICTIONARIES, LOCALES } from "../src/lib/i18n";
import { STAFF_DICTIONARIES } from "../src/lib/staff-i18n";
import { STAFF_ACTIONS } from "../src/lib/roles";
import { applyPatch, emptyAnswers, normaliseFit, readStored, validatePatch, MAX_FIT_CHARS } from "../src/lib/guide/answer-schema";
import { BUSINESS_TYPES, BUSINESS_TYPE_IDS, WORKFLOW_IDS, activityFacts, businessType, composeTypes } from "../src/lib/guide/business-types";
import { capability } from "../src/lib/guide/capabilities";
import { DISCOVERY_RULES, MAX_DISCOVERIES, discover } from "../src/lib/guide/discover";
import { buildSetupPlan, type SetupStep, type StepContext } from "../src/lib/guide/plan";
import { emptyProfile, hasHistory, isEmptyVenue, usesOnlinePayments, type VenueProfile } from "../src/lib/guide/profile-types";
import { launchReadiness } from "../src/lib/guide/readiness";
import { DASHBOARD_TABS, GUIDE_ROLES, mayViewAs } from "../src/lib/guide/shell";
import { SETUP_STEPS, reviewState } from "../src/lib/guide/steps";

/**
 * The guide's shared model without a database: the dashboard's tabs, the roles,
 * the business types, the discovery answers, the setup plan's rules, the
 * readiness groups and the discoveries, over profiles written by hand. What
 * they say of a venue's *real* configuration is in tests/guide-profile.test.ts.
 */

const ctx = (profile: VenueProfile, answers = emptyAnswers(), acknowledged: StepContext["acknowledged"] = {}, role: StepContext["role"] = "manager"): StepContext => ({
  profile,
  answers,
  acknowledged,
  role,
});
const ids = (profile: VenueProfile, answers = emptyAnswers(), acknowledged: StepContext["acknowledged"] = {}) => buildSetupPlan(ctx(profile, answers, acknowledged)).items.map((i) => i.id);
const withAnswers = (patch: Record<string, unknown>) => {
  const checked = validatePatch(patch);
  if (!checked.ok) throw new Error(checked.error);
  return applyPatch(emptyAnswers(), checked.patch);
};

describe("the guide's place in the dashboard", () => {
  it("lists the tabs the dashboard page lists, so a capability can never open a screen that is not there", () => {
    const page = fs.readFileSync(path.join(__dirname, "..", "src/app/admin/page.tsx"), "utf8");
    const listed = /const TABS = \[([^\]]*)\] as const;/.exec(page)![1].match(/"(\w+)"/g)!.map((s) => s.replace(/"/g, ""));
    expect(listed).toEqual([...DASHBOARD_TABS]);
    expect(DASHBOARD_TABS).toContain("guide");
  });

  it("lets a role be previewed by itself and by roles above it, never below", () => {
    expect(GUIDE_ROLES).toEqual(["manager", "desk", "coach"]);
    expect(mayViewAs("manager", "manager")).toBe(true);
    expect(mayViewAs("manager", "desk")).toBe(true);
    expect(mayViewAs("manager", "coach")).toBe(true);
    expect(mayViewAs("desk", "desk")).toBe(true);
    expect(mayViewAs("desk", "coach")).toBe(true);
    expect(mayViewAs("desk", "manager")).toBe(false);
    expect(mayViewAs("coach", "desk")).toBe(false);
  });
});

describe("business types", () => {
  it("are the thirteen the owner named, each with real activities, capabilities and workflows", () => {
    expect(BUSINESS_TYPE_IDS).toHaveLength(13);
    expect(BUSINESS_TYPES.map((b) => b.id)).toEqual([...BUSINESS_TYPE_IDS]);
    const catalogue = new Set(BUILTIN_ACTIVITIES.map((a) => a.key));
    for (const b of BUSINESS_TYPES) {
      expect(b.activities.length, b.id).toBeGreaterThan(0);
      for (const key of b.activities) expect(catalogue.has(key), `${b.id}: ${key}`).toBe(true);
      for (const id of b.capabilities) expect(capability(id), `${b.id}: ${id}`).toBeDefined();
      for (const w of b.workflows) expect(WORKFLOW_IDS, `${b.id}: ${w}`).toContain(w);
      // The models are the activities' own, as the catalogue says.
      expect(b.models, b.id).toEqual(expect.arrayContaining([...new Set(b.activities.map((k) => activityFacts(k)!.model))]));
      for (const locale of LOCALES) expect((DICTIONARIES[locale] as Record<string, string>)[b.titleKey], `${b.id} in ${locale}`).toBeTruthy();
    }
  });

  it("carry an illustrative profile of the profile's own shape, never read from a venue", () => {
    for (const b of BUSINESS_TYPES) {
      expect(b.profile.illustrative, b.id).toBe(true);
      expect(b.profile.venueId, b.id).toBe(0);
      expect(b.profile.resources.total, b.id).toBeGreaterThan(0);
      expect(Object.values(b.profile.resources.byModel).reduce((a, n) => a + n, 0), b.id).toBe(b.profile.resources.total);
      expect(b.profile.activities.map((a) => a.key), b.id).toEqual(b.activities);
    }
  });

  it("warn about what is not supported, where the catalogue says so, instead of promising it", () => {
    // A gym is never sold as sessionless admission: the type lists the unsupported capability, and the catalogue's own note is why.
    expect(businessType("gym-and-fitness")!.capabilities).toContain("gym-walk-in");
    expect(capability("gym-walk-in")!.status).toBe("unsupported");
    expect(businessType("climbing-and-bouldering")!.capabilities).toContain("open-day-pass");
    // A type never offers an available capability its own list does not name, and a coaching academy does not hire equipment out.
    expect(businessType("coaching-academy")!.capabilities).not.toContain("equipment-hire");
    expect(businessType("coaching-academy")!.capabilities).toContain("coaching");
    expect(businessType("not-a-type")).toBeUndefined();
  });

  it("read an activity's support and its note from the catalogue, not a copy", () => {
    for (const a of BUILTIN_ACTIVITIES) {
      const facts = activityFacts(a.key)!;
      expect(facts.support).toBe(a.support);
      expect(facts.supportNote).toBe(a.supportNote);
      expect(facts.model).toBe(a.template.model);
    }
    expect(activityFacts("climbing")!.supportNote).toContain("open-ended day passes");
    expect(activityFacts("not-an-activity")).toBeUndefined();
  });

  it("combine, so a mixed venue is not forced into one: the union, with where each came from", () => {
    const both = composeTypes(["badminton-and-pickleball", "gym-and-fitness", "not-a-type", "gym-and-fitness"]);
    expect(both.types).toEqual(["badminton-and-pickleball", "gym-and-fitness"]);
    expect(both.activities.find((a) => a.key === "badminton")!.from).toEqual(["badminton-and-pickleball"]);
    expect(both.activities.map((a) => a.key)).toEqual(expect.arrayContaining(["badminton", "pickleball", "gym", "yoga", "pilates"]));
    expect(both.capabilities.find((c) => c.id === "memberships")!.from).toEqual(["badminton-and-pickleball", "gym-and-fitness"]);
    expect(both.capabilities.find((c) => c.id === "gym-walk-in")!.from).toEqual(["gym-and-fitness"]);
    expect(both.models).toEqual(expect.arrayContaining(["exclusive", "shared", "class"]));
    const a = businessType("badminton-and-pickleball")!.profile;
    const b = businessType("gym-and-fitness")!.profile;
    expect(both.profile.resources.total).toBe(a.resources.total + b.resources.total);
    expect(both.profile.illustrative).toBe(true);
    expect(composeTypes([]).types).toEqual([]);
    expect(composeTypes(["nothing"]).profile.resources.total).toBe(0);
  });
});

describe("discovery answers", () => {
  it("accept the owner's questions and refuse anything else", () => {
    const ok = validatePatch({
      types: ["multi-sport"],
      activities: ["badminton", "futsal"],
      customersDo: ["reserve", "classes"],
      resources: "several",
      branches: "several",
      staffing: "partial",
      channels: ["online", "counter"],
      memberships: ["passes"],
      coaching: false,
      children: true,
      audience: "both",
    });
    expect(ok.ok).toBe(true);
    for (const bad of [
      { surprise: 1 },
      { types: ["not-a-type"] },
      { activities: ["not-an-activity"] },
      { activities: new Array(40).fill("badminton") },
      { resources: "plenty" },
      { staffing: "ghosts" },
      { coaching: "yes" },
      { channels: "online" },
      { audience: ["public"] },
      "types",
      null,
      [],
    ]) {
      const checked = validatePatch(bad);
      expect(checked.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("put a patch on answers, take an answer back with null, and read old rows without throwing", () => {
    const first = withAnswers({ coaching: true, branches: "several" });
    expect(first).toEqual({ v: 1, coaching: true, branches: "several" });
    const next = applyPatch(first, { coaching: null, children: false });
    expect(next).toEqual({ v: 1, branches: "several", children: false });
    expect(readStored({ v: 1, coaching: true, junk: 1, resources: "bogus", types: ["multi-sport", "ghost"] })).toEqual({ v: 1, coaching: true });
    expect(readStored("nonsense")).toEqual({ v: 1 });
    expect(readStored(null)).toEqual({ v: 1 });
  });

  it("check a fit from the public guide: business types and activities that exist, bounded", () => {
    expect(normaliseFit(undefined)).toEqual({ ok: true, fit: null });
    expect(normaliseFit(null)).toEqual({ ok: true, fit: null });
    expect(normaliseFit({})).toEqual({ ok: true, fit: null });
    expect(normaliseFit({ types: ["swimming"], activities: ["swimming"] })).toEqual({ ok: true, fit: { v: 1, types: ["swimming"], activities: ["swimming"] } });
    expect(normaliseFit({ types: ["spaceport"] }).ok).toBe(false);
    expect(normaliseFit({ activities: ["curling"] }).ok).toBe(false);
    expect(normaliseFit({ v: 2, types: ["swimming"] }).ok).toBe(false);
    expect(normaliseFit({ coaching: null }).ok).toBe(false);
    expect(normaliseFit("swimming").ok).toBe(false);
    expect(normaliseFit({ activities: new Array(MAX_FIT_CHARS).fill("badminton") }).ok).toBe(false);
  });
});

describe("the setup plan", () => {
  it("is conditional: a small badminton centre gets no coach, branch, class or tournament steps", () => {
    const profile = emptyProfile(1);
    const answers = withAnswers({ types: ["badminton-and-pickleball"], customersDo: ["reserve"], resources: "few", branches: "one", staffing: "staffed", channels: ["online", "counter"], coaching: false, children: false, audience: "public" });
    const steps = ids(profile, answers);
    expect(steps).toEqual(expect.arrayContaining(["details", "courts", "cancellation-terms", "online-payment", "test-booking"]));
    for (const absent of ["coaches", "coach-hours", "branches", "copied-branch", "classes", "memberships", "equipment", "guardians", "unattended"]) expect(steps, absent).not.toContain(absent);
    // The plan is in the order of its groups: the venue first, going live last.
    const plan = buildSetupPlan(ctx(profile, answers));
    expect(plan.groups.map((g) => g.group)).toEqual(["identity", "resources", "policies", "payments", "launch"]);
    expect(plan.items.at(-1)!.id).toBe("test-booking");
    // Each says why it is shown.
    for (const item of plan.items) expect(item.because.key.startsWith("gd.because."), item.id).toBe(true);
  });

  it("is conditional: a coaching academy gets coach, class and children steps, and no equipment hire", () => {
    const answers = withAnswers({ types: ["coaching-academy"], customersDo: ["classes", "memberships"], coaching: true, children: true, memberships: ["passes"], channels: ["online"] });
    const steps = ids(emptyProfile(1), answers);
    expect(steps).toEqual(expect.arrayContaining(["coaches", "coach-hours", "classes", "memberships", "guardians", "online-payment"]));
    expect(steps).not.toContain("equipment");
    expect(steps).not.toContain("branches");
    // The hours step waits for the coaches step, and says so, until there is a coach.
    const hours = buildSetupPlan(ctx(emptyProfile(1), answers)).items.find((i) => i.id === "coach-hours")!;
    expect(hours.state).toMatchObject({ status: "blocked", blockedBy: ["coaches"] });
  });

  it("is conditional: a multi-sport centre with branches gets the branch steps, and a counter-only venue no online payment step", () => {
    const multi = withAnswers({ types: ["multi-sport"], branches: "several", resources: "many", customersDo: ["reserve", "memberships"], memberships: ["memberships"] });
    const steps = ids(emptyProfile(1), multi);
    expect(steps).toEqual(expect.arrayContaining(["branches", "memberships"]));
    const counterOnly = withAnswers({ channels: ["counter"] });
    expect(ids(emptyProfile(1), counterOnly)).not.toContain("online-payment");
    // Not asked is not "no": a venue that has not said how customers book is shown the optional step.
    expect(ids(emptyProfile(1))).toContain("online-payment");
    // A counter-only answer does not hide it from a venue that has an online account.
    const online = emptyProfile(1);
    online.payments.online.accountExists = true;
    expect(ids(online, counterOnly)).toContain("online-payment");
  });

  it("reads each state from saved state: courts, details and a test booking from the checklist's own answers", () => {
    const p = emptyProfile(1);
    const state = (profile: VenueProfile, id: string) => buildSetupPlan(ctx(profile)).items.find((i) => i.id === id)!.state.status;
    expect(state(p, "courts")).toBe("todo");
    expect(state(p, "details")).toBe("todo");
    expect(state(p, "test-booking")).toBe("todo");
    p.setup = { ...p.setup, courts: 2, detailsChecked: true, testBooking: true };
    expect(state(p, "courts")).toBe("done");
    expect(state(p, "details")).toBe("done");
    expect(state(p, "test-booking")).toBe("done");
    // Required before going live: the three of the checklist, and nothing optional.
    const plan = buildSetupPlan(ctx(emptyProfile(1)));
    expect(plan.items.filter((i) => i.required).map((i) => i.id)).toEqual(["details", "courts", "test-booking"]);
    expect(plan.counts.requiredOpen).toBe(3);
  });

  it("calls the online payment step done when an account is enabled, but not proven until a payment is taken", () => {
    const p = emptyProfile(1);
    const item = (profile: VenueProfile) => buildSetupPlan(ctx(profile)).items.find((i) => i.id === "online-payment")!;
    expect(item(p).state.status).toBe("optional");
    expect(item(p).required).toBe(false);
    p.setup = { ...p.setup, onlinePayment: true };
    p.payments.online = { ...p.payments.online, accountExists: true, accountEnabled: true };
    expect(item(p).state).toMatchObject({ status: "done", verified: false, note: { key: "gd.step.onlinePayment.unverified" } });
    p.payments.online.firstPaymentTaken = true;
    expect(item(p).state).toMatchObject({ status: "done", verified: true });
    expect(item(p).consequence).not.toBeNull();
  });

  it("is done for a review only when a manager acknowledged it, with when and by whom", () => {
    const p = emptyProfile(1);
    const before = buildSetupPlan(ctx(p)).items.find((i) => i.id === "cancellation-terms")!;
    expect(before.state.status).toBe("review-needed");
    expect(before.consequence?.key).toBe("gd.step.cancellation.consequence");
    const ack = { "cancellation-terms": { at: "2026-10-31 10:00:00", byAdminId: 4, byName: "Musa" } };
    const after = buildSetupPlan(ctx(p, emptyAnswers(), ack)).items.find((i) => i.id === "cancellation-terms")!;
    expect(after.state).toEqual({ status: "done", reviewedAt: "2026-10-31 10:00:00", reviewedBy: "Musa" });
    expect(reviewState(ctx(p), "guardians").status).toBe("review-needed");
    // A review is required once money is taken online, and not before.
    expect(before.required).toBe(false);
    const online = emptyProfile(1);
    online.policies.payToHold = true;
    expect(buildSetupPlan(ctx(online)).items.find((i) => i.id === "cancellation-terms")!.required).toBe(true);
  });

  it("never leads a venue with history through a step that would write starting values over its own", () => {
    const defaults: SetupStep = {
      id: "starting-values",
      group: "policies",
      capabilities: ["booking-rules"],
      kind: "form",
      effect: "defaults",
      titleKey: "gd.step.details.title",
      whyKey: "gd.step.details.why",
      required: false,
      applies: () => ({ key: "gd.because.always" }),
      state: () => ({ status: "todo" }),
    };
    const registry = [...SETUP_STEPS, defaults];
    const empty = emptyProfile(1);
    expect(buildSetupPlan(ctx(empty), registry).items.map((i) => i.id)).toContain("starting-values");
    const established = emptyProfile(1);
    established.history.bookings = 40;
    established.history.paidBookings = 30;
    established.setup = { ...established.setup, courts: 6, detailsChecked: true, testBooking: true };
    expect(hasHistory(established)).toBe(true);
    expect(isEmptyVenue(established)).toBe(false);
    const plan = buildSetupPlan(ctx(established), registry);
    expect(plan.items.map((i) => i.id)).not.toContain("starting-values");
    // What it has already done reads done; nothing offered is a reset: only open, add and review exist for it.
    for (const id of ["details", "courts", "test-booking"]) expect(plan.items.find((i) => i.id === id)!.state.status, id).toBe("done");
    expect(plan.items.every((i) => ["open", "add", "review"].includes(i.effect))).toBe(true);
    // And the registry itself has no step that resets: its effects are the four there are.
    expect(new Set(SETUP_STEPS.map((s) => s.effect)).has("defaults")).toBe(false);
  });

  it("shows a link only where the role may use what it opens", () => {
    const p = emptyProfile(1);
    const manager = buildSetupPlan(ctx(p));
    const desk = buildSetupPlan(ctx(p, emptyAnswers(), {}, "desk"));
    for (const item of manager.items.filter((i) => i.staffAction)) expect(item.allowed, item.id).toBe(true);
    for (const item of desk.items.filter((i) => i.staffAction)) expect(item.allowed, item.id).toBe(false);
  });

  it("is built only from phrases the staff dictionaries have, in all three languages, naming real capabilities and staff actions", () => {
    const phrases = new Set<string>();
    for (const step of SETUP_STEPS) {
      phrases.add(step.titleKey);
      phrases.add(step.whyKey);
      for (const id of step.capabilities) expect(capability(id), `${step.id}: ${id}`).toBeDefined();
      if (step.staffAction) expect(Object.keys(STAFF_ACTIONS), step.id).toContain(step.staffAction);
      if (step.consequence) phrases.add(step.consequence.key);
    }
    // Everything a plan says for venues of every shape: the reasons, recommendations and notes.
    const shapes: [VenueProfile, ReturnType<typeof emptyAnswers>][] = [
      [emptyProfile(1), emptyAnswers()],
      [emptyProfile(1), withAnswers({ types: ["multi-sport"], activities: ["badminton"], customersDo: ["reserve", "classes", "hire", "memberships"], resources: "one", branches: "several", staffing: "partial", channels: ["online"], memberships: ["passes"], coaching: true, children: true, audience: "both" })],
    ];
    for (const band of ["one", "few", "several", "many"] as const) shapes.push([emptyProfile(1), withAnswers({ resources: band })]);
    const rich = emptyProfile(1);
    Object.assign(rich.people, { coaches: 2, classes: 3 });
    Object.assign(rich.guardians, { participants: 4 });
    Object.assign(rich.access, { unstaffedHours: true });
    rich.branches = { venues: 2, copiedFromBranch: true };
    rich.resources.byModel.hire = 1;
    rich.commerce.membershipPlans = 1;
    rich.payments.online.accountExists = true;
    shapes.push([rich, emptyAnswers()]);
    for (const [profile, answers] of shapes)
      for (const item of buildSetupPlan(ctx(profile, answers)).items)
        for (const say of [item.because, item.recommend, item.consequence, item.state.note]) if (say) phrases.add(say.key);
    for (const key of phrases)
      for (const locale of ["en", "ms", "zh"] as const) expect(STAFF_DICTIONARIES[locale][key as keyof (typeof STAFF_DICTIONARIES)["en"]], `${key} in ${locale}`).toBeTruthy();
  });
});

describe("launch readiness", () => {
  const groupsOf = (profile: VenueProfile) => launchReadiness(profile);
  const idsOf = (items: { id: string }[]) => items.map((i) => i.id);

  it("has six kinds of thing and no single score", () => {
    const r = groupsOf(emptyProfile(1));
    expect(Object.keys(r).sort()).toEqual(["configurationComplete", "featureSpecific", "legalPrerequisite", "optionalEnhancements", "requiredMissing", "unverifiedExternal"]);
    expect(JSON.stringify(r)).not.toMatch(/percent|score/i);
    expect(idsOf(r.requiredMissing)).toEqual(["details", "courts", "test-booking"]);
  });

  it("asks nothing of online payments in a venue that does not take them, and asks once it does", () => {
    const counter = emptyProfile(1);
    counter.channels.counter = true;
    counter.payments.counterMethods = ["cash"];
    const said = buildSetupPlan(ctx(counter, withAnswers({ channels: ["counter"] })));
    const before = launchReadiness(counter, said);
    const everything = [...before.requiredMissing, ...before.unverifiedExternal, ...before.optionalEnhancements, ...before.configurationComplete, ...before.featureSpecific];
    expect(idsOf(everything).some((id) => id.startsWith("online"))).toBe(false);
    // Not having said how customers book, the venue is offered it as an extra: never as something missing or unproven.
    const unsaid = groupsOf(counter);
    expect(idsOf(unsaid.optionalEnhancements)).toContain("online-payment");
    expect(idsOf([...unsaid.requiredMissing, ...unsaid.unverifiedExternal])).not.toContain("online-payment");
    // Switch online payment on, with an account that has taken no payment: it shows, unproven.
    const online = emptyProfile(1);
    online.setup = { ...online.setup, onlinePayment: true };
    online.payments.online = { accountExists: true, accountEnabled: true, sandbox: false, provider: "billplz", firstPaymentTaken: false };
    const after = groupsOf(online);
    expect(idsOf(after.unverifiedExternal)).toContain("online-unverified");
    expect(after.unverifiedExternal.find((i) => i.id === "online-unverified")!.integration).toBe("billplz");
    expect(after.unverifiedExternal.find((i) => i.id === "online-unverified")!.label.key).toBe("gd.ready.onlineUnverified");
    // In test mode it says so; with a real payment it is no longer unverified.
    online.payments.online.sandbox = true;
    expect(groupsOf(online).unverifiedExternal.find((i) => i.id === "online-unverified")!.label.key).toBe("gd.ready.onlineSandbox");
    online.payments.online.firstPaymentTaken = true;
    expect(idsOf(groupsOf(online).unverifiedExternal)).not.toContain("online-unverified");
    // Needing it for holds, with no account enabled, is required.
    const hold = emptyProfile(1);
    hold.policies.payToHold = true;
    expect(idsOf(groupsOf(hold).requiredMissing)).toContain("online-account");
    expect(usesOnlinePayments(hold)).toBe(true);
  });

  it("shows e-invoicing's checks only when it is on, and the compliance notice always in Malaysia", () => {
    const off = groupsOf(emptyProfile(1));
    expect(idsOf(off.unverifiedExternal)).not.toContain("einvoice");
    expect(idsOf(off.legalPrerequisite)).toContain("einvoice-notice");
    const on = emptyProfile(1);
    on.compliance.einvoicing = { enabled: true, sandbox: true, sent: 0 };
    const r = groupsOf(on);
    expect(r.unverifiedExternal.find((i) => i.id === "einvoice")).toMatchObject({ integration: "myinvois", label: { key: "gd.ready.einvoiceSandbox" } });
    expect(idsOf(r.legalPrerequisite)).toContain("einvoice-notice");
    // Not in Singapore, where there is no MyInvois.
    const sg = emptyProfile(1);
    sg.identity.country = "SG";
    expect(idsOf(groupsOf(sg).legalPrerequisite)).not.toContain("einvoice-notice");
  });

  it("takes what the application already refuses a draft for, and does not invent a second rule", () => {
    const p = emptyProfile(1);
    p.goLive.missing = [{ key: "srv.app.addCourt" }, { key: "srv.app.pin" }];
    p.history.paidTestBookings = 2;
    const r = groupsOf(p);
    expect(r.requiredMissing.filter((i) => i.id.startsWith("go-live-")).map((i) => i.say)).toEqual([{ key: "srv.app.addCourt" }, { key: "srv.app.pin" }]);
    expect(idsOf(r.requiredMissing)).toContain("paid-test-bookings");
    // A live venue with unpaid tests left over is told, as something that helps, not as something missing.
    const live = emptyProfile(1);
    live.identity = { ...live.identity, draft: false, live: true };
    live.history.testBookings = 3;
    expect(idsOf(groupsOf(live).optionalEnhancements)).toContain("leftover-tests");
  });

  it("names what a feature in use needs, and a copied branch is read for itself", () => {
    const p = emptyProfile(1);
    p.access.unstaffedHours = true;
    p.people = { ...p.people, coaches: 3, coachesWithHours: 1 };
    const r = groupsOf(p);
    expect(idsOf(r.featureSpecific)).toEqual(["emergency-details", "coach-hours"]);
    const copied = emptyProfile(2);
    copied.branches = { venues: 2, copiedFromBranch: true };
    copied.setup = { ...copied.setup, courts: 4 };
    const c = groupsOf(copied);
    expect(idsOf(c.configurationComplete)).toContain("courts");
    // What is not copied is the branch's own to do: its details, and a test booking of its own.
    expect(idsOf(c.requiredMissing)).toEqual(expect.arrayContaining(["details", "test-booking"]));
    expect(idsOf(c.optionalEnhancements)).toContain("copied-branch");
  });
});

describe("discoveries", () => {
  const venue = (over: (p: VenueProfile) => void) => {
    const p = emptyProfile(1);
    p.identity = { ...p.identity, draft: false, live: true };
    p.channels.onlinePage = true;
    p.history.bookings = 40;
    p.resources.total = 5;
    over(p);
    return p;
  };

  it("offer a capability that fits and is unused, with its reason, and never one already in use", () => {
    const p = venue((v) => (v.people.classes = 6));
    const found = discover(p, emptyAnswers());
    expect(found.find((d) => d.id === "coaching")?.reason.key).toBe("gd.disc.coaching");
    p.people.coaches = 2;
    expect(discover(p, emptyAnswers()).map((d) => d.id)).not.toContain("coaching");
  });

  it("offer at most three, and never an unsupported capability", () => {
    const p = venue((v) => {
      v.people.classes = 6;
      v.resources.byModel.class = 1;
      v.activities = [{ key: "badminton", support: "full", own: false }];
    });
    const found = discover(p, withAnswers({ customersDo: ["hire", "classes", "memberships"], branches: "several", types: ["school-and-corporate"] }));
    expect(found.length).toBe(MAX_DISCOVERIES);
    for (const rule of DISCOVERY_RULES) expect(capability(rule.capability)?.status, rule.capability).toBe("available");
    for (const d of found) expect(capability(d.id)!.status).toBe("available");
  });

  it("do not offer again what was dismissed", () => {
    const p = venue((v) => (v.people.classes = 6));
    expect(discover(p, emptyAnswers()).map((d) => d.id)).toContain("coaching");
    expect(discover(p, emptyAnswers(), { coaching: { at: "x" } }).map((d) => d.id)).not.toContain("coaching");
  });

  it("keep to courts until a venue is interested in tournaments, and say nothing to an empty venue", () => {
    expect(discover(emptyProfile(1), emptyAnswers())).toEqual([]);
    const courts = venue((v) => {
      v.activities = [{ key: "badminton", support: "full", own: false }];
      v.resources.total = 2;
    });
    expect(discover(courts, emptyAnswers()).map((d) => d.id)).not.toContain("tournaments");
    const bigger = venue((v) => {
      v.activities = [{ key: "badminton", support: "full", own: false }];
      v.history.bookings = 60;
      v.rates.peakPricing = true;
      v.compliance.bookingAlerts = true;
      v.payments.online.accountEnabled = true;
      v.commerce.membershipPlans = 1;
    });
    expect(discover(bigger, emptyAnswers()).map((d) => d.id)).toContain("tournaments");
    bigger.programmes.leagues = 1;
    expect(discover(bigger, emptyAnswers()).map((d) => d.id)).not.toContain("tournaments");
  });
});
