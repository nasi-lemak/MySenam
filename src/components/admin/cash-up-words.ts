import type { Category } from "@/lib/accounting";
import type { StaffPhrase, StaffT } from "@/lib/staff-i18n";

/** The sales journal's categories (lib/accounting.ts) in the staff dictionary, for the cash-up. */
export const CATEGORY_PHRASES: Record<Category, StaffPhrase> = {
  "Court hire": "p8b.cat.courtHire",
  Classes: "p8b.cat.classes",
  Coaching: "p8b.cat.coaching",
  Memberships: "p8b.cat.memberships",
  Passes: "p8b.cat.passes",
  "Tournament entries": "p8b.cat.entries",
  "League fees": "p8b.cat.leagueFees",
  "Game shares": "p8b.cat.gameShares",
  "Stored credit": "p8b.cat.credit",
  "Gift vouchers": "p8b.cat.vouchers",
  "Counter sales": "p8b.cat.counterSales",
  "Hire deposits kept": "p8b.cat.depositsKept",
  "Hire: damage and loss": "p8b.cat.damage",
  "Hire: extra charges": "p8b.cat.extraCharges",
  "Hire: penalties": "p8b.cat.penalties",
  Other: "p8b.cat.other",
};

const VIA = ["cash", "qr", "transfer", "card", "online", "credit", "pass"] as const;

/** How something was paid, in the staff language: a method, "at the counter" with none said, or "not recorded". */
export function methodText(t: StaffT, method: string | null): string {
  if (method === null) return t("p8b.via.none");
  if (method === "counter") return t("p8b.via.counter");
  return (VIA as readonly string[]).includes(method) ? t(`c.via.${method as (typeof VIA)[number]}`) : method;
}
