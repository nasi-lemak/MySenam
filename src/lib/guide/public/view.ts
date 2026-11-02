import type { ResourceModel } from "../../activity-catalogue";
import { CAPABILITIES, CAPABILITY_GROUPS, availabilityOf, capability, type Availability, type Capability, type CapabilityGroup } from "../capabilities";
import { activityFacts, composeTypes, type ActivityFacts, type BusinessTypeId } from "../business-types";
import type { Phrase } from "../../i18n";
import type { WorkflowId } from "../business-types";
import { WORKFLOWS, claimsOf, shownSteps, type ShownStep } from "./workflows";
import { isEmptySelection, type Selection } from "./select";

/**
 * What the public guide shows for a selection of business types and
 * activities: a model, computed from the shared one and never copied
 * (docs/features/venue-guide.md#the-public-guide). Words are not here, only
 * ids; the page says them in the visitor's language.
 *
 * Several types are composed with `composeTypes`, not forced into one
 * category. Activities the visitor adds beyond the types' own bring the
 * capabilities and journeys their resource model uses, and the limits their
 * catalogue entry names.
 *
 * Browser-safe: data only.
 */

/** Where a capability or a journey came from: a business type, or an activity the visitor added. */
export type Origin = BusinessTypeId | "activity";

export interface ListedCapability {
  capability: Capability;
  availability: Availability;
  from: Origin[];
}

export interface ShownWorkflow {
  id: WorkflowId;
  from: Origin[];
  steps: ShownStep[];
}

export interface FitView {
  selection: Selection;
  /** Nothing chosen: the page shows the picker only. */
  empty: boolean;
  types: BusinessTypeId[];
  activities: { key: string; from: Origin[]; facts: ActivityFacts | undefined }[];
  /** More than one business type, the mixed venue, or activities of more than one resource model. */
  combined: boolean;
  /** The capabilities the selection lists, in the order of the registry. */
  listed: ListedCapability[];
  workflows: ShownWorkflow[];
  /** Available capabilities by group, in the order a venue is set up. */
  setup: { group: CapabilityGroup; items: ListedCapability[] }[];
  /** All listed capabilities by what using them takes. */
  byAvailability: Record<Availability, ListedCapability[]>;
  /** Activities whose support is not full, with the catalogue's own note. */
  partial: ActivityFacts[];
  /** Unsupported capabilities that concern this selection, then the rest. */
  limits: { relevant: Capability[]; others: Capability[] };
  /** Statements about running several kinds of business together, and the capabilities each rests on. */
  combinedClaims: string[];
}

/** The order a venue is set up in: what it is, what it sells, who runs it, how it is paid, how it grows. */
export const SETUP_ORDER: readonly CapabilityGroup[] = ["booking", "pricing", "memberships", "programmes", "access", "people", "money", "communication", "compliance", "multi-branch", "reporting", "integrations", "platform"];

/**
 * What an available capability brings with it that a venue is told of: the
 * unsupported ones whose limit applies wherever it is used. A venue taking
 * Billplz payments refunds by hand; one on WhatsApp sends from the platform's
 * number; door codes are one code to a lock.
 */
export const LIMITS_WITH: Readonly<Record<string, readonly string[]>> = {
  "pay-online-billplz": ["billplz-refunds"],
  "pay-to-hold": ["billplz-refunds"],
  "whatsapp-messages": ["venue-whatsapp-number"],
  "booking-alerts": ["venue-whatsapp-number"],
  "unstaffed-access": ["smart-locks", "door-credentials"],
};

/** What each resource model brings, for an activity the visitor adds (the types list their own). */
export const MODEL_CAPABILITIES: Readonly<Record<ResourceModel, readonly string[]>> = {
  exclusive: ["resources", "opening-hours", "booking-rules", "counter-payments", "check-in", "refunds"],
  lanes: ["resources", "opening-hours", "booking-rules", "counter-payments", "check-in", "refunds"],
  shared: ["resources", "shared-facilities", "opening-hours", "counter-payments", "check-in", "refunds"],
  class: ["classes", "counter-payments", "refunds"],
  hire: ["resources", "equipment-hire", "opening-hours", "counter-payments"],
};

/** The journeys each model's activity is booked through. */
export const MODEL_WORKFLOWS: Readonly<Record<ResourceModel, readonly WorkflowId[]>> = {
  exclusive: ["court-booking", "counter-booking", "cancellation-and-refund"],
  lanes: ["court-booking", "counter-booking", "cancellation-and-refund"],
  shared: ["timed-session", "cancellation-and-refund"],
  class: ["class-enrolment", "cancellation-and-refund"],
  hire: ["equipment-hire", "cancellation-and-refund"],
};

/** The statements about running several kinds of business together: id, and the capabilities it needs to be true. */
export const COMBINED_CLAIMS: readonly { id: string; needs: readonly string[] }[] = [
  { id: "activities", needs: ["activity-catalogue"] },
  { id: "rules", needs: ["booking-rules"] },
  { id: "models", needs: ["resources"] },
  { id: "staff", needs: ["staff-roles"] },
  { id: "branches", needs: ["branches"] },
];

const REGISTRY_ORDER = new Map(CAPABILITIES.map((c, i) => [c.id, i]));

function add(map: Map<string, Set<Origin>>, id: string, from: Origin) {
  if (!map.has(id)) map.set(id, new Set());
  map.get(id)!.add(from);
}

/**
 * Whether a journey is for this selection's activities at all. Unstaffed entry
 * is for activities that may be left unstaffed; the catalogue marks the ones
 * that never may (swimming, water polo, everything on the water) `supervised`.
 */
export function workflowApplies(id: WorkflowId, activities: readonly (ActivityFacts | undefined)[]): boolean {
  if (WORKFLOWS[id].onlyFor !== "unsupervised") return true;
  const known = activities.filter((a): a is ActivityFacts => a !== undefined);
  // No catalogue activity in the selection to judge by (an operator's own): the capability's own rule applies, so it is not hidden.
  return known.length === 0 || known.some((a) => !a.supervised);
}

export function fitView(selection: Selection): FitView {
  const composed = composeTypes(selection.types);
  const capFrom = new Map<string, Set<Origin>>();
  const wfFrom = new Map<string, Set<Origin>>();
  for (const c of composed.capabilities) for (const f of c.from) add(capFrom, c.id, f);
  for (const w of composed.workflows) for (const f of w.from) add(wfFrom, w.id, f);

  // Activities: the types' own, then any the visitor added that the types do not already have.
  const own = new Set(composed.activities.map((a) => a.key));
  const activities: FitView["activities"] = composed.activities.map((a) => ({ key: a.key, from: a.from, facts: activityFacts(a.key) }));
  for (const key of selection.activities) {
    if (own.has(key)) continue;
    const facts = activityFacts(key);
    activities.push({ key, from: ["activity"], facts });
    if (!facts) continue;
    for (const id of MODEL_CAPABILITIES[facts.model]) add(capFrom, id, "activity");
    for (const id of MODEL_WORKFLOWS[facts.model]) add(wfFrom, id, "activity");
    if (facts.signOff) {
      add(capFrom, "sign-offs", "activity");
      add(wfFrom, "first-visit-sign-off", "activity");
    }
    if (facts.perPlayer) add(capFrom, "per-player-pricing", "activity");
  }
  const facts = activities.map((a) => a.facts);

  // What every venue has (resources, the day list, receipts) is in every type's list; for activities alone it is added with the model's.
  if (selection.types.length === 0 && capFrom.size > 0) for (const id of ["day-list", "receipts-tax"]) add(capFrom, id, "activity");

  // Limits that go with an activity's own catalogue entry, or with a capability the selection lists.
  const limitFrom = new Map<string, Set<Origin>>();
  for (const c of CAPABILITIES) {
    // An activity's own way of selling (supported or not), as its catalogue entry says.
    if (!c.activityNote) continue;
    for (const a of activities) if (a.key === c.activityNote) for (const f of a.from) add(limitFrom, c.id, f);
  }
  for (const [id, from] of capFrom) for (const lim of LIMITS_WITH[id] ?? []) for (const f of from) add(limitFrom, lim, f);
  for (const [id, from] of limitFrom) for (const f of from) add(capFrom, id, f);

  const listed: ListedCapability[] = [...capFrom.entries()]
    .map(([id, from]) => ({ capability: capability(id), from: [...from] }))
    .filter((x): x is { capability: Capability; from: Origin[] } => x.capability !== undefined)
    .map((x) => ({ capability: x.capability, availability: availabilityOf(x.capability), from: x.from }))
    .sort((a, b) => (REGISTRY_ORDER.get(a.capability.id) ?? 0) - (REGISTRY_ORDER.get(b.capability.id) ?? 0));

  const ids = new Set(listed.map((l) => l.capability.id));
  const supported = new Set(listed.filter((l) => l.capability.status === "available").map((l) => l.capability.id));

  const workflows: ShownWorkflow[] = [...wfFrom.entries()]
    .filter(([id]) => id in WORKFLOWS && workflowApplies(id as WorkflowId, facts))
    .map(([id, from]) => ({ id: id as WorkflowId, from: [...from], steps: shownSteps(id as WorkflowId, supported) }))
    .filter((w) => w.steps.length > 0);

  const byAvailability: FitView["byAvailability"] = { now: [], configuration: [], integration: [], approval: [], unsupported: [] };
  for (const l of listed) byAvailability[l.availability].push(l);

  const setup = SETUP_ORDER.map((group) => ({ group, items: listed.filter((l) => l.capability.group === group && l.capability.status === "available") })).filter((g) => g.items.length > 0);

  // Everything unsupported that concerns the selection is in `listed` by now; the rest is said once, apart.
  const unsupported = CAPABILITIES.filter((c) => c.status === "unsupported");
  const limits = { relevant: unsupported.filter((c) => ids.has(c.id)), others: unsupported.filter((c) => !ids.has(c.id)) };

  const models = new Set(facts.map((f) => f?.model).filter((m): m is ResourceModel => m !== undefined));
  const combined = composed.types.length > 1 || composed.types.includes("mixed") || models.size > 1;

  return {
    selection,
    empty: isEmptySelection(selection),
    types: composed.types,
    activities,
    combined,
    listed,
    workflows,
    setup,
    byAvailability,
    partial: [...new Map(facts.filter((f): f is ActivityFacts => f !== undefined && f.support !== "full").map((f) => [f.key, f])).values()],
    limits,
    combinedClaims: COMBINED_CLAIMS.filter((c) => c.needs.every((n) => supported.has(n))).map((c) => c.id),
  };
}

/** The capability ids a whole view's journeys rely on (for a test and for the register of claims). */
export function viewClaims(view: FitView): string[] {
  const listed = new Set(view.listed.filter((l) => l.capability.status === "available").map((l) => l.capability.id));
  const out = new Set<string>();
  for (const w of view.workflows) for (const s of w.steps) for (const id of claimsOf(s, listed)) out.add(id);
  return [...out];
}

export const GROUP_PHRASE = (g: CapabilityGroup): Phrase => `fit.group.${g}` as Phrase;
export const AVAILABILITY_PHRASE = (a: Availability): Phrase => `fit.avail.${a}` as Phrase;
export { CAPABILITY_GROUPS };
