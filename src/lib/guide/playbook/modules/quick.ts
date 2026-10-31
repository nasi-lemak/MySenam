import { screen, heading, note, step, steps, w } from "../dsl";
import type { GuideRole, PlaybookModule } from "../types";

const BOTH: GuideRole[] = ["manager", "desk"];
const MANAGER: GuideRole[] = ["manager"];
const always = () => true;

/**
 * Quick-reference cards: a task, a few steps, the screen's link where the role
 * may use it. A card says no more than the section it summarises
 * (booking, cancel, day modules); it is in the guide so a person in a hurry
 * does not have to read it.
 */
export const QUICK_MODULES: PlaybookModule[] = [
  {
    id: "quick.createBooking",
    section: "quick",
    roles: BOTH,
    applies: always,
    blocks: (c) => [
      heading("gp.quick.create.h", "card-create"),
      steps(
        step("gp.quick.create.s1", { screen: screen("bookings"), newBooking: w("p8a.day.newBooking") }, c.go("bookings")),
        step("gp.quick.create.s2"),
        step("gp.quick.create.s3"),
        step("gp.quick.create.s4"),
        step("gp.quick.create.s5")
      ),
    ],
  },
  {
    id: "quick.cancellation",
    section: "quick",
    roles: BOTH,
    applies: always,
    blocks: (c) => [
      heading("gp.quick.cancel.h", "card-cancel"),
      steps(
        step("gp.quick.cancel.s1", { screen: screen("bookings") }, c.go("bookings")),
        step("gp.quick.cancel.s2", { actions: w("p8a.day.actions") }),
        step("gp.quick.cancel.s3"),
        step("gp.quick.cancel.s4"),
        step("gp.quick.cancel.s5")
      ),
    ],
  },
  {
    id: "quick.collectPayment",
    section: "quick",
    roles: BOTH,
    applies: always,
    blocks: (c) => [
      heading("gp.quick.pay.h", "card-pay"),
      steps(
        step("gp.quick.pay.s1", { screen: screen("bookings") }, c.go("bookings")),
        step("gp.quick.pay.s2"),
        step("gp.quick.pay.s3"),
        step("gp.quick.pay.s4", { screen: screen("credit") }, c.go("credit"))
      ),
    ],
  },
  {
    id: "quick.unpaid",
    section: "quick",
    roles: BOTH,
    applies: always,
    blocks: (c) => [
      heading("gp.quick.unpaid.h", "card-unpaid"),
      steps(
        step("gp.quick.unpaid.s1", { screen: screen("bookings") }, c.go("bookings")),
        step("gp.quick.unpaid.s2"),
        c.profile.payments.online.accountEnabled && step("gp.quick.unpaid.online"),
        step("gp.quick.unpaid.s3"),
        c.profile.policies.payToHold && step("gp.quick.unpaid.hold")
      ),
    ],
  },
  {
    id: "quick.checkIn",
    section: "quick",
    roles: BOTH,
    applies: always,
    blocks: (c) => [
      heading("gp.quick.checkin.h", "card-checkin"),
      steps(
        step("gp.quick.checkin.s1", { screen: screen("bookings") }, c.go("bookings")),
        step("gp.quick.checkin.s2", { attendance: w("bk.col.attendance") }),
        (c.profile.commerce.membershipPlans > 0 || c.profile.identity.visibility === "members") && step("gp.quick.checkin.s3"),
        step("gp.quick.checkin.s4")
      ),
    ],
  },
  {
    id: "quick.outage",
    section: "quick",
    roles: BOTH,
    applies: (p) => p.resources.total > 0,
    blocks: (c) => [
      heading("gp.quick.outage.h", "card-outage"),
      steps(
        step("gp.quick.outage.s1", { screen: screen("schedule") }, c.go("schedule")),
        step("gp.quick.outage.s2", { rain: w("rain.open") }),
        c.role === "manager" ? step("gp.quick.outage.s3", { out: w("out.title"), screen: screen("courts") }, c.go("courts", "outages")) : step("gp.quick.outage.deskDays"),
        step("gp.quick.outage.s4")
      ),
    ],
  },
  {
    id: "quick.inviteStaff",
    section: "quick",
    roles: MANAGER,
    applies: always,
    blocks: (c) => [
      heading("gp.quick.invite.h", "card-invite"),
      steps(
        step("gp.quick.invite.s1", { screen: screen("venues"), staff: w("vn.staffAccounts") }, c.go("venues", "staff")),
        step("gp.quick.invite.s2"),
        step("gp.quick.invite.s3"),
        step("gp.quick.invite.s4")
      ),
    ],
  },
  {
    id: "quick.approval",
    section: "quick",
    roles: BOTH,
    applies: (p) => p.guardians.approvalRequirements > 0 || p.policies.signOffRequired,
    blocks: (c) => [
      heading("gp.quick.approval.h", "card-approval"),
      steps(
        step("gp.quick.approval.s1", { screen: screen("bookings") }, c.go("bookings")),
        step("gp.quick.approval.s2"),
        c.role === "manager" ? step("gp.quick.approval.managerS3") : step("gp.quick.approval.deskS3"),
        step("gp.quick.approval.s4")
      ),
      note("gp.quick.approval.declared"),
    ],
  },
];
