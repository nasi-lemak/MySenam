import { hasCoaching, hasHistory, takesCounterPayments, usesOnlinePayments } from "../../profile-types";
import { heading, note, para, step, steps, screen, w, warning, policy } from "../dsl";
import type { Block, GuideRole, PlaybookModule } from "../types";

const BOTH: GuideRole[] = ["manager", "desk"];
const MANAGER: GuideRole[] = ["manager"];
const always = () => true;

const nn = (b: Block | null | false): b is Block => !!b;

/**
 * Before opening, during operations and the end of the day: the daily work,
 * for the front desk and a manager. Each step is what the screens do, as
 * docs/features/venue-operations.md, booking.md and payments-and-credit.md
 * say; what a venue has set is read from its profile.
 */
export const DAY_MODULES: PlaybookModule[] = [
  // ------------------------------------------------------------ before opening
  {
    id: "before.day",
    section: "before",
    roles: BOTH,
    applies: always,
    blocks: (c) => [
      heading("gp.before.day.h", "before-day"),
      steps(
        step("gp.before.day.s1", { screen: screen("bookings") }, c.go("bookings")),
        step("gp.before.day.s2"),
        step("gp.before.day.s3", { screen: screen("schedule") }, c.go("schedule")),
        step("gp.before.day.s4", { screen: screen("occupancy") }, c.go("occupancy")),
        step("gp.before.day.s5", { print: w("p8a.day.print") })
      ),
    ],
  },
  {
    id: "before.attention",
    section: "before",
    roles: BOTH,
    applies: always,
    blocks: (c) => {
      const p = c.profile;
      return [
        heading("gp.before.attention.h", "before-attention"),
        para("gp.before.attention.text", { attention: w("att.title") }),
        p.guardians.approvalRequirements > 0 || p.policies.signOffRequired || p.commerce.membershipPlans > 0 ? para("gp.before.attention.approvals") : null,
      ].filter(nn);
    },
  },
  {
    id: "before.owed",
    section: "before",
    roles: BOTH,
    applies: (p) => takesCounterPayments(p) || hasHistory(p),
    blocks: () => [heading("gp.before.owed.h", "before-owed"), para("gp.before.owed.text", { owed: w("r9e.owed.title") })],
  },
  {
    id: "before.classes",
    section: "before",
    roles: BOTH,
    applies: (p) => p.people.upcomingClasses > 0,
    blocks: (c) => [
      heading("gp.before.classes.h", "before-classes"),
      steps(step("gp.before.classes.s1", { n: c.profile.people.upcomingClasses, screen: screen("classes") }, c.go("classes"))),
    ],
  },
  {
    id: "before.unstaffed",
    section: "before",
    roles: BOTH,
    applies: (p) => p.access.unstaffedHours,
    blocks: () => [heading("gp.before.unstaffed.h", "before-unstaffed"), para("gp.before.unstaffed.text")],
  },

  // ------------------------------------------------------------ during operations
  {
    id: "during.checkin",
    section: "during",
    roles: BOTH,
    applies: always,
    blocks: (c) => {
      const p = c.profile;
      return [
        heading("gp.during.checkin.h", "during-checkin"),
        steps(
          step("gp.during.checkin.s1", { screen: screen("bookings"), attendance: w("bk.col.attendance") }, c.go("bookings")),
          step("gp.during.checkin.s2"),
          step("gp.during.checkin.s3"),
          (p.commerce.membershipPlans > 0 || p.identity.visibility === "members") && step("gp.during.checkin.s4"),
          p.guardians.participants > 0 && step("gp.during.checkin.s5")
        ),
        note("gp.during.checkin.exclusive"),
      ];
    },
  },
  {
    id: "during.walkins",
    section: "during",
    roles: BOTH,
    applies: always,
    blocks: (c) => {
      const p = c.profile;
      return [
        heading("gp.during.walkins.h", "during-walkins"),
        steps(
          step("gp.during.walkins.s1", { screen: screen("schedule") }, c.go("schedule")),
          step("gp.during.walkins.s2"),
          step("gp.during.walkins.s3"),
          p.people.classes > 0 && step("gp.during.walkins.s4")
        ),
      ];
    },
  },
  {
    id: "during.hire",
    section: "during",
    roles: BOTH,
    applies: (p) => p.commerce.hireDeposits,
    blocks: (c) => [
      heading("gp.during.hire.h", "during-hire"),
      steps(
        step("gp.during.hire.s1", { screen: screen("bookings") }, c.go("bookings")),
        step("gp.during.hire.s2"),
        step("gp.during.hire.s3"),
        step("gp.during.hire.s4")
      ),
      warning("gp.during.hire.out"),
    ],
  },
  {
    id: "during.classes",
    section: "during",
    roles: BOTH,
    applies: (p) => p.people.classes > 0,
    blocks: (c) => [
      heading("gp.during.classes.h", "during-classes"),
      para("gp.during.classes.text"),
      steps(step("gp.during.classes.s1", { screen: screen("classes") }, c.go("classes"))),
    ],
  },
  {
    id: "during.coaching",
    section: "during",
    roles: BOTH,
    applies: (p) => hasCoaching(p),
    blocks: (c) => [
      heading("gp.during.coaching.h", "during-coaching"),
      para("gp.during.coaching.text"),
      c.role === "manager" ? para("gp.during.coaching.manager") : para("gp.during.coaching.desk"),
    ],
  },
  {
    id: "during.noshows",
    section: "during",
    roles: BOTH,
    applies: always,
    blocks: (c) => {
      const p = c.profile;
      const limit = p.policies.cancellation.strikeLimit;
      return [
        heading("gp.during.noshows.h", "during-noshows"),
        steps(
          step("gp.during.noshows.s1", { screen: screen("bookings") }, c.go("bookings")),
          step("gp.during.noshows.s2"),
          p.guardians.participants > 0 && step("gp.during.noshows.s3")
        ),
        limit !== null ? policy("gp.during.noshows.strikes", { n: limit }) : note("gp.during.noshows.noLimit"),
      ];
    },
  },
  {
    id: "during.requests",
    section: "during",
    roles: BOTH,
    applies: always,
    blocks: (c) => [
      heading("gp.during.requests.h", "during-requests"),
      steps(
        step("gp.during.requests.s1", { screen: screen("bookings") }, c.go("bookings")),
        step("gp.during.requests.s2", { change: w("bk.changeTime") }),
        step("gp.during.requests.s3", { fix: w("p8a.fix.action") }),
        step("gp.during.requests.s4")
      ),
    ],
  },
  {
    id: "during.outage",
    section: "during",
    roles: BOTH,
    applies: (p) => p.resources.total > 0,
    blocks: (c) =>
      [
        heading("gp.during.outage.h", "during-outage"),
        steps(
          step("gp.during.outage.s1", { screen: screen("schedule") }, c.go("schedule")),
          step("gp.during.outage.s2", { rain: w("rain.open"), screen: screen("schedule") }, c.go("schedule")),
          c.role === "manager"
            ? step("gp.during.outage.s3", { out: w("out.title"), screen: screen("courts") }, c.go("courts", "outages"))
            : step("gp.during.outage.deskDays")
        ),
        note("gp.during.outage.money"),
        c.role === "manager" ? para("gp.during.outage.manager") : null,
      ].filter(nn),
  },

  // ------------------------------------------------------------ end of day
  {
    id: "eod.cashup",
    section: "eod",
    roles: BOTH,
    applies: always,
    blocks: (c) => {
      const p = c.profile;
      return [
        heading("gp.eod.cashup.h", "eod-cashup"),
        steps(
          step("gp.eod.cashup.s1", { screen: screen("credit"), cashup: w("p8b.cash.title") }, c.go("credit")),
          step("gp.eod.cashup.s2"),
          c.role === "desk" ? step("gp.eod.cashup.deskSees") : step("gp.eod.cashup.managerSees"),
          step("gp.eod.cashup.s4", { print: w("p8b.cash.print") })
        ),
        p.history.testBookings > 0 ? note("gp.eod.cashup.tests") : null,
      ].filter(nn);
    },
  },
  {
    id: "eod.unpaid",
    section: "eod",
    roles: BOTH,
    applies: always,
    blocks: (c) => [
      heading("gp.eod.unpaid.h", "eod-unpaid"),
      steps(step("gp.eod.unpaid.s1", { screen: screen("bookings") }, c.go("bookings")), step("gp.eod.unpaid.s2"), step("gp.eod.unpaid.s3")),
    ],
  },
  {
    id: "eod.owedCounter",
    section: "eod",
    roles: BOTH,
    applies: (p) => takesCounterPayments(p) || hasHistory(p),
    blocks: (c) => [
      heading("gp.eod.owedCounter.h", "eod-owed"),
      para("gp.eod.owedCounter.text", { owed: w("r9e.owed.title") }),
      c.role === "desk" ? note("gp.eod.owedCounter.desk") : note("gp.eod.owedCounter.manager"),
    ],
  },
  {
    id: "eod.owedOnline",
    section: "eod",
    roles: MANAGER,
    applies: (p) => usesOnlinePayments(p) || p.payments.onlineRefundsOwed > 0,
    blocks: (c) =>
      [
        heading("gp.eod.owedOnline.h", "eod-owed-online"),
        c.profile.payments.onlineRefundsOwed > 0 ? warning("gp.eod.owedOnline.some", { n: c.profile.payments.onlineRefundsOwed }) : para("gp.eod.owedOnline.none"),
        steps(step("gp.eod.owedOnline.s1", { owed: w("opay.owedTitle"), screen: screen("venues") }, c.go("venues", "paymentSettings"))),
      ].filter(nn),
  },
  {
    id: "eod.exceptions",
    section: "eod",
    roles: BOTH,
    applies: always,
    blocks: (c) => [
      heading("gp.eod.exceptions.h", "eod-exceptions"),
      steps(
        step("gp.eod.exceptions.s1", { screen: screen("bookings") }, c.go("bookings")),
        step("gp.eod.exceptions.s2", { attention: w("att.title") }),
        step("gp.eod.exceptions.s3", { print: w("p8a.day.print") })
      ),
    ],
  },
  {
    id: "eod.reports",
    section: "eod",
    roles: MANAGER,
    applies: always,
    blocks: (c) => {
      const p = c.profile;
      return [
        heading("gp.eod.reports.h", "eod-reports"),
        steps(
          step("gp.eod.reports.s1", { screen: screen("reports") }, c.go("reports", "reports")),
          step("gp.eod.reports.s2"),
          step("gp.eod.reports.s3"),
          p.history.testBookings > 0 && step("gp.eod.reports.s4")
        ),
        para("gp.eod.reports.note"),
      ];
    },
  },
];
