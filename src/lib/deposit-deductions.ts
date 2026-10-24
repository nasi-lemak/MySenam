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
 * The usual treatment in each country, as a starting point only: a charge
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
}

function usualTaxed(nature: DeductionNature): boolean {
  return USUAL[region().country].taxed.includes(nature);
}

/** How a venue treats each reason: its own choice where it made one, else the country's usual. */
export async function deductionTreatments(venueId: number): Promise<DeductionTreatment[]> {
  const row = (await getDb().prepare("SELECT deduction_tax FROM venues WHERE id = ?").get(venueId)) as { deduction_tax: string | null } | undefined;
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
    return { reason, label: info.label, nature: info.nature, taxed, usual: chosen === null, review: chosen === null && !taxed };
  });
}

/** A venue's choice for some reasons; `null` for a reason puts it back to the country's usual. */
export async function setDeductionTreatments(
  venueId: number,
  choices: Record<string, unknown>
): Promise<{ ok: true; treatments: DeductionTreatment[] } | { ok: false; error: string }> {
  const current = Object.fromEntries((await deductionTreatments(venueId)).filter((t) => !t.usual).map((t) => [t.reason, t.taxed])) as Record<string, boolean>;
  for (const [reason, value] of Object.entries(choices)) {
    if (!isDeductionReason(reason)) return { ok: false, error: `Unknown reason: ${reason}.` };
    if (value === null) delete current[reason];
    else if (typeof value === "boolean") current[reason] = value;
    else return { ok: false, error: "Say taxed (true), not taxed (false), or the usual (null)." };
  }
  await getDb()
    .prepare("UPDATE venues SET deduction_tax = ? WHERE id = ?")
    .run(Object.keys(current).length > 0 ? JSON.stringify(current) : null, venueId);
  return { ok: true, treatments: await deductionTreatments(venueId) };
}
