import type { StaffPhrase } from "../staff-i18n";
import type { GuideRole } from "./shell";
import { TOPIC_IDS, type TopicId } from "./playbook/types";

/**
 * Contextual help: where a "?" sits on a dashboard screen and what it says
 * (docs/features/venue-guide.md#contextual-help-and-discovery). Browser-safe:
 * data and pure functions only, so a screen that carries a tip pays for this
 * file and nothing else until the tip is opened.
 *
 * A tip does not hold text. It names a *place* (a control or heading), and the
 * place names the topic of the operating playbook that explains it
 * (`src/lib/guide/playbook/topics.ts`, written once and used unchanged in the
 * guide) and the question the "?" answers. What the tip shows is that topic,
 * built on the server for the caller's own role from the venue's saved
 * settings (`GET /api/admin/guide/topic`). Nothing here answers a free-text
 * question: a rule-specific answer is the reason the application already gave
 * (a refusal, an eligibility reason), shown with the tip that explains the rule.
 *
 * To add a tip: add a topic to the playbook first (this file never invents
 * text), then a place here with its question in `guide-help.ts` (`gh.q.`), then
 * `<HelpTip place="…" venueId={…} />` where it belongs. A test fails for a
 * place no screen uses, a place used twice on one screen's heading, and a
 * question missing in a language.
 */

export type { TopicId };
export { TOPIC_IDS };

export const isTopicId = (v: unknown): v is TopicId => typeof v === "string" && (TOPIC_IDS as readonly string[]).includes(v);

/**
 * Who each topic is written for: the roles that are given it, and no other.
 * (A coach has no dashboard, so no tip.) Held equal to what `buildTopic` gives
 * by `tests/guide-help.test.ts`, so the screen and the server agree.
 */
export const TOPIC_ROLES: Record<TopicId, readonly GuideRole[]> = {
  buffers: ["manager", "desk"],
  "shared-linked": ["manager", "desk"],
  "peak-dated": ["manager", "desk"],
  discounts: ["manager", "desk"],
  memberships: ["manager", "desk"],
  "membership-covers": ["manager", "desk"],
  passes: ["manager", "desk"],
  guardians: ["manager", "desk"],
  refunds: ["manager", "desk"],
  "cannot-reserve": ["manager", "desk"],
  "another-coach": ["manager", "desk"],
  unattended: ["manager", "desk"],
  "test-bookings": ["manager", "desk"],
};

/** Whether a topic is written for a role. An unknown role (not yet known on the screen) is given the benefit of the doubt: the server decides. */
export function topicWrittenFor(topic: TopicId, role: GuideRole | null | undefined): boolean {
  return role === null || role === undefined ? true : TOPIC_ROLES[topic].includes(role);
}

export interface HelpPlace {
  /** The topic that explains it. */
  topic: TopicId;
  /** The question the "?" answers: its accessible name. */
  question: StaffPhrase;
}

/**
 * Every place a "?" is, by an id the screen uses (`<HelpTip place="courts.buffers" />`).
 * The id says where: the screen, then the control or heading.
 */
export const HELP_PLACES = {
  // Courts and rates
  "courts.buffers": { topic: "buffers", question: "gh.q.buffers" },
  "courts.links": { topic: "shared-linked", question: "gh.q.shared" },
  "courts.door": { topic: "unattended", question: "gh.q.unattended" },
  "courts.peak": { topic: "peak-dated", question: "gh.q.peak" },
  "courts.dated": { topic: "peak-dated", question: "gh.q.dated" },
  "courts.concessions": { topic: "discounts", question: "gh.q.discounts" },
  // Passes, promos and memberships
  "credit.promos": { topic: "discounts", question: "gh.q.discounts" },
  "credit.plans": { topic: "memberships", question: "gh.q.plans" },
  "credit.memberships": { topic: "membership-covers", question: "gh.q.covers" },
  "credit.passes": { topic: "passes", question: "gh.q.passes" },
  // Guardians and approvals
  "people.participants": { topic: "guardians", question: "gh.q.guardians" },
  "people.approvals": { topic: "guardians", question: "gh.q.guardians" },
  // Cancellation and refunds
  "venues.cancellation": { topic: "refunds", question: "gh.q.refunds" },
  "bookings.cancel": { topic: "refunds", question: "gh.q.refunds" },
  // At the counter and in the bookings list
  "counter.quote": { topic: "cannot-reserve", question: "gh.q.cannot" },
  "counter.refusal": { topic: "cannot-reserve", question: "gh.q.cannot" },
  "bookings.coach": { topic: "another-coach", question: "gh.q.coach" },
  // Venue details and going live
  "venues.unattended": { topic: "unattended", question: "gh.q.unattended" },
  "golive.draft": { topic: "test-bookings", question: "gh.q.tests" },
  "golive.tests": { topic: "test-bookings", question: "gh.q.tests" },
} as const satisfies Record<string, HelpPlace>;

export type HelpPlaceId = keyof typeof HELP_PLACES;

export const HELP_PLACE_IDS = Object.keys(HELP_PLACES) as HelpPlaceId[];

/**
 * Where "Open this in the guide" goes: the playbook view of the guide, on the
 * same venue, at the topic's section where the venue's guide has one (a topic
 * is in the guide only where the venue uses what it explains; where it is not,
 * the guide simply opens).
 */
export function guideAddress(venueId: number, topic: TopicId): string {
  return `/admin?tab=guide&view=playbook&venue=${venueId}&topic=${topic}`;
}
