import type { StaffActionName } from "../../roles";
import type { StaffPhrase } from "../../staff-i18n";
import type { VenueProfile } from "../profile-types";
import type { DashboardTab, GuideRole } from "../shell";

export type { GuideRole };

/**
 * The shapes of the operating playbook (docs/features/venue-guide.md, "The
 * operating playbook"; ADR 0028). Browser-safe: types only.
 *
 * A playbook is *data*: typed blocks made of staff-dictionary phrases and the
 * venue's own values, never English and never a string built here, so the
 * screen, the print view and the coach's page say it in the reader's language
 * (`say` in render.ts). It is a pure function of a `VenueProfile`, a role and
 * a little context, computed on each request; there is nothing to store and
 * nothing to invalidate.
 */

/** A phrase of the staff dictionaries: the playbook's own (`gp.`), or a screen's own title, so a step names a screen as the screen does. */
export type PhraseKey = StaffPhrase;

/**
 * A value in a phrase, kept typed until it is said, so money, times and dates are
 * written in the reader's language by the one set of helpers the dashboard uses
 * (lib/region.ts) and a name the venue typed is said as typed.
 */
export type Value =
  | string
  | number
  | { money: number }
  | { clock: number }
  | { date: string }
  | { iso: string }
  | { activity: string }
  | { list: Value[] }
  | Words;

/** A phrase and its values. */
export interface Words {
  key: PhraseKey;
  vars?: Record<string, Value>;
}

/** A link to a dashboard screen, shown only to a role that may use it. */
export interface GuideLink {
  tab: DashboardTab;
  /** A part of the tab, where one is addressable. */
  view?: string;
  label: Words;
  /** The staff action that governs what it opens; the link is in a guide only if the role may do it. */
  staffAction?: StaffActionName;
}

export interface Step {
  text: Words;
  link?: GuideLink;
}

export type CalloutKind = "note" | "warning" | "policy" | "scheduled";

export interface Fact {
  label: Words;
  value: Words;
  link?: GuideLink;
}

export type Block =
  | { type: "heading"; level: 3 | 4; text: Words; id?: string }
  | { type: "paragraph"; text: Words }
  | { type: "steps"; items: Step[] }
  | { type: "facts"; items: Fact[] }
  | { type: "callout"; kind: CalloutKind; title?: Words; text: Words }
  | { type: "link"; link: GuideLink }
  | { type: "table"; head: Words[]; rows: Words[][] };

export const SECTION_IDS = ["start", "coach", "before", "booking", "during", "cancel", "eod", "manager", "specialised", "quick"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export interface PlaybookSection {
  id: SectionId;
  title: Words;
  blocks: Block[];
  /** The modules whose blocks are here, in order. */
  modules: string[];
}

export interface TocEntry {
  id: SectionId;
  title: Words;
  /** The quick-reference cards, under their section. */
  items?: { id: string; title: Words }[];
}

/** Something that changes later: never described as in force today. */
export type ScheduledEntry =
  | { kind: "hours"; from: string; openMin: number; closeMin: number }
  | { kind: "rates"; from: string; resources: number };

export interface Playbook {
  venue: { id: number; name: string | null; today: string; live: boolean; draft: boolean; suspended: boolean };
  /** The role this guide is for. */
  role: GuideRole;
  /** What the venue is, in the venue's own current configuration. */
  summary: Words[];
  sections: PlaybookSection[];
  toc: TocEntry[];
  scheduled: ScheduledEntry[];
  /** Every module that applied, in order (for tests and for support). */
  modules: string[];
}

/** What the caller knows that the profile does not: the venue's name, and for a coach their own facts. */
export interface PlaybookContext {
  venueName?: string | null;
  coach?: CoachFacts;
}

/** A coach's own, and only theirs: counts, never another person's name. */
export interface CoachFacts {
  /** Lessons of theirs still on in the next 30 days. */
  lessonsAhead: number;
  /** They have set the hours they take lessons. */
  hoursSet: boolean;
  /** Days off they have added, still to come. */
  timeOff: number;
}

/** What a module's blocks are written from. */
export interface ModuleContext {
  profile: VenueProfile;
  role: GuideRole;
  ctx: PlaybookContext;
  /** A link to a screen, or undefined where this role may not use it. */
  go(tab: DashboardTab, action?: StaffActionName, view?: string): GuideLink | undefined;
  /** The blocks of a topic for this role, so a rule is written once (topics.ts). */
  topic(id: TopicId): Block[];
}

export interface PlaybookModule {
  /** Permanent: tests and support refer to it. */
  id: string;
  section: SectionId;
  /** Who is shown it. A module is written for one role or several; a role not listed never sees it. */
  roles: GuideRole[];
  /** Whether it is true of this venue. A module that does not apply is not in the guide. */
  applies(profile: VenueProfile, role: GuideRole): boolean;
  blocks(c: ModuleContext): Block[];
}

export const TOPIC_IDS = [
  "buffers",
  "shared-linked",
  "peak-dated",
  "discounts",
  "memberships",
  "membership-covers",
  "passes",
  "guardians",
  "refunds",
  "cannot-reserve",
  "another-coach",
  "unattended",
  "test-bookings",
] as const;
export type TopicId = (typeof TOPIC_IDS)[number];

/** An explanation the application gives in more than one place: written once, used by the playbook's sections and by contextual help. */
export interface PlaybookTopic {
  id: TopicId;
  title: Words;
  /** Who it is written for; a role not listed gets none. */
  roles: GuideRole[];
  blocks(c: Pick<ModuleContext, "profile" | "role" | "go">): Block[];
  /** Other topics worth reading next. */
  related: TopicId[];
}

/** A topic built for a venue and a role. */
export interface BuiltTopic {
  id: TopicId;
  title: Words;
  blocks: Block[];
  related: { id: TopicId; title: Words }[];
}
