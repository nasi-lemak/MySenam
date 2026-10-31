import type { StaffPhrase } from "../staff-i18n";
import { BUSINESS_TYPES } from "./business-types";
import type { AnswerKey, GuideAnswers } from "./answer-schema";
import { CUSTOMER_DOES, RESOURCE_BANDS, BRANCH_ANSWERS, STAFFING_ANSWERS, CHANNEL_ANSWERS, MEMBERSHIP_ANSWERS, AUDIENCE_ANSWERS } from "./answer-schema";
import type { Say } from "./plan";
import { hasProgrammes, takesCounterPayments, usesOnlinePayments, type VenueProfile } from "./profile-types";

/**
 * The owner's questions: the discovery stage of the setup journey
 * (docs/features/venue-guide.md#the-setup-journey).
 *
 * Short, in an order that lets later questions be skipped by earlier
 * answers, and never asking what the venue's saved configuration already
 * shows: a question whose answer the profile gives is `fact` (said as a
 * fact, "from your settings"), one that earlier answers make irrelevant is
 * left out. Every question is an answer key of `GuideAnswers`, so what is
 * answered is exactly what `saveAnswers` stores and what the plan's steps
 * read.
 *
 * Browser-safe: data and pure functions over the profile and the answers.
 */

export type QuestionKind = "types" | "activities" | "multi" | "single" | "yesno";

export interface Option {
  value: string;
  label: StaffPhrase;
}

export interface Question {
  id: AnswerKey;
  kind: QuestionKind;
  /** The question, and one line on why it is asked (what it changes in the plan). */
  title: StaffPhrase;
  help: StaffPhrase;
  options?: Option[];
  /** What the venue's saved configuration already says, so the question is not asked; null when it says nothing. */
  fact(profile: VenueProfile): Say | null;
  /** False where earlier answers make it irrelevant: it is left out, not asked. */
  relevant(answers: GuideAnswers, profile: VenueProfile): boolean;
}

const yes = (_a: GuideAnswers, _p: VenueProfile) => true;
const none = () => null;

const options = (prefix: string, values: readonly string[]): Option[] => values.map((value) => ({ value, label: `gs.opt.${prefix}.${value}` as StaffPhrase }));

/** Whether any chosen business type has the capability (browser-safe: the types are data). */
const typesHave = (answers: GuideAnswers, capability: string): boolean =>
  (answers.types ?? []).some((id) => BUSINESS_TYPES.find((t) => t.id === id)?.capabilities.includes(capability));

export const QUESTIONS: readonly Question[] = [
  { id: "types", kind: "types", title: "gs.q.types.title", help: "gs.q.types.help", fact: none, relevant: yes },
  {
    id: "activities",
    kind: "activities",
    title: "gs.q.activities.title",
    help: "gs.q.activities.help",
    fact: (p) => (p.activities.length > 0 ? { key: "gs.fact.activities", vars: { n: p.activities.length } } : null),
    relevant: yes,
  },
  { id: "customersDo", kind: "multi", title: "gs.q.customersDo.title", help: "gs.q.customersDo.help", options: options("customersDo", CUSTOMER_DOES), fact: none, relevant: yes },
  {
    id: "resources",
    kind: "single",
    title: "gs.q.resources.title",
    help: "gs.q.resources.help",
    options: options("resources", RESOURCE_BANDS),
    fact: (p) => (p.resources.total > 0 ? { key: "gs.fact.resources", vars: { n: p.resources.total } } : null),
    relevant: yes,
  },
  {
    id: "branches",
    kind: "single",
    title: "gs.q.branches.title",
    help: "gs.q.branches.help",
    options: options("branches", BRANCH_ANSWERS),
    fact: (p) => (p.branches.venues > 1 ? { key: "gs.fact.branches", vars: { n: p.branches.venues } } : null),
    relevant: yes,
  },
  {
    id: "staffing",
    kind: "single",
    title: "gs.q.staffing.title",
    help: "gs.q.staffing.help",
    options: options("staffing", STAFFING_ANSWERS),
    fact: (p) => (p.access.unstaffedHours ? { key: "gs.fact.staffing" } : null),
    relevant: yes,
  },
  {
    id: "channels",
    kind: "multi",
    title: "gs.q.channels.title",
    help: "gs.q.channels.help",
    options: options("channels", CHANNEL_ANSWERS),
    fact: (p) => (usesOnlinePayments(p) && takesCounterPayments(p) ? { key: "gs.fact.channels" } : null),
    relevant: yes,
  },
  {
    id: "memberships",
    kind: "multi",
    title: "gs.q.memberships.title",
    help: "gs.q.memberships.help",
    options: options("memberships", MEMBERSHIP_ANSWERS),
    fact: (p) => (p.commerce.membershipPlans + p.commerce.passProducts > 0 ? { key: "gs.fact.plans", vars: { n: p.commerce.membershipPlans + p.commerce.passProducts } } : null),
    // Memberships and passes are asked about unless what customers do is answered and has neither memberships nor classes in it.
    relevant: (a) => a.customersDo === undefined || a.customersDo.includes("memberships") || a.customersDo.includes("classes"),
  },
  {
    id: "discounts",
    kind: "yesno",
    title: "gs.q.discounts.title",
    help: "gs.q.discounts.help",
    fact: (p) => (p.commerce.concessions + p.commerce.promoCodes > 0 ? { key: "gs.fact.discounts", vars: { n: p.commerce.concessions + p.commerce.promoCodes } } : null),
    relevant: yes,
  },
  {
    id: "coaching",
    kind: "yesno",
    title: "gs.q.coaching.title",
    help: "gs.q.coaching.help",
    fact: (p) => (p.people.coaches > 0 ? { key: "gs.fact.coaches", vars: { n: p.people.coaches } } : null),
    // No coaching question for a venue whose kinds of business have none and whose customers do not join classes.
    relevant: (a) => a.types === undefined || a.types.length === 0 || typesHave(a, "coaching") || a.customersDo?.includes("classes") === true,
  },
  {
    id: "children",
    kind: "yesno",
    title: "gs.q.children.title",
    help: "gs.q.children.help",
    fact: (p) => (p.guardians.participants > 0 || p.guardians.approvalRequirements > 0 ? { key: "gs.fact.children" } : null),
    relevant: yes,
  },
  {
    id: "competitions",
    kind: "yesno",
    title: "gs.q.competitions.title",
    help: "gs.q.competitions.help",
    fact: (p) => (hasProgrammes(p) ? { key: "gs.fact.programmes" } : null),
    // A one-facility venue is not asked about tournaments and leagues.
    relevant: (a) => a.resources !== "one",
  },
  {
    id: "audience",
    kind: "single",
    title: "gs.q.audience.title",
    help: "gs.q.audience.help",
    options: options("audience", AUDIENCE_ANSWERS),
    fact: (p) => (p.identity.visibility !== "public" ? { key: p.identity.visibility === "members" ? "gs.fact.audienceMembers" : "gs.fact.audiencePrivate" } : null),
    relevant: yes,
  },
];

export interface FlowEntry {
  question: Question;
  /** Asked: nothing saved says it. Otherwise the fact that does, shown instead. */
  fact: Say | null;
}

/**
 * The questions this venue is asked, in order: those relevant given its
 * answers so far, each either to be asked or already answered by its saved
 * configuration. Recomputed as answers change, so an answer that makes later
 * questions irrelevant takes them away, and taking it back brings them back
 * (an answer already saved to a question that is left out stays saved).
 */
export function questionFlow(profile: VenueProfile, answers: GuideAnswers): FlowEntry[] {
  return QUESTIONS.filter((q) => q.relevant(answers, profile)).map((question) => ({ question, fact: question.fact(profile) }));
}

/** The questions still to ask: relevant, not answered by saved configuration, and not yet answered. */
export function unanswered(profile: VenueProfile, answers: GuideAnswers): Question[] {
  return questionFlow(profile, answers)
    .filter((e) => e.fact === null && answers[e.question.id] === undefined)
    .map((e) => e.question);
}
