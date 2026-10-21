import type { CancelRefund } from "./payments";
import type { T } from "./i18n";
import { money } from "./region";

const PHRASE = { gateway: "mine.refundGateway", credit: "mine.refundCredit", staff: "mine.refundStaff" } as const;

/** What a customer is told about money paid online for a booking they cancelled. */
export function refundLines(t: T, refunds: Pick<CancelRefund, "how" | "amount">[] | undefined): string[] {
  return (refunds ?? []).map((r) => t(PHRASE[r.how], { amount: money(r.amount) }));
}
