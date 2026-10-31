import type { Phrase } from "../../i18n";
import type { WorkflowId } from "../business-types";

/**
 * The shapes of the public guide's content (docs/features/venue-guide.md#the-public-guide):
 * a workflow is a list of steps, each saying who does it, which capabilities
 * of the registry it relies on, and what an illustrative screen for it shows.
 * Browser-safe: types and phrase keys only.
 */

/** Who does the step. */
export const ACTORS = ["customer", "parent", "player", "staff", "manager", "coach", "system"] as const;
export type Actor = (typeof ACTORS)[number];

/** The mark beside an illustrative line; its meaning is always in the line's own words as well, never in the colour alone. */
export type Tone = "plain" | "ok" | "wait" | "stop";

export interface ScreenRow {
  /**
   * The line's words, as ids of `fit.tk.<id>` phrases, joined with " · ". An
   * id starting with `#` is shown as it is (a time, a code or a sample name:
   * made-up data, the same in every language); `$40` is an amount of money.
   */
  tokens: string[];
  tone: Tone;
  /** A line, a button, a total, or a field (the first token its label, the rest its value). */
  as: "row" | "action" | "total" | "field";
  /** Shown only where the selection lists at least one of these capabilities. */
  when?: string[];
}

export interface StepNote {
  id: string;
  /** Every one must be listed for the note to be shown. */
  needs: string[];
}

export interface WorkflowStep {
  /** Permanent, unique over all steps; a step may be in several workflows. */
  id: string;
  actor: Actor;
  /** Capabilities relied on: all must be listed for the step to be shown. */
  needs: string[];
  /** At least one of these must be listed (a step that works one of several ways). */
  any?: string[];
  /** Left out, not shown as a gap, where the selection lacks what it needs: the journey does not depend on it. */
  optional?: boolean;
  notes?: StepNote[];
  /** Unsupported capabilities the step names as limits. Never relied on. */
  limits?: string[];
  /** The illustrative screen's lines; its title is the step's own. */
  screen: ScreenRow[];
}

export interface Workflow {
  id: WorkflowId;
  /** Step ids, in order. */
  steps: string[];
  /**
   * A journey that only makes sense for some activities: `unsupervised` is
   * shown only where at least one activity of the selection may be left
   * unstaffed (never swimming, water polo or anything on the water; the
   * catalogue's `supervised` flag decides, see `workflowApplies`).
   */
  onlyFor?: "unsupervised";
}

const key = (k: string) => k as Phrase;

export const workflowTitleKey = (id: string): Phrase => key(`fit.w.${id}.t`);
export const workflowIntroKey = (id: string): Phrase => key(`fit.w.${id}.d`);
export const stepTitleKey = (id: string): Phrase => key(`fit.s.${id}.t`);
export const stepSeesKey = (id: string): Phrase => key(`fit.s.${id}.s`);
export const stepChecksKey = (id: string): Phrase => key(`fit.s.${id}.c`);
export const stepNoteKey = (id: string, noteId: string): Phrase => key(`fit.s.${id}.x.${noteId}`);
export const tokenKey = (id: string): Phrase => key(`fit.tk.${id}`);
export const actorKey = (a: Actor): Phrase => key(`fit.actor.${a}`);

/** A literal token (`#19:00–20:00`) is shown as it is, without the `#`. */
export const isLiteral = (token: string): boolean => token.startsWith("#");
/** A money token (`$40`) is an amount in the install's currency, written as the page's language writes money. */
export const isMoney = (token: string): boolean => /^\$\d+$/.test(token);
/** A token that is a phrase of the dictionary. */
export const isPhraseToken = (token: string): boolean => !isLiteral(token) && !isMoney(token);
