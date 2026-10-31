import { hasHistory, takesCounterPayments, usesOnlinePayments, type VenueProfile } from "../../profile-types";
import { heading, note, para, policy, screen, step, steps, w, warning } from "../dsl";
import { topicBlocks } from "../topics";
import type { Block, GuideRole, PlaybookModule } from "../types";

const BOTH: GuideRole[] = ["manager", "desk"];
const MANAGER: GuideRole[] = ["manager"];
const DESK: GuideRole[] = ["desk"];
const always = () => true;
const nn = (b: Block | null | false): b is Block => !!b;

/** Money was or can be paid online: an account exists, or a payment came through one. */
const onlineMoney = (p: VenueProfile) => p.payments.online.accountExists || p.history.onlinePayments > 0;

/**
 * Handling a customer booking, and cancellations and refunds. The cancellation
 * module states the venue's ACTUAL terms from its profile (the cutoff, the
 * share kept, what `onlineRefunds` governs) and the venue-cancels module the
 * venue-wide policy (docs/features/payments-and-credit.md, "Refunds when the
 * venue cancels"); neither says anything the settings do not.
 */
export const BOOKING_MODULES: PlaybookModule[] = [
  // ------------------------------------------------------------ handling a customer booking
  {
    id: "booking.counter",
    section: "booking",
    roles: BOTH,
    applies: always,
    blocks: (c) => [
      heading("gp.booking.counter.h", "booking-counter"),
      steps(
        step("gp.booking.counter.s1", { screen: screen("bookings"), newBooking: w("p8a.day.newBooking") }, c.go("bookings")),
        step("gp.booking.counter.s2"),
        step("gp.booking.counter.s3"),
        step("gp.booking.counter.s4")
      ),
    ],
  },
  {
    id: "booking.online",
    section: "booking",
    roles: BOTH,
    applies: (p) => p.identity.live,
    blocks: (c) => {
      const p = c.profile;
      const online = p.payments.online.accountEnabled;
      return [
        heading("gp.booking.online.h", "booking-online"),
        para("gp.booking.online.text"),
        online ? para("gp.booking.online.pay") : para("gp.booking.online.counterOnly"),
        p.policies.payToHold ? policy("gp.booking.online.hold") : null,
        p.identity.visibility !== "public" ? para("gp.booking.online.who") : null,
      ].filter(nn);
    },
  },
  {
    id: "booking.behalf",
    section: "booking",
    roles: BOTH,
    applies: always,
    blocks: (c) => [
      heading("gp.booking.behalf.h", "booking-behalf"),
      steps(
        step("gp.booking.behalf.s1", { screen: screen("bookings") }, c.go("bookings")),
        step("gp.booking.behalf.s2"),
        step("gp.booking.behalf.s3"),
        step("gp.booking.behalf.s4")
      ),
    ],
  },
  {
    id: "booking.eligibility",
    section: "booking",
    roles: BOTH,
    applies: always,
    blocks: (c) => {
      const p = c.profile;
      return [
        heading("gp.booking.eligibility.h", "booking-eligibility"),
        ...topicBlocks("cannot-reserve", p, c.role),
        // The manager meets these in the manager's own section (written once, never twice in one guide).
        ...(c.role === "desk" && (p.commerce.membershipPlans > 0 || p.commerce.activeMemberships > 0 || p.identity.visibility === "members") ? topicBlocks("memberships", p, c.role) : []),
        ...(c.role === "desk" && (p.commerce.concessions > 0 || p.commerce.promoCodes > 0) ? topicBlocks("discounts", p, c.role) : []),
        ...(c.role === "desk" && p.commerce.passProducts > 0 ? topicBlocks("passes", p, c.role) : []),
      ];
    },
  },
  {
    id: "booking.availability",
    section: "booking",
    roles: BOTH,
    applies: (p) => p.resources.withBuffers > 0 || p.resources.shared > 0 || p.resources.linked > 0,
    blocks: (c) => {
      const p = c.profile;
      return [
        heading("gp.booking.availability.h", "booking-availability"),
        ...(p.resources.withBuffers > 0 ? topicBlocks("buffers", p, c.role) : []),
        ...(p.resources.shared > 0 || p.resources.linked > 0 ? topicBlocks("shared-linked", p, c.role) : []),
      ];
    },
  },
  {
    id: "booking.changes",
    section: "booking",
    roles: BOTH,
    applies: always,
    blocks: (c) => [
      heading("gp.booking.changes.h", "booking-changes"),
      steps(
        step("gp.booking.changes.s1", { move: w("bk.move"), screen: screen("bookings") }, c.go("bookings")),
        step("gp.booking.changes.s2", { change: w("bk.changeTime") }),
        step("gp.booking.changes.s3", { fix: w("p8a.fix.action") }),
        step("gp.booking.changes.s4")
      ),
    ],
  },
  {
    id: "booking.payments",
    section: "booking",
    roles: BOTH,
    applies: always,
    blocks: (c) => {
      const p = c.profile;
      return [
        heading("gp.booking.payments.h", "booking-payments"),
        steps(
          step("gp.booking.payments.s1", { screen: screen("bookings") }, c.go("bookings")),
          onlineMoney(p) ? step("gp.booking.payments.s2online") : step("gp.booking.payments.s2"),
          step("gp.booking.payments.s3", { screen: screen("credit") }, c.go("credit")),
          step("gp.booking.payments.s4")
        ),
      ];
    },
  },
  {
    id: "booking.prices",
    section: "booking",
    roles: BOTH,
    applies: (p) => p.rates.lowest !== null,
    blocks: (c) => [heading("gp.booking.prices.h", "booking-prices"), ...topicBlocks("peak-dated", c.profile, c.role)],
  },

  // ------------------------------------------------------------ cancellation and refund procedures
  {
    id: "cancel.policy",
    section: "cancel",
    roles: BOTH,
    applies: always,
    blocks: (c) => {
      const p = c.profile;
      const x = p.policies.cancellation;
      const online = onlineMoney(p);
      const how: Block | null = !online
        ? para("gp.cancel.policy.noOnline")
        : x.onlineRefunds === "gateway"
          ? para("gp.cancel.policy.gateway")
          : x.onlineRefunds === "credit"
            ? para("gp.cancel.policy.credit")
            : para("gp.cancel.policy.staff");
      return [
        heading("gp.cancel.policy.h", "cancel-policy"),
        para("gp.cancel.policy.intro"),
        policy("gp.cancel.policy.cutoff", { n: x.cutoffHours }),
        x.lateKeepPercent !== null ? policy("gp.cancel.policy.late", { percent: x.lateKeepPercent }) : policy("gp.cancel.policy.noLate"),
        x.strikeLimit !== null ? policy("gp.cancel.policy.strikes", { n: x.strikeLimit }) : null,
        online ? heading("gp.cancel.policy.onlineH", undefined, 4) : null,
        how,
        online ? para("gp.cancel.policy.customersOnly") : null,
        online && x.onlineRefunds !== "gateway" ? para("gp.cancel.policy.within", { n: x.refundWithinDays }) : null,
        c.role === "manager" ? steps(step("gp.cancel.policy.change", { cxl: w("cxl.title"), screen: screen("venues") }, c.go("venues", "cancelPolicy"))) : null,
        ...topicBlocks("refunds", p, c.role),
      ].filter(nn);
    },
  },
  {
    id: "cancel.venue",
    section: "cancel",
    roles: BOTH,
    applies: always,
    blocks: (c) => {
      const p = c.profile;
      const x = p.policies.cancellation;
      return [
        heading("gp.cancel.venue.h", "cancel-venue"),
        para("gp.cancel.venue.what"),
        onlineMoney(p) ? para("gp.cancel.venue.online") : null,
        onlineMoney(p) ? para("gp.cancel.venue.due", { n: x.refundWithinDays }) : null,
        para("gp.cancel.venue.credit"),
        policy("gp.cancel.venue.counter", { owed: w("r9e.owed.title") }),
        para("gp.cancel.venue.who"),
        para("gp.cancel.venue.books"),
      ].filter(nn);
    },
  },
  {
    id: "cancel.staff",
    section: "cancel",
    roles: BOTH,
    applies: always,
    blocks: (c) => {
      const p = c.profile;
      return [
        heading("gp.cancel.staff.h", "cancel-staff"),
        steps(
          step("gp.cancel.staff.s1", { screen: screen("bookings"), actions: w("p8a.day.actions") }, c.go("bookings")),
          step("gp.cancel.staff.s2"),
          p.policies.cancellation.lateKeepPercent !== null && step("gp.cancel.staff.s2late", { percent: p.policies.cancellation.lateKeepPercent }),
          step("gp.cancel.staff.s3"),
          step("gp.cancel.staff.s4")
        ),
        note("gp.cancel.staff.pastCutoff"),
        c.role === "desk" ? note("gp.cancel.staff.deskWho") : note("gp.cancel.staff.managerWho"),
        warning("gp.cancel.staff.kit"),
      ];
    },
  },
  {
    id: "cancel.partial",
    section: "cancel",
    roles: BOTH,
    applies: (p) => p.guardians.participants > 0 || p.resources.shared > 0 || p.resources.perPlayer > 0 || p.people.classes > 0,
    blocks: (c) => [
      heading("gp.cancel.partial.h", "cancel-partial"),
      steps(step("gp.cancel.partial.s1", { screen: screen("bookings") }, c.go("bookings")), step("gp.cancel.partial.s2"), step("gp.cancel.partial.s3")),
      c.profile.people.classes > 0 ? para("gp.cancel.partial.class") : null,
    ].filter(nn),
  },
  {
    id: "cancel.reschedule",
    section: "cancel",
    roles: BOTH,
    applies: always,
    blocks: (c) => [
      heading("gp.cancel.reschedule.h", "cancel-reschedule"),
      para("gp.cancel.reschedule.customers", { n: c.profile.policies.cancellation.cutoffHours }),
      para("gp.cancel.reschedule.staff", { change: w("bk.changeTime") }),
      para("gp.cancel.reschedule.price"),
    ],
  },
  {
    id: "cancel.manual",
    section: "cancel",
    roles: MANAGER,
    applies: (p) => usesOnlinePayments(p) || p.payments.onlineRefundsOwed > 0 || onlineMoney(p),
    blocks: (c) => {
      const provider = c.profile.payments.online.provider;
      return [
        heading("gp.cancel.manual.h", "cancel-manual"),
        steps(
          step("gp.cancel.manual.s1", { screen: screen("venues"), online: w("opay.title"), owed: w("opay.owedTitle") }, c.go("venues", "paymentSettings")),
          provider !== "billplz" && step("gp.cancel.manual.stripe"),
          provider !== "stripe" && step("gp.cancel.manual.billplz"),
          step("gp.cancel.manual.log")
        ),
        note("gp.cancel.manual.pending"),
      ];
    },
  },
  {
    id: "cancel.manualDesk",
    section: "cancel",
    roles: DESK,
    applies: (p) => onlineMoney(p),
    blocks: () => [heading("gp.cancel.manualDesk.h", "cancel-manual"), para("gp.cancel.manualDesk.text")],
  },
  {
    id: "cancel.obligations",
    section: "cancel",
    roles: BOTH,
    applies: (p) => takesCounterPayments(p) || hasHistory(p) || onlineMoney(p),
    blocks: (c) => {
      const p = c.profile;
      const x = p.policies.cancellation;
      return [
        heading("gp.cancel.obligations.h", "cancel-obligations"),
        para("gp.cancel.obligations.counter", { owed: w("r9e.owed.title") }),
        onlineMoney(p) ? para(c.role === "manager" ? "gp.cancel.obligations.online" : "gp.cancel.obligations.onlineDesk", { owed: w("opay.owedTitle"), n: x.refundWithinDays }) : null,
        c.role === "manager" && p.payments.onlineRefundsOwed > 0 ? warning("gp.cancel.obligations.count", { n: p.payments.onlineRefundsOwed }) : null,
      ].filter(nn);
    },
  },
];
