import type { T } from "../../i18n";
import { sportLabel } from "../../i18n";
import { availabilityOf, capability, type Availability, type Capability, type Integration } from "../capabilities";
import { businessType, type BusinessTypeId } from "../business-types";
import { actorKey, isLiteral, isMoney, stepChecksKey, stepNoteKey, stepSeesKey, stepTitleKey, tokenKey, workflowIntroKey, workflowTitleKey, type ScreenRow, type Tone } from "./model";
import { claimsOf, type ShownStep } from "./workflows";
import type { FitView, ListedCapability, Origin, ShownWorkflow } from "./view";
import type { Phrase } from "../../i18n";

/**
 * The public guide's model said in a language: the words of each step, screen
 * line, capability and limit, from the customer dictionaries
 * (docs/features/venue-guide.md#the-public-guide). Pure: a `T` in, plain
 * strings out, so a page, a test and the walkthrough component all read the
 * same text, and the client component needs no dictionary of its own.
 */

export interface ScreenLine {
  text: string;
  tone: Tone;
  as: ScreenRow["as"];
}

export interface StepPresentation {
  id: string;
  number: number;
  actor: string;
  title: string;
  sees: string;
  checks: string;
  notes: string[];
  /** The capabilities the step rests on, by their titles. */
  relies: { id: string; title: string }[];
  /** What the step says is not there, with what to do instead. */
  limits: { id: string; title: string; alternative: string }[];
  screen: { title: string; lines: ScreenLine[] };
}

export interface WorkflowPresentation {
  id: string;
  title: string;
  intro: string;
  /** The business types it came from, when several were chosen; null otherwise. */
  from: string | null;
  steps: StepPresentation[];
}

/** One token's words: a phrase, a literal without its `#`, or an amount in the install's currency. */
export function tokenText(t: T, token: string): string {
  if (isLiteral(token)) return token.slice(1);
  if (isMoney(token)) return t("fit.money", { amount: Number(token.slice(1)) });
  return t(tokenKey(token));
}

/** A line's words: its tokens joined; a field reads "label: value". */
export function lineText(t: T, row: ScreenRow): string {
  const words = row.tokens.map((tok) => tokenText(t, tok));
  if (row.as === "field") return `${words[0]}: ${words.slice(1).join(" · ")}`;
  return words.join(" · ");
}

/** A list in the page's language: "A, B and C". */
export function list(t: T, items: readonly string[]): string {
  try {
    return new Intl.ListFormat(t.locale === "zh" ? "zh-Hans" : t.locale, { style: "long", type: "conjunction" }).format(items);
  } catch {
    return items.join(", ");
  }
}

export const typeName = (t: T, id: BusinessTypeId): string => t(businessType(id)!.titleKey);

const originNames = (t: T, from: readonly Origin[]): string[] => from.filter((o): o is BusinessTypeId => o !== "activity").map((o) => typeName(t, o));

function presentStep(t: T, shown: ShownStep, number: number, listed: ReadonlySet<string>): StepPresentation {
  const { step } = shown;
  return {
    id: step.id,
    number,
    actor: t(actorKey(step.actor)),
    title: t(stepTitleKey(step.id)),
    sees: t(stepSeesKey(step.id)),
    checks: t(stepChecksKey(step.id)),
    notes: shown.notes.map((n) => t(stepNoteKey(step.id, n.id))),
    relies: claimsOf(shown, listed)
      .map((id) => capability(id))
      .filter((c): c is Capability => c !== undefined)
      .map((c) => ({ id: c.id, title: t(c.titleKey) })),
    limits: (step.limits ?? [])
      .map((id) => capability(id))
      .filter((c): c is Capability => c !== undefined)
      .map((c) => ({ id: c.id, title: t(c.titleKey), alternative: c.alternativeKey ? t(c.alternativeKey) : "" })),
    screen: { title: t(stepTitleKey(step.id)), lines: shown.rows.map((r) => ({ text: lineText(t, r), tone: r.tone, as: r.as })) },
  };
}

/** Every journey of a view, said in the visitor's language. */
export function presentWorkflows(view: FitView, t: T): WorkflowPresentation[] {
  const listed = new Set(view.listed.filter((l) => l.capability.status === "available").map((l) => l.capability.id));
  return view.workflows.map((w: ShownWorkflow) => ({
    id: w.id,
    title: t(workflowTitleKey(w.id)),
    intro: t(workflowIntroKey(w.id)),
    from: view.combined && originNames(t, w.from).length > 0 ? t("fit.from", { list: list(t, originNames(t, w.from)) }) : null,
    steps: w.steps.map((s, i) => presentStep(t, s, i + 1, listed)),
  }));
}

/** A capability as a chip: its title, what using it takes and, for an integration, which. */
export interface ChipPresentation {
  id: string;
  title: string;
  blurb: string;
  availability: Availability;
  label: string;
  needs: string | null;
  alternative: string | null;
}

const INTEGRATION_PHRASE = (i: Integration): Phrase => `fit.int.${i}` as Phrase;

export function presentChip(t: T, l: ListedCapability): ChipPresentation {
  const c = l.capability;
  const integrations = c.integrations ?? [];
  return {
    id: c.id,
    title: t(c.titleKey),
    blurb: t(c.blurbKey),
    availability: availabilityOf(c),
    label: t(`fit.avail.${availabilityOf(c)}` as Phrase),
    needs: integrations.length ? t("fit.avail.needs", { list: list(t, integrations.map((i) => t(INTEGRATION_PHRASE(i)))) }) : null,
    alternative: c.alternativeKey ? t(c.alternativeKey) : null,
  };
}

export function presentCapability(t: T, c: Capability): ChipPresentation {
  return presentChip(t, { capability: c, availability: availabilityOf(c), from: [] });
}

export const activityName = (t: T, key: string): string => sportLabel(t, key);
