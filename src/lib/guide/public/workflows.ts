import type { Phrase } from "../../i18n";
import { WORKFLOW_IDS, type WorkflowId } from "../business-types";
import {
  ACTORS,
  actorKey,
  isPhraseToken,
  stepChecksKey,
  stepNoteKey,
  stepSeesKey,
  stepTitleKey,
  tokenKey,
  workflowIntroKey,
  workflowTitleKey,
  type ScreenRow,
  type StepNote,
  type Workflow,
  type WorkflowStep,
} from "./model";
import { STEP_LIST } from "./steps";

/**
 * The public guide's workflows: what each person sees and what MySenam checks
 * at each stage of a real journey through the application
 * (docs/features/venue-guide.md#the-public-guide).
 *
 * The workflow ids are the shared model's (`WORKFLOW_IDS`); their content is
 * `STEP_LIST` (steps.ts) put in order here. Every step names the capabilities
 * it relies on, and nothing on a public page says MySenam does something that
 * is not a capability of the registry:
 *
 * - a step is shown only where the selection lists every capability in
 *   `needs` (and at least one in `any`); a note, only where it lists the
 *   note's; an illustrative line with `when`, only where it lists one of them;
 * - a step that is not `optional` is the journey itself: every business type
 *   that has the workflow lists what it needs (`tests/guide-public.test.ts`);
 * - a limitation is named in `limits`, as an unsupported capability the step
 *   says is not there, never as something it relies on.
 *
 * Browser-safe: data only.
 */

export const STEPS: ReadonlyMap<string, WorkflowStep> = new Map(STEP_LIST.map((s) => [s.id, s]));

/** Every workflow of the shared model, with its steps in order. */
export const WORKFLOWS: Readonly<Record<WorkflowId, Workflow>> = {
  "court-booking": { id: "court-booking", steps: ["choose", "price", "pay", "day-list", "attend", "cash-up", "reports"] },
  "counter-booking": { id: "counter-booking", steps: ["counter-start", "price", "counter-settle", "receipt", "cash-up"] },
  "online-payment-booking": { id: "online-payment-booking", steps: ["online-hold", "online-pay", "online-receipt", "day-list"] },
  "membership-benefits": { id: "membership-benefits", steps: ["mb-join", "mb-book", "mb-arrive", "mb-suspend"] },
  "pass-redemption": { id: "pass-redemption", steps: ["pass-sell", "pass-use", "pass-ledger"] },
  "class-enrolment": { id: "class-enrolment", steps: ["cl-find", "cl-enrol", "cl-pay", "cl-roster"] },
  "lesson-booking": { id: "lesson-booking", steps: ["ls-choose", "ls-checks", "ls-pay", "ls-coach"] },
  "guardian-child-booking": { id: "guardian-child-booking", steps: ["gc-person", "gc-checks", "gc-approval", "gc-book", "gc-attend"] },
  "tournament-entry": { id: "tournament-entry", steps: ["tn-enter", "tn-draw", "tn-play", "tn-public"] },
  "league-season": { id: "league-season", steps: ["lg-join", "lg-boxes", "lg-report", "lg-standings"] },
  "open-game": { id: "open-game", steps: ["og-host", "og-join", "og-suggest", "og-money"] },
  "equipment-hire": { id: "equipment-hire", steps: ["eh-book", "eh-handover", "eh-return", "eh-kept"] },
  "unstaffed-entry": { id: "unstaffed-entry", steps: ["un-induct", "un-book", "un-code", "un-limits"], onlyFor: "unsupervised" },
  "timed-session": { id: "timed-session", steps: ["ts-choose", "ts-price", "ts-arrive"] },
  "first-visit-sign-off": { id: "first-visit-sign-off", steps: ["so-rule", "so-apply", "so-record", "so-check"] },
  "company-account-booking": { id: "company-account-booking", steps: ["co-open", "co-book", "co-invoice", "co-paid", "co-credit"] },
  "cancellation-and-refund": { id: "cancellation-and-refund", steps: ["cx-customer", "cx-settle", "cx-staff", "cx-venue"] },
  "branch-oversight": { id: "branch-oversight", steps: ["br-signin", "br-add", "br-staff", "br-reports"] },
};

/** The workflow ids the shared model knows, and the ones this file covers: a test holds the two equal. */
export const WORKFLOW_CONTENT_IDS = Object.keys(WORKFLOWS) as WorkflowId[];
export const SHARED_WORKFLOW_IDS: readonly WorkflowId[] = WORKFLOW_IDS;

/** Every token an illustrative line uses that is a phrase (a literal or an amount is not). */
export function screenTokens(rows: readonly ScreenRow[]): string[] {
  return rows.flatMap((r) => r.tokens).filter(isPhraseToken);
}

/** Every phrase key the content uses, for the tests that hold the dictionaries to it. */
export function contentPhraseKeys(): Phrase[] {
  const keys = new Set<Phrase>();
  for (const w of Object.values(WORKFLOWS)) {
    keys.add(workflowTitleKey(w.id));
    keys.add(workflowIntroKey(w.id));
  }
  for (const s of STEPS.values()) {
    keys.add(stepTitleKey(s.id));
    keys.add(stepSeesKey(s.id));
    keys.add(stepChecksKey(s.id));
    for (const n of s.notes ?? []) keys.add(stepNoteKey(s.id, n.id));
    for (const t of screenTokens(s.screen)) keys.add(tokenKey(t));
  }
  for (const a of ACTORS) keys.add(actorKey(a));
  return [...keys];
}

// ------------------------------------------------------------------ what is shown

export interface ShownStep {
  step: WorkflowStep;
  notes: StepNote[];
  rows: ScreenRow[];
}

const has = (listed: ReadonlySet<string>, ids: readonly string[]) => ids.every((id) => listed.has(id));
const hasAny = (listed: ReadonlySet<string>, ids: readonly string[]) => ids.some((id) => listed.has(id));

/** Whether a step is shown, for a selection that lists these capabilities. */
export function stepShown(step: WorkflowStep, listed: ReadonlySet<string>): boolean {
  return has(listed, step.needs) && (!step.any || hasAny(listed, step.any));
}

/** A workflow's steps for a selection, in order: what its capabilities allow, and the notes and screen lines they allow. */
export function shownSteps(workflowId: WorkflowId, listed: ReadonlySet<string>): ShownStep[] {
  const out: ShownStep[] = [];
  for (const id of WORKFLOWS[workflowId].steps) {
    const step = STEPS.get(id);
    if (!step || !stepShown(step, listed)) continue;
    out.push({
      step,
      notes: (step.notes ?? []).filter((n) => has(listed, n.needs)),
      rows: step.screen.filter((r) => !r.when || hasAny(listed, r.when)),
    });
  }
  return out;
}

/** The capability ids a shown step relies on, notes and the ways it is done included: what the step claims. */
export function claimsOf(shown: ShownStep, listed: ReadonlySet<string>): string[] {
  const ids = new Set<string>(shown.step.needs);
  for (const id of shown.step.any ?? []) if (listed.has(id)) ids.add(id);
  for (const n of shown.notes) for (const id of n.needs) ids.add(id);
  return [...ids];
}
