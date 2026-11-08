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

/** Why a refund is owed back (the cause the list of money owed back records), in the staff dictionary, for the cash-up's refunds block. */
export const OWED_CAUSE_PHRASES: Record<string, StaffPhrase> = {
  closure: "r9e.owed.cause.closure",
  outage: "r9e.owed.cause.outage",
  rain: "r9e.owed.cause.rain",
  api: "r9e.owed.cause.api",
  class: "r9e.owed.cause.class",
  test: "r10a.owed.cause.test",
  lesson_moved: "clsb.s.owed.cause.lessonMoved",
  moved_cheaper: "p67.owed.cause.movedCheaper",
  customer_cancelled: "rf74.owed.cause.customer",
  place_withdrawn: "rf74.owed.cause.place",
  tournament_cancelled: "fx10.fee.cause.cancelled",
  before_draw: "fx10.fee.cause.beforeDraw",
  pass_refunded: "cu75.cause.passRefunded",
  membership_refunded: "cu75.cause.membershipRefunded",
};
