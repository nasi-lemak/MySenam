import { CAPABILITY_GROUPS, CAPABILITIES, availabilityOf, capabilitiesIn, type Availability, type Capability, type CapabilityGroup } from "./capabilities";
import { focusIds } from "./plan";
import { hasCoaching, hasMultipleBranches, takesCounterPayments, usesEInvoicing, type VenueProfile } from "./profile-types";
import type { TopicId } from "./help";

/**
 * "Everything MySenam can do", for a manager's discover view
 * (docs/features/venue-guide.md#contextual-help-and-discovery): the capability
 * registry grouped as the registry groups it, each item marked *in use*,
 * *available* or *not currently supported*, with what it needs
 * (`availabilityOf`), and, only for one that is available and not yet used,
 * the way to set it up. Browser-safe, deterministic, and a function of the
 * registry and the venue's profile alone: it holds no list of its own, so a
 * capability added to the registry is here, and one that is unsupported can
 * never be offered for setup (`tests/guide-help-discover.test.ts`).
 */

/**
 * Whether the venue's saved configuration shows it using a capability, from
 * the profile alone; `null` where the profile cannot tell (a capability that
 * leaves no setting or record of use), in which case the item is shown as
 * available and never as in use. A check is a count or a setting the venue
 * itself saved, never a guess.
 */
const IN_USE: Record<string, (p: VenueProfile) => boolean> = {
  resources: (p) => p.resources.total > 0,
  "activity-catalogue": (p) => p.activities.length > 0,
  "own-activities": (p) => p.activities.some((a) => a.own),
  "shared-facilities": (p) => p.resources.shared > 0,
  "linked-courts": (p) => p.resources.linked > 0,
  buffers: (p) => p.resources.withBuffers > 0,
  "booking-rules": (p) => p.policies.bookingRuleLevels > 0,
  "hours-from-date": (p) => p.hours.scheduled.length > 0,
  "who-venue-is-for": (p) => p.identity.visibility !== "public",
  "test-bookings": (p) => p.history.testBookings > 0,
  "peak-pricing": (p) => p.rates.peakPricing,
  "rates-from-date": (p) => p.rates.scheduled.length > 0,
  "last-minute-prices": (p) => p.rates.lastMinute,
  "member-rates": (p) => p.rates.memberRates,
  "per-player-pricing": (p) => p.resources.perPlayer > 0,
  concessions: (p) => p.commerce.concessions > 0,
  "promo-codes": (p) => p.commerce.promoCodes > 0,
  "discount-stacking": (p) => p.policies.discountStacking === "promotion",
  memberships: (p) => p.commerce.membershipPlans > 0,
  passes: (p) => p.commerce.passProducts > 0,
  "family-memberships": (p) => p.guardians.familyPlans > 0,
  "stored-credit": (p) => p.payments.storedCredit,
  "gift-vouchers": (p) => p.payments.giftVouchers,
  "company-accounts": (p) => p.commerce.companyAccounts > 0,
  classes: (p) => p.people.classes > 0,
  coaching: (p) => hasCoaching(p),
  tournaments: (p) => p.programmes.tournaments > 0,
  leagues: (p) => p.programmes.leagues > 0,
  "open-games": (p) => p.programmes.openGames > 0,
  "equipment-hire": (p) => p.resources.byModel.hire > 0,
  "unstaffed-access": (p) => p.access.unstaffedHours,
  "sign-offs": (p) => p.policies.signOffRequired,
  guardians: (p) => p.guardians.participants > 0,
  "staff-roles": (p) => p.staff.desk > 0,
  "counter-payments": (p) => takesCounterPayments(p),
  "pay-online-billplz": (p) => p.payments.online.accountExists && p.payments.online.provider === "billplz",
  "pay-online-stripe": (p) => p.payments.online.accountExists && p.payments.online.provider === "stripe",
  "pay-to-hold": (p) => p.policies.payToHold,
  "receipts-tax": (p) => p.identity.taxRegistered,
  "email-messages": (p) => p.install.emailTransport,
  "whatsapp-messages": (p) => p.install.whatsappTransport,
  "booking-alerts": (p) => p.compliance.bookingAlerts,
  "e-invoicing": (p) => usesEInvoicing(p),
  branches: (p) => hasMultipleBranches(p),
  "branch-copy": (p) => p.branches.copiedFromBranch,
  "go-live": (p) => p.identity.live,
  "public-api": (p) => p.channels.apiKeys > 0,
  languages: (p) => p.identity.customerLanguages.length > 1,
};

/** Whether the venue uses a capability: true or false where its saved configuration shows it, `null` where it cannot. */
export function capabilityInUse(id: string, profile: VenueProfile): boolean | null {
  const check = IN_USE[id];
  return check ? check(profile) : null;
}

/** The ids the in-use table knows, for the test that holds it to the registry. */
export const IN_USE_IDS: readonly string[] = Object.keys(IN_USE);

/**
 * The playbook topic that explains a capability, where one does (so "How it
 * works" can show the venue's own version of it). A capability without a topic
 * is explained by its own blurb in the registry, and nothing is written for it.
 */
export const CAPABILITY_TOPIC: Readonly<Record<string, TopicId>> = {
  buffers: "buffers",
  "shared-facilities": "shared-linked",
  "linked-courts": "shared-linked",
  "peak-pricing": "peak-dated",
  "rates-from-date": "peak-dated",
  concessions: "discounts",
  "promo-codes": "discounts",
  "discount-stacking": "discounts",
  memberships: "memberships",
  "family-memberships": "membership-covers",
  passes: "passes",
  guardians: "guardians",
  refunds: "refunds",
  "test-bookings": "test-bookings",
  "unstaffed-access": "unattended",
};

export type CatalogueState = "in-use" | "available" | "unsupported";

export interface CatalogueItem {
  capability: Capability;
  state: CatalogueState;
  /** What it needs, in the guide's five words. */
  availability: Availability;
  /** One of this venue's current suggestions (shown once, above). */
  suggested: boolean;
  /** The id a targeted setup journey can be focused on (`?view=setup&focus=`): only an available capability not yet in use that has steps. */
  focus: string | null;
  topic: TopicId | null;
}

export interface CatalogueGroup {
  group: CapabilityGroup;
  items: CatalogueItem[];
  counts: { inUse: number; available: number; unsupported: number };
}

/**
 * The id a targeted journey can be started on for a capability: the plan has
 * steps for it (`focusIds`), it is available, and the venue does not use it.
 * Never an unsupported capability.
 */
export function setupFocus(c: Capability, profile: VenueProfile): string | null {
  if (c.status !== "available") return null;
  if (capabilityInUse(c.id, profile) === true) return null;
  return focusIds().includes(c.id) ? c.id : null;
}

/** The whole registry, in the registry's own groups and order, as it stands for this venue. `suggested` is the ids of the suggestions now shown. */
export function catalogue(profile: VenueProfile, suggested: readonly string[] = []): CatalogueGroup[] {
  const focusable = new Set(focusIds());
  return CAPABILITY_GROUPS.map((group) => {
    const items: CatalogueItem[] = capabilitiesIn(group).map((capability) => {
      const used = capability.status === "available" ? capabilityInUse(capability.id, profile) : false;
      const state: CatalogueState = capability.status === "unsupported" ? "unsupported" : used === true ? "in-use" : "available";
      return {
        capability,
        state,
        availability: availabilityOf(capability),
        suggested: suggested.includes(capability.id),
        focus: state === "available" && focusable.has(capability.id) ? capability.id : null,
        topic: CAPABILITY_TOPIC[capability.id] ?? null,
      };
    });
    return {
      group,
      items,
      counts: {
        inUse: items.filter((i) => i.state === "in-use").length,
        available: items.filter((i) => i.state === "available").length,
        unsupported: items.filter((i) => i.state === "unsupported").length,
      },
    };
  }).filter((g) => g.items.length > 0);
}

/** Every capability the registry has, for the test that holds the catalogue equal to it. */
export const REGISTRY_IDS: readonly string[] = CAPABILITIES.map((c) => c.id);
