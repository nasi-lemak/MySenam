import type { StaffPhrase } from "../staff-i18n";
import type { AnswerKey } from "./answers";
import type { Say, SetupStep, StepContext, StepState } from "./plan";
import { usesOnlinePayments } from "./profile-types";

/**
 * The setup steps (docs/features/venue-guide.md#setup-steps).
 *
 * These are the framework's own proof: the three steps of the existing
 * checklist, delegating to what `venueSetup` already says (`profile.setup`,
 * never recomputed), the optional online payment step, a review step (the
 * manager looks and says so), and a handful of conditional ones that show what
 * "adapts to the business" means. The setup journey adds and shapes the
 * rest in this same list, each one a typed `SetupStep`: to add a step, give
 * it an id, a group, the capabilities it concerns, when it applies and why,
 * how its state is read from the profile, and what existing screen it opens.
 * Its text goes in the staff dictionaries (`src/lib/staff-i18n/guide-setup.ts`).
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

// ------------------------------------------------------------ the steps

export const SETUP_STEPS: readonly SetupStep[] = [
  // The three steps of the existing checklist (lib/setup.ts): their answers are `profile.setup`'s.
  {
    id: "details",
    group: "identity",
    capabilities: ["opening-hours", "hours-from-date"],
    kind: "link",
    effect: "open",
    titleKey: "gd.step.details.title",
    whyKey: "gd.step.details.why",
    required: true,
    configure: { tab: "venues" },
    staffAction: "venueDetails",
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
  {
    id: "courts",
    group: "resources",
    capabilities: ["resources", "activity-catalogue"],
    kind: "link",
    effect: "add",
    titleKey: "gd.step.courts.title",
    whyKey: "gd.step.courts.why",
    required: true,
    configure: { tab: "courts" },
    staffAction: "courts",
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
    consequence: { key: "gd.step.cancellation.consequence" },
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
    applies: (ctx) =>
      ctx.profile.guardians.participants > 0 || ctx.profile.guardians.approvalRequirements > 0
        ? becauseFact("gd.because.fact.guardians")
        : ctx.answers.children === true
          ? becauseAnswer("children")
          : null,
    state: (ctx) => reviewState(ctx, "guardians"),
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
    configure: { tab: "classes" },
    staffAction: "coaches",
    applies: (ctx) => (ctx.profile.people.coaches > 0 ? becauseFact("gd.because.fact.coaches") : ctx.answers.coaching === true ? becauseAnswer("coaching") : null),
    state: (ctx) =>
      ctx.profile.people.coaches === 0
        ? { status: "blocked", blockedBy: ["coaches"] }
        : done(ctx.profile.people.coachesWithHours >= ctx.profile.people.coaches),
  },
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
    id: "test-booking",
    group: "launch",
    capabilities: ["test-bookings", "go-live"],
    kind: "link",
    effect: "open",
    titleKey: "gd.step.testBooking.title",
    whyKey: "gd.step.testBooking.why",
    required: true,
    configure: { tab: "bookings" },
    staffAction: "testBookings",
    applies: () => ALWAYS,
    state: (ctx) => done(ctx.profile.setup.testBooking),
  },
];

const BY_ID = new Map(SETUP_STEPS.map((s) => [s.id, s]));

/** One step by id, or undefined. */
export const setupStep = (id: string): SetupStep | undefined => BY_ID.get(id);

/** Steps the manager says they reviewed, by id: what `acknowledge` may be asked for. */
export const reviewStepIds = (): string[] => SETUP_STEPS.filter((s) => s.kind === "review").map((s) => s.id);
