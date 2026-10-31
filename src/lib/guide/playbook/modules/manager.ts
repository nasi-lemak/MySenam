import { hasCoaching } from "../../profile-types";
import { fact, facts, heading, note, para, policy, screen, step, steps, w } from "../dsl";
import { topicBlocks } from "../topics";
import type { Block, GuideRole, PlaybookModule } from "../types";

const MANAGER: GuideRole[] = ["manager"];
const always = () => true;
const nn = (b: Block | null | false): b is Block => !!b;

/**
 * Manager responsibilities: what only a manager does. Every module here is
 * written for the `manager` role alone, and every link in it names the staff
 * action that governs the screen, so a role that may not use it is never
 * given it (tests/guide-playbook-roles.test.ts holds this to MANAGER_ONLY).
 */
export const MANAGER_MODULES: PlaybookModule[] = [
  {
    id: "manager.pricesHours",
    section: "manager",
    roles: MANAGER,
    applies: always,
    blocks: (c) => [
      heading("gp.manager.prices.h", "manager-prices"),
      steps(
        step("gp.manager.prices.s1", { screen: screen("courts"), rules: w("pol.title") }, c.go("courts", "courts")),
        step("gp.manager.prices.s3", { screen: screen("venues") }, c.go("venues", "venueDetails")),
        step("gp.manager.prices.s4", { hours: w("r9b.hours.title") }, c.go("venues", "datedHours"))
      ),
    ],
  },
  {
    id: "manager.staff",
    section: "manager",
    roles: MANAGER,
    applies: always,
    blocks: (c) => {
      const p = c.profile;
      return [
        heading("gp.manager.staff.h", "manager-staff"),
        facts(fact("gp.f.staff", "gp.v.staff", { managers: p.staff.managers, desk: p.staff.desk }), p.staff.pendingInvitations > 0 && fact("gp.f.invitations", "gp.v.n", { n: p.staff.pendingInvitations })),
        steps(
          step("gp.manager.staff.s1", { screen: screen("venues"), staff: w("vn.staffAccounts") }, c.go("venues", "staff")),
          step("gp.manager.staff.s2"),
          step("gp.manager.staff.s3")
        ),
        para("gp.manager.staff.who"),
      ];
    },
  },
  {
    id: "manager.commerce",
    section: "manager",
    roles: MANAGER,
    applies: (p) => p.commerce.promoCodes + p.commerce.passProducts + p.commerce.concessions + p.commerce.membershipPlans > 0,
    blocks: (c) => {
      const p = c.profile;
      return [
        heading("gp.manager.commerce.h", "manager-commerce"),
        para("gp.manager.commerce.void"),
        ...(p.commerce.concessions > 0 || p.commerce.promoCodes > 0 ? topicBlocks("discounts", p, "manager") : []),
        ...(p.commerce.passProducts > 0 ? topicBlocks("passes", p, "manager") : []),
      ];
    },
  },
  {
    id: "manager.memberships",
    section: "manager",
    roles: MANAGER,
    applies: (p) => p.commerce.membershipPlans > 0 || p.commerce.activeMemberships > 0 || p.identity.visibility === "members",
    blocks: (c) => [
      heading("gp.manager.memberships.h", "manager-memberships"),
      steps(
        step("gp.manager.memberships.s1", { screen: screen("credit") }, c.go("credit", "membershipPlans")),
        step("gp.manager.memberships.s2", undefined, c.go("credit", "membershipExtend")),
        step("gp.manager.memberships.s3", undefined, c.go("credit", "membershipSuspend")),
        step("gp.manager.memberships.s4", undefined, c.go("credit", "membershipCovers"))
      ),
      ...topicBlocks("membership-covers", c.profile, "manager"),
      ...topicBlocks("memberships", c.profile, "manager"),
    ],
  },
  {
    id: "manager.overrides",
    section: "manager",
    roles: MANAGER,
    applies: (p) => p.resources.total > 0,
    blocks: (c) => [
      heading("gp.manager.overrides.h", "manager-overrides"),
      para("gp.manager.overrides.what"),
      steps(
        step("gp.manager.overrides.s1", { overrides: w("r9.set.show"), screen: screen("venues") }, c.go("venues", "policyOverrides")),
        step("gp.manager.overrides.s2"),
        step("gp.manager.overrides.s3"),
        step("gp.manager.overrides.s4")
      ),
      policy("gp.manager.overrides.never"),
      para("gp.manager.overrides.rules"),
    ],
  },
  {
    id: "manager.incidents",
    section: "manager",
    roles: MANAGER,
    applies: (p) => p.resources.total > 0,
    blocks: (c) => [
      heading("gp.manager.incidents.h", "manager-incidents"),
      steps(
        step("gp.manager.incidents.s1", { out: w("out.title"), screen: screen("courts") }, c.go("courts", "outages")),
        step("gp.manager.incidents.s2", { screen: screen("venues") }, c.go("venues", "closures")),
        step("gp.manager.incidents.s3", undefined, c.go("venues", "blockNumber")),
        step("gp.manager.incidents.s4", undefined, c.go("venues", "notices")),
        step("gp.manager.incidents.s5", undefined, c.go("venues", "staffLog"))
      ),
      note("gp.manager.incidents.money"),
    ],
  },
  {
    id: "manager.finance",
    section: "manager",
    roles: MANAGER,
    applies: always,
    blocks: (c) => {
      const p = c.profile;
      return [
        heading("gp.manager.finance.h", "manager-finance"),
        steps(
          step("gp.manager.finance.s1", { screen: screen("reports") }, c.go("reports", "reports")),
          step("gp.manager.finance.s2", { cashup: w("p8b.cash.title"), screen: screen("credit") }, c.go("credit")),
          step("gp.manager.finance.s3", undefined, c.go("reports", "exports")),
          step("gp.manager.finance.s4", undefined, c.go("venues", "staffLog")),
          p.compliance.einvoicing.enabled && step("gp.manager.finance.einvoice", undefined, c.go("venues", "einvoicing")),
          hasCoaching(p) && step("gp.manager.finance.coaches")
        ),
        p.commerce.hireDeposits ? para(p.compliance.deductionTaxReviewed ? "gp.manager.finance.deductionReviewed" : "gp.manager.finance.deductionNot") : null,
        note("gp.manager.finance.tax"),
      ].filter(nn);
    },
  },
  {
    id: "manager.testBookings",
    section: "manager",
    roles: MANAGER,
    applies: (p) => p.identity.draft || p.history.testBookings > 0,
    blocks: (c) => [heading("gp.manager.test.h", "manager-test"), ...topicBlocks("test-bookings", c.profile, "manager")],
  },
  {
    id: "manager.future",
    section: "manager",
    roles: MANAGER,
    applies: always,
    blocks: (c) => [
      heading("gp.manager.future.h", "manager-future"),
      para("gp.manager.future.safe"),
      steps(
        step("gp.manager.future.s1", undefined, c.go("guide", "guideSetup", "setup")),
        step("gp.manager.future.s2", undefined, c.go("guide", "guideSetup", "discover")),
        step("gp.manager.future.s3", undefined, c.go("venues", "addBranch"))
      ),
    ],
  },
];
