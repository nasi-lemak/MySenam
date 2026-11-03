import type { ResourceModel } from "../activity-catalogue";
import type { Phrase } from "../i18n";
import type { StaffActionName } from "../roles";
import type { ConfigureTarget } from "./shell";

/**
 * The capability registry: the one list of what the guide may say MySenam
 * can do, and what it must say it cannot (docs/features/venue-guide.md,
 * ADR 0028).
 *
 * Every public page, setup step, discovery and playbook module that says
 * "MySenam can …" names a capability from here, and every capability is
 * traced to the repository's own account of itself:
 *
 * - an `available` capability names the row of
 *   [feature status](docs/product/feature-status.md) it rests on
 *   (`featureRow`, the row's exact name), and that row must be
 *   IMPLEMENTED_AND_TESTED, or INTEGRATION_VERIFICATION_REQUIRED with its
 *   integration listed here. `tests/guide-capabilities.test.ts` parses the
 *   matrix and fails otherwise, so a capability cannot outlive its row;
 * - an `unsupported` capability says what it is and what to do instead, and
 *   rests on a row feature status gives as not built, an anchor in
 *   [known limitations](docs/roadmap/known-limitations.md), or the
 *   `supportNote` of an activity in the catalogue.
 *
 * Browser-safe: data only, no database. Add a capability by adding a row to
 * `AVAILABLE` or `UNSUPPORTED` below and its phrases to the customer
 * dictionaries (`gcap.<id>.title`, `.blurb`, and `.alt` for an unsupported one);
 * the test says what is missing.
 */

export const CAPABILITY_GROUPS = [
  "booking",
  "pricing",
  "memberships",
  "programmes",
  "access",
  "people",
  "money",
  "communication",
  "compliance",
  "multi-branch",
  "reporting",
  "integrations",
  "platform",
] as const;
export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number];

/** What using it takes beyond the software: setting it up, an outside service, somebody's approval. */
export const REQUIREMENTS = ["configuration", "integration", "approval"] as const;
export type Requirement = (typeof REQUIREMENTS)[number];

/** The outside services a capability may depend on (docs/integrations); each is verified against the real service or it is not. */
export const INTEGRATIONS = ["billplz", "stripe", "email", "whatsapp", "myinvois"] as const;
export type Integration = (typeof INTEGRATIONS)[number];

export interface Capability {
  /** Permanent: public pages, steps and playbook modules refer to it. Lower-case words and hyphens. */
  id: string;
  group: CapabilityGroup;
  /** `available`: supported by the code and its feature-status row. `unsupported`: not built; says what to do instead. */
  status: "available" | "unsupported";
  /** Customer-dictionary phrases (`gcap.<id>.title` / `.blurb`); staff screens read them through `t.customer`. */
  titleKey: Phrase;
  blurbKey: Phrase;
  /** For an unsupported one: what to do instead (`gcap.<id>.alt`). */
  alternativeKey?: Phrase;
  requires: Requirement[];
  /** The services it depends on; non-empty exactly when `requires` has "integration". */
  integrations?: Integration[];
  /** The exact name of the row in docs/product/feature-status.md it rests on; null where no row says it. */
  featureRow: string | null;
  /** An anchor in docs/roadmap/known-limitations.md that is its accurate caveat or, for an unsupported one, its source. */
  limitation?: string;
  /**
   * For an unsupported way of selling: the catalogue activity whose `supportNote` names it. For an available one: the
   * catalogue activity sold that way by default, so choosing the activity lists it.
   */
  activityNote?: string;
  /** Where the existing screen is. */
  configure?: ConfigureTarget;
  /**
   * Who may use that screen: a `STAFF_ACTIONS` name (lib/roles.ts), so a link is
   * shown only to a role `staffMay` lets use it; or null, a screen the front
   * desk uses too. Every capability with a `configure` states it.
   */
  staffAction?: StaffActionName | null;
  /** The resource models it concerns (lib/activity-catalogue.ts). */
  models?: ResourceModel[];
}

const ALL_MODELS: ResourceModel[] = ["exclusive", "lanes", "shared", "class", "hire"];

type Spec = Omit<Capability, "id" | "group" | "status" | "titleKey" | "blurbKey" | "alternativeKey" | "requires"> & { requires?: Requirement[] };

function available(id: string, group: CapabilityGroup, spec: Spec & { featureRow: string }): Capability {
  return {
    id,
    group,
    status: "available",
    titleKey: `gcap.${id}.title` as Phrase,
    blurbKey: `gcap.${id}.blurb` as Phrase,
    requires: ["configuration"],
    ...spec,
  };
}

function unsupported(id: string, group: CapabilityGroup, spec: Spec = { featureRow: null }): Capability {
  return {
    id,
    group,
    status: "unsupported",
    titleKey: `gcap.${id}.title` as Phrase,
    blurbKey: `gcap.${id}.blurb` as Phrase,
    alternativeKey: `gcap.${id}.alt` as Phrase,
    requires: [],
    ...spec,
  };
}

const courts = (view?: string): ConfigureTarget => ({ tab: "courts", ...(view ? { view } : {}) });
const venues: ConfigureTarget = { tab: "venues" };
const credit: ConfigureTarget = { tab: "credit" };
const bookings: ConfigureTarget = { tab: "bookings" };

const AVAILABLE: Capability[] = [
  // ------------------------------------------------------------ booking
  available("resources", "booking", { featureRow: "Resource templates and batches", configure: courts(), staffAction: "courts", models: ALL_MODELS }),
  available("activity-catalogue", "booking", { featureRow: "Activity catalogue", configure: courts(), staffAction: "activities", models: ALL_MODELS }),
  available("own-activities", "booking", { featureRow: "Operators' own activities", configure: courts(), staffAction: "activities" }),
  available("shared-facilities", "booking", { featureRow: "Shared facilities (capacity > 1)", configure: courts(), staffAction: "courtChange", models: ["shared", "lanes", "hire"] }),
  available("linked-courts", "booking", { featureRow: "Courts that share a floor", configure: courts(), staffAction: "courtLinks", models: ["exclusive"] }),
  available("buffers", "booking", { featureRow: "Buffers", configure: courts(), staffAction: "bookingPolicies" }),
  available("booking-rules", "booking", { featureRow: "Booking rules (policies)", configure: courts(), staffAction: "bookingPolicies" }),
  available("opening-hours", "booking", { featureRow: "Opening hours, weekday hours, closures", configure: venues, staffAction: "venueDetails" }),
  available("hours-from-date", "booking", { featureRow: "Opening hours from a later date", configure: venues, staffAction: "datedHours" }),
  available("manager-overrides", "booking", { featureRow: "Manager overrides of venue policies", configure: venues, staffAction: "policyOverrides" }),
  available("outages", "booking", { featureRow: "Courts out of service", configure: courts(), staffAction: "outages" }),
  available("who-venue-is-for", "booking", { featureRow: "Who a venue is for, residents' guests", configure: venues, staffAction: "venueAccess" }),
  available("test-bookings", "booking", { featureRow: "Test bookings before going live", configure: bookings, staffAction: "testBookings" }),
  available("day-list", "booking", { featureRow: "The day list and starting a booking", configure: bookings, staffAction: null, requires: [] }),
  // ------------------------------------------------------------ pricing
  available("peak-pricing", "pricing", { featureRow: "Peak bands and holidays", configure: courts(), staffAction: "peakRules" }),
  available("rates-from-date", "pricing", { featureRow: "Court rates from a later date", configure: courts(), staffAction: "datedCourtChanges" }),
  available("last-minute-prices", "pricing", { featureRow: "Last-minute prices", configure: courts(), staffAction: "peakRules" }),
  available("member-rates", "pricing", { featureRow: "Member rates", configure: courts(), staffAction: "courtChange" }),
  available("per-player-pricing", "pricing", { featureRow: "Per-player pricing", configure: courts(), staffAction: "courtChange" }),
  available("concessions", "pricing", { featureRow: "Concession prices", configure: courts(), staffAction: "concessions" }),
  available("promo-codes", "pricing", { featureRow: "Promo codes", configure: credit, staffAction: "promos" }),
  available("discount-stacking", "pricing", { featureRow: "Discounts together, by the venue's rule", configure: credit, staffAction: "promoStacking" }),
  available("regular-free-hour", "pricing", { featureRow: "A free hour for regulars", configure: courts(), staffAction: "loyalty" }),
  // Entry with no set time (lib/entries.ts): a gym floor or a climbing wall letting people in as they come, on a
  // membership whose plan admits, a pass, a day pass or a walk-in at the desk. Off until the venue turns it on.
  available("gym-walk-in", "access", { featureRow: "Entry with no set time", activityNote: "gym", configure: courts(), staffAction: "bookingPolicies", models: ["shared"] }),
  available("open-day-pass", "booking", { featureRow: "Day passes", activityNote: "climbing", configure: credit, staffAction: "passProducts", models: ["shared"] }),
  available("bowling-by-game", "pricing", { featureRow: "Selling by the game, a lane given on arrival", activityNote: "bowling", configure: courts(), staffAction: "bookingPolicies", models: ["lanes"] }),
  // ------------------------------------------------------------ memberships, passes and credit
  available("memberships", "memberships", { featureRow: "Membership plans and tiers online", configure: credit, staffAction: "membershipPlans" }),
  available("passes", "memberships", { featureRow: "Multi-visit passes and lesson packs", configure: credit, staffAction: "passProducts" }),
  available("passes-online", "memberships", {
    featureRow: "Multi-visit passes sold online",
    requires: ["configuration", "integration"],
    integrations: ["billplz", "stripe"],
    configure: credit,
    staffAction: "passProducts",
  }),
  available("family-memberships", "memberships", { featureRow: "Family membership dependants by plan policy", configure: credit, staffAction: "membershipPlans" }),
  available("membership-suspension", "memberships", { featureRow: "Membership suspension and reactivation", configure: credit, staffAction: "membershipSuspend" }),
  available("stored-credit", "memberships", { featureRow: "Stored credit and its scope", configure: credit, staffAction: null }),
  available("gift-vouchers", "memberships", { featureRow: "Gift vouchers", configure: credit, staffAction: null }),
  available("company-accounts", "memberships", { featureRow: "Company and school accounts", configure: credit, staffAction: "accounts" }),
  // ------------------------------------------------------------ programmes
  available("classes", "programmes", { featureRow: "Classes and terms", configure: { tab: "classes" }, staffAction: "classes", models: ["class"] }),
  available("coaching", "programmes", { featureRow: "One-to-one coaching", configure: { tab: "classes" }, staffAction: "coaches" }),
  available("tournaments", "programmes", { featureRow: "Tournaments: setup and court time", configure: { tab: "tournaments" }, staffAction: "tournaments" }),
  // The next match announced, a court called when it is free, a live page (lib/tournament-day.ts).
  available("tournament-day", "programmes", { featureRow: "Tournament day: the next match announced, a court called when it is free", configure: { tab: "tournaments" }, staffAction: "tournamentDay" }),
  available("leagues", "programmes", { featureRow: "Box leagues: setup and seasons", configure: { tab: "leagues" }, staffAction: "leagues" }),
  available("team-leagues", "programmes", { featureRow: "Leagues of teams and fixture lists", configure: { tab: "leagues" }, staffAction: "teamLeagues" }),
  available("teams", "programmes", { featureRow: "Teams that persist across events", requires: [] }),
  available("ratings", "programmes", { featureRow: "Ratings from results and rankings across events", configure: { tab: "leagues" }, staffAction: "ratings" }),
  available("earned-levels", "programmes", { featureRow: "Matchmaking on earned levels", requires: [] }),
  available("open-games", "programmes", { featureRow: "Open games: hosting", requires: [] }),
  available("matchmaking", "programmes", { featureRow: "Suggested games (matchmaking)", requires: [] }),
  available("equipment-hire", "programmes", { featureRow: "Equipment hire and deposits", configure: courts(), staffAction: "courts", models: ["hire"] }),
  available("counter-sales", "programmes", { featureRow: "Counter sales", configure: credit, staffAction: null, requires: [] }),
  // ------------------------------------------------------------ access
  available("check-in", "access", { featureRow: "Check-in, no-shows, live crowd", configure: bookings, staffAction: null, requires: [] }),
  available("unstaffed-access", "access", { featureRow: "Unstaffed hours and door codes", configure: venues, staffAction: "venueDetails" }),
  available("waivers", "access", { featureRow: "Waivers", configure: venues, staffAction: "waiver" }),
  available("sign-offs", "access", { featureRow: "Activity sign-offs and certifications", configure: courts(), staffAction: "bookingPolicies" }),
  available("activity-approvals", "access", { featureRow: "Online applications for activity approval", configure: courts(), staffAction: "approvalSettings" }),
  // ------------------------------------------------------------ people
  available("guardians", "people", { featureRow: "Applying, booking and agreeing for a child from an adult's account", requires: [] }),
  available("staff-roles", "people", { featureRow: "Manager and front-desk roles", configure: venues, staffAction: "staff" }),
  available("staff-invitations", "people", { featureRow: "Staff invited to set their own password", configure: venues, staffAction: "staff" }),
  available("staff-log", "people", { featureRow: "Staff activity log", configure: { tab: "reports" }, staffAction: "staffLog", requires: [] }),
  // ------------------------------------------------------------ money
  available("counter-payments", "money", { featureRow: "Counter payments and the day's takings", configure: bookings, staffAction: null, requires: [] }),
  available("cash-up", "money", { featureRow: "Cash-up", configure: bookings, staffAction: null, requires: [] }),
  available("pay-online-billplz", "money", {
    featureRow: "Billplz bill creation",
    requires: ["configuration", "integration"],
    integrations: ["billplz"],
    configure: venues,
    staffAction: "paymentSettings",
  }),
  available("pay-online-stripe", "money", {
    featureRow: "Stripe Checkout",
    requires: ["configuration", "integration"],
    integrations: ["stripe"],
    configure: venues,
    staffAction: "paymentSettings",
  }),
  available("pay-to-hold", "money", {
    featureRow: "Paying online to hold, and deposit shares",
    requires: ["configuration", "integration"],
    integrations: ["billplz", "stripe"],
    configure: venues,
    staffAction: "holdPolicy",
  }),
  available("refunds", "money", { featureRow: "Refund when a customer cancels", configure: venues, staffAction: "cancelPolicy" }),
  available("venue-cancellations", "money", { featureRow: "Refunds when the venue cancels", configure: bookings, staffAction: null, requires: [] }),
  available("receipts-tax", "money", { featureRow: "Receipts, credit notes, venue tax", configure: venues, staffAction: "venueTax" }),
  // ------------------------------------------------------------ communication
  available("email-messages", "communication", { featureRow: "Email (SMTP, Amazon SES)", requires: ["configuration", "integration"], integrations: ["email"] }),
  available("whatsapp-messages", "communication", {
    featureRow: "WhatsApp template messages",
    requires: ["configuration", "integration", "approval"],
    integrations: ["whatsapp"],
    configure: venues,
    staffAction: "whatsapp",
  }),
  available("booking-alerts", "communication", {
    featureRow: "New-booking alerts to the venue",
    requires: ["configuration", "integration"],
    integrations: ["email", "whatsapp"],
    configure: venues,
    staffAction: "bookingAlerts",
  }),
  // ------------------------------------------------------------ compliance
  available("e-invoicing", "compliance", {
    featureRow: "MyInvois connection",
    requires: ["configuration", "integration"],
    integrations: ["myinvois"],
    configure: venues,
    staffAction: "einvoicing",
  }),
  // ------------------------------------------------------------ branches
  available("branches", "multi-branch", { featureRow: "Businesses and branches", configure: venues, staffAction: "addBranch" }),
  available("branch-copy", "multi-branch", { featureRow: "Starting a branch from another's set-up", configure: venues, staffAction: "addBranch" }),
  available("go-live", "multi-branch", { featureRow: "Drafts and going live", requires: ["configuration", "approval"], configure: venues, staffAction: "goLive" }),
  // ------------------------------------------------------------ reports and integrations
  available("reports", "reporting", { featureRow: "Period reports and occupancy", configure: { tab: "reports" }, staffAction: "reports", requires: [] }),
  available("exports", "reporting", { featureRow: "Exports and sales journal", configure: { tab: "reports" }, staffAction: "exports", requires: [] }),
  available("public-api", "integrations", { featureRow: "Public API and keys", configure: venues, staffAction: "apiKeys" }),
  // ------------------------------------------------------------ platform
  available("languages", "platform", { featureRow: "English, Malay, Chinese; translated refusals", requires: [] }),
];

const UNSUPPORTED: Capability[] = [
  unsupported("range-officer", "people", { featureRow: null, activityNote: "archery", models: ["lanes"] }),
  unsupported("venue-whatsapp-number", "communication", { featureRow: "WhatsApp template messages" }),
  unsupported("web-push", "communication", { featureRow: null, limitation: "integrations-awaiting-live-verification-or-a-partner" }),
  unsupported("native-app", "platform", { featureRow: "Installing as an app" }),
  unsupported("surge-pricing", "pricing", { featureRow: null, limitation: "deliberately-unsupported" }),
  unsupported("referral-credit", "memberships", { featureRow: null, limitation: "deliberately-unsupported" }),
  unsupported("billplz-refunds", "money", { featureRow: "Billplz refunds and subscriptions" }),
  unsupported("google-booking", "integrations", { featureRow: "Reserve with Google booking server" }),
  unsupported("smart-locks", "access", { featureRow: "Smart-lock credentials" }),
  unsupported("door-credentials", "access", { featureRow: null, limitation: "deliberately-unsupported" }),
];

/** Every capability, available first, in the order the guide lists them. */
export const CAPABILITIES: readonly Capability[] = [...AVAILABLE, ...UNSUPPORTED];

const BY_ID = new Map(CAPABILITIES.map((c) => [c.id, c]));

/** One capability by id; undefined for a name the registry does not have. */
export function capability(id: string): Capability | undefined {
  return BY_ID.get(id);
}

/** Like `capability`, for an id the code itself wrote: a typo throws instead of vanishing from a page. */
export function requireCapability(id: string): Capability {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`Unknown guide capability: ${id}`);
  return c;
}

export const availableCapabilities = (): Capability[] => CAPABILITIES.filter((c) => c.status === "available");
export const unsupportedCapabilities = (): Capability[] => CAPABILITIES.filter((c) => c.status === "unsupported");

/** Capabilities in a group, in registry order. */
export const capabilitiesIn = (group: CapabilityGroup): Capability[] => CAPABILITIES.filter((c) => c.group === group);

/**
 * How the guide labels what a capability needs, in the five words it uses
 * everywhere: available now; available with configuration; requires an
 * external integration; requires the operator's approval; not currently
 * supported. A capability needing both an integration and approval reads as
 * the stronger first.
 */
export type Availability = "now" | "configuration" | "integration" | "approval" | "unsupported";

export function availabilityOf(c: Pick<Capability, "status" | "requires">): Availability {
  if (c.status === "unsupported") return "unsupported";
  if (c.requires.includes("integration")) return "integration";
  if (c.requires.includes("approval")) return "approval";
  if (c.requires.includes("configuration")) return "configuration";
  return "now";
}
