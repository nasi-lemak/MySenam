import { hasCoaching, type VenueProfile } from "../profile-types";
import { fact, facts, goFor, note, para, policy, step, steps, table, warning } from "./dsl";
import type { Block, BuiltTopic, GuideRole, PhraseKey, PlaybookTopic, TopicId } from "./types";
import { TOPIC_IDS } from "./types";

/**
 * The explanations the application gives in more than one place, each
 * written once (ADR 0028): the playbook's sections use them, and so does the
 * contextual help beside the screens (`buildTopic`). A topic is a function of
 * the venue's profile and a role, and says only what the application does:
 * the rules are the ones in docs/features/booking.md, pricing.md,
 * payments-and-credit.md, programmes.md, activities.md and
 * venue-operations.md.
 *
 * What differs by role is what a person may do about it: a manager is told
 * where it is changed (with a link); the front desk is told a manager changes
 * it, and never given a link it cannot use.
 *
 * To add a topic: add its id to `TOPIC_IDS` (types.ts), a row here, and its
 * phrases (`gp.t.<id>.*`) to src/lib/staff-i18n/guide-playbook.ts.
 */

type Row = [PhraseKey, PhraseKey];

const BOTH: GuideRole[] = ["manager", "desk"];

type C = Pick<Parameters<PlaybookTopic["blocks"]>[0], "profile" | "role" | "go">;

/** Where a manager changes a setting, or, for the desk, that a manager does. */
const changedBy = (c: C, managerStep: Block, deskNote: Block): Block => (c.role === "manager" ? managerStep : deskNote);

const TOPICS: PlaybookTopic[] = [
  {
    id: "buffers",
    title: { key: "gp.t.buffers.title" },
    roles: BOTH,
    related: ["shared-linked", "cannot-reserve"],
    blocks: (c) => {
      const p = c.profile;
      return [
        para("gp.t.buffers.what"),
        para("gp.t.buffers.kinds"),
        para(p.resources.withBuffers > 0 ? "gp.t.buffers.have" : "gp.t.buffers.none", { n: p.resources.withBuffers, total: p.resources.total }),
        para("gp.t.buffers.notCharged"),
        changedBy(
          c,
          steps(step("gp.t.buffers.change", undefined, c.go("courts", "bookingPolicies"))),
          note("gp.t.buffers.deskNote")
        ),
      ];
    },
  },
  {
    id: "shared-linked",
    title: { key: "gp.t.shared.title" },
    roles: BOTH,
    related: ["buffers", "cannot-reserve"],
    blocks: (c) => {
      const p = c.profile;
      return [
        para("gp.t.shared.shared"),
        para("gp.t.shared.linked"),
        facts(
          p.resources.shared > 0 && fact("gp.t.shared.f.shared", "gp.t.shared.v.shared", { n: p.resources.shared }),
          p.resources.linked > 0 && fact("gp.t.shared.f.linked", "gp.t.shared.v.linked", { n: p.resources.linked }),
          p.resources.shared === 0 && p.resources.linked === 0 && fact("gp.t.shared.f.none", "gp.t.shared.v.none")
        ),
        para("gp.t.shared.out"),
        changedBy(c, steps(step("gp.t.shared.change", undefined, c.go("courts", "courtLinks"))), note("gp.t.shared.deskNote")),
      ];
    },
  },
  {
    id: "peak-dated",
    title: { key: "gp.t.peak.title" },
    roles: BOTH,
    related: ["discounts"],
    blocks: (c) => {
      const p = c.profile;
      const r = p.rates;
      return [
        para("gp.t.peak.what"),
        // Today's rates only: what is set from a later date is the scheduled callout's, never merged in here.
        r.lowest !== null && r.highest !== null
          ? para(r.peakPricing ? "gp.t.peak.range" : "gp.t.peak.flat", { low: { money: r.lowest }, high: { money: r.highest } })
          : para("gp.t.peak.noRates"),
        r.memberRates ? para("gp.t.peak.members") : null,
        r.holidays > 0 ? para("gp.t.peak.holidays", { n: r.holidays }) : null,
        para("gp.t.peak.kept"),
        para("gp.t.peak.dated"),
        changedBy(
          c,
          steps(
            step("gp.t.peak.changeRates", undefined, c.go("courts", "courts")),
            step("gp.t.peak.changePeak", undefined, c.go("courts", "peakRules")),
            step("gp.t.peak.changeDated", undefined, c.go("courts", "datedCourtChanges"))
          ),
          note("gp.t.peak.deskNote")
        ),
      ].filter((b): b is Block => b !== null);
    },
  },
  {
    id: "discounts",
    title: { key: "gp.t.discounts.title" },
    roles: BOTH,
    related: ["peak-dated", "passes", "memberships"],
    blocks: (c) => {
      const p = c.profile;
      const stacking = p.policies.discountStacking;
      return [
        para("gp.t.discounts.kinds"),
        facts(
          fact("gp.t.discounts.f.concessions", "gp.t.discounts.v.count", { n: p.commerce.concessions }),
          fact("gp.t.discounts.f.promos", "gp.t.discounts.v.count", { n: p.commerce.promoCodes })
        ),
        para(stacking === "promotion" ? "gp.t.discounts.stackWhere" : "gp.t.discounts.stackNever"),
        para("gp.t.discounts.together"),
        para("gp.t.discounts.paying"),
        changedBy(
          c,
          steps(
            step("gp.t.discounts.changePromos", undefined, c.go("credit", "promos")),
            step("gp.t.discounts.changeConcessions", undefined, c.go("courts", "concessions"))
          ),
          note("gp.t.discounts.deskNote")
        ),
      ];
    },
  },
  {
    id: "memberships",
    title: { key: "gp.t.memberships.title" },
    roles: BOTH,
    related: ["membership-covers", "cannot-reserve", "guardians"],
    blocks: (c) => {
      const p = c.profile;
      return [
        para("gp.t.memberships.two"),
        table(
          ["gp.t.memberships.h.kind", "gp.t.memberships.h.whose", "gp.t.memberships.h.checked"],
          [
            ["gp.t.memberships.r.booking.kind", "gp.t.memberships.r.booking.whose", "gp.t.memberships.r.booking.checked"],
            ["gp.t.memberships.r.part.kind", "gp.t.memberships.r.part.whose", "gp.t.memberships.r.part.checked"],
          ]
        ),
        para("gp.t.memberships.ends"),
        para("gp.t.memberships.checkIn"),
        facts(
          fact("gp.t.memberships.f.plans", "gp.t.memberships.v.count", { n: p.commerce.membershipPlans }),
          fact("gp.t.memberships.f.active", "gp.t.memberships.v.count", { n: p.commerce.activeMemberships })
        ),
      ];
    },
  },
  {
    id: "membership-covers",
    title: { key: "gp.t.covers.title" },
    roles: BOTH,
    related: ["memberships", "passes"],
    blocks: (c) => {
      const p = c.profile;
      return [
        para("gp.t.covers.scope"),
        table(
          ["gp.t.covers.h.covers", "gp.t.covers.h.pays"],
          [
            ["gp.t.covers.r.booking.covers", "gp.t.covers.r.booking.pays"],
            ["gp.t.covers.r.place.covers", "gp.t.covers.r.place.pays"],
          ]
        ),
        para("gp.t.covers.plan"),
        p.guardians.familyPlans > 0 ? para("gp.t.covers.family", { n: p.guardians.familyPlans }) : null,
        para("gp.t.covers.suspended"),
        c.role === "desk" ? note("gp.t.covers.deskNote") : steps(step("gp.t.covers.manage", undefined, c.go("credit", "membershipPlans"))),
      ].filter((b): b is Block => b !== null);
    },
  },
  {
    id: "passes",
    title: { key: "gp.t.passes.title" },
    roles: BOTH,
    related: ["membership-covers", "discounts"],
    blocks: (c) => {
      const p = c.profile;
      return [
        para("gp.t.passes.kinds"),
        para("gp.t.passes.spend"),
        para("gp.t.passes.each"),
        // Sold online too, where a manager marks a pass so (lib/pass-purchases.ts).
        para("gp.t.passes.online"),
        facts(fact("gp.t.passes.f.products", "gp.t.passes.v.count", { n: p.commerce.passProducts })),
        c.role === "desk"
          ? para("gp.t.passes.deskSell")
          : steps(step("gp.t.passes.products", undefined, c.go("credit", "passProducts"))),
        // Money back on one bought online goes through Refunds owed, a manager's screen.
        c.role === "desk" ? null : para("gp.t.passes.onlineRefund"),
      ].filter((b): b is Block => b !== null);
    },
  },
  {
    id: "guardians",
    title: { key: "gp.t.guardians.title" },
    roles: BOTH,
    related: ["memberships", "cannot-reserve"],
    blocks: (c) => {
      const p = c.profile;
      return [
        para("gp.t.guardians.who"),
        para("gp.t.guardians.declared"),
        para("gp.t.guardians.counter"),
        para("gp.t.guardians.approvals"),
        p.guardians.approvalRequirements > 0
          ? para("gp.t.guardians.requirements", { n: p.guardians.approvalRequirements })
          : para("gp.t.guardians.noRequirements"),
        c.role === "manager" ? steps(step("gp.t.guardians.corrections", undefined, c.go("venues", "venueDetails"))) : note("gp.t.guardians.deskNote"),
      ];
    },
  },
  {
    id: "refunds",
    title: { key: "gp.t.refunds.title" },
    roles: BOTH,
    related: ["cannot-reserve"],
    blocks: (c) => {
      const p = c.profile;
      const online = p.payments.online.accountExists || p.history.onlinePayments > 0;
      return [
        para("gp.t.refunds.two"),
        table(
          ["gp.t.refunds.h.who", "gp.t.refunds.h.what"],
          [
            ["gp.t.refunds.r.counter.who", "gp.t.refunds.r.counter.what"],
            ["gp.t.refunds.r.online.who", online ? "gp.t.refunds.r.online.what" : "gp.t.refunds.r.onlineOff.what"],
            ["gp.t.refunds.r.credit.who", "gp.t.refunds.r.credit.what"],
            ["gp.t.refunds.r.venue.who", "gp.t.refunds.r.venue.what"],
          ]
        ),
        c.role === "desk" ? note("gp.t.refunds.deskNote") : steps(step("gp.t.refunds.owed", undefined, c.go("venues", "paymentSettings"))),
      ];
    },
  },
  {
    id: "cannot-reserve",
    title: { key: "gp.t.cannot.title" },
    roles: BOTH,
    related: ["memberships", "guardians", "buffers", "shared-linked"],
    blocks: (c) => {
      const p = c.profile;
      const rows: Row[] = [["gp.t.cannot.r.open.why", "gp.t.cannot.r.open.do"]];
      if (p.identity.visibility !== "public") rows.push(["gp.t.cannot.r.who.why", "gp.t.cannot.r.who.do"]);
      rows.push(["gp.t.cannot.r.rules.why", "gp.t.cannot.r.rules.do"]);
      if (p.policies.bookAheadDays !== null || p.policies.limits) rows.push(["gp.t.cannot.r.house.why", "gp.t.cannot.r.house.do"]);
      if (p.policies.signOffRequired) rows.push(["gp.t.cannot.r.signoff.why", "gp.t.cannot.r.signoff.do"]);
      if (p.commerce.membershipPlans > 0 || p.commerce.activeMemberships > 0 || p.identity.visibility === "members") rows.push(["gp.t.cannot.r.member.why", "gp.t.cannot.r.member.do"]);
      rows.push(["gp.t.cannot.r.blocked.why", "gp.t.cannot.r.blocked.do"], ["gp.t.cannot.r.unpaid.why", "gp.t.cannot.r.unpaid.do"]);
      if (p.policies.cancellation.strikeLimit !== null) rows.push(["gp.t.cannot.r.strikes.why", "gp.t.cannot.r.strikes.do"]);
      rows.push(["gp.t.cannot.r.taken.why", "gp.t.cannot.r.taken.do"]);
      return [
        para("gp.t.cannot.intro"),
        table(["gp.t.cannot.h.why", "gp.t.cannot.h.do"], rows),
        para("gp.t.cannot.same"),
        c.role === "desk" ? note("gp.t.cannot.deskNote") : note("gp.t.cannot.managerNote"),
        policy("gp.t.cannot.never"),
      ];
    },
  },
  {
    id: "another-coach",
    title: { key: "gp.t.coach.title" },
    roles: BOTH,
    related: ["refunds"],
    blocks: (c) => {
      const p = c.profile;
      return [
        para("gp.t.coach.who"),
        para(hasCoaching(p) ? "gp.t.coach.have" : "gp.t.coach.none", { n: p.people.coaches }),
        c.role === "manager"
          ? steps(
              step("gp.t.coach.s1", undefined, c.go("bookings")),
              step("gp.t.coach.s2"),
              step("gp.t.coach.s3"),
              step("gp.t.coach.s4")
            )
          : note("gp.t.coach.deskNote"),
        para("gp.t.coach.fee"),
      ];
    },
  },
  {
    id: "unattended",
    title: { key: "gp.t.unattended.title" },
    roles: BOTH,
    related: ["memberships", "guardians"],
    blocks: (c) => {
      const p = c.profile;
      return [
        para("gp.t.unattended.dials"),
        para(p.access.unstaffedHours ? "gp.t.unattended.hoursSet" : "gp.t.unattended.hoursNone"),
        para("gp.t.unattended.door"),
        para("gp.t.unattended.induction"),
        warning("gp.t.unattended.refused"),
        p.access.unmannedResources > 0 ? para("gp.t.unattended.resources", { n: p.access.unmannedResources }) : null,
        p.access.emergencyDetails ? para("gp.t.unattended.emergencySet") : para("gp.t.unattended.emergencyMissing"),
        steps(step("gp.t.unattended.induct", undefined, c.go("courts", "courts"))),
      ].filter((b): b is Block => b !== null);
    },
  },
  {
    id: "test-bookings",
    title: { key: "gp.t.test.title" },
    roles: ["manager", "desk"],
    related: ["refunds"],
    blocks: (c) => {
      const p = c.profile;
      return [
        para("gp.t.test.what"),
        para("gp.t.test.money"),
        p.history.testBookings > 0 ? para("gp.t.test.have", { n: p.history.testBookings }) : null,
        p.history.paidTestBookings > 0 ? warning("gp.t.test.paid", { n: p.history.paidTestBookings }) : null,
        c.role === "manager"
          ? steps(step("gp.t.test.clear", undefined, c.go("bookings", "testBookings")))
          : note("gp.t.test.deskNote"),
      ].filter((b): b is Block => b !== null);
    },
  },
];

const BY_ID = new Map<TopicId, PlaybookTopic>(TOPICS.map((t) => [t.id, t]));
export { TOPIC_IDS };

/** The topic for an id, for a role, over a venue's profile; null where the role is not given it. */
export function buildTopic(id: TopicId, profile: VenueProfile, role: GuideRole): BuiltTopic | null {
  const topic = BY_ID.get(id);
  if (!topic || !topic.roles.includes(role)) return null;
  const blocks = topic.blocks({ profile, role, go: goFor(role) });
  const related = topic.related
    .map((r) => BY_ID.get(r))
    .filter((r): r is PlaybookTopic => !!r && r.roles.includes(role))
    .map((r) => ({ id: r.id, title: r.title }));
  return { id, title: topic.title, blocks, related };
}

/** A topic's blocks under its heading, for a section that explains it in place. */
export function topicBlocks(id: TopicId, profile: VenueProfile, role: GuideRole): Block[] {
  const built = buildTopic(id, profile, role);
  return built ? [{ type: "heading", level: 4, text: built.title, id: `topic-${id}` }, ...built.blocks] : [];
}
