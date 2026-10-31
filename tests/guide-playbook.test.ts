import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { managerOnly, staffMay, STAFF_ACTIONS } from "../src/lib/roles";
import { STAFF_AREAS, STAFF_DICTIONARIES, staffTranslator, type StaffLocale } from "../src/lib/staff-i18n";
import { minuteClock } from "../src/lib/region";
import { appliedModules, buildPlaybook, buildTopic, MODULES, SECTION_ORDER, TOPIC_IDS } from "../src/lib/guide/playbook";
import { DESK_TABS, linkAllowed } from "../src/lib/guide/playbook/dsl";
import { blockLinks, playbookLinks, playbookText, say, type Speaker } from "../src/lib/guide/playbook/render";
import type { Block, GuideRole, Playbook } from "../src/lib/guide/playbook/types";
import { emptyProfile, type VenueProfile } from "../src/lib/guide/profile-types";
import { GUIDE_ROLES } from "../src/lib/guide/shell";

/**
 * The operating playbook over profiles written by hand (no database): which
 * sections and modules a kind of venue gets and which it does not, that every
 * number and policy in the text is the profile's, that what is scheduled is
 * never said as in force, what each role is and is not shown (every link of
 * every role held to the real MANAGER_ONLY rules), that the same input gives
 * the same bytes, that all three languages say all of it, and that nothing
 * secret or personal is in it. What it says of a venue's *real* saved
 * configuration is in tests/guide-playbook-venues.test.ts.
 */

const speaker = (locale: StaffLocale = "en"): Speaker => ({ t: staffTranslator(locale, "MySenam"), locale });
const textOf = (book: Playbook, locale: StaffLocale = "en") => playbookText(speaker(locale), book);
const all = (book: Playbook, locale: StaffLocale = "en") => textOf(book, locale).join("\n");
const moduleIds = (p: VenueProfile, role: GuideRole = "manager") => buildPlaybook(p, role).modules;

function profile(change: (p: VenueProfile) => void): VenueProfile {
  const p = emptyProfile(7);
  p.today = "2026-10-31";
  p.identity.live = true;
  p.identity.draft = false;
  p.identity.visibility = "public";
  p.resources.total = 4;
  p.resources.byModel.exclusive = 4;
  p.resources.priced = 4;
  p.activities = [{ key: "badminton", support: "full", own: false }];
  p.rates.lowest = 18;
  p.rates.highest = 28;
  p.rates.peakPricing = true;
  p.channels.onlinePage = true;
  p.channels.counter = true;
  p.payments.counterMethods = ["cash"];
  p.staff = { managers: 1, desk: 2, pendingInvitations: 0 };
  p.history.bookings = 40;
  change(p);
  return p;
}

// ---------------------------------------------------------------- the fixture venues the owner's scenarios name
const smallBadminton = profile(() => undefined);

const academy = profile((p) => {
  p.activities = [
    { key: "badminton", support: "full", own: false },
    { key: "tennis", support: "full", own: false },
  ];
  p.people = { coaches: 3, coachesWithHours: 2, upcomingClasses: 4, classes: 6, lessonsBooked: 25 };
  p.guardians = { participants: 12, approvalRequirements: 2, familyPlans: 1 };
  p.commerce.membershipPlans = 2;
  p.commerce.activeMemberships = 14;
  p.policies.signOffRequired = true;
});

const multiSport = profile((p) => {
  p.resources.total = 9;
  p.resources.shared = 2;
  p.resources.linked = 3;
  p.resources.withBuffers = 4;
  p.activities = [
    { key: "badminton", support: "full", own: false },
    { key: "futsal", support: "full", own: false },
    { key: "yoga", support: "full", own: false },
  ];
  p.branches = { venues: 2, copiedFromBranch: true };
  p.programmes = { tournaments: 1, leagues: 1, openGames: 3 };
  p.commerce.companyAccounts = 2;
});

const existing = profile((p) => {
  p.history = { bookings: 800, paidBookings: 700, onlinePayments: 90, receipts: 650, testBookings: 0, paidTestBookings: 0 };
  p.payments.online = { accountExists: true, accountEnabled: true, sandbox: false, provider: "stripe", firstPaymentTaken: true };
  p.payments.onlineRefundsOwed = 3;
  p.commerce = { ...p.commerce, membershipPlans: 3, activeMemberships: 60, passProducts: 2, concessions: 2, promoCodes: 4, extras: 1 };
  p.rates.memberRates = true;
});

const counterOnly = profile((p) => {
  p.payments.counterMethods = ["cash", "qr"];
});

const onlineOn = profile((p) => {
  p.payments.online = { accountExists: true, accountEnabled: true, sandbox: false, provider: "billplz", firstPaymentTaken: true };
  p.policies.payToHold = true;
  p.policies.cancellation.onlineRefunds = "gateway";
  p.history.onlinePayments = 5;
});

const unattendedGym = profile((p) => {
  p.activities = [{ key: "gym", support: "full", own: false }];
  p.resources.total = 2;
  p.resources.unmanned = 2;
  p.access = { unstaffedHours: true, unmannedResources: 2, emergencyDetails: true, supervisedActivities: 0 };
  p.commerce.membershipPlans = 1;
});

const equipmentHire = profile((p) => {
  p.activities = [{ key: "kayak", support: "full", own: false }];
  p.resources.byModel = { exclusive: 0, lanes: 0, shared: 0, class: 0, hire: 4 };
  p.resources.shared = 4;
  p.commerce.hireDeposits = true;
});

const draft = profile((p) => {
  p.identity.live = false;
  p.identity.draft = true;
  p.history = { bookings: 0, paidBookings: 0, onlinePayments: 0, receipts: 0, testBookings: 2, paidTestBookings: 1 };
});

/** Everything on: the largest guide a role can be given. */
const kitchenSink = profile((p) => {
  p.activities = [
    { key: "badminton", support: "full", own: false },
    { key: "futsal", support: "full", own: false },
  ];
  p.resources = { total: 12, byModel: { exclusive: 6, lanes: 1, shared: 2, class: 1, hire: 2 }, shared: 3, linked: 3, withBuffers: 5, priced: 10, perPlayer: 1, unmanned: 2 };
  p.hours.weekdayOverrides = true;
  p.hours.closedDays = 3;
  p.hours.scheduled = [{ from: "2026-12-01", openMin: 435, closeMin: 1320 }];
  p.rates = { lowest: 18, highest: 40, peakPricing: true, memberRates: true, lastMinute: true, holidays: 5, scheduled: [{ from: "2027-01-01", resources: 6 }] };
  p.policies = {
    cancellation: { cutoffHours: 12, lateKeepPercent: 50, onlineRefunds: "credit", refundWithinDays: 9, strikeLimit: 3 },
    bookingRuleLevels: 2,
    signOffRequired: true,
    bookAheadDays: 30,
    limits: true,
    payToHold: true,
    depositPercent: 20,
    discountStacking: "promotion",
  };
  p.payments = { online: { accountExists: true, accountEnabled: true, sandbox: false, provider: "stripe", firstPaymentTaken: true }, counterMethods: ["cash", "qr", "transfer", "card"], storedCredit: true, giftVouchers: true, onlineRefundsOwed: 2 };
  p.history = { bookings: 500, paidBookings: 400, onlinePayments: 60, receipts: 380, testBookings: 1, paidTestBookings: 1 };
  p.staff = { managers: 2, desk: 3, pendingInvitations: 1 };
  p.people = { coaches: 4, coachesWithHours: 3, upcomingClasses: 5, classes: 8, lessonsBooked: 40 };
  p.commerce = { membershipPlans: 3, activeMemberships: 50, passProducts: 2, concessions: 2, promoCodes: 3, extras: 2, hireDeposits: true, companyAccounts: 2 };
  p.programmes = { tournaments: 2, leagues: 1, openGames: 4 };
  p.guardians = { participants: 20, approvalRequirements: 3, familyPlans: 2 };
  p.access = { unstaffedHours: true, unmannedResources: 2, emergencyDetails: false, supervisedActivities: 0 };
  p.compliance = { einvoicing: { enabled: true, sandbox: false, sent: 4 }, deductionTaxReviewed: false, bookingAlerts: true };
  p.branches = { venues: 3, copiedFromBranch: true };
  p.channels.apiKeys = 1;
  p.identity.visibility = "members";
});

const fixtures: [string, VenueProfile][] = [
  ["small badminton", smallBadminton],
  ["coaching academy", academy],
  ["multi-sport, two branches", multiSport],
  ["existing venue with history", existing],
  ["counter only", counterOnly],
  ["online payments on", onlineOn],
  ["unattended gym", unattendedGym],
  ["equipment hire", equipmentHire],
  ["draft", draft],
  ["everything on", kitchenSink],
];

describe("which sections and modules a venue gets", () => {
  it("gives a small court-only venue the daily sections and none of the specialised ones", () => {
    const manager = buildPlaybook(smallBadminton, "manager");
    expect(manager.sections.map((s) => s.id)).toEqual(["start", "before", "booking", "during", "cancel", "eod", "manager", "quick"]);
    const specialised = MODULES.filter((m) => m.section === "specialised").map((m) => m.id);
    for (const id of specialised) expect(manager.modules, id).not.toContain(id);
    expect(manager.modules).not.toContain("during.hire");
    expect(manager.modules).not.toContain("during.classes");
    expect(manager.modules).not.toContain("during.coaching");
    // No tournament, league, hire, coaching or class text anywhere in it.
    const text = all(manager);
    for (const word of ["tournament", "league", "coach", "deposit", "unstaffed", "company or school", "family"]) expect(text.toLowerCase(), word).not.toContain(word);
  });

  it("gives a coaching academy coaching, classes and guardians, and no equipment-hire procedure", () => {
    for (const role of ["manager", "desk"] as const) {
      const ids = moduleIds(academy, role);
      for (const id of ["spec.coaching", "spec.classes", "spec.guardians", "during.coaching", "during.classes", "quick.approval"]) expect(ids, `${role} ${id}`).toContain(id);
      expect(ids, role).not.toContain("during.hire");
      expect(ids, role).not.toContain("spec.tournaments");
      expect(all(buildPlaybook(academy, role)).toLowerCase(), role).not.toContain("deposit");
    }
    // A coach with no hours is named to the manager only.
    expect(all(buildPlaybook(academy, "manager"))).toContain("1 of your coaches have no weekly hours set");
    expect(all(buildPlaybook(academy, "desk"))).not.toContain("no weekly hours");
  });

  it("gives a multi-sport venue with two branches the branch, shared, linked, programme and account modules", () => {
    const ids = moduleIds(multiSport);
    for (const id of ["spec.branches", "spec.tournaments", "spec.leagues", "spec.openGames", "spec.accounts"]) expect(ids).toContain(id);
    const text = all(buildPlaybook(multiSport, "manager"));
    expect(text).toContain("Your business has 2 branches");
    expect(text).toContain("started from another branch's set-up");
    expect(text).toContain("2 of your resources take more than one booking at a time");
    expect(text).toContain("3 of your resources take, or are taken by, another when booked");
    expect(text).toContain("4 of your 9 resources have buffers set");
    // The desk is given the open games and the accounts, and the tournaments only as the desk's own part.
    const desk = moduleIds(multiSport, "desk");
    expect(desk).toContain("spec.openGames");
    expect(desk).toContain("spec.accounts");
    expect(desk).toContain("spec.competitionsDesk");
    expect(desk).not.toContain("spec.branches");
    expect(desk).not.toContain("spec.tournaments");
  });

  it("tells an existing venue's money from an empty one's: owed refunds, memberships, passes and discounts appear from the saved state", () => {
    const manager = all(buildPlaybook(existing, "manager"));
    expect(manager).toContain("3 online refunds are owed now");
    expect(manager).toContain("passes");
    expect(manager).toContain("promo codes");
    expect(moduleIds(existing)).toEqual(expect.arrayContaining(["manager.commerce", "manager.memberships", "eod.owedOnline", "cancel.manual"]));
    expect(moduleIds(smallBadminton)).not.toContain("manager.commerce");
    expect(moduleIds(smallBadminton)).not.toContain("eod.owedOnline");
    expect(moduleIds(smallBadminton)).not.toContain("cancel.manual");
  });

  it("gives a counter-only venue the counter and no online-payment instruction, and an online venue the online ones", () => {
    const counter = buildPlaybook(counterOnly, "manager");
    expect(all(counter)).toContain("Cash, QR");
    expect(all(counter)).toContain("Online payment is off: customers pay at the counter");
    expect(all(counter)).toContain("Customers pay at the counter, so no money goes back through a gateway");
    expect(counter.modules).not.toContain("cancel.manual");
    expect(counter.modules).not.toContain("eod.owedOnline");
    expect(all(counter)).not.toContain("Stripe");
    const online = buildPlaybook(onlineOn, "manager");
    expect(online.modules).toEqual(expect.arrayContaining(["cancel.manual", "eod.owedOnline"]));
    const text = all(online);
    expect(text).toContain("Customers can pay online into your Billplz account");
    expect(text).toContain("must be paid online within a few minutes");
    expect(text).toContain("sent back through the gateway straight away");
    // Billplz has no refund API: the Billplz step is there and the Stripe one is not.
    expect(text).toContain("Billplz has no refund API");
    expect(text).not.toContain("Through Stripe, refund it with one click");
  });

  it("gives an unattended gym the unattended-access module, with the emergency details said as set or not", () => {
    for (const role of ["manager", "desk"] as const) expect(moduleIds(unattendedGym, role)).toContain("spec.unstaffed");
    expect(all(buildPlaybook(unattendedGym, "manager"))).toContain("emergency details set for the door screen");
    expect(all(buildPlaybook(kitchenSink, "manager"))).toContain("no emergency details set for the door screen yet");
    expect(moduleIds(smallBadminton)).not.toContain("spec.unstaffed");
    expect(all(buildPlaybook(unattendedGym, "manager"))).toContain("MySenam does not open the door");
  });

  it("gives equipment hire the collection and return steps, and nobody else", () => {
    for (const role of ["manager", "desk"] as const) expect(moduleIds(equipmentHire, role)).toContain("during.hire");
    expect(all(buildPlaybook(equipmentHire, "desk"))).toContain("While kit is out, the booking cannot be cancelled or moved");
    for (const [name, p] of fixtures) if (!p.commerce.hireDeposits) expect(moduleIds(p), name).not.toContain("during.hire");
  });

  it("tells a draft venue its bookings are tests, and a live one nothing of the kind", () => {
    expect(moduleIds(draft)).toEqual(expect.arrayContaining(["start.draft", "manager.testBookings"]));
    expect(all(buildPlaybook(draft, "desk"))).toContain("what you book is a test");
    expect(moduleIds(smallBadminton)).not.toContain("start.draft");
  });

  it("keeps module ids and heading ids unique, and every module in a section the guide has", () => {
    expect(new Set(MODULES.map((m) => m.id)).size).toBe(MODULES.length);
    for (const m of MODULES) expect(SECTION_ORDER, m.id).toContain(m.section);
    for (const [name, p] of fixtures)
      for (const role of GUIDE_ROLES) {
        const ids = buildPlaybook(p, role).sections.flatMap((s) => s.blocks.flatMap((b) => (b.type === "heading" && b.id ? [b.id] : [])));
        expect(new Set(ids).size, `${name} ${role}`).toBe(ids.length);
      }
  });

  it("adds a module by adding data: a module that does not apply, or is not for the role, is simply absent", () => {
    const only = appliedModules(smallBadminton, "desk").map((m) => m.id);
    expect(only).not.toContain("manager.finance");
    expect(only).toContain("quick.createBooking");
    // Every applied module made at least one block, in a section the guide shows.
    for (const [name, p] of fixtures) for (const role of GUIDE_ROLES) expect(buildPlaybook(p, role).modules.length, `${name} ${role}`).toBeGreaterThan(0);
  });
});

describe("the sections the owner asked for", () => {
  it("has them in the owner's order, and the quick-reference cards the owner named, each step by step", () => {
    const book = buildPlaybook(kitchenSink, "manager");
    expect(book.sections.map((s) => s.id)).toEqual(["start", "before", "booking", "during", "cancel", "eod", "manager", "specialised", "quick"]);
    const quick = book.toc.find((e) => e.id === "quick")!;
    expect(quick.items!.map((i) => i.id)).toEqual(["card-create", "card-cancel", "card-pay", "card-unpaid", "card-checkin", "card-outage", "card-invite", "card-approval"]);
    for (const section of book.sections.filter((s) => s.id === "quick")) {
      const steps = section.blocks.filter((b) => b.type === "steps");
      expect(steps.length).toBe(quick.items!.length);
      for (const s of steps) expect(s.type === "steps" && s.items.length).toBeGreaterThanOrEqual(3);
    }
    // The desk has every card but the manager's one (inviting staff).
    const desk = buildPlaybook(kitchenSink, "desk").toc.find((e) => e.id === "quick")!;
    expect(desk.items!.map((i) => i.id)).not.toContain("card-invite");
    expect(desk.items!.map((i) => i.id)).toContain("card-approval");
  });

  it("opens with what the venue is, from its saved configuration", () => {
    const text = textOf(buildPlaybook(smallBadminton, "manager"));
    expect(text).toContain("Your venue has 4 bookable resources, offering Badminton.");
    expect(text).toContain(`It opens from ${minuteClock(480)} to ${minuteClock(1380)} today.`);
    expect(text).toContain("Today's rates run from RM18 to RM28 an hour, with peak and off-peak rates.");
  });
});

describe("what every number and policy in the text is", () => {
  const cancelText = (p: VenueProfile) => all(buildPlaybook(p, "manager"));

  it("is the profile's: the cutoff, the share kept, the strike limit, the refund period and what the online-refund setting does", () => {
    const text = cancelText(kitchenSink);
    expect(text).toContain("up to 12 hours before the booking starts");
    expect(text).toContain("keeps 50% of what was paid");
    expect(text).toContain("After 3 strikes");
    expect(text).toContain("promised within 9 days");
    expect(text).toContain("given back as stored credit");
    expect(text).toContain("up to 12 hours before it starts");
    // Change them and the text changes with them.
    const changed = profile((p) => {
      Object.assign(p, structuredClone(kitchenSink));
      p.policies.cancellation = { cutoffHours: 36, lateKeepPercent: null, onlineRefunds: "staff", refundWithinDays: 4, strikeLimit: null };
    });
    const after = cancelText(changed);
    expect(after).toContain("up to 36 hours before the booking starts");
    expect(after).not.toContain("up to 12 hours");
    expect(after).toContain("customers cannot cancel online for a refund");
    expect(after).toContain("promised within 4 days");
    expect(after).toContain("queued for a manager to refund by hand");
    expect(after).not.toContain("keeps 50%");
    expect(after).not.toContain("After 3 strikes");
    expect(after).toContain("sets no strike limit");
  });

  it("is the profile's for hours, rates and counts too", () => {
    const text = all(buildPlaybook(kitchenSink, "manager"));
    expect(text).toContain("RM18 to RM40 an hour");
    expect(text).toContain("5 holidays still to come are priced like the weekend");
    expect(text).toContain("3 closed days are coming up");
    expect(text).toContain("Managers: 2; front desk: 3");
    expect(text).toContain("1 invitations to staff are waiting to be accepted");
    expect(text).toContain("5 classes are still to come");
    expect(text).toContain("2 online refunds are owed now");
    const shifted = profile((p) => {
      p.hours.openMin = 360;
      p.hours.closeMin = 1260;
      p.rates.lowest = 20;
      p.rates.highest = 20;
      p.rates.peakPricing = false;
    });
    const t = all(buildPlaybook(shifted, "desk"));
    expect(t).toContain(`from ${minuteClock(360)} to ${minuteClock(1260)} today`);
    expect(t).toContain("Today's rate is RM20 an hour");
    expect(t).not.toContain("RM18");
  });

  it("says each setting's words only for the setting that is on", () => {
    const onlineText = (setting: "staff" | "gateway" | "credit") =>
      all(
        buildPlaybook(
          profile((p) => {
            p.payments.online = { accountExists: true, accountEnabled: true, sandbox: false, provider: "stripe", firstPaymentTaken: true };
            p.policies.cancellation.onlineRefunds = setting;
          }),
          "manager"
        )
      );
    const staff = onlineText("staff");
    const gateway = onlineText("gateway");
    const credit = onlineText("credit");
    expect(staff).toContain("queued for a manager to refund by hand");
    expect(staff).not.toContain("straight away");
    expect(gateway).toContain("straight away");
    expect(gateway).not.toContain("given back as stored credit");
    expect(credit).toContain("given back as stored credit");
    expect(credit).not.toContain("straight away");
    // Where the venue refunds through its gateway, no by-hand promise is made for a customer's cancellation.
    expect(gateway).not.toContain("is promised within");
    expect(staff).toContain("is promised within");
  });
});

describe("what is in force and what is scheduled", () => {
  const scheduled = (book: Playbook) =>
    book.sections.flatMap((s) => s.blocks.filter((b): b is Extract<Block, { type: "callout" }> => b.type === "callout" && b.kind === "scheduled"));

  it("shows a change of hours or rates only as its own 'Coming on' callout, never in today's text", () => {
    for (const role of ["manager", "desk"] as const) {
      const book = buildPlaybook(kitchenSink, role);
      expect(book.scheduled).toEqual([
        { kind: "hours", from: "2026-12-01", openMin: 435, closeMin: 1320 },
        { kind: "rates", from: "2027-01-01", resources: 6 },
      ]);
      const callouts = scheduled(book);
      expect(callouts).toHaveLength(2);
      const s = speaker();
      const said = callouts.map((c) => `${say(s, c.title!)} ${say(s, c.text)}`);
      expect(said[0]).toContain("Coming on");
      expect(said[0]).toContain(minuteClock(435));
      expect(said[0]).toContain(minuteClock(1320));
      expect(said[1]).toContain("The rates change on 6 of your resources");
      // The new times appear nowhere else in the guide.
      const rest = book.sections.flatMap((sec) => sec.blocks.filter((b) => !(b.type === "callout" && b.kind === "scheduled")).flatMap((b) => textOf({ ...book, summary: [], sections: [{ ...sec, blocks: [b] }] })));
      for (const line of rest) expect(line, `${role}: ${line}`).not.toContain(minuteClock(435));
      for (const line of book.summary.map((w) => say(s, w))) expect(line).not.toContain(minuteClock(435));
      // And today's hours still stand in the summary and the overview.
      expect(all(book)).toContain(`${minuteClock(480)} to ${minuteClock(1380)}`);
    }
  });

  it("has no coming-changes section for a venue with nothing scheduled, and none for a coach", () => {
    expect(scheduled(buildPlaybook(smallBadminton, "manager"))).toEqual([]);
    expect(buildPlaybook(smallBadminton, "manager").scheduled).toEqual([]);
    expect(buildPlaybook(kitchenSink, "coach").scheduled).toEqual([]);
    expect(scheduled(buildPlaybook(kitchenSink, "coach"))).toEqual([]);
  });

  it("describes today's rates from the profile's in-force rates only", () => {
    const p = structuredClone(kitchenSink);
    p.rates.lowest = 22;
    p.rates.highest = 33;
    const text = all(buildPlaybook(p, "desk"));
    expect(text).toContain("RM22 to RM33");
    expect(text).not.toContain("RM18");
    expect(text).not.toContain("RM40");
  });
});

describe("what each role is shown", () => {
  /** Screens only a manager has, said as the dashboard says them: the desk's guide never names them. */
  const MANAGER_SCREENS = [
    "Reports",
    "Courts & rates",
    "Venue details",
    "Manager overrides",
    "Staff accounts",
    "Out of service",
    "Refunds owed",
    "Passes the counter sells",
    "Promo codes",
    "Concession prices",
    "When peak rates apply",
    "Booking rules",
    "Cancellations, refunds and no-shows",
    "Rates and a court's own hours from a date",
    "Change the hours from a date",
    "Clear all test bookings",
  ];

  it("holds every link of every role to the real MANAGER_ONLY rules", () => {
    for (const [name, p] of fixtures)
      for (const role of GUIDE_ROLES) {
        const links = playbookLinks(buildPlaybook(p, role));
        for (const link of links) {
          const label = `${name} ${role} -> ${link.tab} ${link.staffAction ?? ""}`;
          expect(linkAllowed(role, link.tab, link.staffAction), label).toBe(true);
          if (role === "coach") throw new Error(`a coach was given a link: ${label}`);
          const staffRole = role === "desk" ? "desk" : "manager";
          if (link.staffAction) {
            expect(staffMay(staffRole)[link.staffAction], label).toBe(true);
            // The same answer straight from the rules the server enforces.
            const [method, route] = STAFF_ACTIONS[link.staffAction].split(" ");
            expect(role === "desk" ? !managerOnly(method, route) : true, label).toBe(true);
          }
          if (role === "desk") expect(DESK_TABS, label).toContain(link.tab);
        }
      }
  });

  it("gives the desk a link to nothing a manager alone uses, though the same venue's manager has them", () => {
    const desk = playbookLinks(buildPlaybook(kitchenSink, "desk"));
    const manager = playbookLinks(buildPlaybook(kitchenSink, "manager"));
    expect(desk.length).toBeGreaterThan(5);
    expect(manager.length).toBeGreaterThan(desk.length);
    for (const link of desk) expect(["reports", "courts", "venues"]).not.toContain(link.tab);
    for (const tab of ["reports", "courts", "venues"]) expect(manager.map((l) => l.tab)).toContain(tab);
    // Every manager-only staff action the manager's guide links to is one the desk may not make.
    const managerActions = new Set(manager.flatMap((l) => (l.staffAction ? [l.staffAction] : [])));
    const refused = [...managerActions].filter((a) => !staffMay("desk")[a]);
    expect(refused.length).toBeGreaterThan(10);
    expect(desk.some((l) => l.staffAction && refused.includes(l.staffAction))).toBe(false);
  });

  it("gives the desk no manager-only module, no manager-only screen name and no manager-only instruction", () => {
    for (const m of MODULES.filter((m) => m.section === "manager")) expect(m.roles, m.id).toEqual(["manager"]);
    for (const [name, p] of fixtures) {
      const book = buildPlaybook(p, "desk");
      expect(book.sections.map((s) => s.id), name).not.toContain("manager");
      const text = all(book);
      for (const screen of MANAGER_SCREENS) expect(text, `${name}: ${screen}`).not.toContain(screen);
      // The things the owner's round 9 made a manager's are not in the desk's text as something to do.
      for (const word of ["disqualif", "Mark refunded", "export", "reconcil", "fixture"]) expect(text.toLowerCase(), `${name}: ${word}`).not.toContain(word.toLowerCase());
    }
  });

  it("tells the desk when to ask a manager", () => {
    const text = all(buildPlaybook(kitchenSink, "desk"));
    expect(text).toContain("ask a manager");
    expect(text).toContain("a manager's");
    expect(text.toLowerCase()).toContain("earlier day");
  });

  it("gives the coach no money, no link, no dashboard and nothing about anybody else", () => {
    for (const [name, p] of fixtures) {
      const book = buildPlaybook(p, "coach", { venueName: "Court House", coach: { lessonsAhead: 6, hoursSet: true, timeOff: 1 } });
      expect(playbookLinks(book), name).toEqual([]);
      expect(book.scheduled, name).toEqual([]);
      expect(book.sections.map((s) => s.id), name).toEqual(["coach"]);
      for (const locale of ["en", "ms", "zh"] as const) {
        const text = all(book, locale);
        expect(text, `${name} ${locale}`).not.toMatch(/\b(RM|SGD|S\$|refund\w*|price\w*|fee|fees|payment\w*|paid|money|cash|deposit\w*|invoice\w*|receipt\w*|rates?|cutoff)\b/i);
        expect(text, `${name} ${locale}`).not.toMatch(/退款|价格|费用|付款|现金|押金|发票|收据|bayaran|harga|yuran|tunai|deposit|invois|resit/);
      }
      // Counts only the coach's own, from what the caller gave: nothing from the venue's profile reaches the text.
      expect(all(book)).toContain("You have 6 lessons in the next 30 days.");
      expect(all(book)).toContain("This is your guide as a coach at Court House.");
      const json = JSON.stringify(book);
      expect(json).not.toContain('"cutoffHours"');
    }
  });

  it("says the same coach guide whatever the venue's configuration is: it carries nothing of the venue but its name", () => {
    const a = JSON.stringify(buildPlaybook(smallBadminton, "coach", { venueName: "Same" })).replace(/"id":7/, "");
    const b = JSON.stringify(buildPlaybook(kitchenSink, "coach", { venueName: "Same" })).replace(/"id":7/, "");
    const strip = (s: string) => s.replace(/"live":\w+,|"draft":\w+,|"suspended":\w+/g, "");
    expect(strip(a)).toBe(strip(b));
  });

  it("gives the manager everything the desk has, and more", () => {
    const m = new Set(buildPlaybook(kitchenSink, "manager").modules);
    const d = buildPlaybook(kitchenSink, "desk").modules;
    const deskOnly = d.filter((id) => !m.has(id));
    // What only the desk has is what the manager's own modules replace: its limits and its part of competitions.
    expect(deskOnly.sort()).toEqual(["cancel.manualDesk", "spec.competitionsDesk", "start.deskLimits"].sort());
  });
});

describe("the topics: written once", () => {
  it("builds every topic for a manager and the desk, none for a coach, with real related topics", () => {
    for (const id of TOPIC_IDS)
      for (const role of ["manager", "desk"] as const) {
        const built = buildTopic(id, kitchenSink, role);
        expect(built, `${id} ${role}`).not.toBeNull();
        expect(built!.blocks.length).toBeGreaterThan(1);
        for (const r of built!.related) expect(TOPIC_IDS).toContain(r.id);
        expect(buildTopic(id, kitchenSink, "coach")).toBeNull();
      }
    expect(TOPIC_IDS).toEqual([
      "buffers",
      "shared-linked",
      "peak-dated",
      "discounts",
      "memberships",
      "membership-covers",
      "passes",
      "guardians",
      "refunds",
      "cannot-reserve",
      "another-coach",
      "unattended",
      "test-bookings",
    ]);
  });

  it("is the very text the playbook's sections use: a topic's blocks sit unchanged inside the guide, once", () => {
    const pairs: [string, GuideRole][] = [
      ["cannot-reserve", "desk"],
      ["cannot-reserve", "manager"],
      ["refunds", "desk"],
      ["refunds", "manager"],
      ["peak-dated", "manager"],
      ["unattended", "desk"],
      ["another-coach", "manager"],
      ["test-bookings", "manager"],
    ];
    for (const [id, role] of pairs) {
      const book = buildPlaybook(kitchenSink, role);
      const blocks = book.sections.flatMap((s) => s.blocks);
      const built = buildTopic(id as never, kitchenSink, role)!;
      const at = blocks.findIndex((b) => b.type === "heading" && b.id === `topic-${id}`);
      expect(at, `${id} ${role}`).toBeGreaterThanOrEqual(0);
      expect(blocks.slice(at + 1, at + 1 + built.blocks.length), `${id} ${role}`).toEqual(built.blocks);
      expect(blocks.filter((b) => b.type === "heading" && b.id === `topic-${id}`)).toHaveLength(1);
    }
  });

  it("states the eligibility reasons the application gives, only those that apply to the venue", () => {
    const text = (p: VenueProfile) => all({ ...buildPlaybook(p, "desk"), sections: buildPlaybook(p, "desk").sections.filter((s) => s.id === "booking") });
    const plain = text(smallBadminton);
    expect(plain).toContain("The phone number is blocked");
    expect(plain).toContain("too many unpaid bookings");
    expect(plain).not.toContain("members or for people on its list");
    expect(plain).not.toContain("limit of strikes");
    const rich = text(kitchenSink);
    expect(rich).toContain("members or for people on its list");
    expect(rich).toContain("limit of strikes");
    expect(rich).toContain("sign-off or a certification");
    expect(rich).toContain("A house rule");
  });

  it("says a topic differently for a manager and the desk: where to change it, or that a manager does", () => {
    for (const id of ["buffers", "shared-linked", "peak-dated", "discounts", "covers" as never].filter((x) => TOPIC_IDS.includes(x as never))) {
      const manager = buildTopic(id as never, kitchenSink, "manager")!;
      const desk = buildTopic(id as never, kitchenSink, "desk")!;
      expect(blockLinks({ type: "steps", items: manager.blocks.flatMap((b) => (b.type === "steps" ? b.items : [])) }).length, id).toBeGreaterThan(0);
      expect(desk.blocks.flatMap(blockLinks), id).toEqual([]);
    }
  });
});

describe("the same input, the same bytes", () => {
  it("is a pure function: two calls, and a call over a frozen copy, give identical JSON, and the profile is untouched", () => {
    const deepFreeze = <T>(o: T): T => {
      if (o && typeof o === "object") {
        Object.freeze(o);
        for (const v of Object.values(o)) deepFreeze(v);
      }
      return o;
    };
    for (const [name, p] of fixtures)
      for (const role of GUIDE_ROLES) {
        const a = JSON.stringify(buildPlaybook(p, role, { venueName: "V" }));
        const b = JSON.stringify(buildPlaybook(structuredClone(p), role, { venueName: "V" }));
        const c = JSON.stringify(buildPlaybook(deepFreeze(structuredClone(p)), role, { venueName: "V" }));
        expect(b, `${name} ${role}`).toBe(a);
        expect(c, `${name} ${role}`).toBe(a);
      }
    const before = JSON.stringify(kitchenSink);
    buildPlaybook(kitchenSink, "manager");
    expect(JSON.stringify(kitchenSink)).toBe(before);
  });

  it("keeps nothing between calls or between venues: another venue's guide between two calls changes neither", () => {
    const first = JSON.stringify(buildPlaybook(smallBadminton, "manager", { venueName: "A" }));
    buildPlaybook(kitchenSink, "manager", { venueName: "B" });
    buildPlaybook(academy, "desk", { venueName: "C" });
    expect(JSON.stringify(buildPlaybook(smallBadminton, "manager", { venueName: "A" }))).toBe(first);
    // And the venue's name is only ever the caller's.
    expect(first).toContain('"name":"A"');
    expect(first).not.toContain('"B"');
  });

  it("has no store: nothing in the playbook source keeps module-level state", () => {
    const dir = path.join(__dirname, "..", "src/lib/guide/playbook");
    const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".ts"));
    for (const f of files) {
      const text = fs.readFileSync(path.join(f.parentPath, f.name), "utf8");
      expect(text, f.name).not.toMatch(/\bnew (Map|Set|WeakMap)\(\)\s*;?\s*$/m);
      expect(text, f.name).not.toMatch(/\bunstable_cache|\bcache\(|revalidate|localStorage|sessionStorage/);
    }
  });
});

describe("three languages", () => {
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const area = STAFF_AREAS.guidePlaybook;

  it("says every gp. phrase in English, Malay and Chinese with the same placeholders", () => {
    const keys = Object.keys(area.en);
    expect(keys.length).toBeGreaterThan(300);
    for (const key of keys) {
      expect(key.startsWith("gp."), key).toBe(true);
      for (const l of ["ms", "zh"] as const) {
        const said = (area[l] as Record<string, string>)[key];
        expect(said, `${key} in ${l}`).toBeTruthy();
        expect(placeholders(said), `${key} in ${l}`).toEqual(placeholders((area.en as Record<string, string>)[key]));
      }
    }
    expect(Object.keys(area.ms).sort()).toEqual([...keys].sort());
    expect(Object.keys(area.zh).sort()).toEqual([...keys].sort());
  });

  it("uses every phrase it has: none is left over, and none a module names is missing", () => {
    const root = path.join(__dirname, "..", "src");
    const source: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && e.name !== "guide-playbook.ts") source.push(fs.readFileSync(p, "utf8"));
      }
    };
    walk(root);
    const text = source.join("\n");
    const used = new Set([...text.matchAll(/"(gp\.[A-Za-z0-9_.]+)"/g)].map((m) => m[1]));
    for (const key of Object.keys(area.en)) if (!key.startsWith("gp.section.")) expect(used.has(key), `${key} is never used`).toBe(true);
    for (const key of used) expect(key in area.en, `${key} is used but not written`).toBe(true);
    for (const id of SECTION_ORDER) expect(`gp.section.${id}` in area.en, id).toBe(true);
  });

  it("says a whole guide in each language with no value left unfilled and no English in the others' sentences", () => {
    for (const [name, p] of fixtures)
      for (const role of GUIDE_ROLES)
        for (const locale of ["en", "ms", "zh"] as const) {
          const book = buildPlaybook(p, role, { venueName: "Court House", coach: { lessonsAhead: 3, hoursSet: false, timeOff: 2 } });
          for (const line of textOf(book, locale)) {
            expect(line, `${name} ${role} ${locale}`).not.toMatch(/[{}]/);
            expect(line, `${name} ${role} ${locale}`).not.toMatch(/\bundefined\b|\bNaN\b|\[object/);
            expect(line.trim(), `${name} ${role} ${locale}`).not.toBe("");
          }
        }
    // A Chinese or Malay guide is not the English one.
    const en = all(buildPlaybook(kitchenSink, "manager"), "en");
    expect(all(buildPlaybook(kitchenSink, "manager"), "ms")).not.toBe(en);
    expect(all(buildPlaybook(kitchenSink, "manager"), "zh")).toMatch(/[一-鿿]/);
    // Money and times are said as the language writes them.
    expect(all(buildPlaybook(kitchenSink, "manager"), "zh")).toContain(minuteClock(480, "zh"));
    expect(all(buildPlaybook(kitchenSink, "manager"), "ms")).toContain(minuteClock(480, "ms"));
  });

  it("names a screen as the dashboard's own tab does, in each language", () => {
    for (const locale of ["en", "ms", "zh"] as const) {
      const text = all(buildPlaybook(kitchenSink, "manager"), locale);
      expect(text).toContain(STAFF_DICTIONARIES[locale]["sh.tab.bookings"]);
      expect(text).toContain(STAFF_DICTIONARIES[locale]["p8b.cash.title"]);
      expect(text).toContain(STAFF_DICTIONARIES[locale]["bk.col.attendance"]);
    }
  });
});

describe("nothing secret or personal", () => {
  it("has no key, token, tax identifier, email, number or address in any guide in any language", () => {
    const patterns: [string, RegExp][] = [
      ["a long token", /[A-Za-z0-9_-]{32,}/],
      ["a Stripe key", /\b(sk|pk|rk|whsec)_(live|test)?_?[A-Za-z0-9]{8,}/],
      ["a bearer token", /bearer\s+[A-Za-z0-9._-]{8,}/i],
      ["a connection string", /\b(postgres|mysql|https?):\/\/\S+/i],
      ["an email address", /[^\s@]+@[^\s@]+\.[a-z]{2,}/i],
      ["a phone number", /\+?\d[\d -]{8,}\d/],
      ["an identity or tax number", /\b\d{6}-?\d{2}-?\d{4}\b|\b[A-Z]{1,2}\d{9,12}\b|\bTIN\b\s*[:=]?\s*\w{6,}/],
      ["a secret word with a value", /\b(api[_ -]?key|secret|password|token)\s*[:=]\s*\S+/i],
    ];
    for (const [name, p] of fixtures)
      for (const role of GUIDE_ROLES)
        for (const locale of ["en", "ms", "zh"] as const) {
          const book = buildPlaybook(p, role, { venueName: "Court House", coach: { lessonsAhead: 3, hoursSet: true, timeOff: 0 } });
          // A date is not a number to ring: the days a change starts and a guide was printed are ISO dates.
          const text = all(book, locale).replace(/\d{4}-\d{2}-\d{2}/g, "");
          // The data as words: its punctuation is not part of any value.
          const json = JSON.stringify(book).replace(/\d{4}-\d{2}-\d{2}/g, "").replace(/[",:{}[\]]/g, " ");
          for (const [what, re] of patterns) {
            expect(text, `${name} ${role} ${locale}: ${what}`).not.toMatch(re);
            expect(json, `${name} ${role}: ${what} in the data`).not.toMatch(re);
          }
        }
  });

  it("carries counts and settings from the profile, never the profile itself", () => {
    const json = JSON.stringify(buildPlaybook(kitchenSink, "manager"));
    for (const field of ["accountExists", "accountEnabled", "emailTransport", "whatsappTransport", "apiKeys", "taxRegistered", "emergencyDetails", "missing"]) expect(json, field).not.toContain(`"${field}"`);
    // Where a provider is named in words, it is the gateway's public name only.
    expect(all(buildPlaybook(kitchenSink, "manager"))).toContain("Stripe");
  });
});
