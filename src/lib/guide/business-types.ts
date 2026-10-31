import { BUILTIN_ACTIVITIES, type ActivityCategory, type ResourceModel, type SupportLevel } from "../activity-catalogue";
import type { Phrase } from "../i18n";
import { emptyProfile, type VenueProfile } from "./profile-types";

/**
 * The kinds of business the public guide and the setup journey share
 * (docs/features/venue-guide.md#business-types).
 *
 * A business type is a *starting point*, never a configuration engine: which
 * activities it usually offers (catalogue keys), which resource models those
 * use, an *illustrative* profile of the same `VenueProfile` shape (what a
 * typical venue of the kind looks like, labelled `illustrative: true`), the
 * capabilities typical for it (ids in `capabilities.ts`) and the ids of its
 * everyday workflows. The workflows' own content is written where they are
 * shown (the public guide); what is shared is the id.
 *
 * An activity's support level and `supportNote` are never copied here: they
 * are read from the catalogue, by `activityFacts`, every time.
 *
 * Browser-safe: data only.
 */

export const BUSINESS_TYPE_IDS = [
  "badminton-and-pickleball",
  "futsal-and-football",
  "tennis-and-padel",
  "multi-sport",
  "gym-and-fitness",
  "swimming",
  "climbing-and-bouldering",
  "coaching-academy",
  "equipment-rental",
  "archery-and-supervised",
  "club-and-community",
  "school-and-corporate",
  "mixed",
] as const;
export type BusinessTypeId = (typeof BUSINESS_TYPE_IDS)[number];

export const isBusinessTypeId = (v: unknown): v is BusinessTypeId => typeof v === "string" && (BUSINESS_TYPE_IDS as readonly string[]).includes(v);

/**
 * The everyday workflows a business type can have, by id. Each is a real
 * journey through the application (a customer books a court; a parent
 * registers a child for a programme); where its steps and screens are
 * written is the public guide's and the playbook's, which refer to these ids.
 * Add one by adding it here and to the business types that have it.
 */
export const WORKFLOW_IDS = [
  "court-booking",
  "counter-booking",
  "online-payment-booking",
  "membership-benefits",
  "pass-redemption",
  "class-enrolment",
  "lesson-booking",
  "guardian-child-booking",
  "tournament-entry",
  "league-season",
  "open-game",
  "equipment-hire",
  "unstaffed-entry",
  "timed-session",
  "first-visit-sign-off",
  "company-account-booking",
  "cancellation-and-refund",
  "branch-oversight",
] as const;
export type WorkflowId = (typeof WORKFLOW_IDS)[number];

const CATALOGUE = new Map(BUILTIN_ACTIVITIES.map((a) => [a.key, a]));

export interface BusinessType {
  id: BusinessTypeId;
  /** Customer-dictionary phrase `gbt.<id>`: its name, in all four languages. */
  titleKey: Phrase;
  /** Catalogue activity keys it usually offers. */
  activities: string[];
  /** The resource models those activities use. */
  models: ResourceModel[];
  /** What a typical venue of the kind looks like. Illustrative: never read from a venue. */
  profile: VenueProfile;
  /** Capability ids (capabilities.ts) typical for it, available and unsupported alike: what to show, and what to warn about. */
  capabilities: string[];
  workflows: WorkflowId[];
}

/** An illustrative profile: the empty one with these facts, a venue already live and open. */
function illustrate(over: (p: VenueProfile) => void): VenueProfile {
  const p = emptyProfile(0);
  p.illustrative = true;
  p.identity.draft = false;
  p.identity.live = true;
  p.identity.hasPin = true;
  p.setup = { ...p.setup, detailsChecked: true };
  over(p);
  p.resources.priced = p.resources.total;
  return p;
}

function activityRows(keys: string[]): VenueProfile["activities"] {
  return keys.map((key) => ({ key, support: activityFacts(key)?.support ?? null, own: false }));
}

function models(keys: string[]): ResourceModel[] {
  const used = new Set(keys.map((k) => activityFacts(k)?.model).filter((m): m is ResourceModel => m !== undefined));
  return (["exclusive", "lanes", "shared", "class", "hire"] as ResourceModel[]).filter((m) => used.has(m));
}

function spread(p: VenueProfile, keys: string[], total: number) {
  p.activities = activityRows(keys);
  const used = models(keys);
  p.resources.total = total;
  // The resources divided evenly among the models the activities use.
  used.forEach((m, i) => (p.resources.byModel[m] = Math.floor(total / used.length) + (i < total % used.length ? 1 : 0)));
}

function type(id: BusinessTypeId, activities: string[], capabilities: string[], workflows: WorkflowId[], over: (p: VenueProfile) => void): BusinessType {
  return {
    id,
    titleKey: `gbt.${id}` as Phrase,
    activities,
    models: models(activities),
    profile: illustrate((p) => {
      over(p);
      spread(p, activities, p.resources.total);
    }),
    capabilities,
    workflows,
  };
}

/** The common ground of a racket or court venue: rates, a counter, cancellation terms, online booking. */
const COURT_BASICS = ["resources", "opening-hours", "booking-rules", "peak-pricing", "counter-payments", "cash-up", "refunds", "venue-cancellations", "check-in", "test-bookings", "go-live"];

export const BUSINESS_TYPES: readonly BusinessType[] = [
  type("badminton-and-pickleball", ["badminton", "pickleball"], [...COURT_BASICS, "rates-from-date", "memberships", "promo-codes", "concessions", "pay-to-hold", "pay-online-billplz", "booking-alerts", "email-messages", "staff-roles", "staff-invitations", "open-games", "reports"], ["court-booking", "counter-booking", "online-payment-booking", "membership-benefits", "cancellation-and-refund", "open-game"], (p) => {
    p.resources.total = 6;
    p.rates.peakPricing = true;
    p.rates.lowest = 15;
    p.rates.highest = 25;
    p.channels = { onlinePage: true, counter: true, apiKeys: 0 };
    p.payments.counterMethods = ["cash", "qr"];
    p.staff = { managers: 1, desk: 2, pendingInvitations: 0 };
    p.commerce.membershipPlans = 1;
    p.commerce.promoCodes = 1;
  }),
  type("futsal-and-football", ["futsal", "football"], [...COURT_BASICS, "linked-courts", "buffers", "pay-to-hold", "tournaments", "leagues", "open-games", "discount-stacking", "booking-alerts"], ["court-booking", "counter-booking", "online-payment-booking", "tournament-entry", "league-season", "cancellation-and-refund"], (p) => {
    p.resources.total = 4;
    p.resources.linked = 3;
    p.resources.withBuffers = 4;
    p.rates.peakPricing = true;
    p.channels = { onlinePage: true, counter: true, apiKeys: 0 };
    p.programmes = { tournaments: 1, leagues: 1, openGames: 0 };
    p.policies.payToHold = true;
  }),
  type("tennis-and-padel", ["tennis", "padel"], [...COURT_BASICS, "rates-from-date", "memberships", "coaching", "classes", "pay-to-hold", "open-games", "matchmaking", "leagues", "member-rates"], ["court-booking", "counter-booking", "membership-benefits", "lesson-booking", "league-season", "open-game"], (p) => {
    p.resources.total = 5;
    p.rates.peakPricing = true;
    p.rates.memberRates = true;
    p.commerce.membershipPlans = 2;
    p.people.coaches = 2;
    p.people.coachesWithHours = 2;
  }),
  type("multi-sport", ["badminton", "futsal", "squash", "table_tennis", "basketball"], [...COURT_BASICS, "shared-facilities", "linked-courts", "buffers", "activity-catalogue", "booking-rules", "memberships", "passes", "branches", "branch-copy", "reports", "exports", "staff-roles", "staff-invitations", "manager-overrides", "pay-to-hold", "company-accounts"], ["court-booking", "counter-booking", "online-payment-booking", "membership-benefits", "branch-oversight", "cancellation-and-refund"], (p) => {
    p.resources.total = 14;
    p.resources.shared = 2;
    p.resources.linked = 4;
    p.resources.withBuffers = 6;
    p.rates.peakPricing = true;
    p.branches.venues = 2;
    p.staff = { managers: 2, desk: 4, pendingInvitations: 0 };
    p.commerce = { ...p.commerce, membershipPlans: 2, passProducts: 2, companyAccounts: 1 };
  }),
  type("gym-and-fitness", ["gym", "yoga", "pilates"], ["resources", "opening-hours", "memberships", "passes", "membership-suspension", "family-memberships", "check-in", "sign-offs", "waivers", "classes", "unstaffed-access", "counter-payments", "refunds", "gym-walk-in", "test-bookings", "go-live"], ["timed-session", "class-enrolment", "membership-benefits", "pass-redemption", "first-visit-sign-off", "unstaffed-entry"], (p) => {
    p.resources.total = 3;
    p.resources.shared = 1;
    p.commerce.membershipPlans = 3;
    p.commerce.passProducts = 1;
    p.people.classes = 12;
    p.people.upcomingClasses = 8;
    p.policies.signOffRequired = true;
    p.access.unstaffedHours = true;
    p.channels = { onlinePage: true, counter: true, apiKeys: 0 };
  }),
  type("swimming", ["swimming"], ["resources", "shared-facilities", "opening-hours", "passes", "memberships", "guardians", "classes", "coaching", "check-in", "counter-payments", "refunds", "test-bookings", "go-live"], ["timed-session", "class-enrolment", "guardian-child-booking", "pass-redemption", "cancellation-and-refund"], (p) => {
    p.resources.total = 6;
    p.resources.shared = 6;
    p.access.supervisedActivities = 1;
    p.commerce.passProducts = 2;
    p.guardians = { participants: 40, approvalRequirements: 1, familyPlans: 1 };
    p.people.coaches = 3;
    p.people.classes = 20;
    p.people.upcomingClasses = 14;
  }),
  type("climbing-and-bouldering", ["climbing", "bouldering"], ["resources", "shared-facilities", "sign-offs", "waivers", "passes", "memberships", "equipment-hire", "classes", "check-in", "open-day-pass", "counter-payments", "refunds", "test-bookings", "go-live"], ["timed-session", "first-visit-sign-off", "equipment-hire", "pass-redemption", "class-enrolment"], (p) => {
    p.resources.total = 2;
    p.resources.shared = 2;
    p.policies.signOffRequired = true;
    p.commerce.passProducts = 2;
    p.commerce.membershipPlans = 1;
    p.commerce.extras = 2;
  }),
  type("coaching-academy", ["badminton", "tennis", "martial_arts"], ["resources", "coaching", "classes", "passes", "guardians", "activity-approvals", "memberships", "check-in", "counter-payments", "refunds", "email-messages", "staff-invitations", "test-bookings", "go-live"], ["lesson-booking", "class-enrolment", "guardian-child-booking", "pass-redemption", "cancellation-and-refund"], (p) => {
    p.resources.total = 6;
    p.people = { coaches: 5, coachesWithHours: 5, classes: 30, upcomingClasses: 18, lessonsBooked: 60 };
    p.commerce.passProducts = 3;
    p.guardians = { participants: 80, approvalRequirements: 1, familyPlans: 1 };
  }),
  type("equipment-rental", ["kayak", "paddleboard", "cycling"], ["resources", "equipment-hire", "opening-hours", "pay-to-hold", "counter-payments", "refunds", "venue-cancellations", "outages", "check-in", "test-bookings", "go-live"], ["equipment-hire", "counter-booking", "online-payment-booking", "cancellation-and-refund"], (p) => {
    p.resources.total = 4;
    p.commerce.hireDeposits = true;
    p.commerce.extras = 2;
    p.access.supervisedActivities = 2;
    p.channels = { onlinePage: true, counter: true, apiKeys: 0 };
  }),
  type("archery-and-supervised", ["archery", "fencing", "kayak"], ["resources", "sign-offs", "waivers", "classes", "coaching", "check-in", "counter-payments", "refunds", "range-officer", "test-bookings", "go-live"], ["timed-session", "first-visit-sign-off", "class-enrolment", "cancellation-and-refund"], (p) => {
    p.resources.total = 8;
    p.policies.signOffRequired = true;
    p.access.supervisedActivities = 1;
    p.people.coaches = 2;
    p.people.classes = 6;
  }),
  type("club-and-community", ["badminton", "volleyball", "netball"], ["who-venue-is-for", "memberships", "open-games", "matchmaking", "tournaments", "leagues", "counter-payments", "staff-invitations", "reports", "booking-rules", "opening-hours", "test-bookings", "go-live"], ["court-booking", "membership-benefits", "open-game", "league-season", "tournament-entry"], (p) => {
    p.resources.total = 4;
    p.identity.visibility = "members";
    p.commerce.membershipPlans = 2;
    p.programmes = { tournaments: 1, leagues: 1, openGames: 5 };
  }),
  type("school-and-corporate", ["basketball", "futsal", "badminton"], ["who-venue-is-for", "company-accounts", "guardians", "booking-rules", "opening-hours", "tournaments", "reports", "exports", "staff-roles", "test-bookings", "go-live"], ["company-account-booking", "guardian-child-booking", "court-booking", "tournament-entry"], (p) => {
    p.resources.total = 4;
    p.identity.visibility = "private";
    p.commerce.companyAccounts = 3;
    p.guardians = { participants: 120, approvalRequirements: 0, familyPlans: 0 };
  }),
  type("mixed", ["badminton", "gym", "yoga", "kayak"], [...COURT_BASICS, "activity-catalogue", "shared-facilities", "memberships", "passes", "classes", "equipment-hire", "branches", "reports", "gym-walk-in", "staff-roles"], ["court-booking", "timed-session", "class-enrolment", "equipment-hire", "membership-benefits", "branch-oversight"], (p) => {
    p.resources.total = 9;
    p.resources.shared = 1;
    p.rates.peakPricing = true;
    p.commerce.membershipPlans = 2;
    p.commerce.passProducts = 1;
    p.commerce.hireDeposits = true;
    p.people.classes = 10;
    p.people.upcomingClasses = 6;
  }),
];

const BY_TYPE = new Map(BUSINESS_TYPES.map((b) => [b.id, b]));

export function businessType(id: string): BusinessType | undefined {
  return isBusinessTypeId(id) ? BY_TYPE.get(id) : undefined;
}

// ---------------------------------------------------------------- activity facts, read from the catalogue

export interface ActivityFacts {
  key: string;
  category: ActivityCategory;
  model: ResourceModel;
  support: SupportLevel;
  /** The catalogue's own words on what is not built for it; null for a fully supported one. */
  supportNote: string | null;
  supervised: boolean;
  signOff: boolean;
  perPlayer: boolean;
}

/** What the catalogue says about a built-in activity (never copied: read on each call); undefined for any other key. */
export function activityFacts(key: string): ActivityFacts | undefined {
  const a = CATALOGUE.get(key);
  if (!a) return undefined;
  return {
    key: a.key,
    category: a.category,
    model: a.template.model,
    support: a.support,
    supportNote: a.supportNote,
    supervised: a.supervised,
    signOff: a.template.signOff,
    perPlayer: a.template.perPlayer,
  };
}

export const isCatalogueActivity = (key: unknown): key is string => typeof key === "string" && CATALOGUE.has(key);

// ---------------------------------------------------------------- several at once

export interface Composed {
  types: BusinessTypeId[];
  /** Each activity once, with the types that brought it. */
  activities: { key: string; from: BusinessTypeId[] }[];
  capabilities: { id: string; from: BusinessTypeId[] }[];
  workflows: { id: WorkflowId; from: BusinessTypeId[] }[];
  models: ResourceModel[];
  /** The illustrative profiles added together (counts summed, features on if any has them): still `illustrative`. */
  profile: VenueProfile;
}

function union<T extends string>(types: BusinessType[], pick: (t: BusinessType) => readonly T[]): { id: T; from: BusinessTypeId[] }[] {
  const out = new Map<T, BusinessTypeId[]>();
  for (const t of types) for (const id of pick(t)) out.set(id, [...(out.get(id) ?? []), t.id]);
  return [...out.entries()].map(([id, from]) => ({ id, from }));
}

/** The parts of a profile that are counts and features, and so add up across business types; the rest (hours, terms, identity) are the first type's. */
const ADDITIVE = ["resources", "people", "commerce", "programmes", "guardians", "access", "staff", "channels", "payments", "compliance", "history"] as const;

/** Numbers add, flags are on if either is, lists join (an activity once); anything else keeps the first. */
function merge<T>(a: T, b: T): T {
  if (typeof a === "number" && typeof b === "number") return (a + b) as T;
  if (typeof a === "boolean" && typeof b === "boolean") return (a || b) as T;
  if (Array.isArray(a) && Array.isArray(b)) {
    const joined = [...a, ...b] as unknown[];
    const seen = new Set<string>();
    return joined.filter((x) => {
      const k = JSON.stringify(x);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }) as T;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const k of Object.keys(b as Record<string, unknown>)) out[k] = k in out ? merge(out[k], (b as Record<string, unknown>)[k]) : (b as Record<string, unknown>)[k];
    return out as T;
  }
  return a;
}

/**
 * Several business types at once (a mixed venue is not forced into one):
 * the union of their activities, capabilities and workflows, each with the
 * types it came from. Unknown ids are ignored; none known gives the empty
 * composition.
 */
export function composeTypes(ids: readonly string[]): Composed {
  const types = [...new Set(ids)].map((id) => businessType(id)).filter((t): t is BusinessType => t !== undefined);
  const profile: VenueProfile = types.length === 0 ? emptyProfile(0) : (JSON.parse(JSON.stringify(types[0].profile)) as VenueProfile);
  for (const t of types.slice(1)) {
    const other = t.profile;
    for (const section of ADDITIVE) (profile as unknown as Record<string, unknown>)[section] = merge(profile[section], other[section]);
    profile.activities = merge(profile.activities, other.activities);
    profile.branches.venues = Math.max(profile.branches.venues, other.branches.venues);
    profile.rates.peakPricing ||= other.rates.peakPricing;
    profile.rates.memberRates ||= other.rates.memberRates;
    profile.policies.signOffRequired ||= other.policies.signOffRequired;
    profile.policies.payToHold ||= other.policies.payToHold;
  }
  profile.illustrative = true;
  profile.resources.priced = profile.resources.total;
  return {
    types: types.map((t) => t.id),
    activities: union(types, (t) => t.activities).map(({ id, from }) => ({ key: id, from })),
    capabilities: union(types, (t) => t.capabilities),
    workflows: union(types, (t) => t.workflows),
    models: (["exclusive", "lanes", "shared", "class", "hire"] as ResourceModel[]).filter((m) => types.some((t) => t.models.includes(m))),
    profile,
  };
}
