import { BUILTIN_ACTIVITIES } from "../activity-catalogue";
import type { StaffPhrase } from "../staff-i18n";
import type { StaffActionName } from "../roles";
import type { GuideAnswers } from "./answer-schema";
import { requireCapability } from "./capabilities";
import type { Say } from "./plan";
import { hasProgrammes, type VenueProfile } from "./profile-types";
import type { ConfigureTarget } from "./shell";

/**
 * Discoveries: capabilities that suit the venue and that it does not use yet
 * (docs/features/venue-guide.md#discoveries).
 *
 * Deterministic rules over the profile and the answers, each with the
 * reason it gives. At most three at a time; a dismissed one is not offered
 * again; one the venue already uses is never offered; and only an `available`
 * capability can be offered (a rule naming an unsupported one is a test
 * failure, not a promise). Nothing here is learned or ranked by behaviour.
 */

export const MAX_DISCOVERIES = 3;

export interface Discovery {
  /** The capability's id: also what is recorded when it is dismissed. */
  id: string;
  /** Why it is shown, naming the answer or fact. */
  reason: Say;
  configure: ConfigureTarget | null;
  staffAction: StaffActionName | null;
}

interface Rule {
  capability: string;
  reason: StaffPhrase;
  /** The venue does not use it yet. */
  unused(p: VenueProfile, a: GuideAnswers): boolean;
  /** It would suit this venue: from what it has done or said. */
  fits(p: VenueProfile, a: GuideAnswers): boolean;
}

const categoryOf = (key: string) => BUILTIN_ACTIVITIES.find((x) => x.key === key)?.category;
const playsOnCourts = (p: VenueProfile) => p.activities.some((x) => ["racket", "team"].includes(categoryOf(x.key) ?? ""));

/** In the order they are preferred. */
export const DISCOVERY_RULES: readonly Rule[] = [
  {
    capability: "coaching",
    reason: "gd.disc.coaching",
    unused: (p) => p.people.coaches === 0,
    fits: (p, a) => p.people.classes > 0 || a.coaching === true,
  },
  {
    capability: "pay-online-billplz",
    reason: "gd.disc.payOnline",
    unused: (p) => !p.payments.online.accountEnabled && !p.payments.online.accountExists,
    fits: (p) => p.identity.country === "MY" && p.identity.live && p.history.bookings > 0 && p.channels.onlinePage,
  },
  {
    capability: "pay-online-stripe",
    reason: "gd.disc.payOnline",
    unused: (p) => !p.payments.online.accountEnabled && !p.payments.online.accountExists,
    fits: (p) => p.identity.country !== "MY" && p.identity.live && p.history.bookings > 0 && p.channels.onlinePage,
  },
  {
    capability: "memberships",
    reason: "gd.disc.memberships",
    unused: (p) => p.commerce.membershipPlans === 0,
    fits: (p, a) => p.history.bookings > 0 && (a.customersDo?.includes("memberships") === true || a.memberships?.includes("memberships") === true),
  },
  {
    capability: "passes",
    reason: "gd.disc.passes",
    unused: (p) => p.commerce.passProducts === 0,
    fits: (p, a) => p.people.classes > 0 || p.people.coaches > 0 || a.memberships?.includes("passes") === true,
  },
  {
    capability: "peak-pricing",
    reason: "gd.disc.peak",
    unused: (p) => !p.rates.peakPricing,
    fits: (p) => p.resources.total > 0 && p.history.bookings >= 10,
  },
  {
    capability: "equipment-hire",
    reason: "gd.disc.hire",
    unused: (p) => p.resources.byModel.hire === 0,
    fits: (_p, a) => a.customersDo?.includes("hire") === true,
  },
  {
    capability: "classes",
    reason: "gd.disc.classes",
    unused: (p) => p.people.classes === 0,
    fits: (p, a) => p.resources.byModel.class > 0 || a.customersDo?.includes("classes") === true,
  },
  {
    capability: "branch-copy",
    reason: "gd.disc.branches",
    unused: (p) => p.branches.venues === 1,
    fits: (p, a) => a.branches === "several" && p.history.bookings > 0,
  },
  {
    capability: "company-accounts",
    reason: "gd.disc.companyAccounts",
    unused: (p) => p.commerce.companyAccounts === 0,
    fits: (_p, a) => a.types?.includes("school-and-corporate") === true,
  },
  {
    capability: "tournaments",
    reason: "gd.disc.tournaments",
    unused: (p) => !hasProgrammes(p),
    // Courts only, until they are interested: several courts played on, a record of bookings, nothing run yet.
    fits: (p) => playsOnCourts(p) && p.resources.total >= 4 && p.history.bookings >= 20,
  },
  {
    capability: "booking-alerts",
    reason: "gd.disc.alerts",
    unused: (p) => !p.compliance.bookingAlerts,
    fits: (p) => p.identity.live && p.history.bookings > 0,
  },
];

/**
 * Up to three capabilities worth a look: not unsupported, not already used,
 * not dismissed, in the rules' order. `dismissed` is the keys of
 * `venue_guide.dismissed`.
 */
export function discover(profile: VenueProfile, answers: GuideAnswers, dismissed: Record<string, unknown> = {}): Discovery[] {
  const out: Discovery[] = [];
  for (const rule of DISCOVERY_RULES) {
    if (out.length >= MAX_DISCOVERIES) break;
    if (rule.capability in dismissed) continue;
    const cap = requireCapability(rule.capability);
    if (cap.status !== "available") continue;
    if (!rule.unused(profile, answers) || !rule.fits(profile, answers)) continue;
    // Two rules may suggest one capability's alternatives (a payment provider): one is enough.
    if (out.some((d) => d.reason.key === rule.reason)) continue;
    out.push({ id: cap.id, reason: { key: rule.reason }, configure: cap.configure ?? null, staffAction: cap.staffAction ?? null });
  }
  return out;
}
