import { getDb } from "./db";
import { region, type CountryCode } from "./region";

/**
 * Why money is kept back from a hire deposit, and what that money is.
 *
 * The amount kept is income to the venue either way, but not the same
 * income: making good a broken kayak is compensation, keeping it two hours
 * late is more hire, a cleaning fee is a charge for a service. Each is its
 * own heading in the books, and whether sales tax applies depends on that
 * nature and on the country's rules — not something to ask of whoever is at
 * the desk with a tick box. So staff say why (a reason), the reason says
 * what kind of money it is (its nature), and the venue's tax settings say
 * which natures carry its tax, starting from the country's usual treatment
 * below. Neither is legal or tax advice: a venue's accountant confirms it
 * (docs/features/venue-operations.md).
 */

export const DEDUCTION_REASONS = ["damage", "loss", "late_return", "cleaning", "admin_fee", "penalty", "other"] as const;
export type DeductionReason = (typeof DEDUCTION_REASONS)[number];

/** What kind of money it is. */
export type DeductionNature = "compensation" | "replacement" | "service" | "fee" | "penalty" | "other";

export interface ReasonInfo {
  label: string;
  nature: DeductionNature;
  /** The heading it goes under in the sales journal (lib/accounting.ts). */
  category: "Hire: damage and loss" | "Hire: extra charges" | "Hire: penalties" | "Hire deposits kept";
}

export const DEDUCTION_INFO: Record<DeductionReason, ReasonInfo> = {
  damage: { label: "Damage to the equipment", nature: "compensation", category: "Hire: damage and loss" },
  loss: { label: "Equipment lost or not returned (replacement)", nature: "replacement", category: "Hire: damage and loss" },
  late_return: { label: "Kept past the time booked (more hire)", nature: "service", category: "Hire: extra charges" },
  cleaning: { label: "Cleaning", nature: "service", category: "Hire: extra charges" },
  admin_fee: { label: "Administration fee", nature: "fee", category: "Hire: extra charges" },
  penalty: { label: "Penalty under the hire terms", nature: "penalty", category: "Hire: penalties" },
  other: { label: "Other (say what in the note)", nature: "other", category: "Hire deposits kept" },
};

export const isDeductionReason = (v: unknown): v is DeductionReason => DEDUCTION_REASONS.includes(v as DeductionReason);

/**
 * The usual treatment in each country, as a provisional starting point only,
 * not reviewed by a tax adviser and not legal or tax advice: a charge
 * for something the venue supplies (more hire, cleaning, a fee) carries the
 * venue's tax; money that makes good a loss (compensation, replacement) or
 * a penalty is commonly outside it, and "other" is not taxed until the venue
 * says otherwise. Each of the untaxed ones is marked for review, because
 * whether a particular amount is consideration for a supply is a question
 * of fact for the venue's adviser, and the rules differ (Malaysia's service
 * tax, Singapore's GST).
 */
const USUAL: Record<CountryCode, { taxed: DeductionNature[] }> = {
  MY: { taxed: ["service", "fee"] },
  SG: { taxed: ["service", "fee"] },
};

export interface DeductionTreatment {
  reason: DeductionReason;
  label: string;
  nature: DeductionNature;
  /** Carries the venue's tax, if the venue is registered. */
  taxed: boolean;
  /** Left as the country's usual treatment, which is marked to confirm with an adviser. */
  usual: boolean;
  /** The usual treatment is not to tax it, and that is the kind to confirm. */
  review: boolean;
  /** On what footing it applies now: the country's provisional default, the venue's unreviewed choice, or a reviewed configuration. */
  basis: TaxBasis;
}

export type TaxBasis = "provisional" | "venue" | "reviewed";

/** Whether a venue's configuration as it stands has been reviewed, by whom, and when. */
export interface DeductionReview {
  approvedAt: string;
  reviewer: string;
  approvedBy: string | null;
}

function usualTaxed(nature: DeductionNature): boolean {
  return USUAL[region().country].taxed.includes(nature);
}

/** How a venue treats each reason: its own choice where it made one, else the country's usual. */
export async function deductionTreatments(venueId: number): Promise<DeductionTreatment[]> {
  const row = (await getDb().prepare("SELECT deduction_tax, deduction_tax_approved_at FROM venues WHERE id = ?").get(venueId)) as
    | { deduction_tax: string | null; deduction_tax_approved_at: string | null }
    | undefined;
  const reviewed = !!row?.deduction_tax_approved_at;
  let own: Partial<Record<DeductionReason, boolean>> = {};
  try {
    own = row?.deduction_tax ? (JSON.parse(row.deduction_tax) as typeof own) : {};
  } catch {
    own = {};
  }
  return DEDUCTION_REASONS.map((reason) => {
    const info = DEDUCTION_INFO[reason];
    const chosen = typeof own[reason] === "boolean" ? own[reason]! : null;
    const taxed = chosen ?? usualTaxed(info.nature);
    return {
      reason,
      label: info.label,
      nature: info.nature,
      taxed,
      usual: chosen === null,
      review: !reviewed && chosen === null && !taxed,
      basis: reviewed ? "reviewed" : chosen === null ? "provisional" : "venue",
    };
  });
}

/** The review of the venue's configuration as it stands, or null: unreviewed, or changed since it was reviewed. */
export async function deductionReview(venueId: number): Promise<DeductionReview | null> {
  const r = (await getDb()
    .prepare(
      `SELECT v.deduction_tax_approved_at, v.deduction_tax_reviewer, a.name AS approved_by FROM venues v
         LEFT JOIN admins a ON a.id = v.deduction_tax_approved_by WHERE v.id = ?`
    )
    .get(venueId)) as { deduction_tax_approved_at: string | null; deduction_tax_reviewer: string | null; approved_by: string | null } | undefined;
  return r?.deduction_tax_approved_at ? { approvedAt: r.deduction_tax_approved_at, reviewer: r.deduction_tax_reviewer ?? "", approvedBy: r.approved_by } : null;
}

/** Every change and review of a venue's treatments, newest first: the record, kept for good. */
export async function deductionHistory(venueId: number): Promise<{ kind: "changed" | "approved"; changed: Record<string, boolean | null> | null; reviewer: string | null; adminName: string | null; createdAt: string }[]> {
  return (
    (await getDb()
      .prepare("SELECT kind, changed, reviewer, admin_name, created_at FROM deduction_tax_changes WHERE venue_id = ? ORDER BY id DESC LIMIT 50")
      .all(venueId)) as { kind: "changed" | "approved"; changed: string | null; reviewer: string | null; admin_name: string | null; created_at: string }[]
  ).map((r) => ({ kind: r.kind, changed: r.changed ? (JSON.parse(r.changed) as Record<string, boolean | null>) : null, reviewer: r.reviewer, adminName: r.admin_name, createdAt: r.created_at }));
}

/**
 * Record that somebody qualified has reviewed the venue's treatments as
 * they stand — the accountant or tax adviser, named — approved by a manager.
 * It makes the configuration "reviewed" until it next changes.
 */
export async function approveDeductionTreatments(
  venueId: number,
  reviewer: string,
  by: { id: number; name: string }
): Promise<{ ok: true; review: DeductionReview } | { ok: false; error: string }> {
  const who = reviewer.trim();
  if (who.length < 3 || who.length > 200) return { ok: false, error: "Name who reviewed it: the accountant or tax adviser, and their firm." };
  const treatments = await deductionTreatments(venueId);
  await getDb()
    .prepare("UPDATE venues SET deduction_tax_approved_at = datetime('now'), deduction_tax_approved_by = ?, deduction_tax_reviewer = ? WHERE id = ?")
    .run(by.id, who, venueId);
  await getDb()
    .prepare("INSERT INTO deduction_tax_changes (venue_id, kind, treatments, reviewer, admin_id, admin_name) VALUES (?, 'approved', ?, ?, ?, ?)")
    .run(venueId, JSON.stringify(treatments.map((t) => [t.reason, t.taxed])), who, by.id, by.name);
  return { ok: true, review: (await deductionReview(venueId))! };
}

/** A venue's choice for some reasons; `null` for a reason puts it back to the country's usual. */
export async function setDeductionTreatments(
  venueId: number,
  choices: Record<string, unknown>,
  /** Who changed it, for the record. */
  by?: { id: number; name: string }
): Promise<{ ok: true; treatments: DeductionTreatment[] } | { ok: false; error: string }> {
  const current = Object.fromEntries((await deductionTreatments(venueId)).filter((t) => !t.usual).map((t) => [t.reason, t.taxed])) as Record<string, boolean>;
  for (const [reason, value] of Object.entries(choices)) {
    if (!isDeductionReason(reason)) return { ok: false, error: `Unknown reason: ${reason}.` };
    if (value === null) delete current[reason];
    else if (typeof value === "boolean") current[reason] = value;
    else return { ok: false, error: "Say taxed (true), not taxed (false), or the usual (null)." };
  }
  // A change is a configuration nobody has reviewed yet: the review lapses, and the change is kept.
  await getDb()
    .prepare("UPDATE venues SET deduction_tax = ?, deduction_tax_approved_at = NULL, deduction_tax_approved_by = NULL, deduction_tax_reviewer = NULL WHERE id = ?")
    .run(Object.keys(current).length > 0 ? JSON.stringify(current) : null, venueId);
  const treatments = await deductionTreatments(venueId);
  await getDb()
    .prepare("INSERT INTO deduction_tax_changes (venue_id, kind, treatments, changed, admin_id, admin_name) VALUES (?, 'changed', ?, ?, ?, ?)")
    .run(venueId, JSON.stringify(treatments.map((t) => [t.reason, t.taxed])), JSON.stringify(choices), by?.id ?? null, by?.name ?? null);
  return { ok: true, treatments };
}
