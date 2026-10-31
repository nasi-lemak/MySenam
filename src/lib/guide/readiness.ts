import type { StaffActionName } from "../roles";
import type { StaffText } from "../staff-text";
import type { Integration } from "./capabilities";
import { buildSetupPlan, type PlanItem, type Say, type SetupPlan } from "./plan";
import { emptyAnswers } from "./answer-schema";
import { usesOnlinePayments, usesEInvoicing, type VenueProfile } from "./profile-types";
import type { ConfigureTarget } from "./shell";

/**
 * Launch readiness: whether the venue is ready to go live, said in six
 * kinds of thing and never as one percentage
 * (docs/features/venue-guide.md#launch-readiness).
 *
 * Built from the setup plan and the profile and from the rules the
 * application already has, not a second set of launch requirements: what
 * stops a draft asking to go live is `goLiveStatus`'s (`profile.goLive`), a
 * test booking with real money on it blocks it as `lib/test-bookings.ts`
 * says, and the checklist's own answers are `profile.setup`. Online-payment
 * checks appear only where online payments are in use; e-invoicing only
 * where it is on, but the compliance notice that applies to every Malaysian
 * venue stays. A venue copied from another branch is read for itself: what
 * is not copied (its payment account, staff, test booking) reads as missing
 * here.
 */

export interface ReadinessItem {
  id: string;
  /** What it says, in the staff dictionary. */
  label: Say;
  /** Where the application's own go-live rule gives its own words, said as the server composes them. */
  say?: StaffText;
  /** Why it matters, in the staff dictionary: the reason this is on the list. */
  why?: Say;
  /** The plan step it comes from, if any. */
  stepId?: string;
  capability?: string;
  configure?: ConfigureTarget;
  staffAction?: StaffActionName;
}

export interface ExternalItem extends ReadinessItem {
  integration: Integration;
}

export interface LaunchReadiness {
  /** Required or optional steps whose saved state says they are done. */
  configurationComplete: ReadinessItem[];
  /** Optional steps still open: things that would help, none of them needed to open. */
  optionalEnhancements: ReadinessItem[];
  /** What is needed before the venue can go live and is not yet there. */
  requiredMissing: ReadinessItem[];
  /** Configured, but not yet shown to work against the real service. */
  unverifiedExternal: ExternalItem[];
  /** What the venue's own adviser must decide: MySenam does not decide it. */
  legalPrerequisite: ReadinessItem[];
  /** Needs of a feature the venue uses, beyond its own setup step. */
  featureSpecific: ReadinessItem[];
}

const fromStep = (item: PlanItem): ReadinessItem => ({
  id: item.id,
  label: { key: item.titleKey },
  why: { key: item.whyKey },
  stepId: item.id,
  ...(item.capabilities[0] ? { capability: item.capabilities[0] } : {}),
  ...(item.configure ? { configure: item.configure } : {}),
  ...(item.staffAction ? { staffAction: item.staffAction } : {}),
});

const said = (key: Say["key"], vars?: Say["vars"]): Say => (vars ? { key, vars } : { key });

/**
 * The venue's readiness. `plan` is the setup plan for this venue (built from
 * the same profile); leave it out and the plan for a venue with no answers is
 * used, which is the application's own required steps and nothing the venue
 * did not choose.
 */
export function launchReadiness(profile: VenueProfile, plan: SetupPlan = buildSetupPlan({ profile, answers: emptyAnswers(), acknowledged: {}, role: "manager" })): LaunchReadiness {
  const out: LaunchReadiness = {
    configurationComplete: [],
    optionalEnhancements: [],
    requiredMissing: [],
    unverifiedExternal: [],
    legalPrerequisite: [],
    featureSpecific: [],
  };

  // ---- the plan's steps
  for (const item of plan.items) {
    // The launch step is this summary itself: it is not an item of it.
    if (item.action === "readiness") continue;
    if (item.state.status === "done") out.configurationComplete.push(fromStep(item));
    else if (item.required) out.requiredMissing.push(fromStep(item));
    else out.optionalEnhancements.push(fromStep(item));
  }

  // ---- what the application already refuses a draft for
  profile.goLive.missing.forEach((text, i) => out.requiredMissing.push({ id: `go-live-${i}`, label: said("gd.ready.goLiveMissing"), why: said("gs.ready.why.goLive"), say: text, capability: "go-live" }));
  if (profile.history.paidTestBookings > 0)
    out.requiredMissing.push({
      id: "paid-test-bookings",
      label: said("gd.ready.paidTests", { n: profile.history.paidTestBookings }),
      why: said("gs.ready.why.paidTests"),
      capability: "test-bookings",
      configure: { tab: "bookings" },
      staffAction: "testBookings",
    });
  else if (profile.identity.live && profile.history.testBookings > 0)
    out.optionalEnhancements.push({
      id: "leftover-tests",
      label: said("gd.ready.leftoverTests", { n: profile.history.testBookings }),
      why: said("gs.ready.why.leftoverTests"),
      capability: "test-bookings",
      configure: { tab: "bookings" },
      staffAction: "testBookings",
    });

  // ---- online payments: only where they are in use
  if (usesOnlinePayments(profile)) {
    const online = profile.payments.online;
    const provider = (online.provider === "stripe" ? "stripe" : "billplz") satisfies Integration;
    const capabilityId = provider === "stripe" ? "pay-online-stripe" : "pay-online-billplz";
    if (!online.accountEnabled)
      out.requiredMissing.push({
        id: "online-account",
        label: said("gd.ready.onlineAccountMissing"),
        why: said("gs.ready.why.onlineAccount"),
        capability: capabilityId,
        configure: { tab: "venues" },
        staffAction: "paymentSettings",
      });
    else if (!online.firstPaymentTaken)
      out.unverifiedExternal.push({
        id: "online-unverified",
        label: said(online.sandbox ? "gd.ready.onlineSandbox" : "gd.ready.onlineUnverified"),
        why: said("gs.ready.why.onlineUnverified"),
        integration: provider,
        capability: capabilityId,
        configure: { tab: "venues" },
        staffAction: "paymentSettings",
      });
  }

  // ---- messages need an email service on the install
  if (!profile.install.emailTransport)
    out.unverifiedExternal.push({ id: "email", label: said("gd.ready.emailMissing"), why: said("gs.ready.why.email"), integration: "email", capability: "email-messages" });

  // ---- e-invoicing: its checks only when it is on; the notice is every Malaysian venue's
  if (usesEInvoicing(profile))
    out.unverifiedExternal.push({
      id: "einvoice",
      label: said(profile.compliance.einvoicing.sandbox ? "gd.ready.einvoiceSandbox" : "gd.ready.einvoiceUnverified"),
      why: said("gs.ready.why.einvoice"),
      integration: "myinvois",
      capability: "e-invoicing",
      configure: { tab: "venues" },
      staffAction: "einvoicing",
    });
  if (profile.identity.country === "MY") out.legalPrerequisite.push({ id: "einvoice-notice", label: said("gd.ready.einvoiceNotice"), why: said("gs.ready.why.einvoiceNotice"), capability: "e-invoicing" });
  if ((profile.commerce.hireDeposits || profile.policies.depositPercent > 0 || profile.policies.cancellation.lateKeepPercent !== null) && !profile.compliance.deductionTaxReviewed)
    out.legalPrerequisite.push({ id: "tax-treatment", label: said("gd.ready.taxTreatment"), why: said("gs.ready.why.taxTreatment"), capability: "receipts-tax", configure: { tab: "venues" }, staffAction: "venueTax" });

  // ---- what a feature in use needs
  if ((profile.access.unstaffedHours || profile.access.unmannedResources > 0) && !profile.access.emergencyDetails)
    out.featureSpecific.push({ id: "emergency-details", label: said("gd.ready.emergencyDetails"), why: said("gs.ready.why.emergency"), capability: "unstaffed-access", configure: { tab: "venues" }, staffAction: "venueDetails" });
  if (profile.people.coaches > profile.people.coachesWithHours)
    out.featureSpecific.push({
      id: "coach-hours",
      label: said("gd.ready.coachHours", { n: profile.people.coaches - profile.people.coachesWithHours }),
      why: said("gs.ready.why.coachHours"),
      capability: "coaching",
      configure: { tab: "classes" },
      staffAction: "coaches",
    });
  return out;
}
