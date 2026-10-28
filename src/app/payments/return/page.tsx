import Link from "next/link";
import { allGateways, type PaymentResult } from "@/lib/gateways";
import { accountForBill, paymentByBill, settleBill } from "@/lib/payments";
import { serverT } from "@/lib/locale";
import { money } from "@/lib/region";
import { receiptOfPayment } from "@/lib/documents";
import { receiptPath } from "@/lib/receipts";
import { voucherOfPayment, voucherPath } from "@/lib/vouchers";
import { coachDifferences } from "@/lib/lesson-coaches";

export const dynamic = "force-dynamic";

/** Not known to be paid: not paid, or not yet heard. */
const outcomeIcon = (result: PaymentResult | null) => (result && !result.paid ? "↩️" : "⏳");

/**
 * Where the gateway sends the customer back.
 *
 * The result in the address is signed, and is believed only when the
 * signature checks out under the key of the account it was paid through —
 * then it settles the booking exactly as the server-to-server callback would, since either may arrive
 * first and the callback may be late. An address without a good signature
 * changes nothing, whatever it says.
 */
export default async function PaymentReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await serverT();
  const raw = await searchParams;
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") query.set(k, v);

  // Whichever gateway's address this is: each knows its own.
  let result: PaymentResult | null = null;
  for (const gateway of allGateways()) {
    const inbound = gateway.readRedirect(query);
    if (!inbound?.billId) continue;
    const account = await accountForBill(gateway.id, inbound.billId);
    result = account ? await inbound.verify(account) : null;
    break;
  }
  if (result) await settleBill(result);
  const payment = result ? await paymentByBill(result.billId) : null;
  // What was just bought, on paper: for anything but court time, which has its own on My Booking.
  const receipt = payment && payment.status === "paid" ? await receiptOfPayment(payment.id) : null;
  const receiptLink = receipt && (
    <a href={receiptPath(receipt.ref)} className="mt-3 inline-block text-sm font-medium text-teal-700 underline">
      {t("mine.receipt")}
    </a>
  );

  // A venue paying its marketplace invoice, rather than a customer paying for
  // a booking: staff, in English like the rest of the admin, and back to it.
  if (payment?.purpose === "invoice")
    return (
      <div className="mx-auto max-w-sm">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <div className="text-4xl">{payment.status === "paid" ? "✅" : "↩️"}</div>
          <h1 className="mt-2 text-xl font-bold">
            {payment.status === "paid" ? "Invoice paid" : "Invoice not paid"}
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            {payment.status === "paid"
              ? `Thank you. ${money(payment.amount)} has been received.`
              : "Nothing was taken. You can try again from Billing."}
          </p>
          <Link
            href="/admin"
            className="mt-5 inline-block w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
          >
            Back to admin
          </Link>
        </div>
      </div>
    );

  // A tournament entry fee.
  if (payment?.purpose === "entry" && payment.status === "paid")
    return (
      <div className="mx-auto max-w-sm">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <div className="text-4xl">✅</div>
          <h1 className="mt-2 text-xl font-bold">{t("pay.entryTitle")}</h1>
          <p className="mt-2 text-sm text-slate-600">{t("pay.entryBody", { amount: payment.amount })}</p>
          {receiptLink}
          <Link
            href="/tournaments"
            className="mt-5 inline-block w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
          >
            {t("pay.entryBack")}
          </Link>
        </div>
      </div>
    );

  // A season's league fee.
  if (payment?.purpose === "league" && payment.status === "paid")
    return (
      <div className="mx-auto max-w-sm">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <div className="text-4xl">✅</div>
          <h1 className="mt-2 text-xl font-bold">{t("pay.leagueTitle")}</h1>
          <p className="mt-2 text-sm text-slate-600">{t("pay.leagueBody", { amount: payment.amount })}</p>
          {receiptLink}
          <Link
            href="/leagues"
            className="mt-5 inline-block w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
          >
            {t("pay.leagueBack")}
          </Link>
        </div>
      </div>
    );

  // A player's share of somebody else's open game.
  if (payment?.purpose === "share" && payment.status === "paid")
    return (
      <div className="mx-auto max-w-sm">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <div className="text-4xl">✅</div>
          <h1 className="mt-2 text-xl font-bold">{t("pay.shareTitle")}</h1>
          <p className="mt-2 text-sm text-slate-600">{t("pay.shareBody", { amount: payment.amount })}</p>
          {receiptLink}
          <Link
            href="/games"
            className="mt-5 inline-block w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
          >
            {t("pay.shareBack")}
          </Link>
        </div>
      </div>
    );

  // A membership fee: the membership it made, or why there is none.
  if (payment?.purpose === "membership") {
    const m = payment.membership;
    // Whose it is: the buyer's own, or the child's (or other participant's) it was bought for; and whom a family one covers.
    const dates = m && { code: m.code, venue: m.venueName, from: m.startsOn, until: m.expiresOn };
    return (
      <div className="mx-auto max-w-sm">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <div className="text-4xl">{m ? "🎟️" : payment.status === "paid" ? "⚠️" : "↩️"}</div>
          <h1 className="mt-2 text-xl font-bold">
            {m
              ? m.holderName
                ? t("fin5.memberFor.title", { name: m.holderName })
                : t("member.welcomeTitle")
              : payment.status === "paid"
                ? t("member.notMadeTitle")
                : t("pay.notPaidTitle")}
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            {m && dates
              ? m.holderName
                ? t("fin5.memberFor.body", { name: m.holderName, ...dates })
                : t("member.welcomeBody", dates)
              : payment.status === "paid"
                ? t("member.notMadeBody", { amount: payment.amount })
                : t("member.notPaidBody")}
          </p>
          {m && m.covers.length > 0 && <p className="mt-1 text-sm text-slate-600">{t("fin5.memberCovers", { names: m.covers.join(", ") })}</p>}
          {receiptLink}
          <Link
            href={payment.venueId ? `/venue/${payment.venueId}` : "/account"}
            className="mt-5 inline-block w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
          >
            {t("member.back")}
          </Link>
        </div>
      </div>
    );
  }

  // A gift voucher bought online: here it is, to print or pass on.
  if (payment?.purpose === "voucher") {
    const voucher = payment.status === "paid" ? await voucherOfPayment(payment.id) : null;
    return (
      <div className="mx-auto max-w-sm">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <div className="text-4xl">{voucher ? "🎁" : "↩️"}</div>
          <h1 className="mt-2 text-xl font-bold">{voucher ? t("gift.paidTitle") : t("pay.notPaidTitle")}</h1>
          <p className="mt-2 text-sm text-slate-600">{voucher ? t("gift.paidBody", { code: voucher.code }) : t("gift.notPaid")}</p>
          {voucher && (
            <a
              href={voucherPath(voucher.code)}
              className="mt-5 inline-block w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
            >
              {t("gift.open")}
            </a>
          )}
          {receiptLink}
        </div>
      </div>
    );
  }

  // A dearer coach's difference (lib/lesson-coaches.ts): paid, with its own receipt; or, paid after it was settled
  // another way, owed back; or not paid, and still owed.
  if (payment?.purpose === "coach" && payment.coachChangeId) {
    const [view] = await coachDifferences({ changeId: payment.coachChangeId });
    const paidHere = payment.status === "paid" && payment.refundOwed + payment.refunded <= 0 && view?.state === "paid";
    const owedBack = payment.status === "paid" && !paidHere;
    return (
      <div className="mx-auto max-w-sm">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <div className="text-4xl">{paidHere ? "✅" : owedBack ? "↩️" : outcomeIcon(result)}</div>
          <h1 className="mt-2 text-xl font-bold">
            {paidHere ? t("cp7.returnPaidTitle") : owedBack ? t("cp7.returnBackTitle") : result && !result.paid ? t("pay.notPaidTitle") : t("pay.unknownTitle")}
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            {paidHere
              ? t("cp7.returnPaidBody", { amount: money(payment.amount), code: payment.bookingCodes.join(", ") })
              : owedBack
                ? t("cp7.returnBackBody", { amount: money(payment.amount) })
                : result && !result.paid
                  ? t("cp7.returnNotPaid")
                  : t("pay.unknownBody")}
          </p>
          {paidHere && view?.receipt && (
            <a href={receiptPath(view.receipt)} className="mt-3 inline-block text-sm font-medium text-teal-700 underline">
              {t("mine.receipt")}
            </a>
          )}
          <Link
            href="/my-booking"
            className="mt-5 inline-block w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
          >
            {t("pay.toMyBooking")}
          </Link>
        </div>
      </div>
    );
  }

  // Stored credit bought online: back to the account it landed on.
  if (payment?.purpose === "topup")
    return (
      <div className="mx-auto max-w-sm">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <div className="text-4xl">{payment.status === "paid" ? "✅" : "↩️"}</div>
          <h1 className="mt-2 text-xl font-bold">
            {payment.status === "paid" ? t("wallet.topUpTitle") : t("pay.notPaidTitle")}
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            {payment.status === "paid"
              ? t("wallet.topUpBody", { amount: payment.amount })
              : t("wallet.topUpNotPaid")}
          </p>
          {receiptLink}
          <Link
            href="/account"
            className="mt-5 inline-block w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
          >
            {t("wallet.topUpBack")}
          </Link>
        </div>
      </div>
    );

  const outcome: "paid" | "notPaid" | "unknown" = !result
    ? "unknown"
    : payment?.status === "paid"
      ? "paid"
      : result.paid
        ? "unknown"
        : "notPaid";

  return (
    <div className="mx-auto max-w-sm">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="text-4xl">{outcome === "paid" ? "✅" : outcome === "notPaid" ? "↩️" : "⏳"}</div>
        <h1 className="mt-2 text-xl font-bold">
          {outcome === "paid"
            ? t("pay.receivedTitle")
            : outcome === "notPaid"
              ? t("pay.notPaidTitle")
              : t("pay.unknownTitle")}
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          {outcome === "paid" && payment
            ? t("pay.receivedBody", { amount: payment.amount, codes: payment.bookingCodes.join(", ") })
            : outcome === "notPaid"
              ? t("pay.notPaidBody")
              : t("pay.unknownBody")}
        </p>
        <Link
          href="/my-booking"
          className="mt-5 inline-block w-full rounded-lg bg-teal-600 py-2.5 font-semibold text-white hover:bg-teal-700"
        >
          {t("pay.toMyBooking")}
        </Link>
      </div>
    </div>
  );
}
