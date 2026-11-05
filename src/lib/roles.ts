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
  // Moving a class (POST /api/admin/classes/:id/move) is not listed: front desk may move a class at its own venue unless a manager turns that off for the
  // venue (the route asks `venues.desk_may_move_classes` and answers as this list does), and a move that is consequential or exceptional waits for a
  // manager's approval (lib/class-move-requests.ts, ADR 0045). Deciding a request, and the settings that decide what needs one, are a manager's.
  { path: /^\/api\/admin\/class-move-requests\/\d+$/, methods: ["POST"] },
  { path: /^\/api\/admin\/class-move-settings$/, methods: ["POST"] },
  { path: /^\/api\/admin\/go-live$/, methods: ["POST"] },
  { path: /^\/api\/admin\/(hold-policy|house-rules|venue-access|venue-tax|booking-alerts|peak-rules|booking-policies|venue-time-zone|cancel-policy|calendar-feed|court-links|sport-rules)$/, methods: ["POST"] },
  { path: /^\/api\/admin\/holidays$/, methods: ["POST", "DELETE"] },
  { path: /^\/api\/admin\/loyalty$/, methods: ["POST"] },
  { path: /^\/api\/admin\/concessions$/, methods: ["POST", "DELETE"] },
  { path: /^\/api\/admin\/waiver$/, methods: ["POST"] },
  // Opening an account gives credit; the desk charges bookings to it and takes its payments.
  { path: /^\/api\/admin\/accounts(\/bookers|\/invoices|\/credits)?$/, methods: ["POST", "DELETE"] },
  { path: /^\/api\/admin\/accounts\/invoices\/\d+$/, methods: ["DELETE"] },
  { path: /^\/api\/admin\/data-request$/, methods: "all" },
  { path: /^\/api\/admin\/coaches$/, methods: ["POST", "DELETE"] },
  // Who supervises sessions (lib/rosters.ts): the roles, rosters and qualifications, the rules that ask for somebody on shift, and a manager's
  // decision about a session left without one. The desk reads the roster and the list of such sessions, and may make a link to its own shifts.
  { path: /^\/api\/admin\/roster(\/uncovered)?$/, methods: ["POST"] },
  { path: /^\/api\/admin\/strikes$/, methods: ["POST"] },
  { path: /^\/api\/admin\/einvoicing$/, methods: "all" },
  // Live accounting (lib/accounting-push.ts): connecting the venue's Xero organisation, what is mapped to which account, and
  // what is sent are a manager's, as the export of the same sales is.
  { path: /^\/api\/admin\/accounting(\/xero\/callback)?$/, methods: "all" },
  { path: /^\/api\/admin\/reviews$/, methods: ["POST"] },
  { path: /^\/api\/admin\/marketing$/, methods: "all" },
  { path: /^\/api\/admin\/coach-payouts$/, methods: "all" },
  // Closing a register, correcting it afterwards, the attendance report and its spreadsheet, and how long a moved lesson's customer may cancel (lib/attendance.ts):
  // a manager's; the desk marks and walks people in (POST /api/admin/attendance).
  { path: /^\/api\/admin\/attendance\/(lock|report)$/, methods: "all" },
  { path: /^\/api\/admin\/lesson-settings$/, methods: ["POST"] },
  { path: /^\/api\/admin\/integrations$/, methods: "all" },
  { path: /^\/api\/admin\/(leagues|tournaments)$/, methods: ["POST"] },
  { path: /^\/api\/admin\/competitions(\/\d+)?$/, methods: ["POST", "DELETE"] },
  // Calling one off refunds every entry; drawing and seasons shape what people paid for.
  { path: /^\/api\/admin\/(leagues|tournaments)\/\d+$/, methods: ["POST"] },
  // Leagues of teams (lib/team-leagues.ts): setting one up, making its fixture list, stopping it, moving a fixture and taking a team out are
  // a manager's, as a tournament's draw and a league's seasons are; the desk enters results (POST on a fixture).
  { path: /^\/api\/admin\/team-leagues$/, methods: ["POST"] },
  { path: /^\/api\/admin\/team-leagues\/\d+$/, methods: ["POST"] },
  { path: /^\/api\/admin\/team-leagues\/\d+\/fixtures\/\d+$/, methods: ["PATCH"] },
  { path: /^\/api\/admin\/team-leagues\/\d+\/teams\/\d+$/, methods: ["DELETE"] },
  // A forfeit changes the table, the points and who goes where: giving one, and deciding a request for one, are a manager's (lib/team-forfeits.ts).
  // The desk may ask for one (POST .../forfeit-requests) and take its own request back (DELETE).
  { path: /^\/api\/admin\/team-leagues\/\d+\/fixtures\/\d+\/forfeit$/, methods: ["POST"] },
  { path: /^\/api\/admin\/team-leagues\/\d+\/forfeit-requests\/\d+$/, methods: ["POST"] },
  // A correction an official asked for in a performance event's finished round is reviewed by the organiser (lib/official-performances.ts).
  { path: /^\/api\/admin\/tournaments\/\d+\/correction-requests\/\d+$/, methods: ["POST"] },
  // Ladders (lib/ladders.ts): setting one up, its settings and seasons, deciding or correcting a result, moving or taking somebody off, a freeze: a manager's. The desk reads, and adds players at the counter (POST /players).
  { path: /^\/api\/admin\/ladders$/, methods: ["POST"] },
  { path: /^\/api\/admin\/ladders\/\d+$/, methods: ["POST"] },
  // A forfeit on a ladder of teams changes the ranks, so deciding a request for one is a manager's, as in a team league; the desk may ask for one (POST .../forfeit-requests) and take its own request back (DELETE).
  { path: /^\/api\/admin\/ladders\/\d+\/forfeit-requests\/\d+$/, methods: ["POST"] },
  // Ratings from results (lib/ratings.ts): which events count, leaving a result out, restarting a rating and seeding a draw from ratings shape what people are ranked by.
  { path: /^\/api\/admin\/ratings$/, methods: "all" },
  // Reports of messages between players, suspending somebody's messaging, muting or closing a thread (lib/message-moderation.ts): safety decisions, a manager's.
  { path: /^\/api\/admin\/message-moderation$/, methods: "all" },
  // Supervised youth groups that asked this venue to look after them: answering, ending, taking an adult out, and reading a group's conversation for safeguarding review (each reading recorded): a manager's (lib/youth-safeguarding.ts).
  { path: /^\/api\/admin\/youth-groups$/, methods: "all" },
  // What a correction left wrong in a tournament: letting it stand or replaying is the organiser's.
  { path: /^\/api\/admin\/tournaments\/\d+\/issues\/\d+$/, methods: ["POST"] },
  // Calling a fixture to its court, deciding what happens when nobody comes, the day's settings: the organiser's; the desk checks in and enters results.
  { path: /^\/api\/admin\/tournaments\/\d+\/day$/, methods: ["POST"] },
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
  // A resource's launch and tide windows and the tide table behind them narrow what customers may book (lib/launch-windows.ts, ADR 0037); the desk reads them.
  { path: /^\/api\/admin\/launch-windows$/, methods: ["POST", "DELETE"] },
  { path: /^\/api\/admin\/tides$/, methods: ["POST"] },
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
  // Which of the venue's policies its managers may override for one booking (lib/policy-overrides.ts; ADR 0026).
  { path: /^\/api\/admin\/policy-overrides$/, methods: ["POST"] },
  // Changing a class's or a tournament's places and price after it is set up, as setting it up is (lib/class-changes.ts, lib/tournaments.ts).
  { path: /^\/api\/admin\/(classes|tournaments)\/\d+$/, methods: ["PATCH"] },
  // The passes the counter sells, their prices and whether they are sold online are a manager's (lib/pass-products.ts); the desk sells from them.
  { path: /^\/api\/admin\/pass-products$/, methods: ["POST", "PATCH", "DELETE"] },
  // Changing a booking's price, or giving it free, with a reason (lib/price-adjustments.ts).
  { path: /^\/api\/admin\/bookings\/adjust-price$/, methods: ["POST"] },
  // Staff accounts and their invitations (lib/staff-accounts.ts): the owner, a business manager, or a branch manager for their own front desk.
  { path: /^\/api\/admin\/admins(\/\d+|\/invitations\/\d+)?$/, methods: "all" },
  // Opening hours and rates from a later date, as changing them now is (lib/dated-changes.ts, ADR 0027); the desk may read them.
  { path: /^\/api\/admin\/venues\/\d+\/hours-changes(\/\d+)?$/, methods: ["POST", "PATCH", "DELETE"] },
  { path: /^\/api\/admin\/courts\/\d+\/changes(\/\d+)?$/, methods: ["POST", "PATCH", "DELETE"] },
  // Clearing test bookings from before going live gives back what was paid; keeping one as real puts it in the books (lib/test-bookings.ts).
  { path: /^\/api\/admin\/test-bookings$/, methods: ["POST"] },
  // Adding a branch, and starting it from another's set-up (lib/branch-copy.ts): a business manager's.
  { path: /^\/api\/admin\/branches$/, methods: ["POST"] },
  // Ticking "details checked" on the set-up checklist, or hiding it: setting the venue up is a manager's (lib/setup.ts); the desk may read it.
  { path: /^\/api\/admin\/setup$/, methods: ["POST"] },
  // The setup journey (lib/guide): what it knows of the venue's configuration, the manager's answers and what they reviewed.
  // Its playbook route answers every role, each its own guide (docs/features/venue-guide.md#permissions).
  { path: /^\/api\/admin\/guide\/setup(\/journey)?$/, methods: "all" },
];

export type StaffRole = "manager" | "desk";

/** Whether `MANAGER_ONLY` turns front desk away from this request. */
export function managerOnly(method: string, path: string): boolean {
  return MANAGER_ONLY.some((r) => r.path.test(path) && (r.methods === "all" || r.methods.includes(method.toUpperCase())));
}

/** What front desk is told when turned away from something a manager does. */
export function deskTurnedAway(): NextResponse {
  return NextResponse.json({ error: "Front-desk accounts cannot change this. Ask a manager.", code: "MANAGER_ONLY" }, { status: 403 });
}

/** The answer a front-desk account gets for something a manager does. */
export function deskRefusal(role: StaffRole, method: string, path: string): NextResponse | null {
  if (role !== "desk") return null;
  return managerOnly(method, path) ? deskTurnedAway() : null;
}

/**
 * What the dashboard asks before it shows a control (audit R8 X1-5): each
 * action is a request one of its screens makes, and whether this member of
 * staff may make it is answered by `MANAGER_ONLY` above, never by a list of
 * the screens' own. `/api/admin/auth/me` sends the answers (`staffMay`); a
 * screen shows front desk what it may not change read-only, with a line
 * saying a manager changes it, and does not ask for what the desk may not
 * read (components/admin/StaffMay.tsx). `tests/roles.test.ts` holds each
 * one to a real route and method.
 */
export const STAFF_ACTIONS = {
  // Venue details
  venueDetails: "PATCH /api/admin/venues/1",
  datedHours: "POST /api/admin/venues/1/hours-changes",
  closures: "POST /api/admin/venues/1/closures",
  blockNumber: "POST /api/admin/venues/1/blocked-phones",
  photos: "POST /api/admin/venues/1/photos",
  notices: "POST /api/admin/notices",
  addons: "POST /api/admin/addons",
  whatsapp: "POST /api/admin/whatsapp",
  venueAccess: "POST /api/admin/venue-access",
  houseRules: "POST /api/admin/house-rules",
  policyOverrides: "POST /api/admin/policy-overrides",
  waiver: "POST /api/admin/waiver",
  cancelPolicy: "POST /api/admin/cancel-policy",
  bookingAlerts: "POST /api/admin/booking-alerts",
  calendarFeed: "POST /api/admin/calendar-feed",
  venueTax: "POST /api/admin/venue-tax",
  timeZone: "POST /api/admin/venue-time-zone",
  holdPolicy: "POST /api/admin/hold-policy",
  goLive: "POST /api/admin/go-live",
  testBookings: "POST /api/admin/test-bookings",
  addBranch: "POST /api/admin/branches",
  reviews: "POST /api/admin/reviews",
  dataRequest: "GET /api/admin/data-request",
  billing: "POST /api/admin/billing",
  staff: "GET /api/admin/admins",
  // Courts & rates
  courts: "POST /api/admin/courts",
  courtChange: "PATCH /api/admin/courts/1",
  datedCourtChanges: "POST /api/admin/courts/1/changes",
  activities: "POST /api/admin/activities",
  courtLinks: "POST /api/admin/court-links",
  bookingPolicies: "POST /api/admin/booking-policies",
  peakRules: "POST /api/admin/peak-rules",
  holidays: "POST /api/admin/holidays",
  loyalty: "POST /api/admin/loyalty",
  sportRules: "POST /api/admin/sport-rules",
  concessions: "POST /api/admin/concessions",
  outages: "POST /api/admin/outages",
  launchWindows: "POST /api/admin/launch-windows",
  tides: "POST /api/admin/tides",
  inductionDecide: "PATCH /api/admin/inductions/1",
  approvalSettings: "POST /api/admin/approvals/settings",
  approvalReviewers: "POST /api/admin/approvals/reviewers",
  supervised: "POST /api/admin/approvals/supervised",
  approvalHolds: "GET /api/admin/approvals/holds",
  // Classes
  classes: "POST /api/admin/classes",
  classChange: "PATCH /api/admin/classes/1",
  classCancel: "DELETE /api/admin/classes/1",
  // Moving a class is the desk's too, where the venue lets it (classMoveSettings) and with approval for what is consequential; deciding a request is a manager's.
  classMove: "POST /api/admin/classes/1/move",
  classMoveDecide: "POST /api/admin/class-move-requests/1",
  classMoveSettings: "POST /api/admin/class-move-settings",
  coaches: "POST /api/admin/coaches",
  // Registers: closing one, the report and the spreadsheet, and the days of the moved-lesson refund window and the register's open days. The desk marks.
  attendanceLock: "POST /api/admin/attendance/lock",
  attendanceReport: "GET /api/admin/attendance/report",
  lessonSettings: "POST /api/admin/lesson-settings",
  // The roster and the rules that ask for somebody on shift; deciding a session left without a supervisor.
  roster: "POST /api/admin/roster",
  rosterDecide: "POST /api/admin/roster/uncovered",
  // Credit & passes
  passVoid: "POST /api/admin/passes/1/void",
  passProducts: "POST /api/admin/pass-products",
  membershipVoid: "POST /api/admin/memberships/1/void",
  membershipExtend: "POST /api/admin/memberships/1/extend",
  membershipPlans: "POST /api/admin/membership-plans",
  membershipSuspend: "POST /api/admin/memberships/1/suspension",
  membershipCovers: "POST /api/admin/memberships/1/covers",
  promos: "POST /api/admin/promos",
  promoVoid: "POST /api/admin/promos/1/void",
  promoStacking: "POST /api/admin/promos/stacking",
  voucherVoid: "POST /api/admin/vouchers/1/void",
  counterSaleVoid: "POST /api/admin/counter-sales/1/void",
  accounts: "POST /api/admin/accounts",
  accountBookers: "POST /api/admin/accounts/bookers",
  accountInvoices: "POST /api/admin/accounts/invoices",
  accountCredits: "POST /api/admin/accounts/credits",
  invoiceWithdraw: "DELETE /api/admin/accounts/invoices/1",
  // The day list
  strikes: "POST /api/admin/strikes",
  // The set-up checklist (app/admin/page.tsx)
  setupChecklist: "POST /api/admin/setup",
  // Tournaments and competitions: setting up, the draw, rules, calling off, a correction's knock-on. The desk runs entries and results.
  tournaments: "POST /api/admin/tournaments",
  tournamentRun: "POST /api/admin/tournaments/1",
  tournamentChange: "PATCH /api/admin/tournaments/1",
  tournamentIssues: "POST /api/admin/tournaments/1/issues/1",
  tournamentDay: "POST /api/admin/tournaments/1/day",
  competitions: "POST /api/admin/competitions",
  competitionCancel: "DELETE /api/admin/competitions/1",
  // Leagues: setting up, seasons and stopping. The desk runs players, payments and results.
  leagues: "POST /api/admin/leagues",
  leagueRun: "POST /api/admin/leagues/1",
  // Leagues of teams: setting up, the fixture list and stopping, moving a fixture, taking a team out. The desk enters results.
  teamLeagues: "POST /api/admin/team-leagues",
  teamLeagueRun: "POST /api/admin/team-leagues/1",
  teamFixtureMove: "PATCH /api/admin/team-leagues/1/fixtures/1",
  teamLeagueRemove: "DELETE /api/admin/team-leagues/1/teams/1",
  // A forfeit and a decision on a request for one are a manager's; the desk may ask for one.
  teamFixtureForfeit: "POST /api/admin/team-leagues/1/fixtures/1/forfeit",
  teamForfeitDecide: "POST /api/admin/team-leagues/1/forfeit-requests/1",
  // Reviewing a correction an official asked for in a climbing event.
  correctionRequestDecide: "POST /api/admin/tournaments/1/correction-requests/1",
  // Ladders: setting up, settings, seasons, deciding a result, overrides. The desk reads and adds players at the counter.
  ladders: "POST /api/admin/ladders",
  ladderRun: "POST /api/admin/ladders/1",
  ladderForfeitDecide: "POST /api/admin/ladders/1/forfeit-requests/1",
  // Ratings from results: which events count, leaving a result out, restarting a rating, seeding a draw from ratings.
  ratings: "POST /api/admin/ratings",
  // Reports of messages between players and what is done about them.
  messageModeration: "POST /api/admin/message-moderation",
  youthGroups: "POST /api/admin/youth-groups",
  // The venue guide's setup journey and discoveries (lib/guide); the playbook is every role's own.
  guideSetup: "POST /api/admin/guide/setup",
  // Screens the guide links to that a manager alone uses, named so a link can be held to what its reader may open.
  einvoicing: "GET /api/admin/einvoicing",
  reports: "GET /api/admin/reports",
  exports: "GET /api/admin/export",
  marketing: "GET /api/admin/marketing",
  apiKeys: "GET /api/admin/integrations",
  paymentSettings: "GET /api/admin/venues/1/payment-settings",
  staffLog: "GET /api/admin/activity",
} as const satisfies Record<string, string>;

export type StaffActionName = keyof typeof STAFF_ACTIONS;

/** For each action the dashboard asks about, whether this role may do it: `MANAGER_ONLY`'s answer. */
export function staffMay(role: StaffRole): Record<StaffActionName, boolean> {
  const out = {} as Record<StaffActionName, boolean>;
  for (const [name, request] of Object.entries(STAFF_ACTIONS) as [StaffActionName, string][]) {
    const [method, path] = request.split(" ");
    out[name] = role !== "desk" || !managerOnly(method, path);
  }
  return out;
}
