import type { StaffPhrase } from "../staff-i18n";
import { staffMay, type StaffActionName } from "../roles";
import type { GuideAnswers, Acknowledgement } from "./answers";
import type { VenueProfile } from "./profile-types";
import { hasHistory } from "./profile-types";
import type { ConfigureTarget, GuideRole } from "./shell";
import { SETUP_STEPS } from "./steps";

/**
 * The setup framework: a typed step registry (`steps.ts`) and the function
 * that turns it, a venue's real profile, its answers and what it
 * acknowledged into an ordered, grouped, conditional plan
 * (docs/features/venue-guide.md#the-setup-plan).
 *
 * One framework, not one wizard per kind of business: what a venue is
 * shown is decided by each step's own `applies` over the profile and the
 * answers. A step is `done` only from saved state, never because Next was
 * pressed, and the plan never contains a step that would overwrite what an
 * existing venue has set.
 *
 * The types here are what the browser reads; `buildSetupPlan` runs on the
 * server (it asks `staffMay` what the role may open).
 */

/** The groups a plan is shown in, in order. */
export const SETUP_GROUPS = ["identity", "resources", "pricing", "policies", "people", "payments", "programmes", "launch"] as const;
export type SetupGroup = (typeof SETUP_GROUPS)[number];

/** A staff-dictionary phrase with its values: what a plan carries instead of English, so every reader gets their own language. */
export interface Say {
  key: StaffPhrase;
  vars?: Record<string, string | number>;
}

/**
 * What a step does when the manager acts on it. Only these four exist, and
 * only the first three may be shown to a venue with history:
 * - `open`: opens an existing screen; nothing is written by the step;
 * - `add`: adds something new through the existing editor (a court, a coach);
 * - `review`: asks the manager to look and say they have (recorded, attributed);
 * - `defaults`: writes recommended starting values. For an empty venue only:
 *   `buildSetupPlan` leaves it out wherever the venue has history.
 * There is no "reset" and no "replace".
 */
export type StepEffect = "open" | "add" | "review" | "defaults";

/** `form`: the existing editor's own request, run from the journey; `link`: opens the existing screen; `review`: acknowledged by the manager. */
export type StepKind = "form" | "link" | "review";

export type StepStatus = "done" | "todo" | "optional" | "review-needed" | "blocked";

/**
 * What a step proposes, in words (never by colour alone): the venue's own
 * `saved` setting (the step's state is done), MySenam's `recommendation`
 * (from the activity catalogue's policy and template and the install's
 * region, never a saved setting), or the operator's `choice` (nothing is
 * proposed). A rule the platform always enforces is a separate note
 * (`SetupStep.platformRule`), so a card can say both.
 */
export type ProposalNature = "recommendation" | "saved" | "choice";

/**
 * The existing editor or route a step runs inside the journey
 * (components/admin/guide/setup/actions.tsx): the same request, validation,
 * permission, log entry and effective-dating as the screen it belongs to. A
 * step with no action opens that screen instead.
 */
export const SETUP_ACTIONS = ["hours", "resources", "prices", "peak-hours", "price-dates", "booking-rules", "cancellation", "staff", "try-it", "readiness"] as const;
export type SetupAction = (typeof SETUP_ACTIONS)[number];

export interface StepState {
  status: StepStatus;
  /** For `blocked`: the ids of the steps to do first. */
  blockedBy?: string[];
  /** For `done`: false says something is saved but not proven (an online account connected, no payment taken yet). Absent: nothing to verify. */
  verified?: boolean;
  /** Words to show with the state ("connection tested, no payment taken yet"). */
  note?: Say;
  /** For a reviewed `review` step: when, and by whom. */
  reviewedAt?: string;
  reviewedBy?: string;
}

/** What a step reads: the real profile, the venue's answers, what it acknowledged, and whose guide it is. */
export interface StepContext {
  profile: VenueProfile;
  answers: GuideAnswers;
  acknowledged: Record<string, Acknowledgement>;
  role: GuideRole;
  /**
   * A targeted journey (`?view=setup&focus=<group or capability id>`): the
   * steps of that capability or group, shown whether or not the venue said
   * it wanted them, with the steps they wait for. Absent: the whole plan.
   */
  focus?: string;
}

export interface SetupStep {
  /** Permanent: acknowledgements are recorded under it. Lower-case words and hyphens. */
  id: string;
  group: SetupGroup;
  /** Capability ids it concerns (`capabilities.ts`). */
  capabilities: string[];
  kind: StepKind;
  effect: StepEffect;
  /** Staff-dictionary phrases: its name and why it matters, in plain words. */
  titleKey: StaffPhrase;
  whyKey: StaffPhrase;
  /**
   * Whether this venue is shown the step and why: null to leave it out, else
   * the sentence saying which answer or fact brought it ("You said you offer
   * coaching"). A step is never shown without a reason the manager can read.
   */
  applies(ctx: StepContext): Say | null;
  /** Its state, from the profile (and, for a review, what was acknowledged): never from a click. */
  state(ctx: StepContext): StepState;
  /** Needed before the venue goes live, or optional. */
  required: boolean | ((ctx: StepContext) => boolean);
  /** The existing screen it opens. */
  configure?: ConfigureTarget;
  /** Who may use that screen (`STAFF_ACTIONS`), so a link is shown only to a role that may. */
  staffAction?: StaffActionName;
  /** A starting point, from the answers, said in words; null for none. A recommendation, never a saved setting. */
  recommend?(ctx: StepContext): Say | null;
  /** Said before a financial or consequential choice: what saving it will do, as the application does it. */
  consequence?: Say;
  /** The existing editor run inside the journey; absent for a step that opens its screen (or only asks for a review). */
  action?: SetupAction;
  /** Steps this one waits for: a targeted journey brings them along. */
  after?: string[];
  /** A rule MySenam always enforces here, said plainly beside the choice (booking integrity, the cancellation cutoff). */
  platformRule?: Say;
}

export interface PlanItem {
  id: string;
  group: SetupGroup;
  kind: StepKind;
  effect: StepEffect;
  capabilities: string[];
  titleKey: StaffPhrase;
  whyKey: StaffPhrase;
  /** Why the venue is shown it. */
  because: Say;
  state: StepState;
  required: boolean;
  recommend: Say | null;
  consequence: Say | null;
  configure: ConfigureTarget | null;
  staffAction: StaffActionName | null;
  /** The role the plan is for may use what it opens: a link is shown only when true. */
  allowed: boolean;
  /** What is proposed: a recommendation, a setting already saved, or the operator's own choice. */
  nature: ProposalNature;
  /** A rule MySenam always enforces here. */
  platformRule: Say | null;
  /** The existing editor run inside the journey, if the step has one. */
  action: SetupAction | null;
  after: string[];
}

export interface SetupPlan {
  items: PlanItem[];
  /** The items by group, in the groups' order; a group with none is left out. */
  groups: { group: SetupGroup; items: PlanItem[] }[];
  /** Counts by state: not a percentage, which would say more than the plan knows. */
  counts: Record<StepStatus, number> & { requiredOpen: number; requiredTotal: number };
}

/** A step is shown in a targeted journey for this focus when its group is it, or it concerns that capability. */
const matchesFocus = (step: SetupStep, focus: string): boolean => step.group === focus || step.capabilities.includes(focus);

/** The ids a journey can be focused on: the groups, and every capability a step concerns. */
export function focusIds(registry: readonly SetupStep[] = SETUP_STEPS): string[] {
  return [...new Set<string>([...SETUP_GROUPS, ...registry.flatMap((s) => s.capabilities)])];
}

/**
 * The venue's plan: the registry's steps that apply, in group order, each
 * with its state. For a venue with history, `defaults` steps are left out
 * (an established venue is never led through writing starting values over
 * its own), and a step already satisfied reads `done`.
 *
 * `registry` is the step list; leave it out for the application's own. A test
 * passes its own to prove the rules above.
 */
export function buildSetupPlan(ctx: StepContext, registry: readonly SetupStep[] = SETUP_STEPS): SetupPlan {
  const may = staffMay(ctx.role === "coach" ? "desk" : ctx.role);
  const history = hasHistory(ctx.profile);
  const byId = new Map(registry.map((s) => [s.id, s]));
  // A targeted journey: the steps that match, and (whatever they are) the steps those wait for.
  let wanted: Set<string> | null = null;
  if (ctx.focus) {
    wanted = new Set(registry.filter((s) => matchesFocus(s, ctx.focus!)).map((s) => s.id));
    const queue = [...wanted];
    while (queue.length > 0) {
      for (const before of byId.get(queue.pop()!)?.after ?? []) {
        if (byId.has(before) && !wanted.has(before)) {
          wanted.add(before);
          queue.push(before);
        }
      }
    }
  }
  const items: PlanItem[] = [];
  for (const step of registry) {
    if (history && step.effect === "defaults") continue;
    if (wanted && !wanted.has(step.id)) continue;
    const reason = step.applies(ctx);
    // Asked for by name, a step is shown even where the venue's answers would have left it out.
    const because: Say | null = reason ?? (wanted ? { key: matchesFocus(step, ctx.focus!) ? "gs.because.focus" : "gs.because.prerequisite" } : null);
    if (because === null) continue;
    const required = typeof step.required === "function" ? step.required(ctx) : step.required;
    const state = step.state(ctx);
    const recommend = step.recommend?.(ctx) ?? null;
    items.push({
      id: step.id,
      group: step.group,
      kind: step.kind,
      effect: step.effect,
      capabilities: step.capabilities,
      titleKey: step.titleKey,
      whyKey: step.whyKey,
      because,
      state,
      required,
      recommend,
      consequence: step.consequence ?? null,
      configure: step.configure ?? null,
      staffAction: step.staffAction ?? null,
      allowed: step.staffAction === undefined ? true : may[step.staffAction],
      nature: state.status === "done" && step.kind !== "review" ? "saved" : recommend ? "recommendation" : "choice",
      platformRule: step.platformRule ?? null,
      action: step.action ?? null,
      after: step.after ?? [],
    });
  }
  items.sort((a, b) => SETUP_GROUPS.indexOf(a.group) - SETUP_GROUPS.indexOf(b.group));
  const counts = { done: 0, todo: 0, optional: 0, "review-needed": 0, blocked: 0, requiredOpen: 0, requiredTotal: 0 };
  for (const item of items) {
    counts[item.state.status]++;
    if (item.required) counts.requiredTotal++;
    if (item.required && item.state.status !== "done") counts.requiredOpen++;
  }
  return {
    items,
    groups: SETUP_GROUPS.map((group) => ({ group, items: items.filter((i) => i.group === group) })).filter((g) => g.items.length > 0),
    counts,
  };
}
