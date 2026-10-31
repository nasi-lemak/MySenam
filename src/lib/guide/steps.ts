import { BUILTIN_ACTIVITIES } from "../activity-catalogue";
import type { StaffPhrase } from "../staff-i18n";
import { DEFAULT_PEAK } from "../time";
import type { AnswerKey } from "./answers";
import type { Say, SetupStep, StepContext, StepState } from "./plan";
import { hasProgrammes, takesCounterPayments, usesOnlinePayments } from "./profile-types";

/**
 * The setup steps (docs/features/venue-guide.md#setup-steps).
 *
 * One list, one framework: each step is a typed `SetupStep` with an id (never
 * changed: acknowledgements are recorded under it), a group, the capabilities
 * it concerns, when it applies and why (from the profile and the answers),
 * how its state is read from the profile (never from a click), and what
 * existing screen it opens or existing editor it runs
 * (`action`; components/admin/guide/setup/actions.tsx). The first three
 * (`details`, `courts`, `test-booking`) are the existing checklist's three,
 * delegating to what `venueSetup` already says (`profile.setup`, never
 * recomputed). To add a step, add it here and its text to the staff
 * dictionaries (`src/lib/staff-i18n/guide-setup.ts`): a title, a why, and
 * `gs.more.<id>` for its longer explanation.
 *
 * Recommendations are said in words from what the platform itself knows: the
 * activity catalogue's own policy and template, the install's region. They
 * are never a saved setting and never an invented number.
 */

// ------------------------------------------------------------ reasons a step is shown

const ALWAYS: Say = { key: "gd.because.always" };

const ANSWER_BECAUSE: Record<AnswerKey, StaffPhrase> = {
  types: "gd.because.answer.types",
  activities: "gd.because.answer.activities",
  customersDo: "gd.because.answer.customersDo",
  resources: "gd.because.answer.resources",
  branches: "gd.because.answer.branches",
  staffing: "gd.because.answer.staffing",
  channels: "gd.because.answer.channels",
  memberships: "gd.because.answer.memberships",
  coaching: "gd.because.answer.coaching",
  children: "gd.because.answer.children",
  audience: "gd.because.answer.audience",
  competitions: "gs.because.answer.competitions",
  discounts: "gs.because.answer.discounts",
};

/** Shown because of something the manager said. */
export const becauseAnswer = (key: AnswerKey): Say => ({ key: ANSWER_BECAUSE[key] });

/** Shown because of something the venue already has. */
export const becauseFact = (key: StaffPhrase): Say => ({ key });

// ------------------------------------------------------------ states

/** A review step: done once a manager has said they reviewed it, shown with when and by whom. */
export function reviewState(ctx: StepContext, id: string): StepState {
  const ack = ctx.acknowledged[id];
  return ack ? { status: "done", reviewedAt: ack.at, reviewedBy: ack.byName } : { status: "review-needed" };
}

const done = (yes: boolean, otherwise: StepState["status"] = "todo"): StepState => ({ status: yes ? "done" : otherwise });

const noCourts = (ctx: StepContext): boolean => ctx.profile.setup.courts === 0;

/** `state` for a step that cannot be done before there is a court: it says what it waits for. */
const afterCourts = (ctx: StepContext, otherwise: () => StepState): StepState => (noCourts(ctx) ? { status: "blocked", blockedBy: ["courts"] } : otherwise());

const TYPES_SHARING_SPACE = ["multi-sport", "futsal-and-football", "mixed", "club-and-community"] as const;

/** The usual booking length and shortest booking the catalogue gives an activity, if it gives any: a starting point from the catalogue, never invented. */
function usualBooking(ctx: StepContext): Say | null {
  const keys = [...(ctx.answers.activities ?? []), ...ctx.profile.activities.map((a) => a.key)];
  for (const key of keys) {
    const policy = BUILTIN_ACTIVITIES.find((a) => a.key === key)?.policy;
    const length = policy?.defaultLength ?? policy?.minLength ?? null;
    if (policy && length) return { key: "gs.step.bookingRules.rec", vars: { activity: key, minutes: length } };
  }
  return null;
}

// ------------------------------------------------------------ the steps

export const SETUP_STEPS: readonly SetupStep[] = [
  // ---------------------------------------------------------------- identity
  // The three steps of the existing checklist (lib/setup.ts): their answers are `profile.setup`'s.
  {
    id: "details",
    group: "identity",
    capabilities: ["opening-hours", "hours-from-date"],
    kind: "form",
    effect: "open",
    titleKey: "gd.step.details.title",
    whyKey: "gd.step.details.why",
    required: true,
    configure: { tab: "venues" },
    staffAction: "venueDetails",
    action: "hours",
    consequence: { key: "gs.step.details.consequence" },
    platformRule: { key: "gs.step.details.rule" },
    applies: () => ALWAYS,
    state: (ctx) => done(ctx.profile.setup.detailsChecked),
  },
  {
    id: "copied-branch",
    group: "identity",
    capabilities: ["branch-copy"],
    kind: "review",
    effect: "review",
    titleKey: "gd.step.copiedBranch.title",
    whyKey: "gd.step.copiedBranch.why",
    required: false,
    configure: { tab: "venues" },
    staffAction: "venueDetails",
    applies: (ctx) => (ctx.profile.branches.copiedFromBranch ? becauseFact("gd.because.fact.copied") : null),
    state: (ctx) => reviewState(ctx, "copied-branch"),
  },
  {
    id: "branches",
    group: "identity",
    capabilities: ["branches", "branch-copy"],
    kind: "link",
    effect: "add",
    titleKey: "gd.step.branches.title",
    whyKey: "gd.step.branches.why",
    required: false,
    configure: { tab: "venues" },
    staffAction: "addBranch",
    applies: (ctx) => (ctx.profile.branches.venues > 1 ? becauseFact("gd.because.fact.branches") : ctx.answers.branches === "several" ? becauseAnswer("branches") : null),
    state: (ctx) => (ctx.profile.branches.venues > 1 ? { status: "done" } : { status: "todo" }),
  },

  // ---------------------------------------------------------------- resources
  {
    id: "activities",
    group: "resources",
    capabilities: ["activity-catalogue", "own-activities"],
    kind: "link",
    effect: "open",
    titleKey: "gs.step.activities.title",
    whyKey: "gs.step.activities.why",
    required: false,
    configure: { tab: "courts" },
    staffAction: "activities",
    applies: (ctx) => ((ctx.answers.activities?.length ?? 0) > 0 ? becauseAnswer("activities") : null),
    // Each activity chosen is offered by at least one of the venue's resources.
    state: (ctx) => {
      const offered = new Set(ctx.profile.activities.map((a) => a.key));
      const chosen = ctx.answers.activities ?? [];
      return done(chosen.length > 0 && chosen.every((k) => offered.has(k)));
    },
  },
  {
    id: "courts",
    group: "resources",
    capabilities: ["resources", "activity-catalogue"],
    kind: "form",
    effect: "add",
    titleKey: "gd.step.courts.title",
    whyKey: "gd.step.courts.why",
    required: true,
    configure: { tab: "courts" },
    staffAction: "courts",
    action: "resources",
    platformRule: { key: "gs.step.courts.rule" },
    applies: () => ALWAYS,
    state: (ctx) => done(ctx.profile.setup.courts > 0),
    recommend: (ctx) => {
      const band = ctx.answers.resources;
      if (!band) return null;
      return { key: `gd.step.courts.rec.${band}` as StaffPhrase };
    },
  },
  {
    id: "equipment",
    group: "resources",
    capabilities: ["equipment-hire"],
    kind: "link",
    effect: "add",
    titleKey: "gd.step.equipment.title",
    whyKey: "gd.step.equipment.why",
    required: false,
    configure: { tab: "courts" },
    staffAction: "courts",
    applies: (ctx) => (ctx.profile.resources.byModel.hire > 0 ? becauseFact("gd.because.fact.hire") : ctx.answers.customersDo?.includes("hire") ? becauseAnswer("customersDo") : null),
    state: (ctx) => done(ctx.profile.resources.byModel.hire > 0),
  },
  {
    id: "shared-resources",
    group: "resources",
    capabilities: ["shared-facilities", "linked-courts"],
    kind: "link",
    effect: "open",
    titleKey: "gs.step.shared.title",
    whyKey: "gs.step.shared.why",
    required: false,
    after: ["courts"],
    configure: { tab: "courts" },
    staffAction: "courtLinks",
    platformRule: { key: "gs.step.shared.rule" },
    applies: (ctx) =>
      ctx.profile.resources.shared + ctx.profile.resources.linked > 0
        ? becauseFact("gs.because.fact.shared")
        : ctx.answers.types?.some((t) => (TYPES_SHARING_SPACE as readonly string[]).includes(t))
          ? becauseAnswer("types")
          : null,
    state: (ctx) => afterCourts(ctx, () => done(ctx.profile.resources.linked > 0, "optional")),
  },

  // ---------------------------------------------------------------- pricing
  {
    id: "prices",
    group: "pricing",
    capabilities: ["peak-pricing", "member-rates", "per-player-pricing"],
    kind: "form",
    effect: "open",
    titleKey: "gs.step.prices.title",
    whyKey: "gs.step.prices.why",
    required: false,
    after: ["courts"],
    configure: { tab: "courts" },
    staffAction: "courtChange",
    action: "prices",
    consequence: { key: "gs.step.prices.consequence" },
    applies: () => becauseFact("gs.because.fact.pricing"),
    state: (ctx) => afterCourts(ctx, () => done(ctx.profile.resources.priced > 0)),
  },
  {
    id: "peak-hours",
    group: "pricing",
    capabilities: ["peak-pricing"],
    kind: "form",
    effect: "open",
    titleKey: "gs.step.peak.title",
    whyKey: "gs.step.peak.why",
    required: false,
    after: ["courts"],
    configure: { tab: "courts" },
    staffAction: "peakRules",
    action: "peak-hours",
    consequence: { key: "gs.step.peak.consequence" },
    platformRule: { key: "gs.step.peak.rule" },
    // The platform's own starting window (lib/time.ts DEFAULT_PEAK), not a number of ours.
    recommend: () => ({ key: "gs.step.peak.rec", vars: { fromMin: DEFAULT_PEAK.weekdayFrom, untilMin: DEFAULT_PEAK.weekdayUntil } }),
    applies: (ctx) => (ctx.profile.rates.peakPricing ? becauseFact("gs.because.fact.peak") : becauseFact("gs.because.fact.pricing")),
    state: (ctx) => afterCourts(ctx, () => done(ctx.profile.rates.peakPricing, "optional")),
  },
  {
    id: "price-dates",
    group: "pricing",
    capabilities: ["rates-from-date", "hours-from-date"],
    kind: "form",
    effect: "open",
    titleKey: "gs.step.priceDates.title",
    whyKey: "gs.step.priceDates.why",
    required: false,
    after: ["courts"],
    configure: { tab: "courts" },
    staffAction: "datedCourtChanges",
    action: "price-dates",
    consequence: { key: "gs.step.priceDates.consequence" },
    applies: (ctx) =>
      ctx.profile.rates.scheduled.length + ctx.profile.hours.scheduled.length > 0
        ? becauseFact("gs.because.fact.scheduled")
        : ctx.profile.history.bookings > 0 || ctx.profile.history.paidBookings > 0
          ? becauseFact("gs.because.fact.history")
          : null,
    state: (ctx) =>
      afterCourts(ctx, () => {
        const n = ctx.profile.rates.scheduled.length + ctx.profile.hours.scheduled.length;
        return n > 0 ? { status: "optional", note: { key: "gs.step.priceDates.scheduled", vars: { n } } } : { status: "optional" };
      }),
  },
  {
    id: "discounts",
    group: "pricing",
    capabilities: ["concessions", "promo-codes", "discount-stacking"],
    kind: "link",
    effect: "add",
    titleKey: "gs.step.discounts.title",
    whyKey: "gs.step.discounts.why",
    required: false,
    after: ["courts"],
    configure: { tab: "courts" },
    staffAction: "concessions",
    consequence: { key: "gs.step.discounts.consequence" },
    applies: (ctx) =>
      ctx.profile.commerce.concessions + ctx.profile.commerce.promoCodes > 0 ? becauseFact("gs.because.fact.discounts") : ctx.answers.discounts === true ? becauseAnswer("discounts") : null,
    state: (ctx) => done(ctx.profile.commerce.concessions + ctx.profile.commerce.promoCodes > 0),
  },

  // ---------------------------------------------------------------- policies
  {
    id: "booking-rules",
    group: "policies",
    capabilities: ["booking-rules", "buffers"],
    kind: "form",
    effect: "open",
    titleKey: "gs.step.bookingRules.title",
    whyKey: "gs.step.bookingRules.why",
    required: false,
    after: ["courts"],
    configure: { tab: "courts" },
    staffAction: "bookingPolicies",
    action: "booking-rules",
    consequence: { key: "gs.step.bookingRules.consequence" },
    platformRule: { key: "gs.step.bookingRules.rule" },
    recommend: usualBooking,
    applies: () => ALWAYS,
    state: (ctx) => afterCourts(ctx, () => done(ctx.profile.policies.bookingRuleLevels > 0 || ctx.profile.resources.withBuffers > 0, "optional")),
  },
  {
    id: "cancellation-terms",
    group: "policies",
    capabilities: ["refunds", "venue-cancellations"],
    kind: "review",
    effect: "review",
    titleKey: "gd.step.cancellation.title",
    whyKey: "gd.step.cancellation.why",
    // Where money is taken online, how it goes back is settled before customers pay; otherwise it is the venue's to look at.
    required: (ctx) => usesOnlinePayments(ctx.profile),
    configure: { tab: "venues" },
    staffAction: "cancelPolicy",
    action: "cancellation",
    consequence: { key: "gd.step.cancellation.consequence" },
    platformRule: { key: "gs.step.cancellation.rule" },
    applies: () => ALWAYS,
    state: (ctx) => reviewState(ctx, "cancellation-terms"),
  },
  {
    id: "guardians",
    group: "policies",
    capabilities: ["guardians", "activity-approvals"],
    kind: "review",
    effect: "review",
    titleKey: "gd.step.guardians.title",
    whyKey: "gd.step.guardians.why",
    required: false,
    configure: { tab: "courts" },
    staffAction: "approvalSettings",
    platformRule: { key: "gs.step.guardians.rule" },
    applies: (ctx) =>
      ctx.profile.guardians.participants > 0 || ctx.profile.guardians.approvalRequirements > 0
        ? becauseFact("gd.because.fact.guardians")
        : ctx.answers.children === true
          ? becauseAnswer("children")
          : null,
    state: (ctx) => reviewState(ctx, "guardians"),
  },
  {
    id: "participant-requirements",
    group: "policies",
    capabilities: ["activity-approvals", "sign-offs"],
    kind: "link",
    effect: "open",
    titleKey: "gs.step.requirements.title",
    whyKey: "gs.step.requirements.why",
    required: false,
    configure: { tab: "courts" },
    staffAction: "approvalSettings",
    applies: (ctx) => (ctx.profile.guardians.approvalRequirements > 0 ? becauseFact("gs.because.fact.requirements") : ctx.answers.coaching === true ? becauseAnswer("coaching") : null),
    state: (ctx) => done(ctx.profile.guardians.approvalRequirements > 0, "optional"),
  },
  {
    id: "unattended",
    group: "policies",
    capabilities: ["unstaffed-access"],
    kind: "link",
    effect: "open",
    titleKey: "gd.step.unattended.title",
    whyKey: "gd.step.unattended.why",
    required: false,
    configure: { tab: "venues" },
    staffAction: "venueDetails",
    applies: (ctx) =>
      ctx.profile.access.unstaffedHours || ctx.profile.access.unmannedResources > 0
        ? becauseFact("gd.because.fact.unstaffed")
        : ctx.answers.staffing === "partial" || ctx.answers.staffing === "unattended"
          ? becauseAnswer("staffing")
          : null,
    state: (ctx) => done(ctx.profile.access.emergencyDetails),
  },
  {
    id: "communications",
    group: "policies",
    capabilities: ["email-messages", "whatsapp-messages"],
    kind: "review",
    effect: "review",
    titleKey: "gs.step.communications.title",
    whyKey: "gs.step.communications.why",
    required: false,
    configure: { tab: "venues" },
    staffAction: "venueDetails",
    platformRule: { key: "gs.step.communications.rule" },
    applies: () => ALWAYS,
    state: (ctx) => reviewState(ctx, "communications"),
  },

  // ---------------------------------------------------------------- people
  {
    id: "staff",
    group: "people",
    capabilities: ["staff-invitations", "staff-roles"],
    kind: "form",
    effect: "add",
    titleKey: "gs.step.staff.title",
    whyKey: "gs.step.staff.why",
    required: false,
    configure: { tab: "venues" },
    staffAction: "staff",
    action: "staff",
    platformRule: { key: "gs.step.staff.rule" },
    applies: (ctx) =>
      ctx.profile.staff.desk + ctx.profile.staff.pendingInvitations > 0
        ? becauseFact("gs.because.fact.staff")
        : ctx.answers.staffing === "unattended"
          ? null
          : ctx.answers.staffing !== undefined
            ? becauseAnswer("staffing")
            : ALWAYS,
    // Somebody besides the manager is invited, or has joined: an invitation not yet used counts as sent.
    state: (ctx) => done(ctx.profile.staff.desk + ctx.profile.staff.pendingInvitations > 0, ctx.answers.staffing === "staffed" || ctx.answers.staffing === "partial" ? "todo" : "optional"),
  },
  {
    id: "coaches",
    group: "people",
    capabilities: ["coaching"],
    kind: "link",
    effect: "add",
    titleKey: "gd.step.coaches.title",
    whyKey: "gd.step.coaches.why",
    required: false,
    configure: { tab: "classes" },
    staffAction: "coaches",
    applies: (ctx) => (ctx.profile.people.coaches > 0 ? becauseFact("gd.because.fact.coaches") : ctx.answers.coaching === true ? becauseAnswer("coaching") : null),
    state: (ctx) => done(ctx.profile.people.coaches > 0),
  },
  {
    id: "coach-hours",
    group: "people",
    capabilities: ["coaching"],
    kind: "link",
    effect: "open",
    titleKey: "gd.step.coachHours.title",
    whyKey: "gd.step.coachHours.why",
    required: false,
    after: ["coaches"],
    configure: { tab: "classes" },
    staffAction: "coaches",
    applies: (ctx) => (ctx.profile.people.coaches > 0 ? becauseFact("gd.because.fact.coaches") : ctx.answers.coaching === true ? becauseAnswer("coaching") : null),
    state: (ctx) =>
      ctx.profile.people.coaches === 0
        ? { status: "blocked", blockedBy: ["coaches"] }
        : done(ctx.profile.people.coachesWithHours >= ctx.profile.people.coaches),
  },

  // ---------------------------------------------------------------- payments
  {
    id: "counter-payments",
    group: "payments",
    capabilities: ["counter-payments", "cash-up"],
    kind: "review",
    effect: "review",
    titleKey: "gs.step.counter.title",
    whyKey: "gs.step.counter.why",
    required: false,
    configure: { tab: "bookings" },
    consequence: { key: "gs.step.counter.consequence" },
    applies: (ctx) =>
      takesCounterPayments(ctx.profile) ? becauseFact("gs.because.fact.counter") : ctx.answers.channels === undefined ? ALWAYS : ctx.answers.channels.includes("counter") ? becauseAnswer("channels") : null,
    state: (ctx) => reviewState(ctx, "counter-payments"),
  },
  {
    id: "online-payment",
    group: "payments",
    capabilities: ["pay-online-billplz", "pay-online-stripe", "pay-to-hold"],
    kind: "link",
    effect: "open",
    titleKey: "gd.step.onlinePayment.title",
    whyKey: "gd.step.onlinePayment.why",
    // Optional: a venue that takes payment at the counter is complete without it.
    required: false,
    configure: { tab: "venues" },
    staffAction: "paymentSettings",
    consequence: { key: "gd.step.onlinePayment.consequence" },
    // The install's own region decides which provider MySenam offers first; nothing is connected for the venue.
    recommend: (ctx) => ({ key: ctx.profile.identity.country === "MY" ? "gs.step.onlinePayment.recMy" : "gs.step.onlinePayment.recOther" }),
    applies: (ctx) => {
      if (usesOnlinePayments(ctx.profile) || ctx.profile.payments.online.accountExists) return becauseFact("gd.because.fact.onlinePayments");
      // Said to be counter only: no online payment step, and nothing to verify.
      if (ctx.answers.channels !== undefined && !ctx.answers.channels.includes("online")) return null;
      return ctx.answers.channels ? becauseAnswer("channels") : ALWAYS;
    },
    state: (ctx) => {
      // An enabled account is the checklist's own answer (profile.setup); a payment really taken is what verifies it.
      if (!ctx.profile.setup.onlinePayment) return { status: "optional" };
      const taken = ctx.profile.payments.online.firstPaymentTaken;
      return taken ? { status: "done", verified: true } : { status: "done", verified: false, note: { key: "gd.step.onlinePayment.unverified" } };
    },
  },
  {
    id: "einvoicing",
    group: "payments",
    capabilities: ["e-invoicing"],
    kind: "link",
    effect: "open",
    titleKey: "gs.step.einvoicing.title",
    whyKey: "gs.step.einvoicing.why",
    required: false,
    configure: { tab: "venues" },
    staffAction: "einvoicing",
    platformRule: { key: "gs.step.einvoicing.rule" },
    applies: (ctx) =>
      ctx.profile.compliance.einvoicing.enabled
        ? becauseFact("gs.because.fact.einvoicing")
        : ctx.profile.identity.country === "MY" && ctx.profile.identity.taxRegistered
          ? becauseFact("gs.because.fact.taxRegistered")
          : null,
    state: (ctx) =>
      ctx.profile.compliance.einvoicing.enabled
        ? { status: "done", verified: false, note: { key: ctx.profile.compliance.einvoicing.sandbox ? "gd.ready.einvoiceSandbox" : "gd.ready.einvoiceUnverified" } }
        : { status: "optional" },
  },

  // ---------------------------------------------------------------- programmes
  {
    id: "classes",
    group: "programmes",
    capabilities: ["classes"],
    kind: "link",
    effect: "add",
    titleKey: "gd.step.classes.title",
    whyKey: "gd.step.classes.why",
    required: false,
    configure: { tab: "classes" },
    staffAction: "classes",
    applies: (ctx) => (ctx.profile.people.classes > 0 ? becauseFact("gd.because.fact.classes") : ctx.answers.customersDo?.includes("classes") ? becauseAnswer("customersDo") : null),
    state: (ctx) => done(ctx.profile.people.upcomingClasses > 0),
  },
  {
    id: "memberships",
    group: "programmes",
    capabilities: ["memberships", "passes"],
    kind: "link",
    effect: "add",
    titleKey: "gd.step.memberships.title",
    whyKey: "gd.step.memberships.why",
    required: false,
    configure: { tab: "credit" },
    staffAction: "membershipPlans",
    applies: (ctx) =>
      ctx.profile.commerce.membershipPlans + ctx.profile.commerce.passProducts > 0
        ? becauseFact("gd.because.fact.plans")
        : (ctx.answers.memberships?.length ?? 0) > 0
          ? becauseAnswer("memberships")
          : ctx.answers.customersDo?.includes("memberships")
            ? becauseAnswer("customersDo")
            : null,
    state: (ctx) => done(ctx.profile.commerce.membershipPlans + ctx.profile.commerce.passProducts > 0),
  },
  {
    id: "tournaments",
    group: "programmes",
    capabilities: ["tournaments", "leagues"],
    kind: "link",
    effect: "add",
    titleKey: "gs.step.tournaments.title",
    whyKey: "gs.step.tournaments.why",
    required: false,
    after: ["courts"],
    configure: { tab: "tournaments" },
    staffAction: "tournaments",
    // Only on interest: a venue that only takes court bookings is never led through scoring.
    applies: (ctx) => (hasProgrammes(ctx.profile) ? becauseFact("gs.because.fact.programmes") : ctx.answers.competitions === true ? becauseAnswer("competitions") : null),
    state: (ctx) => done(ctx.profile.programmes.tournaments + ctx.profile.programmes.leagues > 0),
  },

  // ---------------------------------------------------------------- going live
  {
    id: "test-booking",
    group: "launch",
    capabilities: ["test-bookings", "go-live"],
    kind: "form",
    effect: "open",
    titleKey: "gd.step.testBooking.title",
    whyKey: "gd.step.testBooking.why",
    required: true,
    after: ["courts", "details"],
    configure: { tab: "bookings" },
    staffAction: "testBookings",
    action: "try-it",
    platformRule: { key: "gs.step.testBooking.rule" },
    applies: () => ALWAYS,
    state: (ctx) => done(ctx.profile.setup.testBooking),
  },
  {
    id: "launch",
    group: "launch",
    capabilities: ["go-live"],
    kind: "form",
    effect: "open",
    titleKey: "gs.step.launch.title",
    whyKey: "gs.step.launch.why",
    // Going live is the venue's own act, asked for with the button at the top of the dashboard: not a checklist step to tick.
    required: false,
    after: ["test-booking"],
    staffAction: "goLive",
    action: "readiness",
    platformRule: { key: "gs.step.launch.rule" },
    applies: () => ALWAYS,
    state: (ctx) => done(ctx.profile.identity.live),
  },
];

const BY_ID = new Map(SETUP_STEPS.map((s) => [s.id, s]));

/** One step by id, or undefined. */
export const setupStep = (id: string): SetupStep | undefined => BY_ID.get(id);

/** Steps the manager says they reviewed, by id: what `acknowledge` may be asked for. */
export const reviewStepIds = (): string[] => SETUP_STEPS.filter((s) => s.kind === "review").map((s) => s.id);
