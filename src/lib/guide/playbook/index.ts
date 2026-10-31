import type { VenueProfile } from "../profile-types";
import type { GuideRole } from "../shell";
import { goFor, w } from "./dsl";
import { BOOKING_MODULES } from "./modules/booking";
import { COACH_MODULES } from "./modules/coach";
import { DAY_MODULES } from "./modules/day";
import { MANAGER_MODULES } from "./modules/manager";
import { QUICK_MODULES } from "./modules/quick";
import { SPECIALISED_MODULES } from "./modules/specialised";
import { START_MODULES, summarise } from "./modules/start";
import { buildTopic, topicBlocks, TOPIC_IDS } from "./topics";
import {
  SECTION_IDS,
  type Block,
  type ModuleContext,
  type Playbook,
  type PlaybookContext,
  type PlaybookModule,
  type PlaybookSection,
  type ScheduledEntry,
  type SectionId,
  type TocEntry,
} from "./types";

/**
 * The operating playbook (docs/features/venue-guide.md, "The operating
 * playbook"; ADR 0028): `buildPlaybook(profile, role, ctx)` composes typed
 * content modules, each saying when it applies to a venue's profile and for
 * which roles, from dictionary phrases and the profile's own facts. It is a
 * pure function: no language model, no service, no store, no cache. The same
 * input gives the same output byte for byte, and a change to the venue's
 * configuration shows in the next call because there is nothing in between.
 *
 * Browser-safe: the profile is the only thing it reads.
 *
 * To add a role: add it in shell.ts, give modules `roles` that include it, and
 * its section titles. To add a module: add a row to the file for its section
 * (modules/*.ts) and its phrases to src/lib/staff-i18n/guide-playbook.ts.
 */

export { buildTopic, topicBlocks, TOPIC_IDS };
export type { Playbook, PlaybookContext, PlaybookModule, PlaybookSection, TocEntry } from "./types";
export type { BuiltTopic, TopicId } from "./types";
export { playbookLinks, playbookText, say, sayValue } from "./render";
export type { Speaker } from "./render";

/** Every module, in the order a section shows them. */
export const MODULES: PlaybookModule[] = [
  ...START_MODULES,
  ...DAY_MODULES,
  ...BOOKING_MODULES,
  ...MANAGER_MODULES,
  ...SPECIALISED_MODULES,
  ...COACH_MODULES,
  ...QUICK_MODULES,
];

/** The sections, in the order the guide shows them. */
export const SECTION_ORDER: readonly SectionId[] = SECTION_IDS;

/** The modules a role would be shown for a venue, in order. */
export function appliedModules(profile: VenueProfile, role: GuideRole): PlaybookModule[] {
  return MODULES.filter((m) => m.roles.includes(role) && m.applies(profile, role));
}

/** What is set to change later: shown apart, never as today's policy. Not shown to a coach. */
function scheduledOf(profile: VenueProfile, role: GuideRole): ScheduledEntry[] {
  if (role === "coach") return [];
  return [
    ...profile.hours.scheduled.map<ScheduledEntry>((h) => ({ kind: "hours", from: h.from, openMin: h.openMin, closeMin: h.closeMin })),
    ...profile.rates.scheduled.map<ScheduledEntry>((r) => ({ kind: "rates", from: r.from, resources: r.resources })),
  ];
}

export function buildPlaybook(profile: VenueProfile, role: GuideRole, ctx: PlaybookContext = {}): Playbook {
  const mc: ModuleContext = { profile, role, ctx, go: goFor(role), topic: (id) => topicBlocks(id, profile, role) };
  const sections: PlaybookSection[] = [];
  const modules: string[] = [];
  for (const id of SECTION_ORDER) {
    const blocks: Block[] = [];
    const used: string[] = [];
    for (const m of appliedModules(profile, role)) {
      if (m.section !== id) continue;
      const made = m.blocks(mc);
      if (made.length === 0) continue;
      blocks.push(...made);
      used.push(m.id);
    }
    if (blocks.length === 0) continue;
    sections.push({ id, title: w(`gp.section.${id}`), blocks, modules: used });
    modules.push(...used);
  }
  const toc: TocEntry[] = sections.map((s) => ({
    id: s.id,
    title: s.title,
    ...(s.id === "quick"
      ? { items: s.blocks.flatMap((b) => (b.type === "heading" && b.id ? [{ id: b.id, title: b.text }] : [])) }
      : {}),
  }));
  const summary =
    role === "coach"
      ? [ctx.venueName ? w("gp.sum.coachAt", { venue: ctx.venueName }) : w("gp.sum.coach")]
      : summarise(profile).map((s) => ({ key: s.key, ...(s.vars ? { vars: s.vars } : {}) }));
  return {
    venue: {
      id: profile.venueId,
      name: ctx.venueName ?? null,
      today: profile.today,
      live: profile.identity.live,
      draft: profile.identity.draft,
      suspended: profile.identity.suspended,
    },
    role,
    summary,
    sections,
    toc,
    scheduled: scheduledOf(profile, role),
    modules,
  };
}
