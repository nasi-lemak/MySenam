import type { CancelRefund, RefundStatus } from "./payments";
import type { T } from "./i18n";
import { money } from "./region";

const PHRASE = { gateway: "mine.refundGateway", credit: "mine.refundCredit", staff: "mine.refundStaff" } as const;

/** What a customer is told about money paid online for a booking they cancelled. */
export function refundLines(t: T, refunds: Pick<CancelRefund, "how" | "amount" | "dueBy">[] | undefined): string[] {
  return (refunds ?? []).map((r) =>
    r.how === "staff" && r.dueBy ? t("refund.owedStaff", { amount: money(r.amount), date: r.dueBy }) : t(PHRASE[r.how], { amount: money(r.amount) })
  );
}

/** Where a refund stands, for the customer to follow: owed by a date, late, or made. */
export function refundStatusLine(t: T, r: Pick<RefundStatus, "owed" | "refunded" | "how" | "clock" | "refundedAt">): { text: string; late: boolean } {
  if (r.owed <= 0) return { text: t("refund.done", { amount: money(r.refunded), date: (r.refundedAt ?? "").slice(0, 10) }), late: false };
  if (r.how !== "staff") return { text: t("refund.owedGateway", { amount: money(r.owed) }), late: false };
  if (r.clock?.overdue) return { text: t("refund.overdue", { amount: money(r.owed), date: r.clock.dueBy }), late: true };
  return { text: t("refund.owedStaff", { amount: money(r.owed), date: r.clock?.dueBy ?? "" }), late: false };
}
