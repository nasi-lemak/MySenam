import { NextResponse } from "next/server";

/**
 * What front-desk staff may not do.
 *
 * A venue's staff are a manager or front desk. The desk runs the day: takes
 * bookings, marks them paid (and how), checks people in, moves, changes and
 * cancels bookings, hands out kit, sells passes, memberships and credit, and
 * blocks a court for an hour. A manager also sets the venue up and handles
 * money going back out: courts and prices, the venue's details and rules, who
 * it is for, payment settings, refunds and voids, promo codes, notices,
 * photos, WhatsApp, the marketplace invoice, and the reports.
 *
 * Written once, here, as the addresses and methods a desk account is turned
 * away from in `requireAdmin` (lib/admin-auth.ts), so a route cannot forget
 * to ask; `tests/roles.test.ts` holds every line of it to a real route.
 */
export const MANAGER_ONLY: { path: RegExp; methods: string[] | "all" }[] = [
  { path: /^\/api\/admin\/addons(\/\d+)?$/, methods: ["POST", "PATCH", "DELETE"] },
  { path: /^\/api\/admin\/activities$/, methods: ["POST", "PATCH"] },
  // What a venue asks before approving somebody online; deciding applications is the desk's too, as sign-offs are.
  { path: /^\/api\/admin\/approvals\/settings$/, methods: ["POST", "DELETE"] },
  // Which coach account reviews, and staff-supervised attendance past a safety rule, are a manager's (ADR 0020).
  { path: /^\/api\/admin\/approvals\/(reviewers|supervised)$/, methods: ["POST"] },
  { path: /^\/api\/admin\/billing$/, methods: ["POST"] },
  { path: /^\/api\/admin\/courts(\/\d+)?$/, methods: ["POST", "PATCH", "DELETE"] },
  { path: /^\/api\/admin\/classes(\/\d+)?$/, methods: ["POST", "DELETE"] },
  { path: /^\/api\/admin\/go-live$/, methods: ["POST"] },
  { path: /^\/api\/admin\/(hold-policy|house-rules|venue-access|venue-tax|booking-alerts|peak-rules|booking-policies|venue-time-zone|cancel-policy|calendar-feed|court-links|sport-rules)$/, methods: ["POST"] },
  { path: /^\/api\/admin\/holidays$/, methods: ["POST", "DELETE"] },
  { path: /^\/api\/admin\/loyalty$/, methods: ["POST"] },
  { path: /^\/api\/admin\/concessions$/, methods: ["POST", "DELETE"] },
  { path: /^\/api\/admin\/waiver$/, methods: ["POST"] },
  // Opening an account gives credit; the desk charges bookings to it and takes its payments.
  { path: /^\/api\/admin\/accounts(\/bookers|\/invoices)?$/, methods: ["POST", "DELETE"] },
  { path: /^\/api\/admin\/accounts\/invoices\/\d+$/, methods: ["DELETE"] },
  { path: /^\/api\/admin\/data-request$/, methods: "all" },
  { path: /^\/api\/admin\/coaches$/, methods: ["POST", "DELETE"] },
  { path: /^\/api\/admin\/strikes$/, methods: ["POST"] },
  { path: /^\/api\/admin\/einvoicing$/, methods: "all" },
  { path: /^\/api\/admin\/reviews$/, methods: ["POST"] },
  { path: /^\/api\/admin\/marketing$/, methods: "all" },
  { path: /^\/api\/admin\/coach-payouts$/, methods: "all" },
  { path: /^\/api\/admin\/integrations$/, methods: "all" },
  { path: /^\/api\/admin\/(leagues|tournaments)$/, methods: ["POST"] },
  { path: /^\/api\/admin\/competitions(\/\d+)?$/, methods: ["POST", "DELETE"] },
  // Calling one off refunds every entry; drawing and seasons shape what people paid for.
  { path: /^\/api\/admin\/(leagues|tournaments)\/\d+$/, methods: ["POST"] },
  // What a correction left wrong in a tournament: letting it stand or replaying is the organiser's.
  { path: /^\/api\/admin\/tournaments\/\d+\/issues\/\d+$/, methods: ["POST"] },
  { path: /^\/api\/admin\/(memberships|passes|promos|vouchers|counter-sales)\/\d+\/void$/, methods: ["POST"] },
  { path: /^\/api\/admin\/memberships\/\d+\/extend$/, methods: ["POST"] },
  // Correcting a person entered wrongly on a membership, with a reason (lib/membership-purchases.ts correctCover).
  { path: /^\/api\/admin\/memberships\/\d+\/covers$/, methods: ["POST"] },
  // Suspending a membership and reactivating it take away and give back what was paid for, as voiding and giving
  // days back do (lib/membership-suspensions.ts). The desk reads the history; it does not suspend.
  { path: /^\/api\/admin\/memberships\/\d+\/(suspension|reactivate)$/, methods: ["POST"] },
  { path: /^\/api\/admin\/promos$/, methods: ["POST"] },
  // Whether a concession price and a promo code go together here (lib/discounts.ts).
  { path: /^\/api\/admin\/promos\/stacking$/, methods: ["POST"] },
  { path: /^\/api\/admin\/membership-plans$/, methods: ["POST", "PATCH", "DELETE"] },
  { path: /^\/api\/admin\/notices(\/\d+)?$/, methods: ["POST", "DELETE"] },
  { path: /^\/api\/admin\/online-payments$/, methods: ["POST"] },
  { path: /^\/api\/admin\/outages$/, methods: ["POST", "DELETE"] },
  { path: /^\/api\/admin\/reports(\/customers)?$/, methods: "all" },
  { path: /^\/api\/admin\/activity$/, methods: "all" },
  { path: /^\/api\/admin\/export$/, methods: "all" },
  { path: /^\/api\/admin\/venues\/\d+$/, methods: ["PATCH"] },
  { path: /^\/api\/admin\/venues\/\d+\/(closures|blocked-phones)$/, methods: ["POST", "DELETE"] },
  { path: /^\/api\/admin\/venues\/\d+\/payment-settings$/, methods: "all" },
  { path: /^\/api\/admin\/venues\/\d+\/photos(\/\d+)?$/, methods: ["POST", "PATCH", "DELETE"] },
  { path: /^\/api\/admin\/whatsapp$/, methods: ["POST"] },
  { path: /^\/api\/admin\/storefronts$/, methods: ["POST", "DELETE"] },
  // Keeping an application past its retention period: a manager's, or the platform owner's, never the desk's.
  { path: /^\/api\/admin\/approvals\/holds$/, methods: "all" },
  // Revoking, pausing or keeping a participant's guardian, the exception to a guardian's agreement, linking their own login,
  // and deciding whose an older induction is: a manager's, with a reason (ADR 0023).
  { path: /^\/api\/admin\/participants\/\d+$/, methods: ["PATCH"] },
  { path: /^\/api\/admin\/inductions\/\d+$/, methods: ["PATCH"] },
  // Asking now whether bookings and court time agree at their venues: a manager's (lib/integrity.ts).
  { path: /^\/api\/admin\/integrity$/, methods: "all" },
];

export type StaffRole = "manager" | "desk";

/** The answer a front-desk account gets for something a manager does. */
export function deskRefusal(role: StaffRole, method: string, path: string): NextResponse | null {
  if (role !== "desk") return null;
  const hit = MANAGER_ONLY.some((r) => r.path.test(path) && (r.methods === "all" || r.methods.includes(method.toUpperCase())));
  return hit
    ? NextResponse.json({ error: "Front-desk accounts cannot change this. Ask a manager.", code: "MANAGER_ONLY" }, { status: 403 })
    : null;
}
